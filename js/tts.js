// Edge TTS — direct WebSocket from browser (no API key, no server)
// Tries v1 endpoint first, falls back to v2 (Microsoft is migrating)
const TOKEN_DASHED = "6A5AA1D4-DFB0-4FF4-BA54-5B6D02881159";
const TOKEN = TOKEN_DASHED.replace(/-/g, "");
const TOKEN_V2 = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const GEC_VERSION = "1-143.0.3650.75";
const GEC_VERSION_V2 = "2-155.0.4283.45";

const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function dateStr() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000`;
}

// Sec-MS-GEC = SHA256( ticks_100ns + TOKEN ), ticks rounded down to 5-min boundary
async function secMsGec(token) {
  const WIN_EPOCH = 11644473600;
  let ticks = Date.now() / 1000 + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const payload = Math.floor(ticks).toString() + token;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function wsUrlV1() {
  const gec = await secMsGec(TOKEN);
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TOKEN_DASHED}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}`;
}

async function wsUrlV2() {
  const gec = await secMsGec(TOKEN_V2);
  return `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1` +
    `?Ocp-Apim-Subscription-Key=${TOKEN_V2}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION_V2}`;
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
  google: "google-my",
};

// Google Translate TTS via Cloudflare Worker proxy (CORS)
// Worker URL saved in localStorage("gtts_worker")
export async function googleTTS(text) {
  const workerUrl = localStorage.getItem("gtts_worker") || "";
  if (!workerUrl) throw new Error("Google TTS Worker URL မထည့်ရသေးဘူး — အောက်က Settings မှာ ထည့်");
  const url = workerUrl.replace(/\/$/, "") + "/?text=" + encodeURIComponent(text);
  const r = await fetch(url);
  if (!r.ok) throw new Error("Google TTS failed (" + r.status + ")");
  const blob = await r.blob();
  if (!blob.size) throw new Error("Google TTS: အသံ မရဘူး");
  return blob;
}

export function edgeTTS(text, voice) {
  return tryTTS(text, voice, 0);
}

function tryTTS(text, voice, attempt) {
  const urlFns = [wsUrlV1, wsUrlV2];
  if (attempt >= urlFns.length) {
    return Promise.reject(new Error("TTS ဆက်သွယ်မှု မအောင်မြင်ပါ (v1+v2) — MP3 upload သုံးပါ"));
  }
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
    // v1 failed → try v2 endpoint
    const tryNext = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tryTTS(text, voice, attempt + 1).then(resolve, reject);
    };

    (async () => {
      let ws;
      try {
        ws = new WebSocket(await urlFns[attempt]());
      } catch (e) {
        tryNext();
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

      ws.onerror = () => tryNext();
      ws.onclose = () => { if (!settled && !chunks.length) tryNext(); };
    })();
  });
}
