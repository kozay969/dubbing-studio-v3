// ffmpeg.wasm — shared singleton instance (single-threaded core, no COOP/COEP needed)
import { FFmpeg } from "@ffmpeg/ffmpeg";
let ffmpegPromise = null;
async function fetchToBlobURL(url, mime, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Download failed: " + resp.status);
  const total = parseInt(resp.headers.get("content-length") || "0", 10);
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total && onProgress) onProgress(loaded / total);
  }
  return URL.createObjectURL(new Blob(chunks, { type: mime }));
}
async function loadFFmpeg(onProgress) {
  const ffmpeg = new FFmpeg();
  const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  const prog = (frac, label) => onProgress && onProgress(frac, label);
  const coreURL = await fetchToBlobURL(`${base}/ffmpeg-core.js`, "text/javascript",
    f => prog(f * 0.05, "Engine download..."));
  const wasmURL = await fetchToBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm",
    f => prog(0.05 + f * 0.9, "Engine download..."));
  prog(0.97, "Engine starting...");
  await ffmpeg.load({ coreURL, wasmURL });
  prog(1, "ready");
  return ffmpeg;
}
export function getFFmpeg(onProgress) {
  if (!ffmpegPromise) ffmpegPromise = loadFFmpeg(onProgress);
  return ffmpegPromise;
}
