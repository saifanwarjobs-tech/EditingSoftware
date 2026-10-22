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
      cur = { start: w.start, end: w.end, text: w.text, count: 1, words: [w] };
    } else {
      cur.text = text; cur.end = w.end; cur.count++; cur.words.push(w);
    }
  }
  if (cur) cues.push(cur);
  // avoid a lonely one-word last cue: fold it into the previous cue when it still fits on screen
  const last = cues[cues.length - 1], prev = cues[cues.length - 2];
  if (prev && last.count === 1 && !/[.!?।]$/.test(prev.text) && last.start - prev.end <= maxGap && prev.text.length + 1 + last.text.length <= maxChars + 6) {
    prev.text += ` ${last.text}`; prev.end = last.end; prev.count++; prev.words.push(...last.words);
    cues.pop();
  }
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

export const CAPTION_STYLES = ["plain", "karaoke", "pop"];

const esc = (t) => t.replace(/\\/g, "").replace(/[{}]/g, "");

/** ASS text for one cue. karaoke = active word fills with the highlight colour as it is spoken. */
function cueText(cue, style) {
  if (style === "karaoke" && cue.words?.length) {
    let t = cue.start;
    let out = "";
    for (const w of cue.words) {
      const gap = Math.round((w.start - t) * 100);
      if (gap > 0) out += `{\\k${gap}}`;
      const dur = Math.max(1, Math.round((w.end - Math.max(w.start, t)) * 100));
      out += `{\\kf${dur}}${esc(w.text)} `;
      t = Math.max(t, w.end);
    }
    return out.trim();
  }
  if (style === "pop") {
    // quick scale-in + short fade, one pop per phrase
    return `{\\fad(60,0)\\fscx82\\fscy82\\t(0,140,\\fscx100\\fscy100)}${esc(cue.text)}`;
  }
  return esc(cue.text);
}

export function toAss(cues, { font = "Arial", size = 18, width = 1080, height = 1920, style = "plain" } = {}) {
  const st = CAPTION_STYLES.includes(style) ? style : "plain";
  // karaoke: Primary = highlight (already spoken), Secondary = not yet spoken. Colours are &HAABBGGRR.
  const primary = st === "karaoke" ? "&H0000E5FF" : "&H00FFFFFF"; // warm yellow vs white
  const secondary = st === "karaoke" ? "&H00FFFFFF" : "&H000000FF";
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},${size},${primary},${secondary},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 10))},1,2,60,60,${Math.round(height * 0.12)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  return header + cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${cueText(c, st)}`).join("\n") + "\n";
}
