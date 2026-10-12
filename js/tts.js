// Edge TTS — direct WebSocket from browser (no API key, no server)
// Protocol: TrustedClientToken + Sec-MS-GEC (SHA-256 DRM token) as query params
const TOKEN_DASHED = "6A5AA1D4-DFB0-4FF4-BA54-5B6D02881159";
const TOKEN = TOKEN_DASHED.replace(/-/g, "");
const GEC_VERSION = "1-143.0.3650.75";

const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function dateStr() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000`;
}

// Sec-MS-GEC = SHA256( ticks_100ns + TOKEN ), ticks rounded down to 5-min boundary
async function secMsGec() {
  const WIN_EPOCH = 11644473600;
  let ticks = Date.now() / 1000 + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const payload = Math.floor(ticks).toString() + TOKEN;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function wsUrl() {
  const gec = await secMsGec();
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TOKEN_DASHED}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}`;
}

function escXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function makeSSML(text, voice) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%'>${escXml(text)}</prosody></voice></speak>`;
}

export const VOICES = {
  thiha: "my-MM-ThihaNeural",
  nilar: "my-MM-NilarNeural",
};

export function edgeTTS(text, voice) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    const timer = setTimeout(() => finishErr("TTS timeout (60s)"), 60000);

    const finishOk = (ws) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) {}
      if (!chunks.length) { reject(new Error("အသံ မရဘူး")); return; }
      resolve(new Blob(chunks, { type: "audio/mpeg" }));
    };
    const finishErr = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(msg));
    };

    (async () => {
      let ws;
      try {
        ws = new WebSocket(await wsUrl());
      } catch (e) {
        finishErr("WebSocket မရ: " + e.message);
        return;
      }
      ws.binaryType = "arraybuffer";
      const reqId = (crypto.randomUUID ? crypto.randomUUID() : "id" + Date.now() + Math.random().toString(16).slice(2)).replace(/-/g, "");

      ws.onopen = () => {
        ws.send(
          `X-Timestamp:${dateStr()}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
        );
        ws.send(
          `X-RequestId:${reqId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${dateStr()}\r\n` +
          `Path:ssml\r\n\r\n` +
          makeSSML(text, voice)
        );
      };

      ws.onmessage = (ev) => {
        const d = ev.data;
        if (typeof d === "string") {
          if (d.includes("Path:turn.end")) finishOk(ws);
          return;
        }
        const bytes = new Uint8Array(d);
        let he = -1;
        for (let i = 0; i < bytes.length - 3; i++) {
          if (bytes[i] === 13 && bytes[i+1] === 10 && bytes[i+2] === 13 && bytes[i+3] === 10) { he = i + 4; break; }
        }
        if (he > 0) {
          const h = new TextDecoder().decode(bytes.subarray(0, he));
          if (h.includes("Path:audio")) chunks.push(bytes.slice(he));
        }
      };

      ws.onerror = () => finishErr("TTS ဆက်သွယ်မှု မအောင်မြင်ပါ");
      ws.onclose = () => { if (!settled) finishErr("TTS ဆက်သွယ်မှု ပြတ်သွားတယ် (403 = Microsoft က block)"); };
    })();
  });
}
