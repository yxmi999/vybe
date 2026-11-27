/**
 * Detection-math test harness. Exercises the pure scoring primitives behind the
 * auto-clipper's highlight detection — no DB, no network, no ffmpeg.
 *
 *   npx tsx scripts/test-detection.ts   (or: npm run test:detection)
 *
 * Covers: median / smooth / pickPeaks / sharpnessFactor / fuse / lift
 * (chat-highlights.ts) and snapToSilence (silence.ts), plus two scenario tests
 * that combine them the way scanTwitchVodHighlights and the auto-pilot floor do.
 */
import {
  median,
  smooth,
  pickPeaks,
  sharpnessFactor,
  fuse,
  lift,
  isHype,
  isClipRequest,
  uniqueChatterFactor,
  percentile,
  normalize01,
  nearestIndex,
  mergeCandidateTimes,
  pickTopSpaced,
  resortShortlist,
  REACTION_BOOST,
} from "../src/lib/chat-highlights";
import { snapToSilence } from "../src/lib/silence";
import { refineBoxToEdges, detectContentRows } from "../src/lib/facecam";
import { panelForFacecam, panelForGameplay, splitCropRect, SPLIT_LAYOUTS } from "../src/lib/clip-filters";
import { chunkSubtitle } from "../src/lib/clip-render";

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
function approx(a: number, b: number, eps = 1e-9) { return Math.abs(a - b) <= eps; }
function section(title: string) { console.log(`\n${title}`); }

// ── median ───────────────────────────────────────────────────────────────────
section("median");
ok("empty list → 0", median([]) === 0);
ok("odd length → middle", median([3, 1, 2]) === 2);
ok("even length → mean of middle two", median([1, 2, 3, 4]) === 2.5);
ok("unsorted input handled", median([10, 0, 5, 100, 1]) === 5);

// ── smooth ───────────────────────────────────────────────────────────────────
section("smooth");
{
  const flat = smooth([5, 5, 5, 5]);
  ok("flat signal stays flat", flat.every((v) => approx(v, 5)));
  const s = smooth([0, 0, 8, 0, 0]); // weighted (prev + 2*cur + next)/4
  ok("isolated spike is attenuated", s[2] === 4 && s[2] < 8);
  ok("spike energy bleeds to neighbours", s[1] > 0 && s[3] > 0);
  ok("same length out", s.length === 5);
}

// ── pickPeaks ──────────────────────────────────────────────────────────────────
section("pickPeaks");
{
  // Two clear peaks at idx 2 and 6; offsets 1s apart.
  const sig = [0, 1, 9, 1, 0, 1, 7, 1, 0];
  const offsets = sig.map((_, i) => i);
  const peaks = pickPeaks(sig, offsets, 2, 5);
  ok("finds the two maxima", peaks.includes(2) && peaks.includes(6), `got ${JSON.stringify(peaks)}`);
  ok("orders best-first", peaks[0] === 2);
  ok("respects max count", pickPeaks(sig, offsets, 1, 1).length === 1);
  // minGap collapses neighbours: a wide gap should drop the weaker second peak.
  ok("minGap suppresses nearby weaker peak", pickPeaks(sig, offsets, 6, 5).length === 1);
  ok("all-zero signal → no peaks", pickPeaks([0, 0, 0], [0, 1, 2], 1, 5).length === 0);
}

// ── sharpnessFactor ────────────────────────────────────────────────────────────
section("sharpnessFactor");
{
  const plateau = [5, 5, 5, 5, 5, 5, 5];
  ok("plateau → ~1 (no prominence)", approx(sharpnessFactor(plateau, 3), 1));
  const spike = [1, 1, 1, 50, 1, 1, 1];
  ok("sharp spike → clamped at 2.5", sharpnessFactor(spike, 3) === 2.5);
  ok("bounded in [1, 2.5]", (() => {
    const f = sharpnessFactor([1, 1, 4, 1, 1], 2);
    return f >= 1 && f <= 2.5;
  })());
  ok("never below 1 even in a trough", sharpnessFactor([9, 9, 1, 9, 9], 2) === 1);
}

// ── fuse ───────────────────────────────────────────────────────────────────────
section("fuse");
ok("no boosts → identity", fuse(10, 1, 0) === 10);
ok("sharpness multiplies", fuse(10, 2, 0) === 20);
ok("hype ratio adds proportionally", fuse(10, 1, 0.5) === 15);
ok("monotonic in hype", fuse(10, 1.5, 0.8) > fuse(10, 1.5, 0.2));
ok("clip-request boost defaults off (back-compat)", fuse(10, 1, 0) === 10);
ok("clip requests multiply the score", fuse(10, 1, 0, 0.5) === 25);
ok("monotonic in clip-request share", fuse(10, 1, 0.2, 0.6) > fuse(10, 1, 0.2, 0.1));

// ── isClipRequest / isHype separation ──────────────────────────────────────────
section("isClipRequest");
{
  for (const s of ["!clip", "!clips", "clip it", "CLIP THAT", "clip this", "someone clip",
                   "mods clip that", "clipped", "needs a clip", "clip pls", "pls clip", "clip now"]) {
    ok(`asks to clip: "${s}"`, isClipRequest(s), "should match");
  }
  for (const s of ["nice clip", "that clip was funny", "clipboard", "paperclip", "KEKW", "what a play"]) {
    ok(`not a clip request: "${s}"`, !isClipRequest(s), "should not match");
  }
  // Clip requests are their own channel, no longer folded into generic hype.
  ok("clip request isn't counted as hype", !isHype("clip it"));
  ok("hype still detected", isHype("KEKW") && isHype("POGGERS"));
}

// ── Scenario: a clip-requested moment outranks a busier one ──────────────────────
section("scenario · explicit clip request lifts a moment over a busier window");
{
  // Window A: busier (rate 12) but no one asks to clip. Window B: slightly slower
  // (rate 9) but chat is spamming "!clip" (40% of the window).
  const a = fuse(12, 1.2, 0.2, 0);
  const b = fuse(9, 1.2, 0.2, 0.4);
  ok("clip-requested moment wins despite lower rate", b > a, `busy=${a.toFixed(1)} clip=${b.toFixed(1)}`);
}

// ── uniqueChatterFactor ────────────────────────────────────────────────────────
section("uniqueChatterFactor");
{
  ok("no author data → neutral 1", uniqueChatterFactor([undefined, undefined, null]) === 1);
  ok("mostly-missing authors → neutral 1", uniqueChatterFactor(["a", undefined, undefined, undefined]) === 1);
  ok("all-distinct chatters → 1", uniqueChatterFactor(["a", "b", "c", "d"]) === 1);
  const spam = uniqueChatterFactor(Array(50).fill("bot1").concat(Array(50).fill("bot2")));
  const wall = uniqueChatterFactor(Array.from({ length: 100 }, (_, i) => `user${i >> 1}`)); // ratio 0.5
  ok("2-account spam is damped hard", spam < 0.6, `spam=${spam.toFixed(2)}`);
  ok("normal hype wall barely touched", wall > 0.8, `wall=${wall.toFixed(2)}`);
  ok("diversity orders windows correctly", spam < wall && wall < 1);
  ok("bounded in [0.5, 1]", spam >= 0.5 && uniqueChatterFactor(["x"]) <= 1);
}

// ── Scenario: bot spam vs organic spike at the same rate ──────────────────────
section("scenario · organic spike outranks bot spam at equal rate");
{
  const rate = 12; // both windows show the same msgs/5s
  const botScore = rate * uniqueChatterFactor(Array(60).fill("spambot"));
  const organic = rate * uniqueChatterFactor(Array.from({ length: 60 }, (_, i) => `viewer${i % 35}`));
  ok("organic crowd wins", organic > botScore, `bot=${botScore.toFixed(1)} organic=${organic.toFixed(1)}`);
}

// ── lift ─────────────────────────────────────────────────────────────────────
section("lift");
ok("ratio over baseline", lift(20, 5) === 4);
ok("at baseline → 1", lift(5, 5) === 1);
ok("real value, no baseline → Infinity", lift(7, 0) === Infinity);
ok("empty value, no baseline → 0", lift(0, 0) === 0);

// ── snapToSilence ──────────────────────────────────────────────────────────────
section("snapToSilence");
{
  const len = 60, peak = 15;
  // No silence at the edges → no-op (full section).
  let r = snapToSilence(len, peak, [{ start: 30, end: 31 }]);
  ok("no edge silence → full section", r.start === 0 && r.end === len);

  // Leading dead air trimmed to where talking resumes.
  r = snapToSilence(len, peak, [{ start: 0, end: 4 }]);
  ok("leading silence trims the start", r.start === 4 && r.end === 60);

  // Trailing dead air trimmed to where the pause begins.
  r = snapToSilence(len, peak, [{ start: 54, end: 60 }]);
  ok("trailing silence trims the end", r.start === 0 && r.end === 54);

  // Both edges.
  r = snapToSilence(len, peak, [{ start: 0, end: 3 }, { start: 55, end: 60 }]);
  ok("both edges trimmed", r.start === 3 && r.end === 55);

  // Never eat into the setup: a huge leading silence is capped at peak - minSetup.
  r = snapToSilence(len, peak, [{ start: 0, end: 40 }]);
  ok("leading trim capped at peak - minSetup(8)", r.start === peak - 8);

  // Never cut before the reaction lands: trailing capped at peak + minTail.
  r = snapToSilence(len, peak, [{ start: 5, end: 60 }]);
  ok("trailing trim floored at peak + minTail(6)", r.end === peak + 6);

  // Degenerate snap (would leave < minLen) falls back to the full section: a
  // 10s section that's basically all silence around an early peak.
  r = snapToSilence(10, 2, [{ start: 0, end: 10 }]);
  ok("over-trim falls back to full section", r.start === 0 && r.end === 10, `got ${JSON.stringify(r)}`);
}

// ── Scenario: fusion ranking (mirrors scanTwitchVodHighlights) ──────────────────
section("scenario · fusion ranks a sharp hype spike over a busy plateau");
{
  // Window A: a broad, busy stretch — high rate, low prominence, little hype.
  // Window B: a sharp, hype-dense spike — lower raw rate but a real moment.
  const rates = [6, 6, 6, 6, 6, 1, 1, 9, 1, 1]; // A at idx 0-4 plateau, B spike at idx 7
  const smoothed = smooth(rates);
  const a = fuse(rates[2], sharpnessFactor(smoothed, 2), 0.05); // plateau, ~no hype
  const b = fuse(rates[7], sharpnessFactor(smoothed, 7), 0.7);  // spike, hype-heavy
  ok("hype spike outranks busy plateau", b > a, `plateau=${a.toFixed(2)} spike=${b.toFixed(2)}`);
}

// ── Scenario: auto-post floor (mirrors the engine's standsOut gate) ──────────────
section("scenario · auto-post floor rejects a quiet VOD's 'top' moment");
{
  const MIN_AUTOPOST_LIFT = 2.0;
  const standsOut = (msgsPer5: number, baseline: number) =>
    msgsPer5 > 0 && lift(msgsPer5, baseline) >= MIN_AUTOPOST_LIFT;

  // Quiet VOD: baseline 4/5s, "best" moment only 5/5s → lift 1.25 → hold for review.
  ok("marginal moment held for review", standsOut(5, 4) === false);
  // Real spike: baseline 4/5s, moment 20/5s → lift 5 → auto-post eligible.
  ok("genuine spike clears the floor", standsOut(20, 4) === true);
  // Dead chat everywhere → never auto-posts.
  ok("zero-activity moment never auto-posts", standsOut(0, 0) === false);
}

// ── percentile ─────────────────────────────────────────────────────────────────
section("percentile");
{
  ok("empty list → 0", percentile([], 50) === 0);
  ok("p50 odd length → middle", percentile([1, 2, 3, 4, 5], 50) === 3);
  ok("p0 → min", percentile([1, 2, 3, 4, 5], 0) === 1);
  ok("p100 → max", percentile([1, 2, 3, 4, 5], 100) === 5);
  ok("interpolates between points", approx(percentile([1, 2, 3, 4], 50), 2.5));
  ok("unsorted input handled", percentile([5, 1, 3], 50) === 3);
}

// ── normalize01 ────────────────────────────────────────────────────────────────
section("normalize01");
{
  ok("empty list → []", normalize01([]).length === 0);
  ok("flat signal → all zero (no range)", normalize01([5, 5, 5, 5]).every((v) => v === 0));
  const spread = normalize01([0, 50, 100]);
  ok("spans [0,1] with no outliers to clip", spread[0] === 0 && approx(spread[1], 0.5) && spread[2] === 1);
  // One extreme outlier shouldn't compress the rest of the series into a sliver.
  const withOutlier = normalize01([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.1);
  ok("outlier is clipped to 1, not stretching the scale", withOutlier[10] === 1);
  ok("outlier clipping preserves resolution among normal values", withOutlier[9] === 1 && withOutlier[0] === 0);
  ok("all values stay bounded in [0,1]", withOutlier.every((v) => v >= 0 && v <= 1));
}

// ── nearestIndex ───────────────────────────────────────────────────────────────
section("nearestIndex");
{
  ok("empty offsets → -1", nearestIndex([], 5) === -1);
  ok("single element → 0", nearestIndex([5], 100) === 0);
  ok("exact match", nearestIndex([10, 20, 30], 20) === 1);
  ok("rounds to nearer neighbour (low side)", nearestIndex([10, 20, 30], 21) === 1);
  ok("rounds to nearer neighbour (high side)", nearestIndex([10, 20, 30], 26) === 2);
  ok("tie goes to the earlier index", nearestIndex([10, 20, 30], 25) === 1);
  ok("before the first offset clamps to 0", nearestIndex([10, 20, 30], 0) === 0);
  ok("past the last offset clamps to the end", nearestIndex([10, 20, 30], 999) === 2);
}

// ── mergeCandidateTimes ────────────────────────────────────────────────────────
section("mergeCandidateTimes");
{
  const m1 = mergeCandidateTimes([100, 200], [105, 500], 20);
  ok("chat+audio within the window merge into one", m1.length === 3, `got ${JSON.stringify(m1)}`);
  const merged100 = m1.find((c) => c.t === 100);
  ok("merged candidate tagged from both channels", !!merged100 && merged100.fromChat && merged100.fromAudio);
  const chatOnly200 = m1.find((c) => c.t === 200);
  ok("untouched chat peak stays chat-only", !!chatOnly200 && chatOnly200.fromChat && !chatOnly200.fromAudio);
  const audioOnly500 = m1.find((c) => c.t === 500);
  ok("far audio peak stays a separate audio-only candidate", !!audioOnly500 && !audioOnly500.fromChat && audioOnly500.fromAudio);

  ok("empty chat list → pure audio candidates", mergeCandidateTimes([], [50], 10).length === 1);
  ok("empty audio list → pure chat candidates, untagged", mergeCandidateTimes([50], [], 10)[0].fromAudio === false);
  ok("exactly at the boundary still merges (<=)", mergeCandidateTimes([100], [120], 20).length === 1);
  ok("just past the boundary stays separate", mergeCandidateTimes([100], [121], 20).length === 2);
}

// ── pickTopSpaced ──────────────────────────────────────────────────────────────
section("pickTopSpaced");
{
  const cands = [{ t: 0, v: 5 }, { t: 10, v: 10 }, { t: 100, v: 1 }];
  const picked = pickTopSpaced(cands, (c) => c.v, 50, 2);
  ok("picks best-first and enforces the min gap", picked.map((c) => c.t).join(",") === "10,100", `got ${JSON.stringify(picked)}`);
  ok("respects the max count", pickTopSpaced(cands, (c) => c.v, 1, 1).length === 1);
  ok("clustered candidates collapse to the top one", pickTopSpaced(
    [{ t: 0, v: 1 }, { t: 5, v: 9 }, { t: 10, v: 3 }], (c) => c.v, 100, 5,
  ).length === 1);
  ok("empty input → empty output", pickTopSpaced([], (c: { t: number }) => 0, 10, 5).length === 0);
}

// ── resortShortlist ────────────────────────────────────────────────────────────
section("resortShortlist");
{
  const A = { id: "A", score: 10, keywordMatch: false, reactionConfirmed: false };
  const B = { id: "B", score: 8, keywordMatch: true, reactionConfirmed: false };
  const C = { id: "C", score: 5, keywordMatch: false, reactionConfirmed: true, reactionIntensity: 100 };
  const D = { id: "D", score: 6, keywordMatch: false, reactionConfirmed: true, reactionIntensity: 100 };
  const order = resortShortlist([A, C, D, B]).map((m) => m.id);
  ok("keyword-confirmed bucket floats above higher raw scores", order[0] === "B", `got ${order.join(",")}`);
  ok("full ranking matches score-then-reaction-boost expectations", order.join(",") === "B,A,D,C", `got ${order.join(",")}`);
  ok("REACTION_BOOST is the documented 0.5", REACTION_BOOST === 0.5);
  ok("no moments → no crash", resortShortlist([]).length === 0);
}

// ── facecam edge snapping + letterbox (facecam.ts) ─────────────────────────────
section("refineBoxToEdges / detectContentRows");
{
  // Synthetic 640x360 frames: noisy "gameplay", a flat cam overlay at
  // x∈[0,180) y∈[0,100) with a bright 2px border, and letterbox bars of 20
  // rows top and bottom. The noise differs per frame so only the overlay's
  // edges persist across frames.
  const W = 640, H = 360;
  const frame = (seed: number) => {
    const d = new Uint8Array(W * H);
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 60 + Math.floor(rnd() * 120);
      if (y < 20 || y >= H - 20) v = 4;                       // letterbox
      if (x < 180 && y < 100) v = 90 + (seed % 3) * 5;        // cam picture (flat-ish)
      if ((x === 178 || x === 179) && y < 100) v = 250;       // cam border, right
      if ((y === 98 || y === 99) && x < 180) v = 250;         // cam border, bottom
      d[y * W + x] = v;
    }
    return { data: d, w: W, h: H };
  };
  const frames = [frame(1), frame(7), frame(13)];
  // AI box overshoots right/bottom by ~4% (the typical miss).
  const r = refineBoxToEdges(frames, { x: 0.005, y: 0.004, w: 0.32, h: 0.32 });
  ok("snaps to the overlay's real edges", !!r && Math.abs(r.box.x + r.box.w - 179 / W) < 0.006 && Math.abs(r.box.y + r.box.h - 99 / H) < 0.01,
    r ? JSON.stringify(r.box) : "null");
  ok("corner-flush sides snap to the frame border", !!r && r.box.x === 0 && r.box.y === 0);
  ok("all inner sides confirmed", !!r && r.confirmed);
  // A 1px bright border line (ridge) between two similar regions — a pure
  // step test can't see it; the overlay bottom of many real streams.
  const ridgeFrames = [1, 7, 13].map((seed) => {
    const f = frame(seed);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x < 180 && y >= 98 && y <= 99) f.data[y * W + x] = 90;   // drop the 2px border…
      if (x < 180 && y > 99 && y < 140) f.data[y * W + x] = 92;    // …gameplay right below is as flat as the cam
      if (x < 180 && y === 99) f.data[y * W + x] = 240;            // 1px ridge line
    }
    return f;
  });
  const rr = refineBoxToEdges(ridgeFrames, { x: 0.004, y: 0.002, w: 0.28, h: 0.32 });
  ok("1px ridge border snapped", !!rr && Math.abs(rr.box.y + rr.box.h - 99 / H) < 0.006, rr ? JSON.stringify(rr.box) : "null");
  const c = detectContentRows(frames);
  ok("letterbox bars detected", Math.abs(c.top - 20 / H) < 0.004 && Math.abs(c.bottom - (H - 20) / H) < 0.004, JSON.stringify(c));
  ok("no bars → full frame", (() => { const f = frame(3); f.data.fill(120); const k = detectContentRows([f]); return k.top === 0 && k.bottom === 1; })());
}

section("panelForFacecam / panelForGameplay");
{
  // 1280x720 source, 9:16 out; cam = top-left 16:9 box (25.8% x 25.7%).
  const box = { x: 0, y: 0, w: 0.258, h: 0.257 };
  const p = panelForFacecam(box, "facecam", 0, 1080, 1920, 1280, 720);
  const crop = splitCropRect(p, SPLIT_LAYOUTS.facecam.slots[0], 1080, 1920, 1280, 720);
  ok("cam screen crop stays inside the cam box (cover, no gameplay bleed)",
    crop.x >= box.x - 1e-6 && crop.y >= box.y - 1e-6 && crop.x + crop.w <= box.x + box.w + 1e-6 && crop.y + crop.h <= box.y + box.h + 1e-6,
    JSON.stringify(crop));
  const g = panelForGameplay({ cx: 0.5, cy: 0.5, zoom: 1 }, { top: 0.056, bottom: 0.944 }, box, "facecam", 1, 1080, 1920, 1280, 720);
  const gc = splitCropRect(g, SPLIT_LAYOUTS.facecam.slots[1], 1080, 1920, 1280, 720);
  ok("gameplay crop excludes letterbox bars", gc.y >= 0.056 - 1e-6 && gc.y + gc.h <= 0.944 + 1e-6, JSON.stringify(gc));
  ok("gameplay crop stays clear of the cam", gc.x >= box.x + box.w - 1e-6, JSON.stringify(gc));
}

section("chunkSubtitle (classic subtitles never overflow)");
{
  const words = "ah damn I was not trying to wake you up this early man".split(" ")
    .map((w, i) => ({ word: w, start: i * 0.4, end: i * 0.4 + 0.35 }));
  const seg = { id: "s", start: 0, end: 5, text: words.map((w) => w.word).join(" "), words };
  const parts = chunkSubtitle(seg, 20);
  ok("long segment split into ≤20-char lines", parts.length > 1 && parts.every((p) => p.text.length <= 20), parts.map((p) => p.text).join(" | "));
  ok("pieces are contiguous and cover the segment", parts[0].start === 0 && parts[parts.length - 1].end === 5 &&
    parts.every((p, i) => i === 0 || Math.abs(p.start - parts[i - 1].end) < 1e-9));
  ok("no words lost", parts.map((p) => p.text).join(" ") === seg.text);
  ok("short segment untouched", chunkSubtitle({ id: "t", start: 0, end: 1, text: "hello" }, 20).length === 1);
  const noWords = chunkSubtitle({ id: "u", start: 2, end: 6, text: seg.text }, 20);
  ok("no word timings → proportional split", noWords.length > 1 && Math.abs(noWords[noWords.length - 1].end - 6) < 1e-9);
}

// ── summary ────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? "✓ all passed" : "✗ failures"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
