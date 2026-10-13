// Dubbing Studio v3 — on-device pipeline orchestration
import { getFFmpeg } from "./ffmpeg.js";
import { extractAudio, transcribeAssemblyAI, segmentsFromWords } from "./transcribe.js";
import { edgeTTS, googleTTS, geminiTTS, serverTTS } from "./tts.js";
import { smartRender } from "./render.js";

const $ = id => document.getElementById(id);

const state = {
  videoFile: null,
  duration: 0,
  segments: [],
  translations: [],
  clips: [],
  clipDurs: [],
};

function setStatus(id, msg, isErr = false) {
  const el = $(id);
  el.textContent = msg;
  el.classList.toggle("err", isErr);
}

// ---------- Engine preload (background, with progress — not blocking transcribe) ----------
getFFmpeg((frac, label) => {
  const e = $("engine-status");
  if (frac >= 1) { e.textContent = "✅ Engine အဆင်သင့်"; e.classList.add("ok"); }
  else e.textContent = `⏳ ${label} ${Math.round(frac * 100)}%`;
}).catch(e => { $("engine-status").textContent = "❌ Engine တင်မရဘူး: " + e.message; });

// ---------- Step 1: video ----------
$("video-input").addEventListener("change", e => {
  const f = e.target.files[0];
  if (!f) return;
  state.videoFile = f;
  const url = URL.createObjectURL(f);
  const v = $("video-preview");
  v.src = url;
  v.style.display = "block";
  v.onloadedmetadata = () => {
    state.duration = v.duration;
    $("video-info").textContent = `⏱️ ${v.duration.toFixed(1)}s — ${f.name}`;
  };
});

// ---------- Step 2: transcribe ----------
$("aai-key").value = localStorage.getItem("aai_key") || "";

$("btn-transcribe").addEventListener("click", async () => {
  const key = $("aai-key").value.trim();
  if (!key) return setStatus("transcribe-status", "API Key ထည့်ပါ", true);
  if (!state.videoFile) return setStatus("transcribe-status", "အရင် video ရွေးပါ", true);
  localStorage.setItem("aai_key", key);
  $("btn-transcribe").disabled = true;
  try {
    setStatus("transcribe-status", "🎵 Audio ထုတ်နေတယ် (ဖုန်းပေါ်မှာ)...");
    const audioBlob = await extractAudio(state.videoFile);
    const tj = await transcribeAssemblyAI(audioBlob, key, m => setStatus("transcribe-status", m));
    let segs = [];
    if (tj.utterances && tj.utterances.length) {
      segs = tj.utterances.map(u => ({ start: u.start / 1000, end: u.end / 1000, text: u.text }));
    } else if (tj.words && tj.words.length) {
      segs = segmentsFromWords(tj.words);
    }
    if (!segs.length) throw new Error("Segment မရဘူး — အသံ မပါလို့ဖြစ်နိုင်တယ်");
    state.segments = segs;
    setStatus("transcribe-status", `✅ ${segs.length} segment ရပြီ`);
    renderSegments();
    buildPrompt();
  } catch (e) {
    setStatus("transcribe-status", "❌ " + e.message, true);
  }
  $("btn-transcribe").disabled = false;
});

function renderSegments() {
  $("segments-list").innerHTML = state.segments.map((s, i) =>
    `<div class="item"><b>${i + 1}</b> [${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${escapeHtml(s.text)}</div>`
  ).join("");
}

// ---------- Step 3: prompt ----------
function buildPrompt() {
  const lines = state.segments.map((s, i) => {
    const dur = Math.round((s.end - s.start) * 10) / 10;
    const maxc = Math.max(10, Math.round(dur * 8));
    return `ID: ${i} | Duration: ${dur}s | MaxChars: ${maxc} | Text: "${s.text}"`;
  });
  $("prompt-text").value =
    "You are a professional Chinese-to-Burmese dubbing translator. " +
    "Translate each line into natural SPOKEN Burmese (စကားပြောဘာသာ), " +
    "the way a Burmese movie-recap narrator speaks — warm, lively, natural. " +
    "Do NOT translate word-for-word.\n\n" +
    "RULES:\n" +
    "(1) Full meaning must survive — never drop key info, rephrase tighter.\n" +
    "(2) Must sound like natural spoken Burmese, never chopped.\n" +
    "(3) Each line must fit within its MaxChars.\n" +
    "(4) Keep names consistent.\n\n" +
    'Return STRICTLY as JSON: {"translations": ["...", ...]} ' +
    "in the same order. Myanmar script ONLY.\n\n" +
    "Inputs:\n" + lines.join("\n");
}

$("btn-copy-prompt").addEventListener("click", async () => {
  const t = $("prompt-text").value;
  if (!t) return;
  try { await navigator.clipboard.writeText(t); }
  catch (e) {
    $("prompt-text").select();
    document.execCommand("copy");
  }
  alert("Copy ကူးပြီးပြီ ✅ — Gemini မှာ paste လုပ်ပါ");
});

// ---------- Step 4: parse translation ----------
function parseTranslations(raw) {
  let t = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j.map(String);
    if (j && Array.isArray(j.translations)) return j.translations.map(String);
  } catch (e) {}
  const m = t.match(/\{[\s\S]*?"translations"[\s\S]*?\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && Array.isArray(j.translations)) return j.translations.map(String);
    } catch (e) {}
  }
  const arr = t.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      const j = JSON.parse(arr[0]);
      if (Array.isArray(j)) return j.map(String);
    } catch (e) {}
  }
  return null;
}

$("btn-parse").addEventListener("click", () => {
  const trs = parseTranslations($("trans-json").value);
  if (!trs) return setStatus("tts-status", "JSON ဖတ်မရဘူး — Gemini output အမှန် paste လုပ်ပါ", true);
  state.translations = trs;
  $("trans-list").innerHTML = trs.map((t, i) =>
    `<div class="item"><b>${i + 1}</b> ${escapeHtml(t)}</div>`).join("");
  if (state.segments.length && trs.length !== state.segments.length) {
    setStatus("tts-status", `⚠️ လိုင်း ${trs.length} vs segment ${state.segments.length} — မကိုက်ဘူး`, true);
  } else {
    setStatus("tts-status", `✅ ${trs.length} လိုင်း အဆင်သင့်`);
  }
});

// ---------- Step 4b: TTS ----------
let actx = null;
async function audioDuration(blob) {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === "suspended") await actx.resume();
  const buf = await actx.decodeAudioData(await blob.arrayBuffer());
  return buf.duration;
}

$("btn-tts").addEventListener("click", async () => {
  if (!state.translations.length) return setStatus("tts-status", "အရင် translation paste လုပ်ပါ", true);
  const voice = $("voice-select").value;
  const speed = parseFloat($("speed-slider").value);
  $("btn-tts").disabled = true;
  state.clips = []; state.clipDurs = [];
  $("clips-list").innerHTML = "";
  try {
    for (let i = 0; i < state.translations.length; i++) {
      setStatus("tts-status", `🔊 ${i + 1}/${state.translations.length} ထုတ်နေတယ်...`);
      let blob;
      if (voice === "google-my") {
        blob = await googleTTS(state.translations[i]);
      } else if (voice === "gemini-my") {
        blob = await geminiTTS(state.translations[i]);
      } else if (voice === "server-thiha" || voice === "server-nilar") {
        blob = await serverTTS(state.translations[i], voice);
      } else {
        blob = await edgeTTS(state.translations[i], voice);
      }
      // Apply speed if not 1.0
      if (Math.abs(speed - 1.0) >= 0.01) {
        blob = await changeSpeed(blob, speed);
      }
      const dur = await audioDuration(blob);
      state.clips.push(blob);
      state.clipDurs.push(dur);
      const url = URL.createObjectURL(blob);
      $("clips-list").insertAdjacentHTML("beforeend",
        `<div class="item"><b>clip${String(i + 1).padStart(2, "0")}</b> (${dur.toFixed(1)}s)<br><audio controls src="${url}"></audio></div>`);
    }
    setStatus("tts-status", `✅ ${state.clips.length} clip ရပြီ`);
  } catch (e) {
    setStatus("tts-status", "❌ " + e.message, true);
  }
  $("btn-tts").disabled = false;
});

// ---------- Speed control ----------
$("speed-slider").addEventListener("input", e => {
  $("speed-val").textContent = parseFloat(e.target.value).toFixed(1) + "x";
});

async function changeSpeed(blob, speed) {
  if (Math.abs(speed - 1.0) < 0.01) return blob;
  const ab = await blob.arrayBuffer();
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === "suspended") await actx.resume();
  const buf = await actx.decodeAudioData(ab);
  const newLen = Math.max(1, Math.floor(buf.length / speed));
  const off = new OfflineAudioContext(buf.numberOfChannels, newLen, buf.sampleRate);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = speed;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  // Encode to WAV
  const wav = encodeWAV(out);
  return new Blob([wav], { type: "audio/wav" });
}

function encodeWAV(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const sr = audioBuffer.sampleRate;
  const len = audioBuffer.length;
  const bytes = 44 + len * numCh * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, bytes - 8, true); ws(8, "WAVE"); ws(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * numCh * 2, true);
  v.setUint16(32, numCh * 2, true); v.setUint16(34, 16, true); ws(36, "data");
  v.setUint32(40, len * numCh * 2, true);
  let off = 44;
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return ab;
}

$("btn-apply-speed").addEventListener("click", async () => {
  if (!state.clips.length) return setStatus("tts-status", "အရင် TTS ထုတ် (သို့) MP3 တင်", true);
  const speed = parseFloat($("speed-slider").value);
  setStatus("tts-status", `⚡ Speed ${speed.toFixed(1)}x ပြောင်းနေတယ်...`);
  try {
    const newClips = [], newDurs = [];
    for (let i = 0; i < state.clips.length; i++) {
      const nb = await changeSpeed(state.clips[i], speed);
      const dur = await audioDuration(nb);
      newClips.push(nb); newDurs.push(dur);
    }
    state.clips = newClips; state.clipDurs = newDurs;
    refreshClipsList();
    setStatus("tts-status", `✅ Speed ${speed.toFixed(1)}x — ${newClips.length} clip`);
  } catch (e) {
    setStatus("tts-status", "❌ " + e.message, true);
  }
});

function refreshClipsList() {
  $("clips-list").innerHTML = "";
  state.clips.forEach((blob, i) => {
    const url = URL.createObjectURL(blob);
    $("clips-list").insertAdjacentHTML("beforeend",
      `<div class="item"><b>clip${String(i + 1).padStart(2, "0")}</b> (${state.clipDurs[i].toFixed(1)}s)<br><audio controls src="${url}"></audio></div>`);
  });
}

// ---------- Google TTS Worker URL ----------
$("worker-url").value = localStorage.getItem("gtts_worker") || "";
$("btn-save-worker").addEventListener("click", () => {
  const u = $("worker-url").value.trim();
  localStorage.setItem("gtts_worker", u);
  setStatus("tts-status", u ? "✅ Worker URL သိမ်းပြီးပြီ" : "Worker URL ဖျက်ပြီးပြီ");
});

// ---------- Gemini API Key ----------
$("gemini-key").value = localStorage.getItem("gemini_key") || "";
$("btn-save-gemini").addEventListener("click", () => {
  const k = $("gemini-key").value.trim();
  localStorage.setItem("gemini_key", k);
  setStatus("tts-status", k ? "✅ Gemini Key သိမ်းပြီးပြီ" : "Gemini Key ဖျက်ပြီးပြီ");
});

// ---------- Step 4c: upload pre-made clips (fallback) ----------
$("clip-input").addEventListener("change", async e => {
  const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) return;
  state.clips = []; state.clipDurs = [];
  $("clips-list").innerHTML = "";
  try {
    for (let i = 0; i < files.length; i++) {
      const dur = await audioDuration(files[i]);
      state.clips.push(files[i]);
      state.clipDurs.push(dur);
      const url = URL.createObjectURL(files[i]);
      $("clips-list").insertAdjacentHTML("beforeend",
        `<div class="item"><b>${escapeHtml(files[i].name)}</b> (${dur.toFixed(1)}s)<br><audio controls src="${url}"></audio></div>`);
    }
    setStatus("tts-status", `✅ clip ${state.clips.length} ခု တင်ပြီးပြီ`);
  } catch (err) {
    setStatus("tts-status", "❌ " + err.message, true);
  }
});

// ---------- Step 5: render ----------
$("btn-render").addEventListener("click", async () => {
  if (!state.videoFile) return alert("အရင် video ရွေးပါ");
  if (!state.segments.length) return alert("အရင် transcribe လုပ်ပါ");
  if (!state.clips.length || state.clips.length !== state.segments.length)
    return alert("TTS အရင် ပြီးအောင် လုပ်ပါ");
  const gapSpeed = parseFloat($("gap-speed").value);
  $("btn-render").disabled = true;
  $("render-progress-wrap").style.display = "block";
  $("btn-download").style.display = "none";
  $("output-preview").style.display = "none";
  try {
    const outBlob = await smartRender({
      videoFile: state.videoFile,
      segments: state.segments,
      clips: state.clips,
      clipDurs: state.clipDurs,
      gapSpeed,
      fps: 30,
      vdur: state.duration,
      onProgress: (p, msg) => {
        $("render-progress-fill").style.width = (p * 100).toFixed(0) + "%";
        setStatus("render-status", `${(p * 100).toFixed(0)}% — ${msg}`);
      },
    });
    const url = URL.createObjectURL(outBlob);
    $("output-preview").src = url;
    $("output-preview").style.display = "block";
    const dl = $("btn-download");
    dl.href = url;
    dl.style.display = "block";
    setStatus("render-status", "🎉 ပြီးပြီ! Download ဆွဲပါ");
  } catch (e) {
    setStatus("render-status", "❌ " + e.message, true);
  }
  $("btn-render").disabled = false;
});

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
