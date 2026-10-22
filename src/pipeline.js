// Orchestrates: transcribe -> (smart) cuts -> FFmpeg cut + captions -> outputs.
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { transcribe, loadTranscriptFile } from "./transcribe.js";
import { buildEdl, remapWords, totalDuration } from "./autocut.js";
import { smartCuts } from "./smartcut.js";
import { groupCues, toAss, toSrt } from "./captions.js";
import { cutVideo, probe } from "./cutter.js";

/**
 * @param {object} o
 * @param {string} o.input       path to the raw video
 * @param {string} o.workDir     job directory (outputs are written here)
 * @param {string} [o.strength]  light | medium | aggressive
 * @param {boolean} [o.smart]    use Claude for repeat-take / tangent removal
 * @param {boolean} [o.captions] burn captions into the video (default true)
 * @param {string} [o.language]  e.g. "en", "hi"
 * @param {string} [o.transcriptPath] skip transcription, use this transcript.json/.srt-converted json
 * @param {(stage:string)=>void} [o.onStage]
 */
export async function processVideo(o) {
  const { input, workDir, strength = "medium", smart = false, captions = true, language, transcriptPath, onStage = () => {} } = o;
  await mkdir(workDir, { recursive: true });

  onStage("probing");
  const info = await probe(input);

  onStage("transcribing");
  const words = transcriptPath ? await loadTranscriptFile(transcriptPath) : await transcribe(input, workDir, { language });
  if (!words.length) throw new Error("No speech detected in the video.");
  await writeFile(join(workDir, "transcript.json"), JSON.stringify(words, null, 2));

  let removeIds = new Set();
  let smartReasons = [];
  let smartNote = null;
  if (smart) {
    onStage("smart-cut");
    try {
      const r = await smartCuts(words);
      removeIds = r.ids; smartReasons = r.reasons; smartNote = r.skipped ?? null;
    } catch (e) {
      smartNote = `smart cut failed, used rules only: ${e.message}`; // never fail the whole job for the optional step
    }
  }

  onStage("planning-cuts");
  const edl = buildEdl(words, { strength, duration: info.duration, removeIds });
  await writeFile(join(workDir, "edl.json"), JSON.stringify(edl));

  let subtitlesPath = null;
  const cues = groupCues(remapWords(words, edl));
  await writeFile(join(workDir, "captions.srt"), toSrt(cues));
  if (captions && info.hasVideo) {
    subtitlesPath = join(workDir, "captions.ass");
    // scale font to the output height (config size is relative to a 1080px-tall frame)
    const scale = (info.height || 1080) / 1080;
    await writeFile(
      subtitlesPath,
      toAss(cues, { font: config.captionFont, size: Math.round(config.captionFontSize * 3 * scale), width: info.width || 1080, height: info.height || 1920 })
    );
  }

  onStage("rendering");
  const output = join(workDir, "output.mp4");
  await cutVideo({ input, output, edl, subtitlesPath, info });

  const newDuration = totalDuration(edl);
  return {
    output,
    srt: join(workDir, "captions.srt"),
    report: {
      originalSeconds: round(info.duration),
      editedSeconds: newDuration,
      removedSeconds: round(info.duration - newDuration),
      segments: edl.length,
      words: words.length,
      smartRemovals: smartReasons,
      smartNote,
    },
  };
}
const round = (n) => Math.round(n * 100) / 100;
