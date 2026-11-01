// ffmpeg.wasm — shared singleton instance.
// Prefers the MULTI-THREAD core (@ffmpeg/core-mt, renders on all CPU
// cores) when the page is cross-origin isolated — coi-serviceworker.js
// adds the COOP/COEP headers GitHub Pages can't set. Falls back to the
// single-thread core automatically if MT can't start, and the user can
// force single-thread with the Step 5 checkbox (localStorage v3_force_st).
import { FFmpeg } from "@ffmpeg/ffmpeg";

let ffmpegPromise = null;
let engineMode = null; // "mt" | "st" once loaded
export function getEngineMode() { return engineMode; }

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

async function loadCore(ffmpeg, base, mt, prog) {
  // core (~32MB) stays on CDN — fetched with CORS, fine cross-origin.
  // Only the ESM wrapper + class worker are self-hosted (same-origin rule).
  const coreURL = await fetchToBlobURL(`${base}/ffmpeg-core.js`, "text/javascript",
    f => prog(f * 0.05, "Engine download..."));
  const wasmURL = await fetchToBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm",
    f => prog(0.05 + f * (mt ? 0.8 : 0.9), "Engine download..."));
  const opts = { coreURL, wasmURL };
  if (mt) {
    // the MT core spawns its pthread workers from this blob URL
    opts.workerURL = await fetchToBlobURL(`${base}/ffmpeg-core.worker.js`, "text/javascript",
      f => prog(0.85 + f * 0.12, "Engine download..."));
  }
  prog(0.97, "Engine စတင်နေတယ်...");
  await ffmpeg.load(opts);
}

async function loadFFmpeg(onProgress) {
  const prog = (frac, label) => onProgress && onProgress(frac, label);
  let forceST = false;
  try { forceST = localStorage.getItem("v3_force_st") === "1"; } catch (e) {}
  if (self.crossOriginIsolated && !forceST) {
    try {
      const ff = new FFmpeg();
      await loadCore(ff, "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm", true, prog);
      engineMode = "mt";
      prog(1, "ready");
      return ff;
    } catch (e) {
      // MT could not start on this phone/browser — fall through to ST
      // with a fresh instance (the failed one may hold a dead worker).
    }
  }
  const ff = new FFmpeg();
  await loadCore(ff, "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm", false, prog);
  engineMode = "st";
  prog(1, "ready");
  return ff;
}

export function getFFmpeg(onProgress) {
  if (!ffmpegPromise) ffmpegPromise = loadFFmpeg(onProgress);
  return ffmpegPromise;
}
