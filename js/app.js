// Dubbing Studio v3 — on-device pipeline orchestration
import { getFFmpeg } from "./ffmpeg.js";
import { extractAudio, transcribeAssemblyAI, segmentsFromWords } from "./transcribe.js";
import { edgeTTS, googleTTS, geminiTTS, serverTTS } from "./tts.js";
import { smartRender } from "./render.js";
import { computePeaks, drawWaveform, attachWaveform } from "./waveform.js";

const $ = id => document.getElementById(id);

const state = {
  videoFile: null,
  duration: 0,
  segments: [],
  translations: [],
  clips: [],
  clipDurs: [],
  audioBlob: null,   // extracted audio (for waveform)
  wavePeaks: null,   // Float32Array
  waveDur: 0,
  waveSel: -1,
  waveSplitTime: null, // last tap position inside selected segment
  segmentsOrig: [],  // pristine copy for reset
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
if ($("trans-lang")) $("trans-lang").value = localStorage.getItem("aai_lang") || "zh";

$("btn-transcribe").addEventListener("click", async () => {
  const key = $("aai-key").value.trim();
  if (!key) return setStatus("transcribe-status", "API Key ထည့်ပါ", true);
  if (!state.videoFile) return setStatus("transcribe-status", "အရင် video ရွေးပါ", true);
  localStorage.setItem("aai_key", key);
  const lang = $("trans-lang") ? $("trans-lang").value : "auto";
  if ($("trans-lang")) localStorage.setItem("aai_lang", lang);
  $("btn-transcribe").disabled = true;
  try {
    setStatus("transcribe-status", "🎵 Audio ထုတ်နေတယ် (ဖုန်းပေါ်မှာ)...");
    const audioBlob = await extractAudio(state.videoFile);
    state.audioBlob = audioBlob;
    const tj = await transcribeAssemblyAI(audioBlob, key, m => setStatus("transcribe-status", m), lang);
    let segs = [];
    if (tj.utterances && tj.utterances.length) {
      segs = tj.utterances.map(u => ({ start: u.start / 1000, end: u.end / 1000, text: u.text }));
    } else if (tj.words && tj.words.length) {
      segs = segmentsFromWords(tj.words);
    }
    if (!segs.length) throw new Error("Segment မရဘူး — အသံ မပါလို့ဖြစ်နိုင်တယ်");
    state.segments = segs;
    state.segmentsOrig = segs.map(s => ({ ...s }));
    state.waveSel = -1;
    setStatus("transcribe-status", `✅ ${segs.length} segment ရပြီ`);
    renderSegments();
    buildPrompt();
    initWaveform();
  } catch (e) {
    setStatus("transcribe-status", "❌ " + e.message, true);
  }
  $("btn-transcribe").disabled = false;
});

function renderSegments() {
  $("segments-list").innerHTML = state.segments.map((s, i) =>
    `<div class="item" data-seg="${i}"><b>${i + 1}</b> [${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${escapeHtml(s.text)}</div>`
  ).join("");
}

// Tap segment in list to edit its text (for manually added segments)
$("segments-list").addEventListener("click", e => {
  const el = e.target.closest("[data-seg]");
  if (!el) return;
  const i = parseInt(el.dataset.seg, 10);
  const s = state.segments[i];
  if (!s) return;
  const v = prompt(`Segment ${i + 1} စာသား ပြင်ပါ:`, s.text);
  if (v === null) return;
  s.text = v.trim();
  renderSegments();
  buildPrompt();
});

// Auto-detect talking region around tapTime using waveform peaks
function detectTalkingRegion(tapTime) {
  const peaks = state.wavePeaks;
  const dur = state.waveDur;
  if (!peaks || !dur) return { start: Math.max(0, tapTime - 1), end: Math.min(dur, tapTime + 1) };
  const n = peaks.length;
  const TH = 0.10; // energy threshold for "talking"
  const t2i = t => Math.max(0, Math.min(n - 1, Math.floor((t / dur) * n)));
  let li = t2i(tapTime), ri = t2i(tapTime);
  // expand left
  while (li > 0 && peaks[li - 1] > TH) li--;
  // expand right
  while (ri < n - 1 && peaks[ri + 1] > TH) ri++;
  // include the tap bar itself even if quiet (user tapped near sound)
  const pad = Math.ceil((0.25 / dur) * n);
  li = Math.max(0, li - pad);
  ri = Math.min(n - 1, ri + pad);
  const start = Math.round(((li / n) * dur) * 10) / 10;
  const end = Math.round(((ri / n) * dur) * 10) / 10;
  return { start: Math.max(0, start), end: Math.min(dur, Math.max(end, start + 0.5)) };
}

// Create a new segment at tapTime (for talking parts AssemblyAI missed)
function createSegmentAt(tapTime) {
  const { start, end } = detectTalkingRegion(tapTime);
  // don't create if it heavily overlaps an existing segment
  for (const s of state.segments) {
    const overlap = Math.min(end, s.end) - Math.max(start, s.start);
    if (overlap > (end - start) * 0.5) {
      setStatus("transcribe-status", "⚠️ ဒီနေရာမှာ segment ရှိနေပြီးသား", true);
      return;
    }
  }
  const text = prompt("Segment အသစ် — စာသား ရိုက်ထည့်ပါ (Chinese/မြန်မာ):", "");
  if (text === null) return; // cancelled
  const seg = { start, end, text: text.trim() || "(စာသား မထည့်ရသေး — ထိပြီး ပြင်ပါ)" };
  state.segments.push(seg);
  state.segments.sort((a, b) => a.start - b.start);
  state.waveSel = state.segments.indexOf(seg);
  renderSegments();
  buildPrompt();
  updateWaveSelInfo();
  redrawWaveform();
  setStatus("transcribe-status", `✅ Segment အသစ် [${start.toFixed(1)}–${end.toFixed(1)}s] ထည့်ပြီးပြီ`);
}

// Split selected segment into two at tap position (or middle)
function splitSelectedSegment() {
  const i = state.waveSel;
  if (i < 0 || !state.segments[i]) return;
  const s = state.segments[i];
  let cut = state.waveSplitTime;
  if (!(cut > s.start + 0.3 && cut < s.end - 0.3)) {
    cut = Math.round(((s.start + s.end) / 2) * 10) / 10;
  }
  cut = Math.round(cut * 10) / 10;

  // split text proportionally by time; prefer splitting at a space
  const text = s.text || "";
  const ratio = (cut - s.start) / Math.max(0.01, s.end - s.start);
  let cutChar = Math.floor(text.length * ratio);
  // find nearest space within 12 chars for cleaner split
  let best = cutChar;
  for (let d = 0; d <= 12; d++) {
    if (text[cutChar + d] === " " || text[cutChar + d] === "၊" || text[cutChar + d] === "။") { best = cutChar + d + 1; break; }
    if (text[cutChar - d] === " " || text[cutChar - d] === "၊" || text[cutChar - d] === "။") { best = cutChar - d + 1; break; }
  }
  const textA = text.slice(0, best).trim();
  const textB = text.slice(best).trim();

  const segA = { start: s.start, end: cut, text: textA || "(စာသား — ထိပြီး ပြင်ပါ)" };
  const segB = { start: cut, end: s.end, text: textB || "(စာသား — ထိပြီး ပြင်ပါ)" };
  state.segments.splice(i, 1, segA, segB);
  state.waveSel = i;
  state.waveSplitTime = null;
  renderSegments();
  buildPrompt();
  updateWaveSelInfo();
  updateSplitBtn();
  redrawWaveform();
  setStatus("transcribe-status", `✂️ Segment ${i + 1} ကို ၂ ပိုင်း ခွဲပြီးပြီ [${segA.start.toFixed(1)}–${segA.end.toFixed(1)}s] + [${segB.start.toFixed(1)}–${segB.end.toFixed(1)}s]`);
}

function updateSplitBtn() {
  const b = $("btn-wave-split");
  if (!b) return;
  b.style.display = state.waveSel >= 0 ? "" : "none";
}

$("btn-wave-split").addEventListener("click", splitSelectedSegment);

// ---------- Waveform ----------
let waveAttached = false;

async function initWaveform() {
  const wrap = $("waveform-wrap");
  if (!state.audioBlob) { wrap.style.display = "none"; return; }
  try {
    setStatus("transcribe-status", "🌊 Waveform ဆွဲနေတယ်...");
    const { peaks, duration } = await computePeaks(state.audioBlob);
    state.wavePeaks = peaks;
    state.waveDur = duration;
    wrap.style.display = "block";
    redrawWaveform();
    if (!waveAttached) {
      waveAttached = true;
      attachWaveform($("waveform"),
        () => ({ duration: state.waveDur, segments: state.segments, selectedIdx: state.waveSel }),
        (newSegs, selIdx, tapTime) => {
          if (newSegs) {
            state.segments = newSegs;
            renderSegments();
            buildPrompt(); // keep prompt in sync with adjusted timing
          }
          state.waveSel = selIdx;
          if (tapTime !== undefined && tapTime !== null) state.waveSplitTime = tapTime;
          updateWaveSelInfo();
          updateSplitBtn();
          redrawWaveform();
        },
        (tapTime) => createSegmentAt(tapTime));
    }
    setStatus("transcribe-status", `✅ ${state.segments.length} segment ရပြီ — waveform နဲ့ timing ညှိလို့ရပြီ`);
  } catch (e) {
    wrap.style.display = "none";
    // waveform is optional — don't break the flow
  }
}

function redrawWaveform() {
  if (!state.wavePeaks) return;
  drawWaveform($("waveform"), state.wavePeaks, state.waveDur, state.segments, state.waveSel);
}

function updateWaveSelInfo() {
  const el = $("wave-sel-info");
  if (state.waveSel >= 0 && state.segments[state.waveSel]) {
    const s = state.segments[state.waveSel];
    el.textContent = `#${state.waveSel + 1}: ${s.start.toFixed(1)}s – ${s.end.toFixed(1)}s`;
  } else {
    el.textContent = "Segment ကို ထိ/ဆွဲပြီး ညှိပါ";
  }
}

$("btn-wave-reset").addEventListener("click", () => {
  if (!state.segmentsOrig.length) return;
  state.segments = state.segmentsOrig.map(s => ({ ...s }));
  state.waveSel = -1;
  renderSegments();
  buildPrompt();
  updateWaveSelInfo();
  redrawWaveform();
  setStatus("transcribe-status", "↩️ Timing မူလအတိုင်း ပြန်ထားပြီးပြီ");
});

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
  const blurSubs = $("blur-subs") ? $("blur-subs").checked : false;
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
      blurSubs,
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
