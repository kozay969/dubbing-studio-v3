// Smart render on-device via ffmpeg.wasm
// Port of phone smart_merge.py: 🗣️ talk=1x, 🔇 gaps sped up, 🎙️ narration placed on retimed timeline
import { getFFmpeg } from "./ffmpeg.js";
import { fetchFile } from "@ffmpeg/util";

const MAX_RATE = 1.5;

export function buildOps(segments, vdur) {
  const ops = [];
  let prev = 0;
  segments.forEach((seg, i) => {
    const s = seg.start, e = seg.end;
    if (s > prev + 0.001) ops.push({ kind: "gap", start: prev, dur: s - prev });
    ops.push({ kind: "seg", idx: i, start: s, dur: e - s });
    prev = e;
  });
  if (prev < vdur - 0.001) ops.push({ kind: "gap", start: prev, dur: vdur - prev });
  return ops;
}

async function safeDelete(ffmpeg, name) {
  try { await ffmpeg.deleteFile(name); } catch (e) {}
}

export async function smartRender({ videoFile, segments, clips, clipDurs, gapSpeed, fps = 30, vdur, onProgress, blurRegion = null, srtContent = null }) {
  const ffmpeg = await getFFmpeg();
  const prog = (p, msg) => onProgress && onProgress(Math.min(1, Math.max(0, p)), msg || "");

  // fresh workspace — also clear stale piece files from earlier runs,
  // they otherwise pile up in the wasm FS and eat phone memory
  for (const n of ["input.mp4", "pieces.txt", "vret.mp4", "vblur.mp4", "vsub.mp4", "subs.srt", "dubbed.mp4"]) await safeDelete(ffmpeg, n);
  try {
    const entries = await ffmpeg.listDir("/");
    for (const e of entries) {
      if (e && !e.isDir && /^p\d{4}\.mp4$/.test(e.name)) await safeDelete(ffmpeg, e.name);
    }
  } catch (e) {}
  await ffmpeg.writeFile("input.mp4", await fetchFile(videoFile));
  for (let i = 0; i < clips.length; i++) {
    await safeDelete(ffmpeg, `clip${i}.mp3`);
    await ffmpeg.writeFile(`clip${i}.mp3`, await fetchFile(clips[i]));
  }

  const ops = buildOps(segments, vdur);

  // Planned duration of every op on the retimed timeline (frame-exact).
  // Narration placement below is computed from these, so both video build
  // paths (single-pass and pieces) must produce exactly this plan.
  const pieceDurs = ops.map(op => {
    const target = op.dur / (op.kind === "gap" ? gapSpeed : 1.0);
    return Math.max(1, Math.ceil(target * fps - 1e-6)) / fps;
  });

  // Stage-weighted progress: video build 0→0.85, blur/subs ~0.85-0.90,
  // mux 0.90→1. The ffmpeg progress fraction applies within the stage.
  let stageBase = 0, stageSpan = 0.85, stageLabel = "Video တည်ဆောက်...";
  let curProg = 0;
  ffmpeg.on("progress", ({ progress }) => {
    curProg = progress || 0;
    prog(stageBase + Math.min(1, Math.max(0, curProg)) * stageSpan, stageLabel);
  });
  const setStage = (base, span, label) => { stageBase = base; stageSpan = span; stageLabel = label; curProg = 0; };

  // ---- Video build, preferred path: SINGLE PASS ----
  // One filtergraph: split the input per op, trim/speed/fps each branch,
  // concat filter joins them. NO piece files ever accumulate in the wasm
  // FS — the old cut-every-piece flow OOM-killed the engine at piece
  // ~98/102 on a phone (source + all pieces + output in wasm memory).
  // Returns the exec exit code; a REJECTION (worker death) propagates.
  async function buildVideoSinglePass() {
    const N = ops.length;
    const parts = [`[0:v]split=${N}${ops.map((_, k) => `[s${k}]`).join("")}`];
    const vlabels = [];
    ops.forEach((op, k) => {
      const speed = op.kind === "gap" ? gapSpeed : 1.0;
      const F = Math.round(pieceDurs[k] * fps);
      let chain = `[s${k}]trim=start=${op.start.toFixed(3)}:end=${(op.start + op.dur).toFixed(3)},setpts=PTS-STARTPTS`;
      if (speed > 1.001) chain += `,setpts=PTS/${speed.toFixed(4)}`;
      chain += `,fps=${fps},tpad=stop_mode=clone:stop=90,trim=end_frame=${F},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v${k}]`;
      parts.push(chain);
      vlabels.push(`[v${k}]`);
    });
    parts.push(`${vlabels.join("")}concat=n=${N}:v=1:a=0[vc]`);
    setStage(0, 0.85, "Video တည်ဆောက်... (single-pass)");
    return await ffmpeg.exec([
      "-y", "-v", "error",
      "-i", "input.mp4",
      "-filter_complex", parts.join(";"),
      "-map", "[vc]",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-an", "vret.mp4",
    ]);
  }

  // ---- Video build, fallback path: cut pieces + concat (previous flow) ----
  async function buildVideoViaPieces() {
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      const speed = op.kind === "gap" ? gapSpeed : 1.0;
      const target = op.dur / speed;
      const F = Math.max(1, Math.ceil(target * fps - 1e-6));
      const vf = [
        `trim=start=${op.start.toFixed(3)}:end=${(op.start + op.dur).toFixed(3)}`,
        "setpts=PTS-STARTPTS",
        "tpad=stop_mode=clone:stop=2",
      ];
      if (speed > 1.001) vf.push(`setpts=PTS/${speed.toFixed(4)}`, `fps=${fps}`);
      else vf.push(`fps=${fps}`);
      const pname = `p${String(k).padStart(4, "0")}.mp4`;
      await safeDelete(ffmpeg, pname);
      setStage((k / ops.length) * 0.85, 0.85 / ops.length, `Piece ${k + 1}/${ops.length}`);
      const rc = await ffmpeg.exec([
        "-y", "-v", "error",
        "-ss", op.start.toFixed(3), "-t", (op.dur + 15).toFixed(3), "-copyts",
        "-i", "input.mp4",
        "-filter:v", vf.join(","),
        "-frames:v", String(F),
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-an", pname,
      ]);
      if (rc !== 0) throw new Error(`Piece ${k + 1} ဖြတ်မရဘူး`);
      prog(((k + 1) / ops.length) * 0.85, `Piece ${k + 1}/${ops.length} ✅`);
    }
    const list = ops.map((_, k) => `file 'p${String(k).padStart(4, "0")}.mp4'`).join("\n");
    await ffmpeg.writeFile("pieces.txt", list);
    await safeDelete(ffmpeg, "vret.mp4");
    setStage(0.83, 0.02, "ဆက်နေတယ်...");
    const rc = await ffmpeg.exec(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "pieces.txt", "-c", "copy", "vret.mp4"]);
    if (rc !== 0) throw new Error("Concat မအောင်မြင်ပါ");
  }

  await safeDelete(ffmpeg, "vret.mp4");
  const singleRc = await buildVideoSinglePass();
  if (singleRc !== 0) {
    // graph-level failure (engine still alive) — fall back to pieces
    await safeDelete(ffmpeg, "vret.mp4");
    await buildVideoViaPieces();
  }
  prog(0.85, "Video ✅");

  // Free memory NOW: the input and any piece files are no longer needed
  // (blur/subs/mux all work from vret.mp4 + the TTS clips).
  await safeDelete(ffmpeg, "input.mp4");
  for (let k = 0; k < ops.length; k++) {
    await safeDelete(ffmpeg, `p${String(k).padStart(4, "0")}.mp4`);
  }

  // 2b. blur subtitles (optional)
  let vInput = "vret.mp4";
  const needBlur = blurRegion && blurRegion.h > 0.01;
  const needSubs = srtContent && srtContent.trim().length > 10;

  if (needBlur) {
    const by = Math.max(0, Math.min(0.95, blurRegion.y)).toFixed(4);
    const bh = Math.max(0.02, Math.min(0.5, blurRegion.h)).toFixed(4);
    setStage(0.85, 0.03, "စာတန်း blur လုပ်နေတယ်...");
    await safeDelete(ffmpeg, "vblur.mp4");
    const blurVf = `split[a][b];[a]crop=iw:ih*${bh}:0:ih*${by},boxblur=20[bg];[b][bg]overlay=0:ih*${by}`;
    const rcb = await ffmpeg.exec([
      "-y", "-v", "error",
      "-i", vInput,
      "-filter:v", blurVf,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-an", "vblur.mp4",
    ]);
    if (rcb !== 0) throw new Error("Blur မအောင်မြင်ပါ");
    vInput = "vblur.mp4";
    prog(0.88, "Blur ✅");
  }

  // 2c. burn Burmese subtitles (optional) — via drawtext (per-line, libass-free)
  if (needSubs) {
    setStage(0.88, 0.02, "မြန်မာစာတန်း ထည့်နေတယ်...");
    // fetch Burmese font
    let fontOk = false;
    try {
      const fr = await fetch("https://fonts.gstatic.com/s/notosansmyanmar/v27/AlZU_y1ZtY3ymOryg38hOCSdOnFq0FP9_gnYM_ME0QeqLzz8-kqmtY3KLEbEGTOZltU.ttf");
      if (fr.ok) {
        const fb = new Uint8Array(await fr.arrayBuffer());
        try { await ffmpeg.createDir("/fonts"); } catch (e) {}
        await ffmpeg.writeFile("/fonts/NotoSansMyanmar.ttf", fb);
        fontOk = true;
      }
    } catch (e) {}
    if (!fontOk) throw new Error("Font ဒေါင်းလုဒ် မရဘူး — internet စစ်ပါ");

    // build drawtext chain: one per subtitle line
    const esc = s => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/\n/g, " ");
    const draws = [];
    let n = 0;
    // parse SRT back into entries (srtContent built by buildSRT)
    const blocks = srtContent.trim().split(/\n\s*\n/);
    for (const b of blocks) {
      const lines = b.trim().split("\n");
      if (lines.length < 3) continue;
      const tm = lines[1].match(/(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)/);
      if (!tm) continue;
      const t1 = (+tm[1]) * 3600 + (+tm[2]) * 60 + (+tm[3]) + (+tm[4]) / 1000;
      const t2 = (+tm[5]) * 3600 + (+tm[6]) * 60 + (+tm[7]) + (+tm[8]) / 1000;
      const text = esc(lines.slice(2).join(" ").trim());
      if (!text) continue;
      n++;
      draws.push(
        `drawtext=fontfile=/fonts/NotoSansMyanmar.ttf:text='${text}':fontsize=44:fontcolor=white:borderw=3:bordercolor=black@0x99:x=(w-text_w)/2:y=h-120:enable='between(t,${t1.toFixed(2)},${t2.toFixed(2)})'`
      );
    }
    if (!draws.length) throw new Error("စာတန်းထိုး စာသား မတွေ့ဘူး");
    await safeDelete(ffmpeg, "vsub.mp4");
    const rcs = await ffmpeg.exec([
      "-y", "-v", "error",
      "-i", vInput,
      "-filter:v", draws.join(","),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-an", "vsub.mp4",
    ]);
    if (rcs !== 0) throw new Error("စာတန်းထိုး မအောင်မြင်ပါ (drawtext)");
    vInput = "vsub.mp4";
    prog(0.9, "စာတန်း ✅");
  }

  // 3. narration on retimed timeline
  const clipInfos = [];
  let t = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k], pd = pieceDurs[k];
    if (op.kind !== "gap") {
      const slot = Math.max(op.dur, 0.01), cd = clipDurs[op.idx];
      const rate = cd > slot ? Math.min(cd / slot, MAX_RATE) : 1.0;
      clipInfos.push({ idx: op.idx, start: t, rate });
    }
    t += pd;
  }
  if (!clipInfos.length) throw new Error("Narration မရှိဘူး");

  const parts = [], labels = [];
  clipInfos.forEach((c, i) => {
    const ms = Math.round(c.start * 1000);
    let chain = `[${i + 1}:a]`;
    if (c.rate > 1.005) chain += `atempo=${c.rate.toFixed(4)},`;
    chain += `adelay=${ms}:all=1[c${i}]`;
    parts.push(chain);
    labels.push(`[c${i}]`);
  });
  parts.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[narr]`);

  const args = ["-y", "-v", "error", "-i", vInput];
  clipInfos.forEach(c => args.push("-i", `clip${c.idx}.mp3`));
  args.push(
    "-filter_complex", parts.join(";"),
    "-map", "0:v:0", "-map", "[narr]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-shortest", "dubbed.mp4"
  );
  await safeDelete(ffmpeg, "dubbed.mp4");
  setStage(0.9, 0.1, "အသံ ပေါင်းနေတယ်...");
  const rcm = await ffmpeg.exec(args);
  if (rcm !== 0) throw new Error("Mux မအောင်မြင်ပါ");
  prog(1, "🎉 ပြီးပြီ!");

  const data = await ffmpeg.readFile("dubbed.mp4");
  return new Blob([data], { type: "video/mp4" });
}
