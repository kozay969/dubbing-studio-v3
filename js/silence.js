// Silence-sync: detect real silences in the extracted audio (Web Audio),
// then snap segment boundaries to silence midpoints — the studio99 trick:
// cuts land mid-pause instead of exactly on word edges, so the smart
// render's 1x pieces and sped-up gaps join where nobody is speaking.

// Pure detector — works on mono Float32Array samples. Testable outside the browser.
// dBFS per window vs threshold (ffmpeg silencedetect style, noise=-38dB default).
export function detectSilencesFromSamples(samples, sampleRate, opts = {}) {
  const thresholdDb = opts.thresholdDb ?? -38;
  const minSilence = opts.minSilence ?? 0.25;   // seconds
  const mergeGap = opts.mergeGap ?? 0.12;       // bridge short sound blips inside a pause
  const winSec = 0.02;                          // 20 ms windows
  const win = Math.max(1, Math.round(sampleRate * winSec));
  const nWin = Math.floor(samples.length / win);
  if (nWin < 2) return [];

  const silent = new Uint8Array(nWin);
  for (let w = 0; w < nWin; w++) {
    let sum = 0;
    const base = w * win;
    for (let i = 0; i < win; i++) { const v = samples[base + i]; sum += v * v; }
    const rms = Math.sqrt(sum / win);
    const db = 20 * Math.log10(rms + 1e-9);
    silent[w] = db < thresholdDb ? 1 : 0;
  }

  // collect runs of silent windows
  const runs = [];
  let start = -1;
  for (let w = 0; w <= nWin; w++) {
    const isSil = w < nWin && silent[w] === 1;
    if (isSil && start < 0) start = w;
    if (!isSil && start >= 0) { runs.push([start, w]); start = -1; }
  }
  // merge runs separated by tiny sound blips
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && (r[0] - last[1]) * winSec <= mergeGap) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  const out = [];
  for (const [a, b] of merged) {
    const s = a * winSec, e = b * winSec;
    if (e - s >= minSilence) {
      out.push({
        start: Math.round(s * 100) / 100,
        end: Math.round(e * 100) / 100,
        mid: Math.round(((s + e) / 2) * 100) / 100,
      });
    }
  }
  return out;
}

// Decode the already-extracted 16kHz mono WAV blob and detect silences.
export async function analyzeSilence(audioBlob, opts = {}) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = new AC();
  try {
    const buf = await actx.decodeAudioData(await audioBlob.arrayBuffer());
    // mix down to mono if needed
    let data;
    if (buf.numberOfChannels === 1) {
      data = buf.getChannelData(0);
    } else {
      data = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < buf.length; i++) data[i] += ch[i] / buf.numberOfChannels;
      }
    }
    return detectSilencesFromSamples(data, buf.sampleRate, opts);
  } finally {
    try { await actx.close(); } catch (e) {}
  }
}

// Snap segment boundaries to silence midpoints.
// segments: [{start, end, text}] sorted, non-overlapping (from segmentsOrig).
// Only boundaries sitting inside/near a real detected pause are moved, and
// both sides of the boundary move to the SAME midpoint — order never breaks.
export function snapSegmentsToSilence(segments, silences, vdur = 0) {
  const segs = segments.map(s => ({ ...s }));
  if (!silences || !silences.length || segs.length < 1) {
    return { segments: segs, snapped: 0 };
  }
  let snapped = 0;
  const findCovering = (t, slack) =>
    silences.find(iv => iv.start <= t + slack && iv.end >= t - slack && (iv.end - iv.start) >= 0.3 - 1e-6);

  // internal boundaries: seg[i].end / seg[i+1].start share one pause
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i], b = segs[i + 1];
    const iv = findCovering(a.end, 0.35) || findCovering(b.start, 0.35);
    if (!iv) continue;
    const mid = iv.mid;
    // keep the midpoint safely inside both segments and near the old boundary
    if (mid <= a.start + 0.3 || mid >= b.end - 0.3) continue;
    if (mid < a.end - 0.15 || mid > b.start + 0.15) continue;
    if (Math.abs(mid - a.end) < 0.03 && Math.abs(mid - b.start) < 0.03) continue;
    a.end = mid;
    b.start = mid;
    snapped++;
  }
  // leading edge: pull first segment start back to a preceding pause midpoint
  const first = segs[0];
  const ivFirst = silences.find(iv => iv.end >= first.start - 0.4 && iv.end <= first.start + 0.15 && iv.mid < first.start && first.start - iv.mid <= 0.6);
  if (ivFirst && ivFirst.mid >= 0) { first.start = Math.max(0, ivFirst.mid); snapped++; }
  // trailing edge: extend last segment end to a following pause midpoint
  const last = segs[segs.length - 1];
  const ivLast = silences.find(iv => iv.start <= last.end + 0.4 && iv.start >= last.end - 0.15 && iv.mid > last.end && iv.mid - last.end <= 0.6);
  if (ivLast) { last.end = vdur > 0 ? Math.min(vdur, ivLast.mid) : ivLast.mid; snapped++; }

  return { segments: segs, snapped };
}
