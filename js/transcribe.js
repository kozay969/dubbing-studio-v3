// Transcribe: extract audio on-device → AssemblyAI (audio-only upload)
import { getFFmpeg } from "./ffmpeg.js";
import { fetchFile } from "@ffmpeg/util";

export async function extractAudio(videoFile) {
  const ffmpeg = await getFFmpeg();
  try { await ffmpeg.deleteFile("input.mp4"); } catch (e) {}
  try { await ffmpeg.deleteFile("audio.wav"); } catch (e) {}
  await ffmpeg.writeFile("input.mp4", await fetchFile(videoFile));
  await ffmpeg.exec([
    "-y", "-v", "error",
    "-i", "input.mp4",
    "-vn", "-ar", "16000", "-ac", "1",
    "-c:a", "pcm_s16le",
    "audio.wav",
  ]);
  const data = await ffmpeg.readFile("audio.wav");
  return new Blob([data], { type: "audio/wav" });
}

export async function transcribeAssemblyAI(audioBlob, apiKey, onStatus) {
  const H = { authorization: apiKey };

  onStatus("☁️ Audio upload...");
  const up = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: H,
    body: audioBlob,
  });
  if (!up.ok) throw new Error("Upload မအောင်မြင်ပါ (" + up.status + ")");
  const { upload_url } = await up.json();

  onStatus("☁️ Transcribe တောင်းနေတယ်...");
  const tr = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ audio_url: upload_url, language_detection: true }),
  });
  if (!tr.ok) throw new Error("Transcribe တောင်းမရဘူး (" + tr.status + ")");
  const { id } = await tr.json();

  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    const pr = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers: H });
    if (!pr.ok) throw new Error("Status ဖတ်မရဘူး (" + pr.status + ")");
    const tj = await pr.json();
    if (tj.status === "completed") return tj;
    if (tj.status === "error") throw new Error("Transcribe error: " + (tj.error || "unknown"));
    onStatus("☁️ Transcribing... (" + tj.status + ")");
  }
}

// Port of v2 _segments_from_words: words have start/end in MILLISECONDS
export function segmentsFromWords(words, maxDur = 12.0, pauseGap = 0.8) {
  const raw = [];
  let cur = [], curStart = null, prevEnd = null;

  const flush = (endMs) => {
    if (cur.length) {
      raw.push({
        start: Math.round(curStart / 1000 * 100) / 100,
        end: Math.round(endMs / 1000 * 100) / 100,
        text: cur.map(w => w.text || "").join(""),
      });
    }
    cur = []; curStart = null;
  };

  for (const w of words) {
    const s = w.start || 0, e = w.end || 0, t = w.text || "";
    if (!t.trim()) continue;
    if (curStart === null) curStart = s;
    if (prevEnd !== null && (s - prevEnd) / 1000 >= pauseGap && cur.length) {
      flush(prevEnd);
      curStart = s;
    }
    cur.push(w);
    prevEnd = e;
    if ((e - curStart) / 1000 >= maxDur) flush(e);
  }
  if (cur.length) flush(prevEnd !== null ? prevEnd : (curStart || 0));

  return raw.filter(sg => sg.text.trim());
}
