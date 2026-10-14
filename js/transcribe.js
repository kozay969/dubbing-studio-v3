// Transcribe: extract audio on-device → AssemblyAI (audio-only upload)
// Uses Web Audio API (no ffmpeg download needed) with ffmpeg.wasm fallback
import { getFFmpeg } from "./ffmpeg.js";
import { fetchFile } from "@ffmpeg/util";

function encodeWAV16k(audioBuffer) {
  const data = audioBuffer.getChannelData(0);
  const buffer = new ArrayBuffer(44 + data.length * 2);
  const view = new DataView(buffer);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, "RIFF");
  view.setUint32(4, 36 + data.length * 2, true);
  ws(8, "WAVE"); ws(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 16000 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ws(36, "data");
  view.setUint32(40, data.length * 2, true);
  let off = 44;
  for (let i = 0; i < data.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function extractAudioWeb(videoFile) {
  const raw = await videoFile.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = new AC();
  try {
    const decoded = await actx.decodeAudioData(raw);
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const resampled = await off.startRendering();
    return encodeWAV16k(resampled);
  } finally {
    try { await actx.close(); } catch (e) {}
  }
}

export async function extractAudioFFmpeg(videoFile) {
  const ffmpeg = await getFFmpeg();
  try { await ffmpeg.deleteFile("input.mp4"); } catch (e) {}
  try { await ffmpeg.deleteFile("audio.wav"); } catch (e) {}
  await ffmpeg.writeFile("input.mp4", await fetchFile(videoFile));
  await ffmpeg.exec([
    "-y", "-v", "error",
    "-i", "input.mp4",
    "-vn", "-ar", "16000", "-ac", "1",
    "-c:a", "pcm_s16le",
    "audio.wav",
  ]);
  const data = await ffmpeg.readFile("audio.wav");
  return new Blob([data], { type: "audio/wav" });
}

export async function extractAudio(videoFile) {
  try {
    return await extractAudioWeb(videoFile);
  } catch (e) {
    // Web Audio failed (large file?) — fall back to ffmpeg.wasm
    return await extractAudioFFmpeg(videoFile);
  }
}

export async function transcribeAssemblyAI(audioBlob, apiKey, onStatus, languageCode) {
  const H = { authorization: apiKey };

  onStatus("☁️ Audio upload...");
  const up = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: H,
    body: audioBlob,
  });
  if (!up.ok) throw new Error("Upload မအောင်မြင်ပါ (" + up.status + ")");
  const { upload_url } = await up.json();

  onStatus("☁️ Transcribe တောင်းနေတယ်...");
  const body = { audio_url: upload_url };
  if (languageCode && languageCode !== "auto") {
    body.language_code = languageCode;
  } else {
    body.language_detection = true;
  }
  const tr = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!tr.ok) throw new Error("Transcribe တောင်းမရဘူး (" + tr.status + ")");
  const { id } = await tr.json();

  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    const pr = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: H });
    if (!pr.ok) throw new Error("Status ဖတ်မရဘူး (" + pr.status + ")");
    const tj = await pr.json();
    if (tj.status === "completed") return tj;
    if (tj.status === "error") throw new Error("Transcribe error: " + (tj.error || "unknown"));
    onStatus("☁️ Transcribing... (" + tj.status + ")");
  }
}

// Port of v2 _segments_from_words: words have start/end in MILLISECONDS
export function segmentsFromWords(words, maxDur = 12.0, pauseGap = 0.8) {
  const raw = [];
  let cur = [], curStart = null, prevEnd = null;

  const flush = (endMs) => {
    if (cur.length) {
      raw.push({
        start: Math.round(curStart / 1000 * 100) / 100,
        end: Math.round(endMs / 1000 * 100) / 100,
        text: cur.map(w => w.text || "").join(""),
      });
    }
    cur = []; curStart = null;
  };

  for (const w of words) {
    const s = w.start || 0, e = w.end || 0, t = w.text || "";
    if (!t.trim()) continue;
    if (curStart === null) curStart = s;
    if (prevEnd !== null && (s - prevEnd) / 1000 >= pauseGap && cur.length) {
      flush(prevEnd);
      curStart = s;
    }
    cur.push(w);
    prevEnd = e;
    if ((e - curStart) / 1000 >= maxDur) flush(e);
  }
  if (cur.length) flush(prevEnd !== null ? prevEnd : (curStart || 0));

  return raw.filter(sg => sg.text.trim());
}
