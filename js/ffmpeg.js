// ffmpeg.wasm — shared singleton instance (single-threaded core, no COOP/COEP needed)
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

let ffmpegPromise = null;

async function loadFFmpeg() {
  const ffmpeg = new FFmpeg();
  const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
  });
  return ffmpeg;
}

export function getFFmpeg() {
  if (!ffmpegPromise) ffmpegPromise = loadFFmpeg();
  return ffmpegPromise;
}
