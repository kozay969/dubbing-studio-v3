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

export async function smartRender({ videoFile, segments, clips, clipDurs, gapSpeed, fps = 30, vdur, onProgress, blurSubs = false }) {
  const ffmpeg = await getFFmpeg();
  const prog = (p, msg) => onProgress && onProgress(Math.min(1, Math.max(0, p)), msg || "");

  // fresh workspace
  for (const n of ["input.mp4", "pieces.txt", "vret.mp4", "vblur.mp4", "dubbed.mp4"]) await safeDelete(ffmpeg, n);
  await ffmpeg.writeFile("input.mp4", await fetchFile(videoFile));
  for (let i = 0; i < clips.length; i++) {
    await safeDelete(ffmpeg, `clip${i}.mp3`);
    await ffmpeg.writeFile(`clip${i}.mp3`, await fetchFile(clips[i]));
  }

  const ops = buildOps(segments, vdur);
  const totalExecs = ops.length + 2; // pieces + concat + mux
  let doneExecs = 0;
  let curProg = 0;
  ffmpeg.on("progress", ({ progress }) => {
    curProg = progress || 0;
    prog((doneExecs + curProg) / totalExecs, `Piece ${doneExecs + 1}/${ops.length}`);
  });

  // 1. cut pieces
  const pieceDurs = [];
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
    if (speed > 1.001) {
      vf.push(`setpts=PTS/${speed.toFixed(4)}`, `fps=${fps}`);
    } else {
      vf.push(`fps=${fps}`);
    }
    const pname = `p${String(k).padStart(4, "0")}.mp4`;
    await safeDelete(ffmpeg, pname);
    curProg = 0;
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
    pieceDurs.push(F / fps);
    doneExecs++;
    prog(doneExecs / totalExecs, `Piece ${k + 1}/${ops.length} ✅`);
  }

  // 2. concat
  const list = ops.map((_, k) => `file 'p${String(k).padStart(4, "0")}.mp4'`).join("\n");
  await ffmpeg.writeFile("pieces.txt", list);
  await safeDelete(ffmpeg, "vret.mp4");
  curProg = 0;
  prog(doneExecs / totalExecs, "ဆက်နေတယ်...");
  let rc = await ffmpeg.exec(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "pieces.txt", "-c", "copy", "vret.mp4"]);
  if (rc !== 0) throw new Error("Concat မအောင်မြင်ပါ");
  doneExecs++;
  prog(doneExecs / totalExecs, "Concat ✅");

  // 2b. blur subtitles (optional) — blur bottom 18% where subs usually are
  let vInput = "vret.mp4";
  if (blurSubs) {
    prog(doneExecs / totalExecs, "စာတန်း blur လုပ်နေတယ်...");
    await safeDelete(ffmpeg, "vblur.mp4");
    // crop bottom 18%, blur it, overlay back
    const blurVf = "split[a][b];[a]crop=iw:ih*0.18:0:ih*0.82,boxblur=20[bg];[b][bg]overlay=0:ih*0.82";
    rc = await ffmpeg.exec([
      "-y", "-v", "error",
      "-i", "vret.mp4",
      "-filter:v", blurVf,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-an", "vblur.mp4",
    ]);
    if (rc !== 0) throw new Error("Blur မအောင်မြင်ပါ");
    vInput = "vblur.mp4";
    prog(doneExecs / totalExecs, "Blur ✅");
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
  curProg = 0;
  prog(doneExecs / totalExecs, "အသံ ပေါင်းနေတယ်...");
  rc = await ffmpeg.exec(args);
  if (rc !== 0) throw new Error("Mux မအောင်မြင်ပါ");
  doneExecs++;
  prog(1, "🎉 ပြီးပြီ!");

  const data = await ffmpeg.readFile("dubbed.mp4");
  return new Blob([data], { type: "video/mp4" });
}
