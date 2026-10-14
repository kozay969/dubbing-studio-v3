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

  // fresh workspace
  for (const n of ["input.mp4", "pieces.txt", "vret.mp4", "vsub.mp4", "subs.srt", "dubbed.mp4"]) await safeDelete(ffmpeg, n);
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

  // 2b. blur subtitles (optional)
  let vInput = "vret.mp4";
  const needBlur = blurRegion && blurRegion.h > 0.01;
  const needSubs = srtContent && srtContent.trim().length > 10;

  if (needBlur) {
    const by = Math.max(0, Math.min(0.95, blurRegion.y)).toFixed(4);
    const bh = Math.max(0.02, Math.min(0.5, blurRegion.h)).toFixed(4);
    prog(doneExecs / totalExecs, "စာတန်း blur လုပ်နေတယ်...");
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
    prog(doneExecs / totalExecs, "Blur ✅");
  }

  // 2c. burn Burmese subtitles (optional) — via drawtext (per-line, libass-free)
  if (needSubs) {
    prog(doneExecs / totalExecs, "မြန်မာစာတန်း ထည့်နေတယ်...");
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
    prog(doneExecs / totalExecs, "စာတန်း ✅");
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
