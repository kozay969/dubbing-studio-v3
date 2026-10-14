// Waveform visualization with draggable segment boundaries (phone-friendly)
"use strict";

// Downsample audio to N peak bars for drawing
export async function computePeaks(audioBlob, numBars = 320) {
  const ab = await audioBlob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = new AC();
  try {
    const buf = await actx.decodeAudioData(ab);
    const data = buf.getChannelData(0);
    const peaks = new Float32Array(numBars);
    const blockSize = Math.max(1, Math.floor(data.length / numBars));
    for (let i = 0; i < numBars; i++) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, data.length);
      let max = 0;
      // sample every 8th sample for speed
      for (let j = start; j < end; j += 8) {
        const v = data[j] < 0 ? -data[j] : data[j];
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    return { peaks, duration: buf.duration };
  } finally {
    try { await actx.close(); } catch (e) { /* ignore */ }
  }
}

// Draw waveform + segment regions + drag handles
export function drawWaveform(canvas, peaks, duration, segments, selectedIdx) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 120;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = "#1a1a24";
  ctx.fillRect(0, 0, w, h);

  const t2x = t => (t / duration) * w;

  // Segment regions (behind waveform)
  segments.forEach((s, i) => {
    const x1 = t2x(s.start), x2 = t2x(s.end);
    ctx.fillStyle = i === selectedIdx ? "rgba(253,203,110,0.22)" : "rgba(108,92,231,0.16)";
    ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
  });

  // Waveform bars
  const n = peaks.length;
  const barW = w / n;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * duration;
    let inSeg = false, isSel = false;
    for (let k = 0; k < segments.length; k++) {
      if (t >= segments[k].start && t <= segments[k].end) {
        inSeg = true;
        if (k === selectedIdx) isSel = true;
        break;
      }
    }
    const bh = Math.max(2, peaks[i] * h * 0.92);
    ctx.fillStyle = isSel ? "#fdcb6e" : inSeg ? "#a29bfe" : "#3d3d4d";
    ctx.fillRect(i * barW, (h - bh) / 2, Math.max(1, barW - 0.4), bh);
  }

  // Drag handles at segment edges
  segments.forEach((s, i) => {
    const x1 = t2x(s.start), x2 = t2x(s.end);
    ctx.fillStyle = i === selectedIdx ? "#fdcb6e" : "#6c5ce7";
    ctx.fillRect(x1 - 3, 0, 6, h);
    ctx.fillRect(x2 - 3, 0, 6, h);
    // Segment number label
    ctx.fillStyle = i === selectedIdx ? "#fdcb6e" : "#a29bfe";
    ctx.font = "bold 10px sans-serif";
    const label = String(i + 1);
    const lx = Math.min(Math.max(x1 + 4, 2), w - 14);
    ctx.fillText(label, lx, 13);
  });

  // Time ruler
  ctx.fillStyle = "#777";
  ctx.font = "9px sans-serif";
  const step = Math.max(5, Math.round(duration / 6 / 5) * 5);
  for (let t = 0; t <= duration; t += step) {
    ctx.fillText(t.toFixed(0) + "s", t2x(t) + 2, h - 4);
  }
}

// Attach touch + mouse interaction.
// getState() -> { duration, segments, selectedIdx }
// onChange(newSegments|null, selectedIdx) — newSegments null means selection only
export function attachWaveform(canvas, getState, onChange) {
  let dragging = null; // { segIdx, edge: "start"|"end" }
  const HANDLE_PX = 16;

  function xToTime(clientX) {
    const r = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    return (x / r.width) * getState().duration;
  }

  function findHandle(clientX) {
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const { duration, segments } = getState();
    for (let i = 0; i < segments.length; i++) {
      const x1 = (segments[i].start / duration) * r.width;
      const x2 = (segments[i].end / duration) * r.width;
      if (Math.abs(x - x1) <= HANDLE_PX) return { segIdx: i, edge: "start" };
      if (Math.abs(x - x2) <= HANDLE_PX) return { segIdx: i, edge: "end" };
    }
    return null;
  }

  function findSegment(clientX) {
    const t = xToTime(clientX);
    const { segments } = getState();
    for (let i = 0; i < segments.length; i++) {
      if (t >= segments[i].start && t <= segments[i].end) return i;
    }
    return -1;
  }

  function applyDrag(clientX) {
    if (!dragging) return;
    const st = getState();
    const t = Math.round(xToTime(clientX) * 10) / 10;
    const segs = st.segments.map(s => ({ start: s.start, end: s.end, text: s.text }));
    const s = segs[dragging.segIdx];
    if (dragging.edge === "start") {
      s.start = Math.max(0, Math.min(t, s.end - 0.3));
    } else {
      s.end = Math.min(st.duration, Math.max(t, s.start + 0.3));
    }
    onChange(segs, dragging.segIdx);
  }

  // --- touch ---
  canvas.addEventListener("touchstart", e => {
    e.preventDefault();
    const tc = e.touches[0];
    const h = findHandle(tc.clientX);
    if (h) { dragging = h; onChange(null, h.segIdx); }
    else onChange(null, findSegment(tc.clientX));
  }, { passive: false });

  canvas.addEventListener("touchmove", e => {
    if (!dragging) return;
    e.preventDefault();
    applyDrag(e.touches[0].clientX);
  }, { passive: false });

  const endTouch = () => { dragging = null; };
  canvas.addEventListener("touchend", endTouch);
  canvas.addEventListener("touchcancel", endTouch);

  // --- mouse (desktop / testing) ---
  canvas.addEventListener("mousedown", e => {
    const h = findHandle(e.clientX);
    if (h) { dragging = h; onChange(null, h.segIdx); }
    else onChange(null, findSegment(e.clientX));
  });
  canvas.addEventListener("mousemove", e => { if (dragging) applyDrag(e.clientX); });
  window.addEventListener("mouseup", () => { dragging = null; });
}
