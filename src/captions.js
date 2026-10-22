// Turn (remapped) words into caption cues, SRT and ASS (for burn-in).
export function groupCues(words, { maxWords = 6, maxChars = 36, maxGap = 0.45 } = {}) {
  const cues = [];
  let cur = null;
  for (const w of words) {
    const text = cur ? `${cur.text} ${w.text}` : w.text;
    const breakNow =
      cur && (cur.count >= maxWords || text.length > maxChars || w.start - cur.end > maxGap || /[.!?।]$/.test(cur.text));
    if (!cur || breakNow) {
      if (cur) cues.push(cur);
      cur = { start: w.start, end: w.end, text: w.text, count: 1 };
    } else {
      cur.text = text; cur.end = w.end; cur.count++;
    }
  }
  if (cur) cues.push(cur);
  // avoid flicker: hold each cue until the next one starts (max 0.4s extra)
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i + 1].start, cues[i].end + 0.4);
  return cues;
}

const pad = (n, l = 2) => String(n).padStart(l, "0");
function srtTime(t) {
  const ms = Math.round(t * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}
function assTime(t) {
  const cs = Math.round(t * 100);
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

export function toAss(cues, { font = "Arial", size = 18, width = 1080, height = 1920 } = {}) {
  // PlayRes matches the output video so font size is consistent; size is scaled by caller if needed.
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 8))},1,2,60,60,${Math.round(height * 0.12)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const esc = (s) => s.replace(/\\/g, "").replace(/[{}]/g, "");
  return header + cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${esc(c.text)}`).join("\n") + "\n";
}
