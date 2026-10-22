// Step 3: cut the video to the EDL with FFmpeg (one re-encode, optional caption burn-in).
import { writeFile } from "node:fs/promises";
import { run } from "./exec.js";

export async function probe(path) {
  const { out } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return {
    duration: Number(j.format.duration),
    width: v?.width, height: v?.height,
    hasVideo: !!v, hasAudio: !!a,
  };
}

const FADE = 0.03; // 30 ms ramps remove clicks at every splice

export function buildFilterScript(edl, { hasVideo = true, subtitlesPath = null, fontsDir = null } = {}) {
  const lines = [];
  const labels = [];
  edl.forEach(([s, e], i) => {
    const d = e - s;
    const f = Math.min(FADE, d / 4);
    if (hasVideo) lines.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    lines.push(
      `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${f.toFixed(3)},afade=t=out:st=${(d - f).toFixed(3)}:d=${f.toFixed(3)}[a${i}]`
    );
    labels.push(hasVideo ? `[v${i}][a${i}]` : `[a${i}]`);
  });
  lines.push(`${labels.join("")}concat=n=${edl.length}:v=${hasVideo ? 1 : 0}:a=1${hasVideo ? "[vc]" : ""}[aout]`);
  if (hasVideo) {
    if (subtitlesPath) {
      // Paths inside filtergraphs need escaping of \ : '
      const esc = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
      const fd = fontsDir ? `:fontsdir='${esc(fontsDir)}'` : "";
      lines.push(`[vc]subtitles='${esc(subtitlesPath)}'${fd}[vout]`);
    } else {
      lines.push(`[vc]null[vout]`);
    }
  }
  return lines.join(";\n");
}

export async function cutVideo({ input, output, edl, subtitlesPath = null, fontsDir = null, info }) {
  if (!edl.length) throw new Error("Nothing left to keep after cutting (EDL is empty).");
  const meta = info ?? (await probe(input));
  if (!meta.hasAudio) throw new Error("Input has no audio track; cannot transcribe/cut by speech.");
  const scriptPath = `${output}.filter.txt`;
  await writeFile(scriptPath, buildFilterScript(edl, { hasVideo: meta.hasVideo, subtitlesPath, fontsDir }));
  const args = ["-y", "-i", input, "-filter_complex_script", scriptPath];
  if (meta.hasVideo) args.push("-map", "[vout]");
  args.push("-map", "[aout]");
  if (meta.hasVideo) args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
  args.push("-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output);
  await run("ffmpeg", args);
  return { path: output, meta };
}
