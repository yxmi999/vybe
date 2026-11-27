// Non-destructive multi-clip timeline — pure, framework-free helpers shared by
// the editor (src/app/clips/page.tsx) and the render pipeline
// (src/lib/clip-render.ts). A `Clip[]` describes cuts/order over the ONE
// original source video; the source file itself is never touched until
// export, when the clips are concatenated (see src/lib/clip-assemble.ts).
import { uid } from "./utils";

export type Clip = {
  id: string;
  sourceStart: number;   // seconds into the one original source video
  sourceEnd: number;
  timelineStart: number; // derived — cumulative sum of prior clip durations
  duration: number;      // derived — sourceEnd - sourceStart
  volume?: number;       // this segment's audio level, percent (0–200); unset = 100
};

export const clipVolume = (c: Pick<Clip, "volume"> | null | undefined) =>
  c?.volume == null || !isFinite(c.volume) ? 100 : Math.max(0, Math.min(200, c.volume));

export type SubWord = { word: string; start: number; end: number; emoji?: string };
export type Subtitle = { id: string; start: number; end: number; text: string; words?: SubWord[] };

// Below this, a clip/subtitle fragment is considered degenerate and dropped
// rather than kept as a sliver no one could see or scrub to.
export const MIN_CLIP_DURATION = 0.1;

// The single authority for consistency: recompute `duration`/`timelineStart`
// from `sourceStart`/`sourceEnd` and array order. Every structural mutation
// (split/delete/reorder/trim-edge) ends by calling this — ripple-delete and
// ripple-trim fall out of this recompute, they aren't separate logic.
export function relayoutClips(clips: Clip[]): Clip[] {
  let t = 0;
  const out: Clip[] = [];
  for (const c of clips) {
    const duration = Math.max(0, c.sourceEnd - c.sourceStart);
    if (duration < MIN_CLIP_DURATION) continue;
    out.push({ ...c, duration, timelineStart: t });
    t += duration;
  }
  return out;
}

export function totalDuration(clips: Clip[]): number {
  return clips.reduce((sum, c) => sum + c.duration, 0);
}

// Half-open interval lookup — the last clip includes its own end so a
// playhead sitting exactly at the final frame still resolves to something.
export function ownerClipAt(clips: Clip[], timelineT: number): Clip | null {
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const isLast = i === clips.length - 1;
    if (timelineT >= c.timelineStart && (isLast ? timelineT <= c.timelineStart + c.duration : timelineT < c.timelineStart + c.duration)) {
      return c;
    }
  }
  return null;
}

export function timelineTimeToSourceTime(clips: Clip[], timelineT: number): { clip: Clip; sourceTime: number } | null {
  const clip = ownerClipAt(clips, timelineT);
  if (!clip) return null;
  return { clip, sourceTime: clip.sourceStart + (timelineT - clip.timelineStart) };
}

// Inverse mapping. `preferClipId` disambiguates when the same source instant
// is covered by more than one clip (reachable via split + reorder) by
// preferring whichever clip the caller was already in.
export function sourceTimeToTimelineTime(clips: Clip[], sourceTime: number, preferClipId?: string): number | null {
  const matches = clips.filter((c) => sourceTime >= c.sourceStart && sourceTime <= c.sourceEnd);
  if (matches.length === 0) return null;
  const pick = (preferClipId && matches.find((c) => c.id === preferClipId)) || matches[0];
  return pick.timelineStart + (sourceTime - pick.sourceStart);
}

// Splits the clip under the playhead into two at that timeline position. A
// no-op (returns the same array reference) if the split point is within
// MIN_CLIP_DURATION of either edge of the owning clip, or if nothing owns it.
export function splitClipAtTimelineTime(clips: Clip[], timelineT: number): Clip[] {
  const hit = timelineTimeToSourceTime(clips, timelineT);
  if (!hit) return clips;
  const { clip, sourceTime: splitAt } = hit;
  if (splitAt - clip.sourceStart < MIN_CLIP_DURATION || clip.sourceEnd - splitAt < MIN_CLIP_DURATION) return clips;
  const idx = clips.findIndex((c) => c.id === clip.id);
  // Both halves keep the segment's volume.
  const before: Clip = { id: uid(), sourceStart: clip.sourceStart, sourceEnd: splitAt, timelineStart: 0, duration: 0, volume: clip.volume };
  const after: Clip = { id: uid(), sourceStart: splitAt, sourceEnd: clip.sourceEnd, timelineStart: 0, duration: 0, volume: clip.volume };
  const next = [...clips];
  next.splice(idx, 1, before, after);
  return relayoutClips(next);
}

export function deleteClip(clips: Clip[], id: string): Clip[] {
  return relayoutClips(clips.filter((c) => c.id !== id));
}

export function reorderClips(clips: Clip[], fromIndex: number, toIndex: number): Clip[] {
  if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= clips.length || toIndex < 0 || toIndex >= clips.length) return clips;
  const next = [...clips];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return relayoutClips(next);
}

// Drags one edge of a clip. Clamped so the clip stays >= MIN_CLIP_DURATION and
// within [0, sourceMediaDuration]; does not touch neighboring clips' source
// ranges (only their derived timelineStart shifts, via relayout).
export function trimClipEdge(
  clips: Clip[],
  id: string,
  edge: "start" | "end",
  newSourceTime: number,
  sourceMediaDuration: number,
): Clip[] {
  const idx = clips.findIndex((c) => c.id === id);
  if (idx === -1) return clips;
  const c = clips[idx];
  const next = [...clips];
  if (edge === "start") {
    const clamped = Math.max(0, Math.min(newSourceTime, c.sourceEnd - MIN_CLIP_DURATION));
    next[idx] = { ...c, sourceStart: clamped };
  } else {
    const clamped = Math.min(sourceMediaDuration, Math.max(newSourceTime, c.sourceStart + MIN_CLIP_DURATION));
    next[idx] = { ...c, sourceEnd: clamped };
  }
  return relayoutClips(next);
}

function shiftWord(w: SubWord, offset: number, lo: number, hi: number): SubWord | null {
  const start = Math.max(lo, w.start) + offset;
  const end = Math.min(hi, w.end) + offset;
  if (end <= start) return null;
  return { ...w, start, end };
}

// The single shared function satisfying both "trim shifts subtitles to 0" and
// "subtitle rendering maps source time to timeline time": for each subtitle,
// intersect it against every clip's source range and emit a shifted copy per
// non-empty intersection. A subtitle entirely inside a trimmed-out gap
// produces zero output entries. A subtitle straddling a split/reorder point
// can legitimately produce two entries (the utterance was cut across).
export function mapSubtitlesToTimeline(subs: Subtitle[], clips: Clip[]): Subtitle[] {
  const out: Subtitle[] = [];
  for (const sub of subs) {
    for (const clip of clips) {
      const lo = Math.max(sub.start, clip.sourceStart);
      const hi = Math.min(sub.end, clip.sourceEnd);
      if (hi <= lo) continue;
      const offset = clip.timelineStart - clip.sourceStart;
      const words = sub.words
        ?.map((w) => shiftWord(w, offset, lo, hi))
        .filter((w): w is SubWord => w != null);
      out.push({
        id: `${sub.id}:${clip.id}`,
        start: lo + offset,
        end: hi + offset,
        text: sub.text,
        words: words && words.length > 0 ? words : sub.words ? [] : undefined,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
