// Waveform visualization with draggable segment boundaries + zoom (phone-friendly)
"use strict";

// ---------- View state (zoom / pan) ----------
let view = { zoom: 1, start: 0 }; // start = visible window start time (sec)
const MAX_ZOOM = 16;

export function getWaveView() { return { zoom: view.zoom, start: view.start }; }
export function resetWaveView() { view = { zoom: 1, start: 0 }; }

function viewDur(duration) { return duration / view.zoom; }

function clampView(duration) {
  const vd = viewDur(duration);
  if (vd >= duration || view.zoom <= 1) { view.zoom = 1; view.start = 0; return; }
  view.start = Math.max(0, Math.min(view.start, duration - vd));
}

// Zoom in/out keeping centerT (sec) fixed in view. Returns new zoom.
export function waveZoomIn(duration, centerT) {
  if (view.zoom >= MAX_ZOOM) return view.zoom;
  if (centerT == null || isNaN(centerT)) centerT = view.start + viewDur(duration) / 2;
  view.zoom = Math.min(MAX_ZOOM, view.zoom * 2);
  view.start = centerT - viewDur(duration) / 2;
  clampView(duration);
  return view.zoom;
}

export function waveZoomOut(duration, centerT) {
  if (view.zoom <= 1) return view.zoom;
  if (centerT == null || isNaN(centerT)) centerT = view.start + viewDur(duration) / 2;
  view.zoom = Math.max(1, view.zoom / 2);
  view.start = centerT - viewDur(duration) / 2;
  clampView(duration);
  return view.zoom;
}

// Zoom so the segment fills ~50% of the view, centered on it
export function waveZoomToSegment(duration, seg) {
  if (!seg || duration <= 0) return view.zoom;
  const segLen = Math.max(1, seg.end - seg.start);
  view.zoom = Math.max(1, Math.min(MAX_ZOOM, duration / (segLen * 2)));
  view.start = (seg.start + seg.end) / 2 - viewDur(duration) / 2;
  clampView(duration);
  return view.zoom;
}

// Pan by frac of the visible window (+1 = one full window right)
export function wavePan(duration, frac) {
  if (view.zoom <= 1) return;
  view.start += frac * viewDur(duration);
  clampView(duration);
}

// Jump view so that time t is centered
export function waveCenterOn(duration, t) {
  if (view.zoom <= 1) return;
  view.start = t - viewDur(duration) / 2;
  clampView(duration);
}

// ---------- Peaks ----------

// Downsample audio to N peak bars for drawing
export async function computePeaks(audioBlob, numBars = 1000) {
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

const OV_H = 14; // overview strip height (css px)

// Draw waveform + segment regions + drag handles (respects zoom view)
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

  clampView(duration);
  const vd = viewDur(duration); // visible window length (sec)
  const vs = view.start;        // visible window start (sec)
  const t2x = t => ((t - vs) / vd) * w;
  const mainY = OV_H, mainH = h - OV_H;

  // ---- Overview strip (full duration mini-map) ----
  ctx.fillStyle = "#23232f";
  ctx.fillRect(0, 0, w, OV_H);
  const n = peaks.length;
  const step = Math.max(1, Math.floor(n / 240));
  for (let i = 0; i < n; i += step) {
    const bh = Math.max(1, peaks[i] * (OV_H - 3));
    ctx.fillStyle = "#55556a";
    ctx.fillRect((i / n) * w, (OV_H - bh) / 2, Math.max(1, (w / n) * step - 0.4), bh);
  }
  // viewport rectangle
  const vx = (vs / duration) * w, vw = (vd / duration) * w;
  ctx.strokeStyle = "#fdcb6e";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(vx + 1, 1.5, Math.max(5, vw - 2), OV_H - 3);

  // ---- Segment regions (behind waveform) ----
  segments.forEach((s, i) => {
    const x1 = t2x(s.start), x2 = t2x(s.end);
    if (x2 < 0 || x1 > w) return; // outside view
    ctx.fillStyle = i === selectedIdx ? "rgba(253,203,110,0.22)" : "rgba(108,92,231,0.16)";
    ctx.fillRect(x1, mainY, Math.max(2, x2 - x1), mainH);
  });

  // ---- Waveform bars (only bars inside view) ----
  const barW = Math.max(1, w / (n * (vd / duration)));
  const i0 = Math.max(0, Math.floor((vs / duration) * n) - 1);
  const i1 = Math.min(n - 1, Math.ceil(((vs + vd) / duration) * n) + 1);
  for (let i = i0; i <= i1; i++) {
    const t = ((i + 0.5) / n) * duration;
    let inSeg = false, isSel = false;
    for (let k = 0; k < segments.length; k++) {
      if (t >= segments[k].start && t <= segments[k].end) {
        inSeg = true;
        if (k === selectedIdx) isSel = true;
        break;
      }
    }
    const bh = Math.max(2, peaks[i] * mainH * 0.92);
    ctx.fillStyle = isSel ? "#fdcb6e" : inSeg ? "#a29bfe" : "#3d3d4d";
    const bx = t2x((i / n) * duration);
    ctx.fillRect(bx, mainY + (mainH - bh) / 2, Math.max(1, barW - 0.4), bh);
  }

  // ---- Drag handles at segment edges ----
  segments.forEach((s, i) => {
    const x1 = t2x(s.start), x2 = t2x(s.end);
    if (x2 < -10 || x1 > w + 10) return;
    ctx.fillStyle = i === selectedIdx ? "#fdcb6e" : "#6c5ce7";
    ctx.fillRect(x1 - 3, mainY, 6, mainH);
    ctx.fillRect(x2 - 3, mainY, 6, mainH);
    // Segment number label
    ctx.fillStyle = i === selectedIdx ? "#fdcb6e" : "#a29bfe";
    ctx.font = "bold 10px sans-serif";
    const label = String(i + 1);
    const lx = Math.min(Math.max(x1 + 4, 2), w - 14);
    if (x2 > 0 && x1 < w) ctx.fillText(label, lx, mainY + 13);
  });

  // ---- Time ruler (adapts to zoom) ----
  ctx.fillStyle = "#777";
  ctx.font = "9px sans-serif";
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  let rstep = steps[steps.length - 1];
  for (const c of steps) { if (vd / c <= 8) { rstep = c; break; } }
  const tStart = Math.floor(vs / rstep) * rstep;
  for (let t = tStart; t <= vs + vd + 0.001; t += rstep) {
    if (t < 0) continue;
    const x = t2x(t);
    if (x < -20 || x > w + 20) continue;
    const lbl = rstep < 1 ? t.toFixed(1) + "s" : t.toFixed(0) + "s";
    ctx.fillText(lbl, x + 2, h - 4);
  }

  // ---- Zoom badge ----
  if (view.zoom > 1) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    const bw = 44, bx0 = w - bw - 6;
    ctx.fillRect(bx0, mainY + 4, bw, 16);
    ctx.fillStyle = "#fdcb6e";
    ctx.font = "bold 10px sans-serif";
    const zl = view.zoom >= 10 ? view.zoom.toFixed(0) : (Math.round(view.zoom * 10) / 10).toString();
    ctx.fillText("🔍" + zl + "x", bx0 + 5, mainY + 16);
  }
}

// Attach touch + mouse interaction.
// getState() -> { duration, segments, selectedIdx }
// onChange(newSegments|null, selectedIdx) — newSegments null means selection only
// onEmptyTap(time) — tapped on area with no segment (for creating new segment)
// onViewChange() — view (zoom/pan) changed, redraw needed
export function attachWaveform(canvas, getState, onChange, onEmptyTap, onViewChange) {
  let dragging = null; // { segIdx, edge: "start"|"end" }
  let pinch = null;    // { d0, zoom0, c0 }
  const HANDLE_PX = 16;

  function viewParams() {
    const { duration } = getState();
    clampView(duration);
    return { duration, vd: viewDur(duration), vs: view.start };
  }

  function xToTime(clientX) {
    const r = canvas.getBoundingClientRect();
    const { vd, vs } = viewParams();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    return vs + (x / r.width) * vd;
  }

  function inOverview(clientY) {
    const r = canvas.getBoundingClientRect();
    return (clientY - r.top) < OV_H + 4;
  }

  function overviewTap(clientX) {
    const r = canvas.getBoundingClientRect();
    const { duration } = getState();
    const t = Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
    waveCenterOn(duration, t);
    if (onViewChange) onViewChange();
  }

  function findHandle(clientX) {
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const { vd, vs, duration } = viewParams();
    void duration;
    for (let i = 0; i < getState().segments.length; i++) {
      const s = getState().segments[i];
      const x1 = ((s.start - vs) / vd) * r.width;
      const x2 = ((s.end - vs) / vd) * r.width;
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

  function touchDist(e) {
    const a = e.touches[0], b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }
  function touchCenter(e) {
    const a = e.touches[0], b = e.touches[1];
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  // --- touch ---
  canvas.addEventListener("touchstart", e => {
    e.preventDefault();
    if (e.touches.length === 2) {
      // start pinch-zoom, cancel any drag
      dragging = null;
      const { duration } = getState();
      const c = touchCenter(e);
      pinch = { d0: Math.max(20, touchDist(e)), zoom0: view.zoom, c0: xToTime(c.x), duration };
      return;
    }
    const tc = e.touches[0];
    if (inOverview(tc.clientY)) { overviewTap(tc.clientX); return; }
    const h = findHandle(tc.clientX);
    if (h) { dragging = h; onChange(null, h.segIdx); }
    else {
      const si = findSegment(tc.clientX);
      if (si >= 0) onChange(null, si, xToTime(tc.clientX));
      else if (onEmptyTap) onEmptyTap(xToTime(tc.clientX));
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", e => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const d = Math.max(20, touchDist(e));
      const nz = Math.max(1, Math.min(MAX_ZOOM, pinch.zoom0 * d / pinch.d0));
      view.zoom = nz;
      view.start = pinch.c0 - viewDur(pinch.duration) / 2;
      clampView(pinch.duration);
      if (onViewChange) onViewChange();
      return;
    }
    if (!dragging) return;
    e.preventDefault();
    applyDrag(e.touches[0].clientX);
  }, { passive: false });

  const endTouch = () => { dragging = null; pinch = null; };
  canvas.addEventListener("touchend", endTouch);
  canvas.addEventListener("touchcancel", endTouch);

  // --- mouse (desktop / testing) ---
  // wheel = zoom around cursor (desktop convenience)
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if ((e.clientY - r.top) < OV_H + 4) return;
    const { duration } = getState();
    const ct = xToTime(e.clientX);
    if (e.deltaY < 0) waveZoomIn(duration, ct); else waveZoomOut(duration, ct);
    if (onViewChange) onViewChange();
  }, { passive: false });

  canvas.addEventListener("mousedown", e => {
    if (inOverview(e.clientY)) { overviewTap(e.clientX); return; }
    const h = findHandle(e.clientX);
    if (h) { dragging = h; onChange(null, h.segIdx); }
    else {
      const si = findSegment(e.clientX);
      if (si >= 0) onChange(null, si, xToTime(e.clientX));
      else if (onEmptyTap) onEmptyTap(xToTime(e.clientX));
    }
  });
  canvas.addEventListener("mousemove", e => { if (dragging) applyDrag(e.clientX); });
  window.addEventListener("mouseup", () => { dragging = null; });
}
