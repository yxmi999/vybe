import { registerJob } from "./jobs";
import { generateSubtitles, type SubtitleGenerationInput } from "./subtitle-generation";
import { planAutoEdit, type AutoEditInput } from "./auto-edit";
import { analyzeReference } from "./style-analyze";
import { parseInlineStyle, resolveStyle } from "./style-store";

registerJob("clips-subtitles", (input) => generateSubtitles(input as SubtitleGenerationInput));

// Auto-edit (optionally in a saved/builtin style) and style analysis of a link.
registerJob("clips-auto-edit", async (input, { userId }) => {
  const i = (input ?? {}) as Omit<AutoEditInput, "style"> & { styleRef?: string | number; style?: unknown };
  const style = parseInlineStyle(i.style) ?? await resolveStyle(userId, i.styleRef);
  return planAutoEdit({ ...i, style });
});
registerJob("styles-analyze", (input) => {
  const url = String((input as { url?: unknown } | null)?.url ?? "");
  return analyzeReference({ url }, url.startsWith("/") ? "" : url);
});

// Other long-running AI-assist endpoints (auto-edit, virality, reframe,
// auto-clipper/*-vod-highlights) follow the same pattern: extract the
// route's core logic into a plain function like subtitle-generation.ts,
// then register it here under a job type.
