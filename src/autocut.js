// Step 2 (rule-based): turn word timestamps into an edit decision list (EDL).
// EDL = array of [start, end] ranges (seconds) of the ORIGINAL video to KEEP.

export const STRENGTHS = {
  light:      { maxGap: 0.9, keepGap: 0.40 },
  medium:     { maxGap: 0.6, keepGap: 0.25 },
  aggressive: { maxGap: 0.4, keepGap: 0.15 },
};

// Safe defaults only: sounds that are almost never meaningful words.
// Words like "matlab", "like", "so" CAN be meaningful -> opt in via extraFillers.
export const DEFAULT_FILLERS = [
  "um", "umm", "ummm", "uh", "uhh", "uhm", "er", "erm", "hmm", "hmmm", "mm", "mmm", "ah", "aah",
  "अम्म", "उम्म", "हम्म", "अं", "आ", "उं",
];

const clean = (t) => t.toLowerCase().replace(/[.,!?;:"'()\-–—…।]/g, "").trim();

/**
 * @param {{id:number,text:string,start:number,end:number}[]} words
 * @param {{strength?:string, duration?:number, extraFillers?:string[], removeFillers?:boolean, removeIds?:Set<number>|number[]}} opts
 *   removeIds: extra word ids to drop (e.g. from the Claude smart-cut step)
 */
export function buildEdl(words, opts = {}) {
  const { maxGap, keepGap } = STRENGTHS[opts.strength ?? "medium"] ?? STRENGTHS.medium;
  const fillers = new Set([...(opts.removeFillers === false ? [] : DEFAULT_FILLERS), ...(opts.extraFillers ?? [])].map(clean));
  const removeIds = new Set(opts.removeIds ?? []);
  const duration = opts.duration ?? (words.length ? words[words.length - 1].end + 0.3 : 0);

  const isRemoved = (w) => removeIds.has(w.id) || fillers.has(clean(w.text));

  // 1. group consecutive kept words into runs; split on long gaps or removed words between them
  const runs = [];
  let cur = null;
  let removedBetween = false;
  for (const w of words) {
    if (isRemoved(w)) { removedBetween = true; continue; }
    if (!cur) {
      cur = { start: w.start, end: w.end, lead: "edge" };
    } else if (removedBetween || w.start - cur.end > maxGap) {
      cur.tail = removedBetween ? "filler" : "pause";
      runs.push(cur);
      cur = { start: w.start, end: w.end, lead: removedBetween ? "filler" : "pause" };
    } else {
      cur.end = Math.max(cur.end, w.end);
    }
    removedBetween = false;
  }
  if (cur) { cur.tail = "edge"; runs.push(cur); }

  // 2. pad each run so speech is not clipped; keep ~keepGap of natural silence at pause cuts
  const half = keepGap / 2;
  const padFor = (kind) => (kind === "pause" ? half : kind === "filler" ? Math.min(half, 0.05) : 0.15);
  const padded = runs.map((r) => [
    Math.max(0, r.start - padFor(r.lead)),
    Math.min(duration, r.end + padFor(r.tail)),
  ]);

  // 3. merge overlaps, drop slivers
  const edl = [];
  for (const seg of padded) {
    const last = edl[edl.length - 1];
    if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
    else edl.push([...seg]);
  }
  return edl.filter(([s, e]) => e - s >= 0.15).map(([s, e]) => [round(s), round(e)]);
}

const round = (n) => Math.round(n * 1000) / 1000;

export function totalDuration(edl) {
  return round(edl.reduce((sum, [s, e]) => sum + (e - s), 0));
}

/**
 * Map words from the original timeline to the edited timeline.
 * Words that fall outside every kept range are dropped.
 */
export function remapWords(words, edl) {
  const out = [];
  let offset = 0;
  for (const [s, e] of edl) {
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      if (mid >= s && mid <= e) {
        out.push({
          ...w,
          start: round(offset + Math.max(w.start, s) - s),
          end: round(offset + Math.min(w.end, e) - s),
        });
      }
    }
    offset += e - s;
  }
  return out;
}
