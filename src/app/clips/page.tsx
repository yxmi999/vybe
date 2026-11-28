"use client";
import { useState, useRef, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Film, Download, Scissors, Type as TypeIcon, Crop, Play, Pause,
  Loader2, ChevronRight, AlertCircle, Clapperboard, Search, FolderOpen,
  Music, Gauge, SunMedium, SlidersHorizontal, X, Zap, Sparkles,
  ImageIcon, Volume2, Layers, Plus, Move, Save, Check, ZoomIn, Wand2, Languages, RotateCcw,
  Palette, FlipHorizontal2, Blend, ScanFace, Pencil, LayoutGrid,
  SkipBack, SkipForward, StepBack, StepForward, Undo2, Redo2, Keyboard, Maximize2, Minimize2,
} from "lucide-react";
import {
  ASPECTS, ASPECT_KEYS, CAPTION_BASE_DIVISOR, type AspectKey, type CropKeyframe, type ZoomKeyframe,
  type TextStyle, DEFAULT_TEXT_STYLE,
  buildVideoFilters, audioPitchFilters, audioFadeFilters, audioVolumeFilters, volumeAt,
  COLOR_FILTERS, COLOR_FILTER_KEYS, type ColorFilterKey,
  EFFECTS, EFFECT_KEYS, type EffectKey, type EffectSegment, type VolumeKeyframe,
  type SplitConfig, defaultSplit, outputDims, SPLIT_LAYOUT_KEYS, splitResizable, type SplitLayoutKey,
} from "@/lib/clip-filters";
import { SplitStage, SplitControls, SplitMediaPlayers, detectFacecamSplit } from "./SplitScreen";
import { detectAudioHighlights, MAX_ANALYZE_SECONDS, type Highlight } from "@/lib/highlights";
import {
  type Clip, relayoutClips, totalDuration, timelineTimeToSourceTime, sourceTimeToTimelineTime,
  mapSubtitlesToTimeline, splitClipAtTimelineTime, deleteClip as deleteClipAt, reorderClips, trimClipEdge, clipVolume,
} from "@/lib/timeline";
import { uid, cn } from "@/lib/utils";
import {
  formatTime, formatTimecode, SUB_LANGS, FONT_KEYS, TEMPLATE_KEYS, P, SPEED_OPTIONS,
  type ClipInfo, type AssetItem, type SubWord, type Subtitle,
} from "./editor-types";
import { textStyleCss, TextStylePicker, GlowDot, Section, DInput, DSlider, TransportBtn, ShortcutsModal } from "./editor-ui";
import { useHistory } from "./useHistory";
import { SubtitlePanel } from "./SubtitlePanel";
import { ClipTimeline, type TrackItem, type TrackItemType, type TrackPatch } from "./ClipTimeline";
import { EmptyState } from "./EmptyState";
import { useStyles, StylePicker, CopyStyleModal, StyleTags, type StyleOption } from "./StyleStudio";
import { styleLook } from "@/lib/clip-style";
import { DEFAULT_SUBTITLE_LOOK, sanitizeSubtitleLook, chunkWindows, caseWord, ACTIVE_SCALE, type SubtitleLook } from "@/lib/subtitle-look";
import { uploadFile } from "@/lib/upload-client";
import { SFX_LIBRARY, SFX_KEYS, type SfxKey } from "@/lib/sfx-library";
import { saveEditSession, loadEditSession } from "@/lib/edit-session";

// Load a media file into memory for in-browser FFmpeg / audio analysis.
// Local (blob:/"/") URLs are read directly. Files on our Vercel Blob store are
// fetched straight from the Blob CDN — going through /api/clips/proxy would
// bill the bytes twice (Blob egress + function egress) plus function time —
// and only fall back to the proxy if the direct read fails (e.g. CORS). Other
// hosts (platform CDNs) never allow cross-origin reads, so they use the proxy.
async function loadMediaBytes(u: string): Promise<Uint8Array> {
  const read = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  if (u.startsWith("blob:") || u.startsWith("/")) return read(u);
  if (/^https:\/\/[^/]+\.blob\.vercel-storage\.com\//.test(u)) {
    try { return await read(u); } catch { /* fall through to the proxy */ }
  }
  return read(`/api/clips/proxy?url=${encodeURIComponent(u)}`);
}

type EditorTab = "ai" | "edit" | "frame" | "text" | "look" | "audio" | "media";

// ─── Main ─────────────────────────────────────────────────────────────────────

function ClipsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const videoRef       = useRef<HTMLVideoElement>(null);
  const bgVideoRef     = useRef<HTMLVideoElement>(null);
  const stageWrapRef   = useRef<HTMLDivElement>(null);
  const pointerRef     = useRef<{ x: number; startCropX: number; width: number; moved: boolean } | null>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const musicInputRef  = useRef<HTMLInputElement>(null);
  const soundAssetRef  = useRef<HTMLInputElement>(null);
  const imageAssetRef  = useRef<HTMLInputElement>(null);
  const videoAssetRef  = useRef<HTMLInputElement>(null);

  const [url, setUrl]               = useState("");
  const [fetching, setFetching]     = useState(false);
  const [clip, setClip]             = useState<ClipInfo | null>(null);
  const [fetchError, setFetchError] = useState("");

  // Non-destructive timeline: `clips` is the source of truth for what's
  // included and in what order. `trimStart`/`trimEnd` are kept as derived
  // reads of the single clip (the common case, and the only shape the 8
  // single-clip AI features ever see) so the ~40 existing read sites below
  // don't need touching; `setTrimStart`/`setTrimEnd` are compatibility
  // wrappers so existing call sites (AI-edit apply, highlights, tighten,
  // reset) keep working unchanged as long as there's 0 or 1 clips.
  const [clips, setClips] = useState<Clip[]>([]);
  const clipsRef = useRef<Clip[]>([]);
  clipsRef.current = clips;
  const trimStart = clips[0]?.sourceStart ?? 0;
  const trimEnd = clips[0]?.sourceEnd ?? 0;
  const timelineDuration = totalDuration(clips);
  // Gates the AI-assisted single-clip tools (Auto-Highlights apply, AI edit
  // assistant, Auto-edit, Auto-reframe, Auto-tighten, Virality, Cover,
  // B-roll) — they read/write the flat trimStart/trimEnd shape and aren't
  // timeline-aware, so they stay available only while there's one clip.
  const singleClip = clips.length <= 1;
  const multiClipNote = "Available with a single clip on the timeline.";
  // Which clip the real <video> element is currently seeked into — needed to
  // disambiguate source→timeline time when a source range is covered by more
  // than one clip (reachable via split + reorder).
  const ownerClipIdRef = useRef<string | undefined>(undefined);
  function setTrimStart(v: number) {
    setClips((prev) => relayoutClips([{
      id: prev[0]?.id ?? uid(), sourceStart: v, sourceEnd: prev[0]?.sourceEnd ?? v, timelineStart: 0, duration: 0,
    }]));
  }
  function setTrimEnd(v: number) {
    setClips((prev) => relayoutClips([{
      id: prev[0]?.id ?? uid(), sourceStart: prev[0]?.sourceStart ?? 0, sourceEnd: v, timelineStart: 0, duration: 0,
    }]));
  }
  const [caption, setCaption]                 = useState("");
  const [textStyle, setTextStyle]             = useState<TextStyle>(DEFAULT_TEXT_STYLE);
  const [captionX, setCaptionX]               = useState(50); // 0..100 % of width  (center of text)
  const [captionY, setCaptionY]               = useState(88); // 0..100 % of height (center of text)
  const [captionSize, setCaptionSize]         = useState(1);  // font-size multiplier
  const [cropAspect, setCropAspect]           = useState<AspectKey>("original");
  const [cropFill, setCropFill]               = useState<"crop" | "blur" | "split">("crop");
  // Split screen: 2–4 screens, each its own crop of the source (see SplitScreen.tsx).
  const [split, setSplit]                     = useState<SplitConfig>(() => defaultSplit());
  // Hidden players for screens showing their own video, keyed by url.
  const splitMediaRef = useRef<Record<string, HTMLVideoElement | null>>({});
  const [cropX, setCropX]                     = useState(50); // 0=left, 50=center, 100=right
  const [cropKeys, setCropKeys]               = useState<CropKeyframe[]>([]);
  const [cropSmooth, setCropSmooth]           = useState(true); // smooth pan vs hard cut
  const [cropDirty, setCropDirty]             = useState(false); // user is dialing in cropX manually
  const [zoom, setZoom]                       = useState(1);    // 1..3 magnification
  const [zoomKeys, setZoomKeys]               = useState<ZoomKeyframe[]>([]);
  const [zoomSmooth, setZoomSmooth]           = useState(true);
  const [zoomDirty, setZoomDirty]             = useState(false);
  const [draggingCaption, setDraggingCaption] = useState(false);

  const cropEnabled = cropAspect !== "original";
  const blurFill = cropEnabled && cropFill === "blur";
  const splitOn  = cropEnabled && cropFill === "split";
  // Split needs a target frame, so turning it on from "Original" picks 9:16.
  function toggleSplit() {
    if (splitOn) { setCropFill("crop"); return; }
    if (!cropEnabled) setCropAspect("9:16");
    setCropFill("split");
  }
  const [introText, setIntroText]             = useState("");
  const [outroText, setOutroText]             = useState("");

  const [subtitles, setSubtitles]             = useState<Subtitle[]>([]);
  const [subtitleLang, setSubtitleLang]       = useState("original");
  const [subtitlesLoading, setSubtitlesLoading] = useState(false);
  const [subtitleMsg, setSubtitleMsg]         = useState("");
  // Animated caption style: 'classic' lines, 'karaoke' (phrase + highlighted word),
  // or 'word' (one word at a time). Highlight = active-word colour for the latter two.
  const [subtitleStyle, setSubtitleStyle]     = useState<"classic" | "karaoke" | "word">("classic");
  const [subtitleHighlight, setSubtitleHighlight] = useState("FFE000");
  // Drag-to-reposition + size, same model as the static caption (captionX/Y/Size).
  const [subtitleX, setSubtitleX]             = useState(50); // 0..100 % of width (center of text)
  const [subtitleY, setSubtitleY]             = useState(88); // 0..100 % of height
  const [subtitleSize, setSubtitleSize]       = useState(1);  // font-size multiplier
  // Animated-caption details: words per line, caps, outline, active-word mode, pop.
  const [subtitleLook, setSubtitleLook]       = useState<SubtitleLook>(DEFAULT_SUBTITLE_LOOK);
  const [draggingSubtitle, setDraggingSubtitle] = useState(false);
  const [subtitleEmoji, setSubtitleEmoji]     = useState(false);
  const [emojiLoading, setEmojiLoading]       = useState(false);
  // Set when an AI/auto edit wants emoji on subtitles that are still being
  // transcribed — generateSubtitles re-runs the tagger once they land.
  const wantEmojiRef = useRef(false);

  const [musicFileName, setMusicFileName]   = useState("");
  const [musicServerUrl, setMusicServerUrl] = useState("");
  const [musicLocalUrl, setMusicLocalUrl]   = useState("");
  const [musicUploading, setMusicUploading] = useState(false);
  const [musicVolume, setMusicVolume]       = useState(80);
  const [musicDuration, setMusicDuration]   = useState(0); // seconds; 0 = entire clip
  const [videoVolume, setVideoVolume]       = useState(100);
  const [videoPitch, setVideoPitch]         = useState(0); // semitones, -12..+12

  const [speed, setSpeed]           = useState(1);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast]     = useState(0);
  const [saturation, setSaturation] = useState(0);
  const [colorFilter, setColorFilter] = useState<ColorFilterKey>("none");
  const [mirror, setMirror]         = useState(false);
  const [fadeIn, setFadeIn]         = useState(0); // seconds, on the output timeline
  const [fadeOut, setFadeOut]       = useState(0);
  const [vignette, setVignette]     = useState(false);
  const [effects, setEffects]       = useState<EffectSegment[]>([]); // timed effect windows
  const [effectType, setEffectType] = useState<EffectKey>("flash");  // next segment's type
  const [volumeKeys, setVolumeKeys] = useState<VolumeKeyframe[]>([]); // audio ducking
  const [loudnorm, setLoudnorm]     = useState(false); // auto-level audio on export
  const [captionStart, setCaptionStart] = useState(0); // 0 = from clip start
  const [captionEnd, setCaptionEnd]     = useState(0); // 0 = until clip end

  const [playing, setPlaying]         = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [videoAspect, setVideoAspect] = useState(16 / 9);
  const [srcDims, setSrcDims]         = useState({ w: 1280, h: 720 });
  const [srcFps, setSrcFps]           = useState(30);
  const [stageBox, setStageBox]       = useState({ w: 0, h: 0 });
  const [draggingCrop, setDraggingCrop] = useState(false);

  const [localVideoUrl, setLocalVideoUrl] = useState("");
  const [blobVideoUrl,  setBlobVideoUrl]  = useState(""); // original blob: URL – avoids re-downloading for FFmpeg
  const [saveError, setSaveError]     = useState("");
  const [saving, setSaving]           = useState(false);
  const [uploading, setUploading]     = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [processing, setProcessing]   = useState(false);
  const [processError, setProcessError] = useState("");
  const [processPhase, setProcessPhase] = useState<"" | "loading-ff" | "loading-video" | "encoding" | "uploading">("");
  const [processProgress, setProcessProgress] = useState(0);
  const [processMode, setProcessMode] = useState<"schedule" | "save">("schedule");
  const [saveDone, setSaveDone]       = useState(false);
  // Free plan caps exports to 720p + watermark — enforced server-side, so free
  // exports always go through the server path (see processClip).
  const [isFreePlan, setIsFreePlan]   = useState(false);

  const [aiPrompt, setAiPrompt]   = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiStatus, setAiStatus]   = useState<{ ok: boolean; msg: string } | null>(null);
  const [aiChanges, setAiChanges] = useState<string[]>([]);     // human labels of what the last AI edit changed
  const [autoLoading, setAutoLoading] = useState(false);        // one-click Auto-edit in flight
  const [autoEditTighten, setAutoEditTighten] = useState(true); // Auto-edit removes dead air first
  // Auto-edit progress (index into autoSteps) + the AI's "why" notes for the last plan.
  const [autoStep, setAutoStep] = useState(0);
  const [autoSteps, setAutoSteps] = useState<string[]>([]);
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  // Running log of assistant requests this session (newest first).
  const [aiLog, setAiLog] = useState<{ id: string; prompt: string; changes: string[] }[]>([]);
  // Editing style ("copy a style"): drives Auto-edit + Apply look.
  const styles = useStyles();
  const [editStyle, setEditStyle] = useState<StyleOption | null>(null);
  const [copyStyleOpen, setCopyStyleOpen] = useState(false);
  const [viralityLoading, setViralityLoading] = useState(false);
  const [virality, setVirality] = useState<{ score: number; hookStrength: number; verdict: string; reasons: string[]; fixes: string[] } | null>(null);
  const [coverLoading, setCoverLoading] = useState(false);
  const [cover, setCover] = useState<{ url: string; hooks: string[]; chosenHook: string; frameTime: number; reason: string } | null>(null);
  const [reframeLoading, setReframeLoading] = useState(false);  // auto face-tracking reframe in flight
  // Full-state undo/redo stack — covers every AI edit AND every manual
  // structural op (split/delete/reorder/trim-edge, subtitle edits). Pushed
  // right before applying each change; see captureEditState/restoreEditState.
  const history = useHistory<ReturnType<typeof captureEditState>>();

  // ── AI video generation (Veo) ──

  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [brollLoading, setBrollLoading] = useState(false);
  const [brollMsg, setBrollMsg] = useState("");
  const [tightenLoading, setTightenLoading] = useState(false);
  const [tightenMsg, setTightenMsg] = useState("");
  const [titleIdeas, setTitleIdeas] = useState<string[]>([]);
  const [titleIdeasLoading, setTitleIdeasLoading] = useState(false);
  const [titleIdeasError, setTitleIdeasError] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [captionIdeas, setCaptionIdeas] = useState<string[]>([]);
  const [captionIdeasLoading, setCaptionIdeasLoading] = useState(false);
  const [captionIdeasError, setCaptionIdeasError] = useState("");
  const [activeTab, setActiveTab] = useState<EditorTab>("ai");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Phones: shrink the pinned preview so more of the tool panel is visible.
  const [previewCompact, setPreviewCompact] = useState(false);
  // Phones: the URL/import row collapses once a clip is open.
  const [showImport, setShowImport] = useState(false);
  const [highlights, setHighlights]   = useState<Highlight[]>([]);
  const [analyzing, setAnalyzing]     = useState(false);
  const [highlightMsg, setHighlightMsg] = useState("");
  // Accordion: at most one inspector section open at a time (keeps the panel tidy).
  const [openSection, setOpenSection] = useState<string | null>(null);
  const sec = (id: string) => ({
    open: openSection === id,
    onToggle: () => setOpenSection((s) => (s === id ? null : id)),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ffmpegRef = useRef<any>(null);
  const ffLogRef  = useRef<string[]>([]);
  const soundElsRef = useRef<Record<string, HTMLAudioElement | null>>({});
  const videoAssetElsRef = useRef<Record<string, HTMLVideoElement | null>>({});
  const musicElRef  = useRef<HTMLAudioElement | null>(null);
  const imgDragRef  = useRef<{ id: string; offX: number; offY: number } | null>(null);
  const [draggingImageId, setDraggingImageId] = useState<string | null>(null);

  // Learn the user's plan once so free exports route through the capped +
  // watermarked server path.
  useEffect(() => {
    fetch("/api/clips/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.plan) setIsFreePlan(d.plan === "free"); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Playhead moving hands crop control back to the keyframe track (preview animates).
    // currentTime is TIMELINE time (0-based over the assembled clips), while the
    // real <video> element's own currentTime stays source-absolute (there's one
    // underlying file; the timeline is just cuts/order over it) — map on every
    // tick via the clip the playhead is actually inside (ownerClipIdRef).
    const onTime = () => {
      const cs = clipsRef.current;
      const mapped = sourceTimeToTimelineTime(cs, video.currentTime, ownerClipIdRef.current);
      if (mapped != null) setCurrentTime(mapped);
      setCropDirty(false); setZoomDirty(false);

      // Playing across a clip boundary: jump the real video to the next
      // clip's source start (or pause, on the last clip) the instant we cross
      // the current clip's sourceEnd — otherwise playback would just keep
      // running past the cut into footage the timeline doesn't include.
      if (!video.paused && cs.length > 0) {
        const idx = cs.findIndex((c) => c.id === ownerClipIdRef.current);
        const owner = idx >= 0 ? cs[idx]
          : cs.find((c) => video.currentTime >= c.sourceStart && video.currentTime < c.sourceEnd);
        if (owner && video.currentTime >= owner.sourceEnd - 0.03) {
          const next = cs[cs.findIndex((c) => c.id === owner.id) + 1];
          if (next) { ownerClipIdRef.current = next.id; video.currentTime = next.sourceStart; }
          else video.pause();
        }
      }
    };
    const onLoaded = () => {
      setVideoLoaded(true);
      if (video.videoWidth && video.videoHeight) {
        setVideoAspect(video.videoWidth / video.videoHeight);
        setSrcDims({ w: video.videoWidth, h: video.videoHeight });
      }
      if (video.duration && video.duration > 0 && clipsRef.current.length === 0) {
        const id = uid();
        ownerClipIdRef.current = id;
        setClips(relayoutClips([{ id, sourceStart: 0, sourceEnd: video.duration, timelineStart: 0, duration: 0 }]));
      }
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onLoaded);

    // Estimate the real frame rate from presented frames (used for timed zoom on
    // the client). requestVideoFrameCallback fires once per displayed frame.
    let prev = -1;
    const samples: number[] = [];
    let rafId = 0;
    type VEl = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    };
    const vel = video as VEl;
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (prev >= 0) {
        const dt = meta.mediaTime - prev;
        if (dt > 0.002 && dt < 0.5) {
          samples.push(1 / dt);
          if (samples.length > 24) samples.shift();
          if (samples.length >= 6) {
            const sorted = [...samples].sort((a, b) => a - b);
            const med = sorted[Math.floor(sorted.length / 2)];
            const snapped = [24, 25, 30, 50, 60].reduce((p, c) => (Math.abs(c - med) < Math.abs(p - med) ? c : p), 30);
            setSrcFps(snapped);
          }
        }
      }
      prev = meta.mediaTime;
      if (vel.requestVideoFrameCallback) rafId = vel.requestVideoFrameCallback(onFrame);
    };
    if (vel.requestVideoFrameCallback) rafId = vel.requestVideoFrameCallback(onFrame);

    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onLoaded);
      const cancel = (video as VEl & { cancelVideoFrameCallback?: (id: number) => void }).cancelVideoFrameCallback;
      if (cancel && rafId) cancel.call(video, rafId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip]);

  useEffect(() => {
    if (!clip) return;
    const TABS: EditorTab[] = ["ai", "edit", "frame", "text", "look", "audio", "media"];
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.code === "KeyZ") { e.preventDefault(); undo(); return; }
      if (mod && ((e.shiftKey && e.code === "KeyZ") || e.code === "KeyY")) { e.preventDefault(); redo(); return; }
      if (mod || e.altKey) return;
      if (e.key === "?") { e.preventDefault(); setShortcutsOpen((v) => !v); return; }
      if (e.key === "Escape") { setShortcutsOpen(false); return; }
      switch (e.code) {
        case "Space": e.preventDefault(); togglePlay(); break;
        case "KeyK": e.preventDefault(); videoRef.current?.pause(); break;
        case "KeyJ": e.preventDefault(); seekTo(Math.max(0, currentTime - 5)); break;
        case "KeyL": e.preventDefault(); seekTo(Math.min(timelineDuration, currentTime + 5)); break;
        case "ArrowLeft": e.preventDefault(); seekTo(Math.max(0, currentTime - (e.shiftKey ? 5 : 1))); break;
        case "ArrowRight": e.preventDefault(); seekTo(Math.min(timelineDuration, currentTime + (e.shiftKey ? 5 : 1))); break;
        case "Comma": e.preventDefault(); stepFrames(-1); break;
        case "Period": e.preventDefault(); stepFrames(1); break;
        case "Home": e.preventDefault(); seekTo(0); break;
        case "End": e.preventDefault(); seekTo(Math.max(0, timelineDuration - 0.05)); break;
        case "KeyS": e.preventDefault(); handleSplit(); break;
        case "KeyQ": e.preventDefault(); handleTrimToPlayhead("start"); break;
        case "KeyW": e.preventDefault(); handleTrimToPlayhead("end"); break;
        case "Delete": case "Backspace": {
          const at = clips.find((c) => currentTime >= c.timelineStart && currentTime < c.timelineStart + c.duration);
          if (at && clips.length > 1) { e.preventDefault(); handleDeleteClip(at.id); }
          break;
        }
        default:
          if (/^Digit[1-7]$/.test(e.code)) { setActiveTab(TABS[Number(e.code.slice(5)) - 1]); setOpenSection(null); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, currentTime, timelineDuration, clips]);

  // Live preview: keep playback rate in sync with the chosen speed
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, clip, videoLoaded]);

  // Live preview: drive the main video's volume (static level or keyframed ducking).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const base = volumeKeys.length > 0 ? volumeAt(volumeKeys, currentTime, videoVolume) : videoVolume;
    // Times the segment under the playhead's own level (the browser caps at
    // 100%, so a boosted segment previews at full volume; export applies it).
    const seg = clipVolume(timelineTimeToSourceTime(clips, currentTime)?.clip);
    v.volume = Math.max(0, Math.min(1, (base / 100) * (seg / 100)));
  }, [currentTime, volumeKeys, videoVolume, clip, videoLoaded, clips]);

  // Live preview: keep the blurred background video in sync with the main one.
  useEffect(() => {
    const v = videoRef.current, bg = bgVideoRef.current;
    if (!v || !bg || !blurFill) return;
    function sync() {
      if (!v || !bg) return;
      if (Math.abs(bg.currentTime - v.currentTime) > 0.15) bg.currentTime = v.currentTime;
      bg.playbackRate = v.playbackRate || 1;
      if (v.paused) { if (!bg.paused) bg.pause(); }
      else if (bg.paused) bg.play().catch(() => {});
    }
    v.addEventListener("timeupdate", sync);
    v.addEventListener("play", sync);
    v.addEventListener("pause", sync);
    v.addEventListener("seeking", sync);
    v.addEventListener("seeked", sync);
    sync();
    return () => {
      v.removeEventListener("timeupdate", sync);
      v.removeEventListener("play", sync);
      v.removeEventListener("pause", sync);
      v.removeEventListener("seeking", sync);
      v.removeEventListener("seeked", sync);
      bg.pause();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blurFill, clip, videoLoaded]);

  // Live preview: play sound/video assets (at their timestamps) and background
  // music, synced to the video.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sounds = assets.filter((a) => a.type === "sound" && a.localUrl);
    const vids   = assets.filter((a) => a.type === "video" && a.localUrl);

    // `start`/`timelineNow` are TIMELINE time (asset timestamps and the
    // playhead are both in that space now) — the underlying media elements
    // themselves still just play in their own local time once cued.
    function driveClip(el: HTMLMediaElement, timelineNow: number, start: number, vol: number, len: number) {
      el.volume = Math.max(0, Math.min(1, vol));
      el.playbackRate = v!.playbackRate || 1;
      const offset = timelineNow - start;
      const inRange = !v!.paused && offset >= 0 && offset < len;
      if (inRange) {
        if (Math.abs(el.currentTime - offset) > 0.3) el.currentTime = Math.max(0, offset);
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) {
        el.pause();
      }
    }

    function sync() {
      if (!v) return;
      const timelineNow = sourceTimeToTimelineTime(clipsRef.current, v.currentTime, ownerClipIdRef.current) ?? 0;
      for (const a of sounds) {
        const el = soundElsRef.current[a.id];
        if (!el) continue;
        driveClip(el, timelineNow, a.timestamp, a.volume / 100, a.duration || el.duration || Infinity);
      }
      for (const a of vids) {
        const el = videoAssetElsRef.current[a.id];
        if (!el) continue;
        driveClip(el, timelineNow, a.timestamp, a.volume / 100, a.duration || el.duration || Infinity);
      }
      const music = musicElRef.current;
      if (music && (musicLocalUrl || musicServerUrl)) {
        // Music starts at timeline 0; plays for musicDuration (0 = whole timeline).
        const len = musicDuration > 0 ? musicDuration : (timelineDuration || Infinity);
        driveClip(music, timelineNow, 0, musicVolume / 100, len);
      }
    }
    function stopAll() {
      for (const a of sounds) { const el = soundElsRef.current[a.id]; if (el) el.pause(); }
      for (const a of vids)   { const el = videoAssetElsRef.current[a.id]; if (el) el.pause(); }
      if (musicElRef.current) musicElRef.current.pause();
    }

    v.addEventListener("timeupdate", sync);
    v.addEventListener("play", sync);
    v.addEventListener("pause", stopAll);
    v.addEventListener("seeking", sync);
    v.addEventListener("seeked", sync);
    v.addEventListener("ended", stopAll);
    return () => {
      v.removeEventListener("timeupdate", sync);
      v.removeEventListener("play", sync);
      v.removeEventListener("pause", stopAll);
      v.removeEventListener("seeking", sync);
      v.removeEventListener("seeked", sync);
      v.removeEventListener("ended", stopAll);
      stopAll();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, clip, videoLoaded, musicLocalUrl, musicServerUrl, musicVolume, musicDuration, timelineDuration]);

  // Auto-import a clip passed in via ?url= (e.g. handed off from the To-Do page),
  // then strip the param so a refresh doesn't re-import. Deferred a tick so the
  // state updates don't run synchronously inside the effect body.
  useEffect(() => {
    // "Back to editor" from Compose: reopen the saved project with its edits.
    const resume = searchParams.get("resume");
    if (resume) {
      const t = setTimeout(() => {
        const s = loadEditSession<NonNullable<ReturnType<typeof buildEditSession>>>(resume);
        if (s) resumeEditSession(s.data);
        else setFetchError("That editing session has expired — open the video again to keep editing.");
        router.replace("/clips");
      }, 0);
      return () => clearTimeout(t);
    }
    // A generated clip from the AI Studio comes in as a direct video URL via
    // ?gen= — load it straight (it's already on our storage), no fetch/resolve.
    const gen = searchParams.get("gen");
    if (gen) {
      const title = searchParams.get("t") || "AI clip";
      // A preview cut from the auto-clipper can arrive with preset trim bounds
      // (e.g. an "Auto" length that got silence-snapped server-side) so the
      // editor opens already trimmed to the natural moment instead of the raw window.
      const tsRaw = searchParams.get("ts");
      const teRaw = searchParams.get("te");
      const presetTrim =
        tsRaw != null && teRaw != null && Number.isFinite(Number(tsRaw)) && Number.isFinite(Number(teRaw))
          ? { trimStart: Number(tsRaw), trimEnd: Number(teRaw) }
          : undefined;
      const t = setTimeout(() => {
        loadGeneratedVideo(gen, title, presetTrim);
        router.replace("/clips");
      }, 0);
      return () => clearTimeout(t);
    }
    const incoming = searchParams.get("url");
    if (!incoming) return;
    const t = setTimeout(() => {
      setUrl(incoming);
      fetchClip(incoming);
      router.replace("/clips");
    }, 0);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Measure the player area so the output "stage" can be fit precisely inside it
  useEffect(() => {
    const el = stageWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setStageBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [clip]);

  // Drag-to-reposition the crop window (and tap-to-toggle playback). Pointer
  // events cover both mouse and touch so it works on phones.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const p = pointerRef.current;
      if (!p) return;
      e.preventDefault(); // keep the page from scrolling while dragging the preview
      const dx = e.clientX - p.x;
      if (Math.abs(dx) > 3) p.moved = true;
      if (cropEnabled && !blurFill && !splitOn && p.width > 0) {
        const deltaPct = (dx / p.width) * 100;
        setCropX(Math.max(0, Math.min(100, p.startCropX - deltaPct)));
        setCropDirty(true);
      }
    }
    function onUp() {
      const p = pointerRef.current;
      pointerRef.current = null;
      setDraggingCrop(false);
      if (p && !p.moved) togglePlay();
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropEnabled, blurFill, splitOn]);

  function resetEditState() {
    setClips([]); setCurrentTime(0); ownerClipIdRef.current = undefined;
    setCaption(""); setCaptionX(50); setCaptionY(88); setCaptionSize(1); setTextStyle(DEFAULT_TEXT_STYLE);
    setCropAspect("original"); setCropFill("crop"); setCropX(50); setSplit(defaultSplit());
    setCropKeys([]); setCropSmooth(true); setCropDirty(false);
    setZoom(1); setZoomKeys([]); setZoomSmooth(true); setZoomDirty(false);
    setHighlights([]); setHighlightMsg(""); setAnalyzing(false);
    setSubtitles([]); setSubtitleLang("original"); setSubtitleMsg(""); setSubtitlesLoading(false);
    setSubtitleStyle("classic"); setSubtitleHighlight("FFE000");
    setSubtitleX(50); setSubtitleY(88); setSubtitleSize(1); setSubtitleLook(DEFAULT_SUBTITLE_LOOK);
    setSubtitleEmoji(false); setEmojiLoading(false); wantEmojiRef.current = false;
    setIntroText(""); setOutroText("");
    setSaveDone(false); setVideoAspect(16 / 9);
    setMusicFileName(""); setMusicServerUrl(""); setMusicLocalUrl(""); setMusicVolume(80); setMusicDuration(0); setVideoVolume(100);
    setSpeed(1); setBrightness(0); setContrast(0); setVideoPitch(0);
    setSaturation(0); setColorFilter("none"); setMirror(false); setFadeIn(0); setFadeOut(0);
    setVignette(false); setEffects([]); setVolumeKeys([]); setLoudnorm(false);
    setCaptionStart(0); setCaptionEnd(0);
    setVideoLoaded(false); setProcessError(""); setProcessPhase(""); setProcessProgress(0);
    setAssets([]); setBrollLoading(false); setBrollMsg(""); setTightenLoading(false); setTightenMsg("");
    setViralityLoading(false); setVirality(null); setCoverLoading(false); setCover(null); setBlobVideoUrl(""); setSaveError("");
  }

  async function fetchClip(explicitUrl?: string) {
    const target = (explicitUrl ?? url).trim();
    if (!target) return;
    setFetching(true); setFetchError(""); setClip(null); setLocalVideoUrl("");
    resetEditState();
    try {
      const res  = await fetch("/api/clips/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: target }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setClip(data);
      setTrimEnd(data.duration);
      if (data.alreadySaved) setLocalVideoUrl(data.videoUrl);
      else saveToServer(data.videoUrl, data.title, data.clipPageUrl);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to fetch clip");
    } finally {
      setFetching(false);
    }
  }

  async function saveToServer(videoUrl: string, title: string, clipPageUrl?: string) {
    setSaving(true);
    setSaveError("");
    try {
      const res  = await fetch("/api/clips/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoUrl, clipPageUrl, title }) });
      const data = await res.json();
      if (res.ok && data.url) setLocalVideoUrl(data.url);
      else setSaveError(data.error ?? "Could not download clip to server");
    } catch {
      setSaveError("Network error while downloading clip");
    }
    setSaving(false);
  }

  async function handleLocalFile(file: File) {
    const isVideo = file.type.startsWith("video/") ||
      /\.(mp4|mov|mkv|avi|webm|wmv|flv|m4v|ts|m2ts|3gp)$/i.test(file.name);
    if (!isVideo) return;
    setFetchError(""); setClip(null); resetEditState();
    const blobUrl    = URL.createObjectURL(file);
    const measureUrl = URL.createObjectURL(file);
    const duration   = await new Promise<number>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => { URL.revokeObjectURL(measureUrl); resolve(v.duration || 0); };
      v.onerror = () => { URL.revokeObjectURL(measureUrl); resolve(0); };
      v.src = measureUrl;
    });
    const dur  = duration > 0 ? duration : 0;
    const name = file.name.replace(/\.[^.]+$/, "");
    setClip({ platform: "local", title: name, duration: dur, thumbnailUrl: "", videoUrl: blobUrl, streamer: "local" });
    setLocalVideoUrl(blobUrl);
    setBlobVideoUrl(blobUrl); // keep original blob URL for FFmpeg – never overwrite this
    setTrimEnd(dur);
    setUploading(true);
    try {
      setLocalVideoUrl(await uploadFile(file, "upload")); // server URL for compose/server-side ops only
    } catch { /* keep blob URL */ }
    setUploading(false);
  }

  async function handleMusicFile(file: File) {
    if (!file.type.startsWith("audio/")) return;
    setMusicFileName(file.name); setMusicServerUrl(""); setMusicLocalUrl(URL.createObjectURL(file)); setMusicUploading(true);
    try {
      setMusicServerUrl(await uploadFile(file, "upload"));
    } catch { setMusicFileName(""); }
    setMusicUploading(false);
  }

  // Built-in SFX (public/sfx) — already server-fetchable, no upload needed.
  function sfxAsset(k: SfxKey, at: number, volume = 100): AssetItem {
    const fx = SFX_LIBRARY[k];
    return {
      id: uid(), type: "sound", name: fx.label, localUrl: fx.url, serverUrl: fx.url, uploading: false,
      timestamp: Math.max(0, at), duration: fx.duration, volume, x: 0, y: 0, scale: 100,
    };
  }
  function addSfx(k: SfxKey, at: number) {
    setAssets((prev) => [...prev, sfxAsset(k, at)]);
  }

  async function handleAssetFile(file: File, type: "sound" | "image" | "video", at = 0) {
    const localUrl = URL.createObjectURL(file);
    const id = uid();
    setAssets((prev) => [...prev, {
      id, type, name: file.name, localUrl, serverUrl: "", uploading: true,
      timestamp: at, duration: 3, volume: 80, x: 5, y: 5, scale: type === "video" ? 35 : 25,
    }]);
    // Default a sound/video's duration to its real length (user can shorten it).
    if (type !== "image") {
      const probe = type === "sound" ? new Audio(localUrl) : document.createElement("video");
      if (type === "video") { probe.preload = "metadata"; probe.src = localUrl; }
      probe.addEventListener("loadedmetadata", () => {
        if (isFinite(probe.duration) && probe.duration > 0) {
          updateAsset(id, { duration: Math.min(60, Math.round(probe.duration * 10) / 10) });
        }
      }, { once: true });
    }
    try {
      const url = await uploadFile(file, "upload");
      setAssets((prev) => prev.map((a) => a.id === id ? { ...a, serverUrl: url, uploading: false } : a));
    } catch {
      setAssets((prev) => prev.filter((a) => a.id !== id));
    }
  }

  function removeAsset(id: string) {
    setAssets((prev) => {
      const a = prev.find((x) => x.id === id);
      if (a?.localUrl.startsWith("blob:")) URL.revokeObjectURL(a.localUrl);
      return prev.filter((x) => x.id !== id);
    });
  }

  function updateAsset(id: string, patch: Partial<AssetItem>) {
    setAssets((prev) => prev.map((a) => a.id === id ? { ...a, ...patch } : a));
  }

  // ── Timeline tracks: assets + background music as movable/resizable items ──
  const MUSIC_TRACK_ID = "__music";
  const timelineTracks: TrackItem[] = [
    ...assets.map((a): TrackItem => ({
      id: a.id, type: a.type, name: a.name, start: a.timestamp, duration: a.duration || 3,
      volume: a.type === "image" ? undefined : a.volume, uploading: a.uploading,
      thumb: a.type === "image" ? a.localUrl : undefined,
    })),
    ...(musicLocalUrl || musicServerUrl ? [{
      id: MUSIC_TRACK_ID, type: "music" as const, name: musicFileName || "Music", start: 0,
      duration: musicDuration > 0 ? Math.min(musicDuration, timelineDuration || musicDuration) : timelineDuration,
      volume: musicVolume, uploading: musicUploading, fixedStart: true,
    }] : []),
  ];
  function handleTrackChange(id: string, p: TrackPatch) {
    if (id === MUSIC_TRACK_ID) {
      // Music length 0 = "the whole timeline"; dragging to the end snaps back to that.
      if (p.duration != null) setMusicDuration(p.duration >= timelineDuration - 0.05 ? 0 : p.duration);
      if (p.volume != null) setMusicVolume(Math.max(0, Math.min(100, p.volume)));
      return;
    }
    updateAsset(id, {
      ...(p.start != null ? { timestamp: p.start } : {}),
      ...(p.duration != null ? { duration: p.duration } : {}),
      ...(p.volume != null ? { volume: p.volume } : {}),
    });
  }
  function handleTrackDelete(id: string) {
    if (id === MUSIC_TRACK_ID) { setMusicFileName(""); setMusicServerUrl(""); setMusicLocalUrl(""); setMusicDuration(0); return; }
    removeAsset(id);
  }
  function handleAddMedia(type: TrackItemType, file?: File, at?: number) {
    if (type === "music") { if (file) handleMusicFile(file); else musicInputRef.current?.click(); return; }
    if (file) { handleAssetFile(file, type, at ?? 0); return; }
    (type === "sound" ? soundAssetRef : type === "image" ? imageAssetRef : videoAssetRef).current?.click();
  }

  // AI Auto B-roll: read the transcript, pick visual moments, fetch matching
  // stock photos, and drop them in as timed overlay assets (the existing system).
  // Needs subtitles for the timeline of words → visuals.
  async function runAutoBroll() {
    if (!clip || brollLoading) return;
    if (subtitles.length === 0) {
      setActiveTab("media");
      setBrollMsg("Generate subtitles first — B-roll picks its moments from the transcript.");
      return;
    }
    setBrollLoading(true); setBrollMsg("");
    try {
      const res = await fetch("/api/clips/broll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: subtitles.map((s) => ({ start: s.start, end: s.end, text: s.text })),
          aspectRatio: cropAspect,
          duration: Math.max(1, trimEnd - trimStart),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not add B-roll");
      const found: { timestamp: number; url: string; name: string }[] = Array.isArray(data.assets) ? data.assets : [];
      if (found.length === 0) { setBrollMsg("No clear B-roll moments found in this clip."); return; }
      // Add as full-width image overlays sitting in the upper third — a clean
      // B-roll insert that doesn't fully cover the speaker. Drag/resize after.
      setAssets((prev) => [
        ...prev,
        ...found.map((f) => ({
          id: uid(), type: "image" as const, name: f.name,
          localUrl: f.url, serverUrl: f.url, uploading: false,
          timestamp: Math.max(0, Math.min(trimEnd, f.timestamp)),
          duration: 2.5, volume: 0, x: 0, y: 6, scale: 100,
        })),
      ]);
      setActiveTab("media");
      setBrollMsg(`Added ${found.length} B-roll insert${found.length > 1 ? "s" : ""} — drag to reposition.`);
    } catch (e) {
      setBrollMsg(e instanceof Error ? e.message : "Could not add B-roll");
    } finally {
      setBrollLoading(false);
    }
  }

  // Filler-word ranges from the current transcript (when subtitles exist) so
  // Auto-tighten can drop "um/uh/er…" along with the silences.
  const FILLER_RE = /^(u+m+|u+h+|e+r+|a+h+|h+m+|m+h+|mhm|uhm|erm)[.,!?]*$/i;
  function fillerRanges(): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    for (const s of subtitles) {
      for (const w of s.words ?? []) {
        if (w && typeof w.start === "number" && typeof w.end === "number" && FILLER_RE.test((w.word || "").trim())) {
          out.push({ start: w.start, end: w.end });
        }
      }
    }
    return out;
  }

  const fetchableUrl = (u?: string) => !!u && (u.startsWith("/") || /^https?:/.test(u));
  // A server-fetchable URL for the current working source (server ops can't read blob:).
  function tightenableSrc(): string {
    if (!clip) return "";
    return fetchableUrl(localVideoUrl) ? localVideoUrl
      : fetchableUrl(clip.videoUrl) ? clip.videoUrl : "";
  }

  // Core tighten: re-render the kept ranges, then ADOPT the result as the working
  // source. It's a pre-pass, so it resets time-based edits (trim, subtitles,
  // crop/zoom/volume keyframes, timed effects) keyed to the old timeline. Returns
  // the new source `{ url, duration }` (so callers can keep working without waiting
  // for React state to flush), or null when there was nothing worth cutting. Throws
  // on a real failure.
  async function tightenClip(src: string, tStart: number, tEnd: number): Promise<
    { url: string; duration: number; removed: number; segments: number; fillers: number } | null
  > {
    const res = await fetch("/api/clips/tighten", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoUrl: src, trimStart: tStart, trimEnd: tEnd, fillerWords: fillerRanges() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Could not tighten the clip");
    if (!data.url || !(data.removed > 0)) return null;

    const newDur = Number(data.duration) || (tEnd - tStart);
    // Adopt the tightened clip as the source for preview + both export paths.
    setClip((prev) => prev ? { ...prev, videoUrl: data.url, duration: newDur } : prev);
    setLocalVideoUrl(data.url);
    setBlobVideoUrl(data.url);
    // Reset edits that were keyed to the old (looser) timeline. `data.url` is a
    // brand-new file, so the old `clips` offsets are meaningless — seek the raw
    // video directly to 0 rather than through seekTo() (which would resolve
    // against the stale pre-tighten clips still bound in this closure).
    const freshId = uid();
    setClips(relayoutClips([{ id: freshId, sourceStart: 0, sourceEnd: newDur, timelineStart: 0, duration: 0 }]));
    setSubtitles([]); setSubtitleMsg(""); setSubtitleEmoji(false);
    setCropKeys([]); setZoomKeys([]); setEffects([]); setVolumeKeys([]);
    setCaptionStart(0); setCaptionEnd(0);
    ownerClipIdRef.current = freshId;
    if (videoRef.current) videoRef.current.currentTime = 0;
    setCurrentTime(0);
    return { url: data.url, duration: newDur, removed: Number(data.removed), segments: Number(data.segments), fillers: Number(data.fillers ?? 0) };
  }

  async function runAutoTighten() {
    if (!clip || tightenLoading) return;
    const src = tightenableSrc();
    if (!src) { setTightenMsg("Still saving the clip — try again in a moment."); return; }
    setTightenLoading(true); setTightenMsg("");
    try {
      const r = await tightenClip(src, trimStart, trimEnd > trimStart ? trimEnd : (clip.duration || trimStart));
      if (!r) { setTightenMsg("No dead air found to trim."); return; }
      const hadFillers = r.fillers > 0;
      setTightenMsg(`Removed ${r.removed.toFixed(1)}s${hadFillers ? " (incl. fillers)" : ""} across ${r.segments} cut${r.segments > 1 ? "s" : ""}. Re-generate subtitles if you need them.`);
    } catch (e) {
      setTightenMsg(e instanceof Error ? e.message : "Could not tighten the clip");
    } finally {
      setTightenLoading(false);
    }
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }

  // Frame-accurate nudge (pauses first so the step is visible).
  function stepFrames(n: number) {
    videoRef.current?.pause();
    const fps = srcFps || 30;
    seekTo(Math.max(0, Math.min(timelineDuration, currentTime + n / fps)));
  }

  // `t` is TIMELINE time — resolve which clip owns it and seek the real video
  // to the matching SOURCE time within that clip.
  function seekTo(t: number) {
    const resolved = timelineTimeToSourceTime(clips, t);
    if (resolved) {
      if (videoRef.current) videoRef.current.currentTime = resolved.sourceTime;
      ownerClipIdRef.current = resolved.clip.id;
    }
    setCurrentTime(t);
    setCropDirty(false);
  }

  // ── Non-destructive timeline: split / delete / reorder / trim-edge ──
  // Pure array ops over `clips` (src/lib/timeline.ts) — the source media is
  // never touched, only the metadata describing which cuts are included.
  // Each discrete op pushes one undo snapshot before applying; trim-edge is a
  // continuous drag, so its snapshot is pushed once at drag-start instead
  // (handleTrimDragStart, wired to ClipTimeline's onTrimDragStart).
  function handleSplit() {
    history.push(captureEditState());
    setClips((prev) => splitClipAtTimelineTime(prev, currentTime));
  }
  function handleDeleteClip(clipId: string) {
    history.push(captureEditState());
    setClips((prev) => (prev.length > 1 ? deleteClipAt(prev, clipId) : prev));
  }
  function handleReorderClip(fromIndex: number, toIndex: number) {
    history.push(captureEditState());
    setClips((prev) => reorderClips(prev, fromIndex, toIndex));
  }
  // Ripple-trim the segment under the playhead so it starts/ends right there.
  function handleTrimToPlayhead(edge: "start" | "end") {
    const hit = timelineTimeToSourceTime(clips, currentTime);
    if (!hit) return;
    history.push(captureEditState());
    const next = trimClipEdge(clips, hit.clip.id, edge, hit.sourceTime, clip?.duration ?? hit.sourceTime);
    setClips(next);
    // After trimming the start, park the playhead on the segment's new first frame.
    if (edge === "start") {
      const c = next.find((x) => x.id === hit.clip.id);
      if (c) {
        if (videoRef.current) videoRef.current.currentTime = c.sourceStart;
        ownerClipIdRef.current = c.id;
        setCurrentTime(c.timelineStart);
      }
    }
  }
  // Segment volume: one undo snapshot per slider gesture (pushed on pointer-down).
  function handleClipVolume(clipId: string, volume: number) {
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, volume: Math.max(0, Math.min(200, Math.round(volume))) } : c)));
  }
  function handleTrimEdge(clipId: string, edge: "start" | "end", newSourceTime: number) {
    setClips((prev) => trimClipEdge(prev, clipId, edge, newSourceTime, clip?.duration ?? newSourceTime));
  }
  function handleTrimDragStart() {
    history.push(captureEditState());
  }

  // Crop position at a given time, from the keyframe track (interpolated or stepped).
  function cropXAt(t: number): number {
    if (cropKeys.length === 0) return cropX;
    const ks = [...cropKeys].sort((a, b) => a.time - b.time);
    if (t <= ks[0].time) return ks[0].x;
    const last = ks[ks.length - 1];
    if (t >= last.time) return last.x;
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      if (t >= a.time && t <= b.time) {
        if (!cropSmooth) return a.x;
        const f = (t - a.time) / ((b.time - a.time) || 1);
        return a.x + (b.x - a.x) * f;
      }
    }
    return last.x;
  }

  // Snapshot the current position at the playhead as a keyframe (replaces a nearby one).
  function addCropKey() {
    const time = currentTime;
    const x = Math.round(cropX);
    setCropKeys((prev) =>
      [...prev.filter((k) => Math.abs(k.time - time) > 0.25), { id: uid(), time, x }]
        .sort((a, b) => a.time - b.time)
    );
    setCropDirty(false);
  }

  function removeCropKey(id: string) {
    setCropKeys((prev) => prev.filter((k) => k.id !== id));
  }

  function setCropPos(x: number) { setCropX(x); setCropDirty(true); }

  // ── Zoom (time-based, mirrors the crop-keyframe machinery) ──
  function zoomAt(t: number): number {
    if (zoomKeys.length === 0) return zoom;
    const ks = [...zoomKeys].sort((a, b) => a.time - b.time);
    if (t <= ks[0].time) return ks[0].z;
    const last = ks[ks.length - 1];
    if (t >= last.time) return last.z;
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      if (t >= a.time && t <= b.time) {
        if (!zoomSmooth) return a.z;
        const f = (t - a.time) / ((b.time - a.time) || 1);
        return a.z + (b.z - a.z) * f;
      }
    }
    return last.z;
  }

  function setZoomVal(z: number) { setZoom(Math.max(1, Math.min(3, z))); setZoomDirty(true); }

  function addZoomKey() {
    const time = currentTime;
    const z = Math.max(1, Math.min(3, Number(zoom.toFixed(2))));
    setZoomKeys((prev) =>
      [...prev.filter((k) => Math.abs(k.time - time) > 0.25), { id: uid(), time, z }]
        .sort((a, b) => a.time - b.time)
    );
    setZoomDirty(false);
  }

  function removeZoomKey(id: string) {
    setZoomKeys((prev) => prev.filter((k) => k.id !== id));
  }

  // ── Auto-highlights: scan the audio for loud "viral moment" peaks ──
  async function findHighlights() {
    if (!clip || analyzing) return;
    setHighlightMsg(""); setHighlights([]);
    if (effectiveDuration > MAX_ANALYZE_SECONDS) {
      setHighlightMsg(`Too long to scan in-browser (best under ${Math.round(MAX_ANALYZE_SECONDS / 60)} min). Trim first.`);
      return;
    }
    setAnalyzing(true);
    try {
      const src = blobVideoUrl || localVideoUrl || clip.videoUrl;
      const bytes = (await loadMediaBytes(src).catch(() => {
        throw new Error("Could not load the video for analysis");
      })).buffer as ArrayBuffer;
      const hs = await detectAudioHighlights(bytes, { duration: effectiveDuration });
      setHighlights(hs);
      if (hs.length === 0) setHighlightMsg("No clear peaks found — the audio is pretty flat.");
    } catch (e) {
      setHighlightMsg(e instanceof Error ? e.message : "Could not analyze audio");
    } finally {
      setAnalyzing(false);
    }
  }

  function applyHighlight(h: Highlight) {
    // h.start/h.end are SOURCE-absolute (from analyzing the raw downloaded
    // video), not timeline time — seek the real video directly to h.start
    // rather than through seekTo() (which would double-apply the clip's own
    // sourceStart against the stale pre-update clips still bound here).
    setTrimStart(h.start);
    setTrimEnd(h.end);
    if (videoRef.current) videoRef.current.currentTime = h.start;
    setCurrentTime(0); // h.start is now the very start of the (single) timeline
  }

  // ── Auto-subtitles: transcribe (and optionally translate) with Gemini ──
  async function generateSubtitles(explicitLang?: string, srcOverride?: string) {
    if (!clip || subtitlesLoading) return;
    const language = explicitLang ?? subtitleLang;
    const src = srcOverride || localVideoUrl || (clip.videoUrl.startsWith("http") ? clip.videoUrl : "");
    if (!src) { setSubtitleMsg("Still saving the clip — try again in a moment."); return; }
    setSubtitlesLoading(true); setSubtitleMsg("");
    try {
      const res = await fetch("/api/clips/subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl: src, language }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to generate subtitles");
      const segs: Subtitle[] = (data.segments ?? [])
        .filter((s: { start?: unknown; end?: unknown; text?: unknown }) =>
          typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string")
        .map((s: { start: number; end: number; text: string; words?: SubWord[] }) => ({
          id: uid(), start: s.start, end: s.end, text: s.text,
          words: Array.isArray(s.words) && s.words.length ? s.words : undefined,
        }));
      setSubtitles(segs);
      if (segs.length === 0) {
        setSubtitleMsg("No speech detected in this clip.");
        wantEmojiRef.current = false;
      } else if (wantEmojiRef.current || subtitleEmoji) {
        // Fresh word objects — re-tag emoji so it tracks the new transcription.
        wantEmojiRef.current = false;
        void applyAutoEmoji(segs);
      }
    } catch (e) {
      setSubtitleMsg(e instanceof Error ? e.message : "Could not generate subtitles");
    } finally {
      setSubtitlesLoading(false);
    }
  }

  // Auto-emoji: ask the AI to tag impactful keywords, then merge the picks onto
  // the subtitle words by flat index. Ensures each segment has concrete word
  // objects first (same even-distribution fallback the renderer uses) so there's
  // always a slot to attach to. Pass `segs` when the state hasn't settled yet.
  async function applyAutoEmoji(segs?: Subtitle[]) {
    const base = segs ?? subtitles;
    if (emojiLoading || base.length === 0) return;
    setEmojiLoading(true); setSubtitleMsg("");
    try {
      const withWords = base.map((s) => ({
        ...s,
        words: subWordWindows(s).map((w) => ({ word: w.word, start: w.start, end: w.end } as SubWord)),
      }));
      const flat: { si: number; wi: number; word: string }[] = [];
      withWords.forEach((s, si) => s.words.forEach((w, wi) => flat.push({ si, wi, word: w.word })));
      const res = await fetch("/api/clips/caption-emojis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ words: flat.map((f) => f.word) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add emoji");
      const assignments: { index: number; emoji: string }[] = Array.isArray(data.assignments) ? data.assignments : [];
      for (const a of assignments) {
        const f = flat[a.index];
        if (f && a.emoji) withWords[f.si].words[f.wi].emoji = a.emoji;
      }
      setSubtitles(withWords);
      setSubtitleEmoji(true);
      if (assignments.length === 0) setSubtitleMsg("No clear spots for emoji in this clip.");
    } catch (e) {
      setSubtitleMsg(e instanceof Error ? e.message : "Could not add emoji");
    } finally {
      setEmojiLoading(false);
    }
  }

  // Whether any subtitle word currently carries an emoji (toggle reuses it
  // instead of re-calling the AI).
  const hasEmoji = subtitles.some((s) => s.words?.some((w) => w.emoji));

  function toggleSubtitleEmoji() {
    if (subtitleEmoji) { setSubtitleEmoji(false); return; }
    if (hasEmoji) { setSubtitleEmoji(true); return; }
    void applyAutoEmoji();
  }

  function updateSubtitle(id: string, text: string) {
    setSubtitles((prev) => prev.map((s) => (s.id === id ? { ...s, text } : s)));
  }
  function removeSubtitle(id: string) {
    history.push(captureEditState());
    setSubtitles((prev) => prev.filter((s) => s.id !== id));
  }
  // Pushed once when a subtitle text/timing field gains focus — one undo step
  // per editing session, not per keystroke (mirrors the trim-edge drag-start
  // debounce: capture before the gesture begins, not on every change).
  function beginSubtitleEdit() {
    history.push(captureEditState());
  }
  // New blank subtitle at the playhead's SOURCE time (subtitles are stored
  // source-relative; the playhead is timeline time).
  function addSubtitle() {
    const src = timelineTimeToSourceTime(clips, currentTime)?.sourceTime ?? 0;
    history.push(captureEditState());
    setSubtitles((prev) => [...prev, { id: uid(), start: src, end: src + 1.5, text: "" }].sort((a, b) => a.start - b.start));
  }
  function retimeSubtitle(id: string, start: number, end: number) {
    if (end <= start) return;
    setSubtitles((prev) => prev.map((s) => (s.id === id ? { ...s, start, end } : s)));
  }
  // Splits at the playhead's source time if it falls inside the subtitle,
  // else the midpoint. Partitions words by side when word timing exists;
  // falls back to a proportional character split of the text otherwise (an
  // approximation for subtitles without word-level timing).
  function splitSubtitle(id: string) {
    const s = subtitles.find((x) => x.id === id);
    if (!s) return;
    const playheadSrc = timelineTimeToSourceTime(clips, currentTime)?.sourceTime;
    const at = playheadSrc != null && playheadSrc > s.start && playheadSrc < s.end
      ? playheadSrc : (s.start + s.end) / 2;
    if (at - s.start < 0.05 || s.end - at < 0.05) return; // too close to an edge

    let firstText: string, secondText: string, firstWords: SubWord[] | undefined, secondWords: SubWord[] | undefined;
    if (s.words && s.words.length > 0) {
      firstWords = s.words.filter((w) => w.start < at);
      secondWords = s.words.filter((w) => w.start >= at);
      firstText = firstWords.map((w) => w.word).join(" ");
      secondText = secondWords.map((w) => w.word).join(" ");
    } else {
      const frac = Math.max(0.05, Math.min(0.95, (at - s.start) / (s.end - s.start)));
      const cut = Math.round(s.text.length * frac);
      firstText = s.text.slice(0, cut).trim();
      secondText = s.text.slice(cut).trim();
    }
    if (!firstText || !secondText) return;

    history.push(captureEditState());
    setSubtitles((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      if (idx === -1) return prev;
      const next = [...prev];
      next.splice(idx, 1,
        { id: uid(), start: s.start, end: at, text: firstText, words: firstWords },
        { id: uid(), start: at, end: s.end, text: secondText, words: secondWords },
      );
      return next.sort((a, b) => a.start - b.start);
    });
  }
  // Merges two ADJACENT (by start-sorted order) subtitles into one.
  function mergeSubtitles(firstId: string, secondId: string) {
    const a = subtitles.find((x) => x.id === firstId);
    const b = subtitles.find((x) => x.id === secondId);
    if (!a || !b) return;
    history.push(captureEditState());
    setSubtitles((prev) => {
      const merged: Subtitle = {
        id: uid(), start: Math.min(a.start, b.start), end: Math.max(a.end, b.end),
        text: `${a.text} ${b.text}`.trim(),
        words: a.words || b.words ? [...(a.words ?? []), ...(b.words ?? [])] : undefined,
      };
      return prev.filter((x) => x.id !== firstId && x.id !== secondId).concat(merged).sort((x, y) => x.start - y.start);
    });
  }

  // Subtitles are stored/edited in SOURCE time (they come from the transcript);
  // map to TIMELINE time for display, exactly the way the server does at
  // export — same shared function, so preview and export always agree.
  const timelineSubs = mapSubtitlesToTimeline(subtitles, clips);
  const currentSubtitle = timelineSubs.find((s) => currentTime >= s.start && currentTime <= s.end);

  // Contiguous per-word windows for a segment (mirrors the server ASS builder),
  // used by the animated-caption preview. Falls back to even distribution when
  // the transcription didn't return word timings.
  function subWordWindows(seg: Subtitle): { word: string; start: number; end: number; emoji?: string }[] {
    let ws = (seg.words ?? []).filter((w) => w && w.word && typeof w.start === "number" && typeof w.end === "number");
    if (!ws.length) {
      const toks = seg.text.split(/\s+/).filter(Boolean);
      const dur = Math.max(0.3, seg.end - seg.start);
      const per = dur / Math.max(1, toks.length);
      ws = toks.map((w, i) => ({ word: w, start: seg.start + i * per, end: seg.start + (i + 1) * per }));
    }
    const sorted = [...ws].sort((a, b) => a.start - b.start);
    return sorted.map((w, i) => ({
      word: w.word,
      start: i === 0 ? Math.max(seg.start, w.start) : sorted[i].start,
      end: i < sorted.length - 1 ? sorted[i + 1].start : Math.max(w.end, seg.end),
      emoji: w.emoji,
    }));
  }

  function triggerDownload(blob: Blob, filename: string) {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }

  function flagSaved() {
    setProcessing(false); setProcessPhase(""); setProcessProgress(0);
    setSaveDone(true);
    setTimeout(() => setSaveDone(false), 4000);
  }

  async function downloadToPC() {
    if (!clip) return;
    setDownloading(true);
    try {
      const apiUrl = localVideoUrl
        ? `/api/clips/download?url=${encodeURIComponent(localVideoUrl)}`
        : clip.clipPageUrl
          ? `/api/clips/download?pageUrl=${encodeURIComponent(clip.clipPageUrl)}`
          : `/api/clips/download?url=${encodeURIComponent(clip.videoUrl)}`;
      const res = await fetch(apiUrl);
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Download failed" })); throw new Error(err.error ?? "Download failed"); }
      const blob      = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a         = document.createElement("a");
      a.href = objectUrl; a.download = `${clip.title.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 50)}.mp4`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  // Snapshot of every editable field — pushed to the undo stack before any
  // edit (AI-driven or manual structural/subtitle op) applies.
  function captureEditState() {
    return {
      clips, caption, captionX, captionY, captionSize, textStyle,
      cropAspect, cropFill, cropX, cropKeys, cropSmooth, zoom, zoomKeys, zoomSmooth, split,
      speed, brightness, contrast, saturation, colorFilter, mirror, fadeIn, fadeOut,
      vignette, loudnorm, captionStart, captionEnd, effects, volumeKeys, videoVolume,
      videoPitch, introText, outroText, subtitles, subtitleLang, subtitleStyle, subtitleHighlight, subtitleEmoji,
      subtitleX, subtitleY, subtitleSize, subtitleLook,
    };
  }

  function restoreEditState(s: ReturnType<typeof captureEditState>) {
    setClips(s.clips);
    // Seek the real video directly to the restored timeline's first clip —
    // seekTo() would resolve against the stale pre-restore clips still bound
    // in this closure.
    const first = s.clips[0];
    if (videoRef.current) videoRef.current.currentTime = first?.sourceStart ?? 0;
    ownerClipIdRef.current = first?.id;
    setCurrentTime(0);
    setCaption(s.caption); setCaptionX(s.captionX); setCaptionY(s.captionY); setCaptionSize(s.captionSize);
    setTextStyle(s.textStyle);
    setCropAspect(s.cropAspect); setCropFill(s.cropFill); setCropX(s.cropX); setSplit(s.split);
    setCropKeys(s.cropKeys); setCropSmooth(s.cropSmooth); setCropDirty(false);
    setZoom(s.zoom); setZoomKeys(s.zoomKeys); setZoomSmooth(s.zoomSmooth); setZoomDirty(false);
    setSpeed(s.speed); setBrightness(s.brightness); setContrast(s.contrast); setSaturation(s.saturation);
    setColorFilter(s.colorFilter); setMirror(s.mirror); setFadeIn(s.fadeIn); setFadeOut(s.fadeOut);
    setVignette(s.vignette); setLoudnorm(s.loudnorm); setCaptionStart(s.captionStart); setCaptionEnd(s.captionEnd);
    setEffects(s.effects); setVolumeKeys(s.volumeKeys); setVideoVolume(s.videoVolume); setVideoPitch(s.videoPitch);
    setIntroText(s.introText); setOutroText(s.outroText);
    setSubtitles(s.subtitles); setSubtitleLang(s.subtitleLang);
    setSubtitleStyle(s.subtitleStyle); setSubtitleHighlight(s.subtitleHighlight);
    setSubtitleEmoji(s.subtitleEmoji);
    setSubtitleX(s.subtitleX); setSubtitleY(s.subtitleY); setSubtitleSize(s.subtitleSize);
    setSubtitleLook(s.subtitleLook);
  }

  // ── Back-to-editor sessions ────────────────────────────────────────────────
  // Everything needed to reopen this project from Compose. Only server-stored
  // media is referenced (blob: URLs die with the page), so if the source never
  // reached the server there's nothing restorable and Compose falls back to
  // opening the exported video instead.
  function buildEditSession() {
    if (!clip || !localVideoUrl || localVideoUrl.startsWith("blob:")) return null;
    return {
      clip: { ...clip, videoUrl: localVideoUrl },
      localVideoUrl,
      edit: captureEditState(),
      music: musicServerUrl ? { fileName: musicFileName, serverUrl: musicServerUrl, volume: musicVolume, duration: musicDuration } : null,
      assets: assets
        .filter((a) => !a.uploading && a.serverUrl && !a.serverUrl.startsWith("blob:"))
        .map((a) => ({ ...a, localUrl: a.serverUrl })),
    };
  }

  function goToCompose(exportUrl: string) {
    if (!clip) return;
    const session = buildEditSession();
    const sessionId = session ? saveEditSession(session, exportUrl, clip.title) : null;
    const params = new URLSearchParams({ videoUrl: exportUrl, videoTitle: clip.title });
    if (sessionId) params.set("session", sessionId);
    router.push(`/compose?${params}`);
  }

  function resumeEditSession(data: NonNullable<ReturnType<typeof buildEditSession>>) {
    setFetchError(""); setUrl("");
    resetEditState();
    setClip(data.clip);
    setLocalVideoUrl(data.localVideoUrl);
    restoreEditState(data.edit);
    if (data.music) {
      setMusicFileName(data.music.fileName); setMusicServerUrl(data.music.serverUrl);
      setMusicVolume(data.music.volume); setMusicDuration(data.music.duration);
    }
    setAssets(data.assets);
  }

  function undo() {
    const s = history.undo(captureEditState());
    if (!s) return;
    restoreEditState(s);
    setAiChanges([]); setAiNotes([]);
    setAiStatus({ ok: true, msg: "Undone" });
    setTimeout(() => setAiStatus(null), 2000);
  }

  function redo() {
    const s = history.redo(captureEditState());
    if (!s) return;
    restoreEditState(s);
    setAiChanges([]);
    setAiStatus({ ok: true, msg: "Redone" });
    setTimeout(() => setAiStatus(null), 2000);
  }

  // Human-readable list of what an edit object changes vs the current state.
  function diffEdits(e: Record<string, unknown>): string[] {
    const out: string[] = [];
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) < eps;

    const ts = num(e.trimStart), te = num(e.trimEnd);
    if (clips.length <= 1 && !(Array.isArray(e.segments) && e.segments.length > 0)
        && ((ts !== undefined && !near(ts, trimStart)) || (te !== undefined && !near(te, trimEnd))))
      out.push(`Trim ${(ts ?? trimStart).toFixed(1)}–${(te ?? trimEnd).toFixed(1)}s`);
    if (typeof e.caption === "string" && e.generateSubtitles !== true && e.caption !== caption)
      out.push(e.caption ? `Caption “${e.caption.slice(0, 16)}${e.caption.length > 16 ? "…" : ""}”` : "Caption removed");
    if (typeof e.cropAspect === "string" && e.cropAspect !== cropAspect) out.push(`Aspect → ${e.cropAspect}`);
    if ((e.cropFill === "crop" || e.cropFill === "blur") && e.cropFill !== cropFill && cropFill !== "split"
        && (typeof e.cropAspect === "string" ? e.cropAspect : cropAspect) !== "original")
      out.push(e.cropFill === "blur" ? "Blur fill" : "Crop fill");
    if (Array.isArray(e.cropKeys) && e.cropKeys.length > 0) out.push(`Moving crop (${e.cropKeys.length})`);
    else { const cx = num(e.cropX); if (cx !== undefined && Math.abs(cx - cropX) > 2) out.push(cx < 50 ? "Crop ←" : "Crop →"); }
    if (Array.isArray(e.zoomKeys) && e.zoomKeys.length > 0) out.push(`Punch-in zoom (${e.zoomKeys.length}kf)`);
    else { const z = num(e.zoom); if (z !== undefined && !near(z, zoom, 0.02)) out.push(z > 1.001 ? `Zoom ${z.toFixed(1)}×` : "Zoom off"); }
    const sp = num(e.speed); if (sp !== undefined && sp !== speed) out.push(`Speed ${sp}×`);
    if ((num(e.brightness) !== undefined && e.brightness !== brightness)
        || (num(e.contrast) !== undefined && e.contrast !== contrast)
        || (num(e.saturation) !== undefined && e.saturation !== saturation)) out.push("Color tweaks");
    if (typeof e.colorFilter === "string" && e.colorFilter !== colorFilter && (e.colorFilter !== "none" || colorFilter !== "none"))
      out.push(e.colorFilter === "none" ? "Filter off" : `Filter ${e.colorFilter}`);
    if (e.mirror === true && !mirror) out.push("Mirrored");
    const fi = num(e.fadeIn), fo = num(e.fadeOut);
    if ((fi !== undefined && fi > 0 && fi !== fadeIn) || (fo !== undefined && fo > 0 && fo !== fadeOut)) out.push("Fade in/out");
    if (e.vignette === true && !vignette) out.push("Vignette");
    if (e.loudnorm === true && !loudnorm) out.push("Audio leveled");
    const vv = num(e.videoVolume); if (vv !== undefined && vv !== videoVolume) out.push(`Volume ${vv}%`);
    const vp = num(e.videoPitch); if (vp !== undefined && Math.round(vp) !== videoPitch) out.push(`Pitch ${Math.round(vp) > 0 ? "+" : ""}${Math.round(vp)}st`);
    if (Array.isArray(e.volumeKeys) && e.volumeKeys.length > 0) out.push(`Audio ducking (${e.volumeKeys.length})`);
    if (Array.isArray(e.effects) && e.effects.length > 0) out.push(`Timed FX (${e.effects.length})`);
    const styleChanged = (typeof e.captionFont === "string" && e.captionFont !== textStyle.font)
      || (typeof e.captionTemplate === "string" && e.captionTemplate !== textStyle.template)
      || (typeof e.captionColor === "string" && e.captionColor.replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase() !== textStyle.color);
    if (styleChanged) out.push("Text style");
    if (((num(e.captionStart) ?? 0) > 0 || (num(e.captionEnd) ?? 0) > 0)
        && (e.captionStart !== captionStart || e.captionEnd !== captionEnd)) out.push("Caption timing");
    if (typeof e.introText === "string" && e.introText && e.introText !== introText) out.push("Intro card");
    if (typeof e.outroText === "string" && e.outroText && e.outroText !== outroText) out.push("Outro card");
    if (e.generateSubtitles === true) {
      const lang = typeof e.subtitleLanguage === "string" ? e.subtitleLanguage : "original";
      out.push(lang === "original" ? "+ Subtitles" : `+ Subtitles (${lang})`);
    }
    if (typeof e.subtitleStyle === "string" && e.subtitleStyle !== subtitleStyle
        && ["classic", "karaoke", "word"].includes(e.subtitleStyle)) out.push(`Captions → ${e.subtitleStyle}`);
    if (e.subtitleEmoji === true && !subtitleEmoji) out.push("Emoji captions");
    if ((typeof e.subtitleHighlight === "string" && e.subtitleHighlight.toUpperCase() !== subtitleHighlight.toUpperCase())
        || (typeof e.subtitleY === "number" && Math.abs(e.subtitleY - subtitleY) > 1)
        || (typeof e.subtitleSize === "number" && Math.abs(e.subtitleSize - subtitleSize) > 0.02)
        || (e.subtitleLook && typeof e.subtitleLook === "object")) out.push("Subtitle look");
    if (Array.isArray(e.segments) && e.segments.length > 0) {
      const segs = e.segments as Array<{ volume?: unknown }>;
      const vols = segs.filter((g) => typeof g.volume === "number" && g.volume !== 100).length;
      out.push(`Timeline → ${segs.length} segment${segs.length > 1 ? "s" : ""}${vols ? ` · ${vols} with custom volume` : ""}`);
    }
    if (Array.isArray(e.trackEdits)) {
      for (const t of e.trackEdits as Array<{ id?: unknown; remove?: unknown; volume?: unknown; start?: unknown; duration?: unknown }>) {
        const item = timelineTracks.find((x) => x.id === t.id);
        if (!item) continue;
        if (t.remove === true) { out.push(`Remove ${item.name}`); continue; }
        const bits = [
          typeof t.start === "number" && t.start >= 0 && !near(t.start, item.start) ? `@ ${t.start.toFixed(1)}s` : "",
          typeof t.duration === "number" && t.duration >= 0 && !near(t.duration, item.duration) ? `${t.duration.toFixed(1)}s long` : "",
          typeof t.volume === "number" && t.volume >= 0 && t.volume !== item.volume ? `vol ${Math.round(t.volume)}%` : "",
        ].filter(Boolean);
        if (bits.length) out.push(`${item.name}: ${bits.join(", ")}`);
      }
    }
    if (e.splitScreen === "off" && splitOn) out.push("Split screen off");
    if (typeof e.splitScreen === "string" && e.splitScreen !== "keep" && e.splitScreen !== "off"
        && (!splitOn || split.layout !== e.splitScreen)) out.push(`Split → ${e.splitScreen}`);
    if (e.detectFacecam === true) out.push("Detect facecam");
    if (Array.isArray(e.addSounds) && e.addSounds.length > 0) out.push(`+ ${e.addSounds.length} sound effect${e.addSounds.length > 1 ? "s" : ""}`);
    if (typeof e.splitTopHeight === "number" && e.splitTopHeight > 0) out.push(`Top screen ${Math.round(e.splitTopHeight)}%`);
    return out;
  }

  // Apply a full edit object to the controls, record an undo snapshot + a
  // "what changed" list, and trigger subtitle transcription if requested.
  // Shared by the natural-language assistant and one-click Auto-edit.
  function applyAiResult(e: Record<string, unknown>, okMsg: string, srcOverride?: string) {
    history.push(captureEditState()); // snapshot BEFORE applying
    const changes = diffEdits(e);

    // e.trimStart is SOURCE-absolute (the AI schema's documented convention),
    // not timeline time — seek the real video directly rather than through
    // seekTo() (which would resolve against the stale pre-update clips).
    // Timeline segments (AI editor): when given, they replace the timeline and
    // the trim fields are ignored. Without them, trim only applies to a
    // single-segment timeline — setTrimStart/End collapse everything into one
    // segment, which would silently undo the user's cuts.
    let segsApplied = false;
    if (Array.isArray(e.segments) && e.segments.length > 0) {
      const maxT = clip?.duration && clip.duration > 0 ? clip.duration : Infinity;
      const laid = relayoutClips((e.segments as Array<{ start?: unknown; end?: unknown; volume?: unknown }>)
        .filter((g) => g && typeof g.start === "number" && typeof g.end === "number")
        .slice(0, 50)
        .map((g) => ({
          id: uid(),
          sourceStart: Math.max(0, Math.min(maxT, g.start as number)),
          sourceEnd: Math.max(0, Math.min(maxT, g.end as number)),
          timelineStart: 0, duration: 0,
          volume: typeof g.volume === "number" && isFinite(g.volume) ? Math.max(0, Math.min(200, Math.round(g.volume))) : 100,
        })));
      if (laid.length > 0) {
        setClips(laid);
        ownerClipIdRef.current = laid[0].id;
        if (videoRef.current) videoRef.current.currentTime = laid[0].sourceStart;
        setCurrentTime(0);
        segsApplied = true;
      }
    }
    if (!segsApplied && clips.length <= 1) {
      if (typeof e.trimStart === "number") { setTrimStart(e.trimStart); if (videoRef.current) videoRef.current.currentTime = e.trimStart; setCurrentTime(0); }
      if (typeof e.trimEnd   === "number") setTrimEnd(e.trimEnd);
    }
    // Don't touch the static caption when the user asked for subtitles.
    if (typeof e.caption === "string" && e.generateSubtitles !== true) setCaption(e.caption);
    if (typeof e.captionX    === "number")  setCaptionX(Math.max(0, Math.min(100, e.captionX)));
    if (typeof e.captionY    === "number")  setCaptionY(Math.max(0, Math.min(100, e.captionY)));
    if (typeof e.captionSize === "number")  setCaptionSize(Math.max(0.5, Math.min(2.5, e.captionSize)));
    setTextStyle((prev) => {
      const next = { ...prev };
      if (typeof e.captionFont === "string" && (FONT_KEYS as readonly string[]).includes(e.captionFont)) next.font = e.captionFont as TextStyle["font"];
      if (typeof e.captionTemplate === "string" && (TEMPLATE_KEYS as readonly string[]).includes(e.captionTemplate)) next.template = e.captionTemplate as TextStyle["template"];
      if (typeof e.captionColor === "string") {
        const c = e.captionColor.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
        if (c.length === 6) next.color = c.toUpperCase();
      }
      return next;
    });
    if (typeof e.cropVertical === "boolean") setCropAspect(e.cropVertical ? "9:16" : "original");
    if (typeof e.cropAspect === "string" && (ASPECT_KEYS as string[]).includes(e.cropAspect)) setCropAspect(e.cropAspect as AspectKey);
    // The AI's schema only knows crop/blur and echoes a fill on every edit;
    // don't let that silently tear down a split-screen layout the user built.
    if ((e.cropFill === "crop" || e.cropFill === "blur") && cropFill !== "split") setCropFill(e.cropFill);
    if (typeof e.zoom         === "number")  setZoom(Math.max(1, Math.min(3, e.zoom)));
    if (typeof e.cropX        === "number")  setCropX(Math.max(0, Math.min(100, e.cropX)));
    if (typeof e.cropSmooth   === "boolean") setCropSmooth(e.cropSmooth);
    if (Array.isArray(e.cropKeys)) {
      const keys = (e.cropKeys as Array<{ time?: unknown; x?: unknown }>)
        .filter((k) => k && typeof k.time === "number" && typeof k.x === "number")
        .map((k) => ({ id: uid(), time: Math.max(0, k.time as number), x: Math.max(0, Math.min(100, k.x as number)) }))
        .sort((a, b) => a.time - b.time);
      setCropKeys(keys);
      setCropDirty(false);
      if (keys.length > 0) setCropAspect((prev) => (prev === "original" ? "9:16" : prev));
    }
    if (typeof e.zoomSmooth   === "boolean") setZoomSmooth(e.zoomSmooth);
    if (Array.isArray(e.zoomKeys)) {
      const keys = (e.zoomKeys as Array<{ time?: unknown; z?: unknown }>)
        .filter((k) => k && typeof k.time === "number" && typeof k.z === "number")
        .map((k) => ({ id: uid(), time: Math.max(0, k.time as number), z: Math.max(1, Math.min(3, k.z as number)) }))
        .sort((a, b) => a.time - b.time);
      setZoomKeys(keys);
      setZoomDirty(false);
    }
    if (typeof e.speed        === "number")  setSpeed(e.speed as typeof speed);
    if (typeof e.brightness   === "number")  setBrightness(Math.max(-50, Math.min(50, e.brightness)));
    if (typeof e.contrast     === "number")  setContrast(Math.max(-50, Math.min(50, e.contrast)));
    if (typeof e.saturation   === "number")  setSaturation(Math.max(-50, Math.min(50, e.saturation)));
    if (typeof e.colorFilter === "string" && (COLOR_FILTER_KEYS as string[]).includes(e.colorFilter)) {
      setColorFilter(e.colorFilter as ColorFilterKey);
    }
    if (typeof e.mirror       === "boolean") setMirror(e.mirror);
    if (typeof e.fadeIn       === "number")  setFadeIn(Math.max(0, Math.min(3, e.fadeIn)));
    if (typeof e.fadeOut      === "number")  setFadeOut(Math.max(0, Math.min(3, e.fadeOut)));
    if (typeof e.vignette     === "boolean") setVignette(e.vignette);
    if (typeof e.loudnorm     === "boolean") setLoudnorm(e.loudnorm);
    if (typeof e.captionStart === "number")  setCaptionStart(Math.max(0, e.captionStart));
    if (typeof e.captionEnd   === "number")  setCaptionEnd(Math.max(0, e.captionEnd));
    if (Array.isArray(e.effects)) {
      const segs = (e.effects as Array<{ type?: unknown; start?: unknown; end?: unknown }>)
        .filter((s) => s && typeof s.type === "string" && (EFFECT_KEYS as string[]).includes(s.type)
          && typeof s.start === "number" && typeof s.end === "number" && (s.end as number) > (s.start as number))
        .map((s) => ({ id: uid(), type: s.type as EffectKey, start: Math.max(0, s.start as number), end: Math.max(0, s.end as number) }))
        .sort((a, b) => a.start - b.start);
      setEffects(segs);
    }
    if (Array.isArray(e.volumeKeys)) {
      const keys = (e.volumeKeys as Array<{ time?: unknown; v?: unknown }>)
        .filter((k) => k && typeof k.time === "number" && typeof k.v === "number")
        .map((k) => ({ id: uid(), time: Math.max(0, k.time as number), v: Math.max(0, Math.min(200, k.v as number)) }))
        .sort((a, b) => a.time - b.time);
      setVolumeKeys(keys);
    }
    if (typeof e.videoVolume  === "number")  setVideoVolume(Math.max(0, Math.min(100, e.videoVolume)));
    if (typeof e.videoPitch   === "number")  setVideoPitch(Math.max(-12, Math.min(12, Math.round(e.videoPitch))));
    if (typeof e.introText    === "string")  setIntroText(e.introText);
    if (typeof e.outroText    === "string")  setOutroText(e.outroText);

    if (typeof e.subtitleStyle === "string" && ["classic", "karaoke", "word"].includes(e.subtitleStyle)) {
      setSubtitleStyle(e.subtitleStyle as "classic" | "karaoke" | "word");
    }
    // Style-pinned caption placement/colour (only present when a style was applied).
    if (typeof e.subtitleHighlight === "string") {
      const h = e.subtitleHighlight.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
      if (h.length === 6) setSubtitleHighlight(h.toUpperCase());
    }
    if (typeof e.subtitleX    === "number") setSubtitleX(Math.max(0, Math.min(100, e.subtitleX)));
    if (typeof e.subtitleY    === "number") setSubtitleY(Math.max(0, Math.min(100, e.subtitleY)));
    if (typeof e.subtitleSize === "number") setSubtitleSize(Math.max(0.4, Math.min(3, e.subtitleSize)));
    if (e.subtitleLook && typeof e.subtitleLook === "object") setSubtitleLook(sanitizeSubtitleLook({ ...subtitleLook, ...(e.subtitleLook as object) }));
    // Overlay / audio track items.
    if (Array.isArray(e.trackEdits)) {
      for (const t of e.trackEdits as Array<{ id?: unknown; start?: unknown; duration?: unknown; volume?: unknown; remove?: unknown }>) {
        const item = typeof t?.id === "string" ? timelineTracks.find((x) => x.id === t.id) : undefined;
        if (!item) continue;
        if (t.remove === true) { handleTrackDelete(item.id); continue; }
        const patch: TrackPatch = {};
        if (typeof t.start === "number" && t.start >= 0 && !item.fixedStart) patch.start = Math.min(t.start, Math.max(0, timelineDuration - 0.2));
        if (typeof t.duration === "number" && (item.type === "music" ? t.duration >= 0 : t.duration >= 0.2)) patch.duration = t.duration;
        if (typeof t.volume === "number" && t.volume >= 0 && item.volume != null) patch.volume = Math.min(item.type === "music" ? 100 : 200, Math.round(t.volume));
        if (Object.keys(patch).length) handleTrackChange(item.id, patch);
      }
    }

    // Built-in sound effects dropped by the AI editor (TIMELINE seconds).
    if (Array.isArray(e.addSounds)) {
      const add = (e.addSounds as Array<{ sfx?: unknown; time?: unknown; volume?: unknown }>)
        .filter((x) => typeof x?.sfx === "string" && (SFX_KEYS as string[]).includes(x.sfx) && typeof x.time === "number")
        .slice(0, 12)
        .map((x) => sfxAsset(x.sfx as SfxKey, x.time as number,
          typeof x.volume === "number" ? Math.max(0, Math.min(200, Math.round(x.volume))) : 100));
      if (add.length) setAssets((prev) => [...prev, ...add]);
    }

    // Split screen + facecam. The AI echoes cropAspect on every edit, so the
    // frame is forced to 9:16 here when a split needs one.
    {
      const want = e.splitScreen;
      const layoutWanted = typeof want === "string" && (SPLIT_LAYOUT_KEYS as string[]).includes(want) ? want as SplitLayoutKey : null;
      let nextSplit = split;
      let turnOn = false;
      if (want === "off") {
        if (cropFill === "split") setCropFill("crop");
      } else if (layoutWanted) {
        if (split.layout !== layoutWanted) nextSplit = defaultSplit(layoutWanted);
        turnOn = true;
      }
      if (e.detectFacecam === true && want !== "off") {
        if (!layoutWanted && !splitOn) nextSplit = defaultSplit("facecam");
        turnOn = true;
      }
      if (typeof e.splitTopHeight === "number" && e.splitTopHeight > 0 && splitResizable(nextSplit.layout)) {
        nextSplit = { ...nextSplit, topH: e.splitTopHeight / 100 };
      }
      const aspectNow = typeof e.cropAspect === "string" && (ASPECT_KEYS as string[]).includes(e.cropAspect) ? e.cropAspect as AspectKey : cropAspect;
      const finalAspect: AspectKey = turnOn && aspectNow === "original" ? "9:16" : aspectNow;
      if (turnOn) { setCropAspect(finalAspect); setCropFill("split"); }
      if (nextSplit !== split) setSplit(nextSplit);
      if (e.detectFacecam === true && want !== "off" && (turnOn || splitOn)) {
        const out = outputDims(finalAspect, srcDims.w, srcDims.h);
        void detectFacecamSplit({
          source: videoRef.current, split: nextSplit, slotIndex: 0,
          srcW: srcDims.w, srcH: srcDims.h, outW: out.w, outH: out.h,
        }).then((r) => {
          if (r.split) setSplit(r.split);
          setAiStatus({ ok: !!r.split, msg: r.text });
          setTimeout(() => setAiStatus(null), 6000);
        });
      }
    }

    let subtitlesRequested = false;
    if (e.generateSubtitles === true) {
      const lang = typeof e.subtitleLanguage === "string" && SUB_LANGS.some((l) => l.code === e.subtitleLanguage)
        ? e.subtitleLanguage : "original";
      setSubtitleLang(lang);
      setOpenSection("subtitles");
      subtitlesRequested = true;
      void generateSubtitles(lang, srcOverride);
    }

    // Auto-emoji: turn it on now (so the preview reflects intent), and either tag
    // existing subtitles immediately or let the fresh transcription pick it up.
    if (e.subtitleEmoji === true) {
      setSubtitleEmoji(true);
      setOpenSection("subtitles");
      if (subtitlesRequested) {
        wantEmojiRef.current = true;
      } else if (subtitles.length > 0) {
        void applyAutoEmoji();
      }
    }

    setAiChanges(changes);
    const msg = changes.length === 0
      ? "Nothing to change — looks good already"
      : subtitlesRequested ? "Applied · transcribing subtitles…" : okMsg;
    setAiStatus({ ok: true, msg });
    setTimeout(() => setAiStatus(null), 4000);
  }

  // Auto-edit plans key every timed field to SOURCE seconds, but the editor
  // (like renderClip — see the same conversion in lib/styled-render.ts) keys
  // them to TIMELINE seconds, 0 = the trim start. Shift them so zooms and
  // effects land on the intended moment instead of `trimStart` seconds late.
  function sourceTimedToTimeline(e: Record<string, unknown>): Record<string, unknown> {
    const off = typeof e.trimStart === "number" ? e.trimStart : 0;
    if (!(off > 0)) return e;
    const sh = (t: unknown) => (typeof t === "number" ? Math.max(0, t - off) : t);
    const keys = (v: unknown) => Array.isArray(v) ? (v as Array<Record<string, unknown>>).map((k) => ({ ...k, time: sh(k.time) })) : v;
    const out: Record<string, unknown> = {
      ...e,
      zoomKeys: keys(e.zoomKeys), cropKeys: keys(e.cropKeys), volumeKeys: keys(e.volumeKeys),
      effects: Array.isArray(e.effects) ? (e.effects as Array<Record<string, unknown>>).map((x) => ({ ...x, start: sh(x.start), end: sh(x.end) })) : e.effects,
    };
    if (typeof e.captionEnd === "number" && e.captionEnd > 0) { out.captionStart = sh(e.captionStart); out.captionEnd = sh(e.captionEnd); }
    return out;
  }

  // One-click Auto-edit: the model sees the clip and returns a tailored plan.
  // When Auto-tighten is enabled it runs FIRST (a pre-pass that re-renders the clip
  // without dead air), then the model plans on the already-tightened clip — so the
  // analysis, trim and any subtitles all line up with the final timeline.
  async function runAutoEdit() {
    if (!clip || autoLoading || aiLoading) return;
    setAutoLoading(true); setAiStatus(null); setAiChanges([]); setAiNotes([]);
    const tightenSrc = autoEditTighten ? tightenableSrc() : "";
    const steps = [
      ...(tightenSrc ? ["Removing dead air"] : []),
      "Watching the clip",
      editStyle ? `Planning in “${editStyle.name}” style` : "Planning hook, cuts & zooms",
    ];
    setAutoSteps(steps); setAutoStep(0);
    let planTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Work off locals, not state — tightening swaps the source but React state
      // won't have flushed into this closure before the auto-edit call.
      let videoUrl = localVideoUrl || clip.videoUrl;
      let duration = clip.duration;
      let tStart = trimStart, tEnd = trimEnd;
      const transcript = subtitles.map((s) => s.text).join(" ");
      let tightenNote = "";

      if (tightenSrc) {
        try {
          const r = await tightenClip(tightenSrc, trimStart, trimEnd > trimStart ? trimEnd : (clip.duration || trimStart));
          if (r) {
            videoUrl = r.url; duration = r.duration; tStart = 0; tEnd = r.duration;
            // Keep the transcript TEXT (same words, minus fillers) — the model
            // only uses it to detect speech / craft a caption, not for timing.
            tightenNote = ` · trimmed ${r.removed.toFixed(1)}s dead air`;
          }
        } catch { /* tighten is best-effort; fall through to a normal auto-edit */ }
      }

      // Watching → planning happens in one server call; advance the visible
      // step once the upload/proxy phase has realistically finished.
      const watchIdx = tightenSrc ? 1 : 0;
      setAutoStep(watchIdx);
      planTimer = setTimeout(() => setAutoStep(watchIdx + 1), 9000);
      const res = await fetch("/api/clips/auto-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl,
          clip: { title: clip.title, platform: clip.platform, duration, streamer: clip.streamer },
          transcript,
          trimStart: tStart, trimEnd: tEnd,
          ...(editStyle ? (editStyle.builtin || editStyle.id != null ? { styleRef: editStyle.ref } : { style: editStyle.style }) : {}),
        }),
      });
      const data = await res.json().catch(() => ({ error: "The server returned an unexpected response." }));
      if (!res.ok) throw new Error(data.error ?? "Auto-edit failed");
      // Pass the (possibly tightened) source so any subtitle re-transcription
      // analyzes the right clip, not the stale URL still in state.
      applyAiResult(
        sourceTimedToTimeline(data.edits as Record<string, unknown>),
        `${editStyle ? `Edited in “${editStyle.name}”` : "Auto-edit applied"} ✨${tightenNote}`,
        videoUrl,
      );
      setAiNotes(Array.isArray(data.notes) ? data.notes : []);
    } catch (err) {
      setAiStatus({ ok: false, msg: err instanceof Error ? err.message : "Auto-edit failed" });
      setTimeout(() => setAiStatus(null), 8000);
    } finally {
      if (planTimer) clearTimeout(planTimer);
      setAutoLoading(false);
      setAutoSteps([]);
    }
  }

  // Instant, AI-free: apply the selected style's LOOK (framing, caption
  // treatment, grade, fades, loudness) to the current edit without touching
  // trim or timing. Undoable like any AI edit.
  function applyStyleLook(opt: StyleOption) {
    const look = styleLook(opt.style);
    history.push(captureEditState());
    setCropAspect(look.cropAspect as AspectKey); setCropFill(look.cropFill);
    setTextStyle({ font: look.textStyle.font, template: look.textStyle.template, color: look.textStyle.color });
    setSubtitleStyle(look.subtitleStyle); setSubtitleHighlight(look.subtitleHighlight);
    setSubtitleX(look.subtitleX); setSubtitleY(look.subtitleY); setSubtitleSize(look.subtitleSize);
    setSubtitleLook(look.subtitleLook);
    setColorFilter(look.colorFilter as ColorFilterKey);
    setBrightness(look.brightness); setContrast(look.contrast); setSaturation(look.saturation);
    setVignette(look.vignette); setFadeIn(look.fadeIn); setFadeOut(look.fadeOut); setLoudnorm(look.loudnorm);
    const wantsEmoji = opt.style.captions.emoji && opt.style.captions.animation !== "classic";
    if (wantsEmoji && subtitles.length > 0 && !subtitleEmoji) { setSubtitleEmoji(true); void applyAutoEmoji(); }
    // Facecam layout: cam on top, gameplay below — framed on the real webcam.
    if (look.layout === "facecam") {
      const aspect: AspectKey = look.cropAspect === "original" ? "9:16" : look.cropAspect as AspectKey;
      const nextSplit = splitOn && split.layout === "facecam" ? split : defaultSplit("facecam");
      setCropAspect(aspect); setCropFill("split"); setSplit(nextSplit);
      const out = outputDims(aspect, srcDims.w, srcDims.h);
      void detectFacecamSplit({
        source: videoRef.current, split: nextSplit, slotIndex: 0,
        srcW: srcDims.w, srcH: srcDims.h, outW: out.w, outH: out.h,
      }).then((r) => { if (r.split) setSplit(r.split); });
    }
    setAiNotes([]);
    setAiChanges([`Look: ${opt.name}`, `${look.cropAspect} · ${look.layout === "facecam" ? "facecam split" : look.cropFill}`, `${look.subtitleStyle} captions`,
      ...(look.colorFilter !== "none" ? [`Grade ${look.colorFilter}`] : [])]);
    setAiStatus({ ok: true, msg: subtitles.length === 0 && opt.style.captions.enabled
      ? "Look applied — add subtitles to see the caption style" : "Style look applied" });
    setTimeout(() => setAiStatus(null), 4000);
  }

  function selectEditStyle(opt: StyleOption | null) {
    setEditStyle(opt);
    // A jump-cut style implies removing dead air; a slow one keeps pauses.
    if (opt) setAutoEditTighten(opt.style.pacing.removeDeadAir);
  }

  // Virality score: the model sees the clip (frames + transcript) and rates its
  // short-form viral potential, with reasons and concrete fixes. Read-only — it
  // never changes the edit, just guides whether/how to post.
  async function runVirality() {
    if (!clip || viralityLoading) return;
    const src = tightenableSrc() || localVideoUrl || clip.videoUrl; // frames need a fetchable URL; transcript-only still works
    setViralityLoading(true);
    try {
      const res = await fetch("/api/clips/virality", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: src,
          clip: { title: clip.title, platform: clip.platform, duration: clip.duration, streamer: clip.streamer },
          transcript: subtitles.map((s) => s.text).join(" "),
          trimStart, trimEnd,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not score this clip");
      setVirality({
        score: data.score ?? 0, hookStrength: data.hookStrength ?? 0,
        verdict: data.verdict ?? "", reasons: data.reasons ?? [], fixes: data.fixes ?? [],
      });
    } catch (e) {
      setAiStatus({ ok: false, msg: e instanceof Error ? e.message : "Could not score this clip" });
      setTimeout(() => setAiStatus(null), 6000);
    } finally {
      setViralityLoading(false);
    }
  }

  // AI cover/thumbnail: the model picks the most scroll-stopping frame and writes
  // hook-text options; the server burns the chosen hook onto a 1080×1920 still.
  // Pass `hookOverride` to re-render the SAME frame with a different hook (cheap —
  // no model call). Read-only: it never changes the clip itself.
  async function runCover(hookOverride?: string) {
    if (!clip || coverLoading) return;
    const src = tightenableSrc(); // a cover needs server-fetchable bytes — no blob: URLs
    if (!src) {
      setAiStatus({ ok: false, msg: "Save the clip first — a cover needs the saved video." });
      setTimeout(() => setAiStatus(null), 6000);
      return;
    }
    setCoverLoading(true);
    try {
      const res = await fetch("/api/clips/cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: src,
          clip: { title: clip.title, platform: clip.platform, duration: clip.duration, streamer: clip.streamer },
          transcript: subtitles.map((s) => s.text).join(" "),
          trimStart, trimEnd,
          ...(hookOverride ? { hook: hookOverride, frameTime: cover?.frameTime } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not make a cover");
      setCover((prev) => ({
        url: data.url,
        // re-render keeps the existing hooks/reason; analyze returns fresh ones
        hooks: data.hooks ?? prev?.hooks ?? [],
        chosenHook: data.chosenHook ?? hookOverride ?? "",
        frameTime: data.frameTime ?? prev?.frameTime ?? 0,
        reason: data.reason ?? prev?.reason ?? "",
      }));
    } catch (e) {
      setAiStatus({ ok: false, msg: e instanceof Error ? e.message : "Could not make a cover" });
      setTimeout(() => setAiStatus(null), 6000);
    } finally {
      setCoverLoading(false);
    }
  }

  // Auto face-tracking reframe: the model finds the speaker in sampled frames and
  // returns motion-crop keyframes that follow them. Applied through the same
  // snapshot/undo path as an AI edit, so one click reverts it.
  async function runAutoReframe() {
    if (!clip || reframeLoading || autoLoading || aiLoading) return;
    // Frames must be extracted server-side; a blob: URL can't be fetched there.
    const serverFetchable = (u?: string) => !!u && (u.startsWith("/") || /^https?:/.test(u));
    const videoUrl = serverFetchable(localVideoUrl) ? localVideoUrl
      : serverFetchable(clip.videoUrl) ? clip.videoUrl : "";
    if (!videoUrl) {
      setAiStatus({ ok: false, msg: "Save or re-import this clip first so it can be analyzed on the server." });
      setTimeout(() => setAiStatus(null), 6000);
      return;
    }
    setReframeLoading(true); setAiStatus(null); setAiChanges([]);
    try {
      const res = await fetch("/api/clips/reframe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl,
          srcW: srcDims.w, srcH: srcDims.h,
          duration: clip.duration,
          trimStart, trimEnd,
          cropAspect: cropEnabled ? cropAspect : "9:16",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Auto-reframe failed");

      history.push(captureEditState());
      const keys = (data.cropKeys as Array<{ time: number; x: number }>).map((k) => ({ id: uid(), time: k.time, x: k.x }));
      setCropAspect(data.cropAspect as AspectKey);
      setCropFill("crop");
      setCropKeys(keys);
      setCropSmooth(data.cropSmooth !== false);
      setCropX(typeof data.cropX === "number" ? data.cropX : 50);
      setCropDirty(false);
      setAiChanges([`Auto-reframe → ${data.cropAspect}`, `Follows subject (${keys.length} keyframe${keys.length === 1 ? "" : "s"})`]);
      setAiStatus({ ok: true, msg: `Reframed to ${data.cropAspect}, tracking the speaker ✨` });
      setTimeout(() => setAiStatus(null), 5000);
    } catch (err) {
      setAiStatus({ ok: false, msg: err instanceof Error ? err.message : "Auto-reframe failed" });
      setTimeout(() => setAiStatus(null), 8000);
    } finally {
      setReframeLoading(false);
    }
  }

  async function runAiEdit() {
    if (!clip || !aiPrompt.trim() || aiLoading) return;
    setAiLoading(true); setAiStatus(null); setAiChanges([]); setAiNotes([]);
    const promptText = aiPrompt.trim();
    try {
      const res = await fetch("/api/clips/ai-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: aiPrompt,
          clip: { title: clip.title, platform: clip.platform, duration: clip.duration, streamer: clip.streamer },
          currentState: {
            trimStart, trimEnd,
            caption, captionX: Math.round(captionX), captionY: Math.round(captionY), captionSize: Number(captionSize.toFixed(2)),
            captionFont: textStyle.font, captionTemplate: textStyle.template, captionColor: textStyle.color,
            cropAspect, cropFill, cropX,
            cropKeys: cropKeys.map((k) => ({ time: Number(k.time.toFixed(2)), x: Math.round(k.x) })), cropSmooth,
            zoom, zoomKeys: zoomKeys.map((k) => ({ time: Number(k.time.toFixed(2)), z: Number(k.z.toFixed(2)) })), zoomSmooth,
            speed, brightness, contrast, videoVolume, videoPitch, introText, outroText,
            saturation, colorFilter, mirror, fadeIn, fadeOut,
            vignette, loudnorm, captionStart, captionEnd,
            effects: effects.map((s) => ({ type: s.type, start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)) })),
            volumeKeys: volumeKeys.map((k) => ({ time: Number(k.time.toFixed(2)), v: Math.round(k.v) })),
            segments: clips.map((c, i) => ({
              n: i + 1, start: Number(c.sourceStart.toFixed(2)), end: Number(c.sourceEnd.toFixed(2)), volume: clipVolume(c),
            })),
            tracks: timelineTracks.map((t) => ({
              id: t.id, type: t.type, name: t.name, start: Number(t.start.toFixed(2)), duration: Number(t.duration.toFixed(2)),
              ...(t.volume != null ? { volume: t.volume } : {}),
            })),
            split: splitOn ? { layout: split.layout, topHeightPct: split.topH != null ? Math.round(split.topH * 100) : "default" } : null,
            subtitles: { count: subtitles.length, style: subtitleStyle, emoji: subtitleEmoji, highlight: subtitleHighlight, look: subtitleLook },
          },
          // Timestamped speech lets the assistant act on "when he says X".
          transcript: subtitles.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n"),
          // A server-fetchable source unlocks the agent's detectors (silence,
          // loudness, scene cuts, frames). blob: imports fall back to transcript-only.
          videoUrl: tightenableSrc() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({ error: "The server returned an unexpected response." }));
      if (!res.ok) throw new Error(data.error ?? "AI request failed");

      const e = data.edits as Record<string, unknown>;
      const changes = diffEdits(e);
      applyAiResult(e, "Edits applied");
      setAiNotes(Array.isArray(data.notes) ? data.notes : []);
      setAiLog((prev) => [{ id: uid(), prompt: promptText, changes }, ...prev].slice(0, 8));
      setAiPrompt("");
    } catch (err) {
      // Keep failures on screen longer so they can actually be read.
      setAiStatus({ ok: false, msg: err instanceof Error ? err.message : "Failed" });
      setTimeout(() => setAiStatus(null), 8000);
    } finally {
      setAiLoading(false);
    }
  }

  // Load a finished AI clip into the editor exactly like an imported video.
  // `presetTrim` lets a caller that already knows the natural in/out points
  // (e.g. a silence-snapped auto-clipper preview) open the editor pre-trimmed
  // instead of defaulting to the full window.
  async function loadGeneratedVideo(videoUrl: string, title: string, presetTrim?: { trimStart: number; trimEnd: number }) {
    setFetchError(""); setClip(null); resetEditState();
    const src = videoUrl;
    const duration = await new Promise<number>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve(v.duration || 0);
      v.onerror = () => resolve(0);
      v.src = src;
    });
    const dur = duration > 0 ? duration : 0;
    setClip({ platform: "ai", title, duration: dur, thumbnailUrl: "", videoUrl: src, streamer: "AI Studio" });
    setLocalVideoUrl(src);
    if (presetTrim && presetTrim.trimEnd > presetTrim.trimStart && presetTrim.trimEnd <= dur + 0.5) {
      setTrimStart(presetTrim.trimStart);
      setTrimEnd(presetTrim.trimEnd);
    } else {
      setTrimEnd(dur);
    }
  }

  async function loadFFmpeg() {
    if (ffmpegRef.current) return ffmpegRef.current;
    setProcessPhase("loading-ff");
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { toBlobURL } = await import("@ffmpeg/util");
    const ff = new FFmpeg();
    ff.on("progress", ({ progress }: { progress: number }) => setProcessProgress(Math.round(progress * 100)));
    // Keep the tail of FFmpeg's log so a failed export can surface the real reason.
    const logs: string[] = [];
    ffLogRef.current = logs;
    ff.on("log", ({ message }: { message: string }) => {
      logs.push(message);
      if (logs.length > 60) logs.shift();
    });
    const base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
    await ff.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpegRef.current = ff;
    return ff;
  }

  async function processClip(mode: "schedule" | "save" = "schedule") {
    if (!clip) return;
    setProcessMode(mode); setSaveDone(false);

    const safeName      = clip.title.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 50) || "clip";
    const hasAssets     = assets.some((a) => !a.uploading && a.serverUrl);

    // Assets and text burns export on the server (native ffmpeg — fast, and
    // wasm can't burn fonts or decode a second video without hitting its
    // memory cap). The wasm path below handles the remaining cheap edits in
    // the browser for free. Free-plan exports also go server-side, where the
    // 720p cap + watermark are burned in (wasm can't burn the watermark font).
    // A multi-clip timeline needs the concat pre-pass, which wasm has no
    // equivalent for — those always go server-side too.
    // Split screens with their own video need the server too: the graph reads
    // those files via `movie=`, which only works on server-downloaded paths.
    const splitHasMedia = splitOn && split.panels.some((p) => p.media);
    const segVolume = clips.some((c) => clipVolume(c) !== 100);
    if (isFreePlan || hasAssets || clips.length > 1 || segVolume || splitHasMedia || !!(caption || introText || outroText || subtitles.length > 0 || blurFill)) {
      await processClipServer(mode);
      return;
    }

    setProcessing(true); setProcessError(""); setProcessProgress(0);
    try {
      const ff = await loadFFmpeg();
      if (!ff) throw new Error("FFmpeg failed to load");

      // Prefer in-memory blob URL (no network round-trip, no Content-Length issues)
      const videoSrc   = blobVideoUrl || localVideoUrl || clip.videoUrl;

      setProcessPhase("loading-video");
      await ff.writeFile("input.mp4", await loadMediaBytes(videoSrc));
      // Write audio with its real extension so FFmpeg picks the right demuxer
      // (forcing .mp3 on a wav/m4a/ogg causes "Failed to read frame size").
      const audioExt  = (n: string) => (n.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "mp3");
      const musicFile = `music.${audioExt(musicFileName)}`;

      if (musicServerUrl) await ff.writeFile(musicFile, await loadMediaBytes(musicLocalUrl || musicServerUrl));

      // Some sources have no audio track (certain YouTube/AV1 sections, silent
      // uploads). Mapping a missing 0:a makes ffmpeg abort, so probe first: a
      // bare `-i` exits cleanly and logs the stream list into ffLogRef.
      let hasSourceAudio = true;
      try {
        ffLogRef.current.length = 0;
        await ff.exec(["-i", "input.mp4"]);
      } catch { /* "At least one output file must be specified" — expected */ }
      hasSourceAudio = ffLogRef.current.some((l) => /Stream #\d+:\d+.*Audio:/i.test(l));

      // cropKeys/zoomKeys/effects/volumeKeys are set from `currentTime`, which
      // is TIMELINE time — but this path (gated to clips.length<=1 above)
      // still seeks the real input to `trimStart` and passes it as the
      // filter-time offset below, exactly like the server's single-clip fast
      // path (clip-render.ts). Shift them back to source-absolute so that
      // `t - trimStart` math lines up. A no-op when trimStart is 0 (untrimmed).
      const shift = trimStart;
      const shiftedCropKeys = cropKeys.map((k) => ({ ...k, time: k.time + shift }));
      const shiftedZoomKeys = zoomKeys.map((k) => ({ ...k, time: k.time + shift }));
      const shiftedEffects  = effects.map((e) => ({ ...e, start: e.start + shift, end: e.end + shift }));
      const shiftedVolumeKeys = volumeKeys.map((k) => ({ ...k, time: k.time + shift }));

      // Base filter chains — crop/scale/zoom/eq/speed come from the shared builder
      // so the wasm export matches the preview and the server export exactly.
      const { filters: vBuilt } = buildVideoFilters({
        srcW: srcDims.w, srcH: srcDims.h, fps: srcFps,
        aspect: cropAspect, cropX, cropKeys: shiftedCropKeys, cropSmooth,
        zoom, zoomKeys: shiftedZoomKeys, zoomSmooth, trimStart, brightness, contrast, speed,
        saturation, colorFilter, mirror, fadeIn, fadeOut, trimEnd,
        effects: shiftedEffects, vignette,
        split: splitOn ? split : null,
      });
      const vFilters: string[] = [...vBuilt];
      // Order matters: pitch → volume (keyframes use clip-relative t, so before
      // atempo) → atempo → fades (output timeline) → loudness normalization.
      const aFilters: string[] = [...audioPitchFilters(videoPitch)];
      aFilters.push(...audioVolumeFilters(shiftedVolumeKeys, trimStart, videoVolume));
      if (speed !== 1) aFilters.push(`atempo=${speed}`);
      aFilters.push(...audioFadeFilters(fadeIn, fadeOut, (trimEnd - trimStart) / speed));
      if (loudnorm) aFilters.push("loudnorm=I=-16:TP=-1.5:LRA=11");

      const needsComplex = vFilters.length > 0 || aFilters.length > 0 || !!musicServerUrl;
      const isCopy = !needsComplex;

      // Build input args
      const args: string[] = [];
      if (trimStart > 0) args.push("-ss", trimStart.toFixed(3));
      args.push("-i", "input.mp4");
      let musicIdx = -1;
      if (musicServerUrl) { args.push("-i", musicFile); musicIdx = 1; }
      args.push("-t", (trimEnd - trimStart).toFixed(3));

      if (isCopy) {
        args.push("-c", "copy");
      } else {
        const parts: string[] = [];

        // Video chain
        let vChain = "[0:v]";
        if (vFilters.length > 0) { parts.push(`[0:v]${vFilters.join(",")}[vbase]`); vChain = "[vbase]"; }
        // Guarantee even output dimensions — libx264 fails on odd width/height,
        // which un-cropped sources can produce.
        if (vFilters.length > 0) {
          parts.push(`${vChain}scale=trunc(iw/2)*2:trunc(ih/2)*2[veven]`);
          vChain = "[veven]";
        }
        const vMap = vChain === "[0:v]" ? "0:v" : vChain;
        const videoNeedsRecode = vFilters.length > 0;

        // Audio chain. The source may have no audio track, so only touch audio
        // that exists: pass it through untouched when nothing modifies it, build
        // a filter graph when it does, or build from music alone for a silent
        // clip. aMap stays null when there's no audio anywhere → no audio map.
        let aMap: string | null = null;
        let audioRecode = false;
        if (hasSourceAudio || musicIdx >= 0) {
          const passthrough = hasSourceAudio && aFilters.length === 0 && musicIdx < 0;
          if (passthrough) {
            // Mixing a filtered stream with -c:a copy is invalid in FFmpeg.
            aMap = "0:a";
          } else {
            audioRecode = true;
            // Normalize every source to the same rate/layout so amix doesn't fail
            // on mismatched audio (the usual cause of sound-export errors).
            const fmt = "aformat=sample_rates=44100:channel_layouts=stereo";
            const audioSources: string[] = [];
            if (hasSourceAudio) {
              // The main volume (static or keyframed) is already inside aFilters.
              if (aFilters.length > 0) parts.push(`[0:a]${aFilters.join(",")},${fmt}[amain]`);
              else                     parts.push(`[0:a]${fmt}[amain]`);
              audioSources.push("[amain]");
            }
            if (musicIdx >= 0) {
              const mtrim = musicDuration > 0 ? `atrim=0:${musicDuration.toFixed(3)},` : "";
              parts.push(`[${musicIdx}:a]${mtrim}volume=${(musicVolume / 100).toFixed(3)},${fmt}[amusic]`);
              audioSources.push("[amusic]");
            }
            if (audioSources.length === 1) {
              aMap = audioSources[0];
            } else {
              parts.push(`${audioSources.join("")}amix=inputs=${audioSources.length}:duration=first:dropout_transition=0[aout]`);
              aMap = "[aout]";
            }
          }
        }

        if (parts.length > 0) args.push("-filter_complex", parts.join(";"));
        args.push("-map", vMap);
        if (aMap) args.push("-map", aMap);
        args.push("-c:v", videoNeedsRecode ? "libx264" : "copy");
        if (videoNeedsRecode) args.push("-preset", "ultrafast");
        if (aMap) {
          args.push("-c:a", audioRecode ? "aac" : "copy");
          if (audioRecode) args.push("-ar", "44100");
        }
      }

      args.push("-y", "output.mp4");

      setProcessPhase("encoding"); setProcessProgress(0);
      await ff.exec(args);

      const raw  = await ff.readFile("output.mp4");
      const blob = new Blob([raw as BlobPart], { type: "video/mp4" });

      // Save mode: download the edited video straight to the user's PC — no upload/navigation
      if (mode === "save") {
        triggerDownload(blob, `${safeName}.mp4`);
        flagSaved();
        return;
      }

      setProcessPhase("uploading"); setProcessProgress(0);
      // "export": derived from an already-counted clip — don't double-count.
      const exportUrl = await uploadFile(new File([blob], `${clip.title}.mp4`, { type: "video/mp4" }), "export");

      goToCompose(exportUrl);
    } catch (e) {
      // Surface the real FFmpeg error (last meaningful log lines) instead of a generic message.
      const meaningful = ffLogRef.current.filter((l) =>
        /error|invalid|unable|no such|failed|matches no|not (found|divisible)|height|width|stream/i.test(l));
      const tail = (meaningful.length ? meaningful : ffLogRef.current).slice(-3).join(" · ");
      const base = e instanceof Error ? e.message : "Processing failed";
      setProcessError(tail ? `${base} — ${tail}` : base);
      // console.warn (not error) so Next's dev overlay doesn't hijack the screen.
      console.warn("[clips/process client]", base, "\n", ffLogRef.current.slice(-15).join("\n"));
      setProcessing(false);
      setProcessPhase("");
    }
  }

  // Ask Gemini for title/caption suggestions — it sees frames from the clip
  // plus the streamer name, original title, and the transcript when subtitles
  // exist.
  async function fetchAiText(kind: "title" | "caption"): Promise<string[]> {
    if (!clip) return [];
    const res = await fetch("/api/clips/ai-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        videoUrl: localVideoUrl || clip.videoUrl,
        title: clip.title,
        streamer: clip.streamer,
        platform: clip.platform,
        duration: clip.duration,
        trimStart, trimEnd,
        transcript: subtitles.map((s) => s.text).join(" "),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "AI request failed");
    return data.suggestions ?? [];
  }

  async function suggestTitles() {
    if (!clip || titleIdeasLoading) return;
    setTitleIdeasLoading(true); setTitleIdeasError(""); setTitleIdeas([]);
    try {
      const ideas = await fetchAiText("title");
      setTitleIdeas(ideas);
      if (ideas.length === 0) setTitleIdeasError("No suggestions came back — try again.");
    } catch (e) {
      setTitleIdeasError(e instanceof Error ? e.message : "Failed to suggest titles");
    } finally {
      setTitleIdeasLoading(false);
    }
  }

  async function suggestCaptions() {
    if (!clip || captionIdeasLoading) return;
    setCaptionIdeasLoading(true); setCaptionIdeasError(""); setCaptionIdeas([]);
    try {
      const ideas = await fetchAiText("caption");
      setCaptionIdeas(ideas);
      if (ideas.length === 0) setCaptionIdeasError("No suggestions came back — try again.");
    } catch (e) {
      setCaptionIdeasError(e instanceof Error ? e.message : "Failed to suggest captions");
    } finally {
      setCaptionIdeasLoading(false);
    }
  }

  function applyTitle(t: string) {
    setClip((prev) => (prev ? { ...prev, title: t } : prev));
    setTitleIdeas([]);
  }

  // Inline title editing — works on the imported default and on an applied AI
  // suggestion alike; the edited title flows into scheduling/export unchanged.
  function startTitleEdit() {
    if (!clip) return;
    setTitleDraft(clip.title);
    setEditingTitle(true);
  }
  function commitTitle() {
    const t = titleDraft.trim();
    if (t) setClip((prev) => (prev ? { ...prev, title: t } : prev));
    setEditingTitle(false);
  }

  async function processClipServer(mode: "schedule" | "save" = "schedule") {
    if (!clip) return;
    const safeName = clip.title.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 50) || "clip";
    setProcessing(true); setProcessError(""); setProcessPhase("encoding"); setProcessProgress(0);
    try {
      const res  = await fetch("/api/clips/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: localVideoUrl || clip.videoUrl,
          // `clips` is the non-destructive timeline the server assembles
          // (concatenating cuts when there's more than one); `duration` stays
          // the true source-media length, which the server uses to decide
          // whether an extra `-to` seek is even needed for the fast path.
          clips, duration: clip.duration,
          caption, captionX, captionY, captionSize, textStyle,
          cropAspect, cropFill, cropX, cropKeys, cropSmooth,
          split: splitOn ? split : undefined,
          zoom, zoomKeys, zoomSmooth,
          introText, outroText,
          subtitles: subtitles.map((s) => ({
            start: s.start, end: s.end, text: s.text,
            // Emoji only renders in the animated (libass) styles and when enabled.
            words: s.words?.map((w) => ({
              word: w.word, start: w.start, end: w.end,
              emoji: subtitleEmoji && subtitleStyle !== "classic" ? w.emoji : undefined,
            })),
          })),
          subtitleStyle, subtitleHighlight, subtitleX, subtitleY, subtitleSize, subtitleLook,
          videoPitch,
          srcW: srcDims.w, srcH: srcDims.h, fps: srcFps,
          title: clip.title,
          musicUrl: musicServerUrl || null,
          musicVolume, musicDuration, videoVolume, speed, brightness, contrast,
          saturation, colorFilter, mirror, fadeIn, fadeOut,
          vignette, loudnorm, captionStart, captionEnd,
          effects: effects.map((s) => ({ type: s.type, start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)) })),
          volumeKeys: volumeKeys.map((k) => ({ time: Number(k.time.toFixed(2)), v: Math.round(k.v) })),
          assets: assets.filter((a) => !a.uploading && a.serverUrl).map((a) => ({
            type: a.type, url: a.serverUrl,
            timestamp: Number(a.timestamp.toFixed(2)), duration: Number(a.duration.toFixed(2)),
            volume: Math.round(a.volume),
            x: Number(a.x.toFixed(2)), y: Number(a.y.toFixed(2)), scale: Number(a.scale.toFixed(2)),
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (mode === "save") {
        setProcessPhase("uploading");
        const fileRes = await fetch(data.url);
        triggerDownload(await fileRes.blob(), `${safeName}.mp4`);
        flagSaved();
        return;
      }
      goToCompose(data.url);
    } catch (e) {
      setProcessError(e instanceof Error ? e.message : "Processing failed");
      setProcessing(false);
      setProcessPhase("");
    }
  }

  const effectiveDuration = Math.max(clip?.duration ?? 0, trimEnd, 1);
  const pc     = clip ? P[clip.platform] : null;
  // Only use local/blob URLs as video src — external CDN URLs (Twitch, etc.) have
  // short-lived signed tokens and CORS restrictions that prevent browser playback.
  const isLocalUrl = (u?: string) => !!u && (u.startsWith("/") || u.startsWith("blob:"));
  const srcUrl = blobVideoUrl || localVideoUrl || (isLocalUrl(clip?.videoUrl) ? clip!.videoUrl : "");

  // The "stage" is the actual output frame — sized to fit inside the measured player area
  // so the preview is WYSIWYG (crop, caption position and overlays all match the export).
  const stageAspect = (cropEnabled ? ASPECTS[cropAspect].ar! : videoAspect) || (16 / 9);
  const stageW = stageBox.w > 0 && stageBox.h > 0
    ? Math.min(stageBox.w, stageBox.h * stageAspect)
    : 0;
  const stageH = stageW / stageAspect;
  // Export frame size for the split layout's slot aspect ratios.
  const splitOut = outputDims(cropAspect, srcDims.w, srcDims.h);

  // While the user is dialing in a position (cropDirty) show that; otherwise, if a
  // keyframe track exists, follow it at the current playhead time.
  const previewCropX = cropEnabled && cropKeys.length > 0 && !cropDirty ? cropXAt(currentTime) : cropX;
  const previewZoom  = zoomKeys.length > 0 && !zoomDirty ? zoomAt(currentTime) : zoom;

  // Color pipeline for the live preview — mirrors the export's eq + preset chain,
  // plus any timed effect whose window contains the playhead.
  const activeEffects = effects.filter((s) => currentTime >= s.start && currentTime <= s.end);
  const previewFilter = [
    `brightness(${(1 + brightness / 100).toFixed(3)})`,
    `contrast(${(1 + contrast / 100).toFixed(3)})`,
    saturation !== 0 ? `saturate(${Math.max(0, 1 + saturation / 100).toFixed(3)})` : "",
    COLOR_FILTERS[colorFilter].css,
    ...activeEffects.map((s) => EFFECTS[s.type].css),
  ].filter(Boolean).join(" ");

  // Caption visibility window (0 = open-ended on that side).
  const captionVisible = !!caption
    && (captionStart <= 0 || currentTime >= captionStart)
    && (captionEnd <= 0 || currentTime <= captionEnd);

  // Fade-to-black overlay opacity at the playhead (output-timeline seconds).
  // Fades are a whole-timeline effect now — currentTime is already 0-based
  // timeline time, so no trimStart subtraction (that would double-count the
  // clip's own source offset).
  const outDurPrev = Math.max(0.01, timelineDuration / speed);
  const outTPrev   = Math.max(0, currentTime / speed);
  let fadeOpacity = 0;
  if (fadeIn > 0 && outTPrev < fadeIn) fadeOpacity = 1 - outTPrev / fadeIn;
  if (fadeOut > 0 && outTPrev > outDurPrev - fadeOut) {
    fadeOpacity = Math.max(fadeOpacity, (outTPrev - (outDurPrev - fadeOut)) / fadeOut);
  }
  fadeOpacity = Math.max(0, Math.min(1, fadeOpacity));

  return (
    <div className="flex flex-col bg-d0a text-white" style={{ minHeight: "100%" }}>

      {/* Hidden inputs */}
      <input ref={fileInputRef}   type="file" accept="video/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLocalFile(f); e.target.value = ""; }} />
      <input ref={musicInputRef}  type="file" accept="audio/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleMusicFile(f); e.target.value = ""; }} />
      <input ref={soundAssetRef}  type="file" accept="audio/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAssetFile(f, "sound"); e.target.value = ""; }} />
      <input ref={imageAssetRef}  type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAssetFile(f, "image"); e.target.value = ""; }} />
      <input ref={videoAssetRef}  type="file" accept="video/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAssetFile(f, "video"); e.target.value = ""; }} />

      {/* ── Toolbar ──────────────────────────────────────────────────────────── */}
      <div
        className="flex flex-wrap items-center gap-2 px-3 py-2 min-h-12 border-b border-white/[0.06] bg-d0c flex-shrink-0"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleLocalFile(f); }}
      >
        {/* Brand mark */}
        <div className="flex items-center gap-2 pr-3 border-r border-white/[0.06] flex-shrink-0">
          <div className="w-7 h-7 rounded-lg bg-violet-600/20 border border-violet-500/25 flex items-center justify-center">
            <Film size={14} className="text-violet-400" />
          </div>
          <span className="cue text-violet-400/90 hidden sm:block">Clip editor</span>
          {clip && <GlowDot pulse={saving || uploading} color={saving || uploading ? "amber" : "violet"} />}
        </div>

        {/* Phones with a clip open: compact title + "New" toggle instead of the URL bar */}
        {clip && (
          <div className="flex-1 min-w-0 flex items-center gap-2 sm:hidden">
            <p className="flex-1 min-w-0 truncate text-[13px] font-medium text-white/75">{clip.title}</p>
            <button type="button" onClick={() => setShowImport((v) => !v)} aria-expanded={showImport}
              className="flex items-center gap-1 h-9 px-2.5 rounded-lg text-[12px] font-medium text-white/60 bg-white/[0.04] border border-white/[0.08]">
              {showImport ? <X size={13} /> : <Plus size={13} />} New
            </button>
          </div>
        )}

        <div className={cn(
          "items-center gap-2 min-w-0",
          clip ? (showImport ? "flex basis-full order-last sm:order-none sm:basis-auto sm:flex-1" : "hidden sm:flex sm:flex-1") : "flex flex-1",
        )}>
          {/* URL input */}
          <div className="flex-1 min-w-0 flex items-center gap-2 bg-black/30 border border-white/[0.07] rounded-lg px-3 h-9
            focus-within:border-violet-500/40 focus-within:bg-black/40 focus-within:shadow-[0_0_0_3px_rgba(51,92,186,0.1)]
            transition-all duration-200 ease-out">
            <Search size={13} className="text-white/25 flex-shrink-0" />
            <input
              type="url"
              inputMode="url"
              placeholder="Paste a Twitch, Kick, YouTube, TikTok or Instagram link…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { fetchClip(); setShowImport(false); } }}
              className="flex-1 min-w-0 bg-transparent text-[13px] text-white/80 placeholder:text-white/25 outline-none"
            />
            {url && (
              <button type="button" onClick={() => setUrl("")} aria-label="Clear link" className="text-white/25 hover:text-white/60 transition-colors duration-150">
                <X size={13} />
              </button>
            )}
          </div>

          {/* Upload local */}
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} title="Upload a video file"
            className="flex items-center gap-1.5 h-9 px-3 bg-white/[0.04] hover:bg-white/[0.07] disabled:opacity-40
              border border-white/[0.08] hover:border-white/[0.14] text-white/60 hover:text-white/85
              rounded-lg text-[12px] font-medium transition-all duration-200 ease-out flex-shrink-0">
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
            <span className="hidden md:inline">{uploading ? "Uploading…" : "Upload"}</span>
          </button>

          {/* Import */}
          <button type="button" onClick={() => { fetchClip(); setShowImport(false); }} disabled={fetching || !url.trim()}
            className="flex items-center gap-1.5 h-9 px-3.5 bg-white/[0.08] hover:bg-white/[0.12] disabled:opacity-40
              border border-white/[0.1] text-white rounded-lg text-[12px] font-semibold transition-all duration-200 ease-out flex-shrink-0">
            {fetching && <Loader2 size={13} className="animate-spin" />}
            {fetching ? "Fetching…" : "Import"}
          </button>
        </div>

        {/* Error */}
        {fetchError && (
          <div className="flex items-center gap-1.5 text-[12px] text-red-300 bg-red-500/[0.08] border border-red-500/20
            rounded-lg px-2.5 h-9 max-w-full sm:max-w-[260px] flex-shrink-0 order-last sm:order-none">
            <AlertCircle size={13} className="flex-shrink-0" />
            <span className="truncate">{fetchError}</span>
          </div>
        )}

        {/* Export — always reachable on desktop (phones get the sticky bar below) */}
        {clip && (
          <button type="button" onClick={() => processClip("schedule")} disabled={processing}
            className="hidden lg:flex items-center gap-1.5 h-9 px-4 rounded-lg text-[12px] font-semibold text-white flex-shrink-0
              bg-gradient-to-b from-violet-500 to-violet-700 border border-violet-400/40
              shadow-[0_0_16px_rgba(51,92,186,0.35)] hover:from-violet-400 hover:to-violet-600 disabled:opacity-50 transition-all">
            {processing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} className="fill-white" />}
            {processing ? (processProgress > 0 ? `Exporting ${processProgress}%` : "Exporting…") : "Export"}
          </button>
        )}
      </div>

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {clip ? (
        <div className="flex flex-col lg:flex-row flex-1 min-h-0">

          {/* ── Video + Timeline ───────────────────────────────────────────────── */}
          {/* On mobile this column sticks to the top so the live preview stays
              visible while the controls below scroll. lg: restores the side panel. */}
          <div className="flex flex-col lg:flex-1 min-w-0 bg-black sticky top-14 md:top-0 z-20 lg:static lg:top-auto lg:z-auto">

            {/* Player */}
            <div ref={stageWrapRef} className={`keep-dark relative bg-black flex items-center justify-center overflow-hidden group transition-[height] duration-200 lg:h-auto lg:min-h-[300px] lg:flex-1 ${previewCompact ? "h-[22vh] min-h-[140px]" : "h-[36vh] min-h-[210px]"}`}>

              {/* Output stage — exact frame that will be exported */}
              <div
                className="relative overflow-hidden bg-black flex-shrink-0 select-none"
                style={{
                  width: stageW || "100%",
                  height: stageH || "100%",
                  cursor: cropEnabled ? (draggingCrop ? "grabbing" : "grab") : "pointer",
                  touchAction: "none",
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  const base = previewCropX;
                  if (cropEnabled && !blurFill && !splitOn) { setCropX(base); setCropDirty(true); setDraggingCrop(true); }
                  pointerRef.current = { x: e.clientX, startCropX: base, width: stageW, moved: false };
                }}
              >
                {/* Mirror wraps the picture only — captions/subtitles stay readable,
                    matching the export where hflip runs before drawtext. */}
                <div
                  className="absolute inset-0 overflow-hidden"
                  style={{ transform: mirror ? "scaleX(-1)" : undefined }}
                >
                  {/* Blurred background fill (whole video, zoomed + blurred) */}
                  {blurFill && (
                    <video
                      ref={bgVideoRef}
                      src={srcUrl || undefined}
                      muted
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      style={{ objectFit: "cover", filter: "blur(14px) brightness(0.85)", transform: "scale(1.1)" }}
                    />
                  )}
                  <video
                    ref={videoRef}
                    src={srcUrl || undefined}
                    className="relative w-full h-full pointer-events-none"
                    style={{
                      // In split mode this element stays the playback master
                      // (audio, time, events) but is painted by SplitStage instead.
                      opacity: splitOn ? 0 : 1,
                      objectFit: blurFill ? "contain" : "cover",
                      objectPosition: blurFill ? "center" : `${previewCropX}% 50%`,
                      transform: blurFill ? "none" : `scale(${previewZoom.toFixed(3)})`,
                      transformOrigin: `${previewCropX}% 50%`,
                      filter: previewFilter,
                    }}
                    onEnded={() => setPlaying(false)}
                    onPause={() => setPlaying(false)}
                    onPlay={() => setPlaying(true)}
                  />
                  {splitOn && (
                    <SplitMediaPlayers split={split} mediaEls={splitMediaRef} clipRef={videoRef} timelineTime={currentTime} />
                  )}
                  {splitOn && (
                    <SplitStage
                      videoRef={videoRef} mediaEls={splitMediaRef} split={split} onChange={setSplit}
                      srcW={srcDims.w} srcH={srcDims.h} outW={splitOut.w} outH={splitOut.h}
                      width={stageW} height={stageH} filter={previewFilter} mirror={mirror}
                      onTap={togglePlay}
                    />
                  )}
                </div>

                {/* Vignette preview */}
                {vignette && (
                  <div
                    className="absolute inset-0 z-[5] pointer-events-none"
                    style={{ background: "radial-gradient(ellipse at center, transparent 52%, rgba(0,0,0,0.55) 100%)" }}
                  />
                )}

                {/* Fade-to-black preview (sits under the caption, like the export) */}
                {fadeOpacity > 0 && (
                  <div className="absolute inset-0 z-10 bg-black pointer-events-none" style={{ opacity: fadeOpacity }} />
                )}

                {/* Caption preview — drag to position anywhere in the frame */}
                {captionVisible && (
                  <div
                    onPointerDown={(e) => {
                      e.stopPropagation(); e.preventDefault();
                      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                      setDraggingCaption(true);
                    }}
                    onPointerMove={(e) => {
                      if (!draggingCaption) return;
                      const stage = (e.currentTarget as HTMLElement).parentElement;
                      if (!stage) return;
                      const r = stage.getBoundingClientRect();
                      setCaptionX(Math.max(5, Math.min(95, ((e.clientX - r.left) / r.width) * 100)));
                      setCaptionY(Math.max(5, Math.min(95, ((e.clientY - r.top) / r.height) * 100)));
                    }}
                    onPointerUp={(e) => {
                      setDraggingCaption(false);
                      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                    }}
                    className="absolute z-20 -translate-x-1/2 -translate-y-1/2 cursor-move select-none touch-none"
                    style={{ left: `${captionX}%`, top: `${captionY}%`, maxWidth: "92%" }}
                  >
                    <span
                      className={`inline-block break-words text-center transition-all ${draggingCaption ? "ring-2 ring-violet-400/70 rounded" : ""}`}
                      style={{ ...textStyleCss(textStyle, Math.max(8, ((stageH || 320) / CAPTION_BASE_DIVISOR) * captionSize)), maxWidth: "100%" }}
                    >
                      {caption}
                    </span>
                  </div>
                )}

                {/* Subtitle preview (current segment, burned in on export) —
                    drag to reposition, same model as the static caption. */}
                {currentSubtitle && (
                  <div
                    onPointerDown={(e) => {
                      e.stopPropagation(); e.preventDefault();
                      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                      setDraggingSubtitle(true);
                    }}
                    onPointerMove={(e) => {
                      if (!draggingSubtitle) return;
                      const stage = (e.currentTarget as HTMLElement).parentElement;
                      if (!stage) return;
                      const r = stage.getBoundingClientRect();
                      setSubtitleX(Math.max(5, Math.min(95, ((e.clientX - r.left) / r.width) * 100)));
                      setSubtitleY(Math.max(5, Math.min(95, ((e.clientY - r.top) / r.height) * 100)));
                    }}
                    onPointerUp={(e) => {
                      setDraggingSubtitle(false);
                      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                    }}
                    className="absolute z-20 -translate-x-1/2 -translate-y-1/2 cursor-move select-none touch-none px-[6%] text-center"
                    style={{ left: `${subtitleX}%`, top: `${subtitleY}%`, maxWidth: "94%" }}
                  >
                    <span className={`inline-block leading-tight ${draggingSubtitle ? "ring-2 ring-violet-400/70 rounded" : ""}`}>
                      {subtitleStyle === "classic" && (
                        <span className="inline-block" style={textStyleCss(textStyle, Math.max(9, (stageH || 320) / 26) * subtitleSize)}>
                          {currentSubtitle.text}
                        </span>
                      )}
                      {subtitleStyle === "karaoke" && (() => {
                        // Same grouping + active-word treatment as the libass export (lib/subtitle-look).
                        const ws = subWordWindows(currentSubtitle);
                        const active = ws.findIndex((w) => currentTime >= w.start && currentTime < w.end);
                        const groups = chunkWindows(ws, subtitleLook.wordsPerLine);
                        const startIdx = (g: number) => groups.slice(0, g).reduce((n, x) => n + x.length, 0);
                        let gi = groups.findIndex((g, k) => active >= startIdx(k) && active < startIdx(k) + g.length);
                        if (gi < 0) gi = 0;
                        const group = groups[gi] ?? [];
                        const base = startIdx(gi);
                        const restScale = subtitleLook.activeMode === "scale" ? ACTIVE_SCALE : 1;
                        const activeCss = (): React.CSSProperties => {
                          const hl = `#${subtitleHighlight}`;
                          const css: React.CSSProperties = { display: "inline-block" };
                          if (subtitleLook.activeMode === "box") Object.assign(css, { background: hl, borderRadius: "0.18em", padding: "0 0.14em", WebkitTextStroke: "0px", textShadow: "none" });
                          else css.color = hl;
                          // A real font-size (not transform: scale) so the bigger word takes up
                          // room like libass's \fscx in the export, instead of overlapping neighbours.
                          if (restScale !== 1) css.fontSize = `${restScale}em`;
                          if (subtitleLook.pop) Object.assign(css, { animation: "sub-pop 110ms ease-out both", ["--pop-from" as string]: "0.72", ["--pop-to" as string]: "1" });
                          return css;
                        };
                        return (
                          <span className="inline-block" style={textStyleCss(textStyle, Math.max(9, (stageH || 320) / 24) * subtitleSize, subtitleLook.outline)}>
                            {group.map((w, j) => {
                              const i = base + j;
                              return (
                                <span key={i}>
                                  {/* key on the active index restarts the pop animation per word */}
                                  <span key={i === active ? `a${i}` : `w${i}`} style={i === active ? activeCss() : undefined}>{caseWord(w.word, subtitleLook)}</span>
                                  {subtitleEmoji && w.emoji ? ` ${w.emoji}` : ""}{j < group.length - 1 ? " " : ""}
                                </span>
                              );
                            })}
                          </span>
                        );
                      })()}
                      {subtitleStyle === "word" && (() => {
                        const ws = subWordWindows(currentSubtitle);
                        const curIdx = Math.max(0, ws.findIndex((w) => currentTime >= w.start && currentTime < w.end));
                        const cur = ws[curIdx] ?? ws[ws.length - 1];
                        if (!cur) return null;
                        const boxed = subtitleLook.activeMode === "box";
                        return (
                          <span key={`w${curIdx}`} className="inline-block" style={{
                            ...textStyleCss(textStyle, Math.max(16, (stageH || 320) / 12) * subtitleSize, subtitleLook.outline),
                            ...(boxed ? { background: `#${subtitleHighlight}`, borderRadius: "0.18em", WebkitTextStroke: "0px", textShadow: "none" } : { color: `#${subtitleHighlight}` }),
                            ...(subtitleLook.pop ? { animation: "sub-pop 110ms ease-out both" } : {}),
                          }}>
                            {cur.word.toUpperCase()}{subtitleEmoji && cur.emoji ? <span style={{ color: "initial" }}> {cur.emoji}</span> : ""}
                          </span>
                        );
                      })()}
                    </span>
                  </div>
                )}

                {/* Image / video asset overlays — drag to reposition. Video
                    elements stay mounted while hidden so playback can sync. */}
                {assets.filter((a) => (a.type === "image" || a.type === "video") && a.localUrl).map((a) => {
                  const visible = currentTime >= a.timestamp && currentTime <= a.timestamp + a.duration;
                  if (!visible && a.type === "image") return null;
                  const dragging = draggingImageId === a.id;
                  const dragHandlers = {
                    onPointerDown: (e: React.PointerEvent) => {
                      e.stopPropagation(); e.preventDefault();
                      const stage = (e.currentTarget as HTMLElement).parentElement;
                      if (!stage) return;
                      const r = stage.getBoundingClientRect();
                      const px = ((e.clientX - r.left) / r.width) * 100;
                      const py = ((e.clientY - r.top) / r.height) * 100;
                      imgDragRef.current = { id: a.id, offX: px - a.x, offY: py - a.y };
                      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                      setDraggingImageId(a.id);
                    },
                    onPointerMove: (e: React.PointerEvent) => {
                      const d = imgDragRef.current;
                      if (!d || d.id !== a.id) return;
                      const stage = (e.currentTarget as HTMLElement).parentElement;
                      if (!stage) return;
                      const r = stage.getBoundingClientRect();
                      const px = ((e.clientX - r.left) / r.width) * 100;
                      const py = ((e.clientY - r.top) / r.height) * 100;
                      updateAsset(a.id, {
                        x: Math.max(0, Math.min(100, px - d.offX)),
                        y: Math.max(0, Math.min(100, py - d.offY)),
                      });
                    },
                    onPointerUp: (e: React.PointerEvent) => {
                      imgDragRef.current = null;
                      setDraggingImageId(null);
                      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                    },
                  };
                  const overlayClass = `absolute object-contain cursor-move touch-none transition-shadow ${
                    dragging ? "ring-2 ring-violet-400/70 shadow-lg" : "hover:ring-2 hover:ring-violet-400/30"
                  } ${visible ? "" : "invisible pointer-events-none"}`;
                  const overlayStyle = { left: `${a.x}%`, top: `${a.y}%`, width: `${a.scale}%` };
                  if (a.type === "video") {
                    return (
                      <video key={a.id}
                        ref={(el) => { videoAssetElsRef.current[a.id] = el; }}
                        src={a.localUrl} playsInline preload="auto" draggable={false}
                        {...dragHandlers} className={overlayClass} style={overlayStyle}
                      />
                    );
                  }
                  return (
                    <img key={a.id} src={a.localUrl} alt={a.name} draggable={false}
                      {...dragHandlers} className={overlayClass} style={overlayStyle}
                    />
                  );
                })}

                {/* Hidden audio for sound assets (preview playback) */}
                {assets.filter((a) => a.type === "sound" && a.localUrl).map((a) => (
                  <audio
                    key={a.id}
                    ref={(el) => { soundElsRef.current[a.id] = el; }}
                    src={a.localUrl}
                    preload="auto"
                    className="hidden"
                  />
                ))}
                {/* Hidden audio for background music (preview playback) */}
                {(musicLocalUrl || musicServerUrl) && (
                  <audio ref={musicElRef} src={musicLocalUrl || musicServerUrl} preload="auto" className="hidden" />
                )}

                {/* Crop reposition hint */}
                {cropEnabled && !blurFill && videoLoaded && (
                  <div className={`absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 text-[11px] font-medium text-white/70 bg-black/55 backdrop-blur-sm px-2 py-0.5 rounded-full border border-white/10 pointer-events-none transition-opacity duration-200 ${draggingCrop ? "opacity-100" : "hover-reveal"}`}>
                    <Move size={11} /> Drag to reposition crop
                  </div>
                )}
              </div>

              {/* Play/pause indicator (visual only — click handled on stage).
                  While paused it's always shown — the tap affordance on touch
                  devices; while playing it stays hover-only so it never sits
                  over the preview. */}
              <div className={`absolute inset-0 flex items-center justify-center pointer-events-none transition-opacity duration-200 ${playing ? "opacity-0 group-hover:opacity-100" : "hover-reveal"}`}>
                <div className="bg-black/50 rounded-full p-4 backdrop-blur-md border border-white/[0.08] shadow-2xl
                  scale-90 group-hover:scale-100 transition-transform duration-200 ease-out">
                  {playing
                    ? <Pause size={22} className="text-white" />
                    : <Play size={22} className="text-white fill-white" />}
                </div>
              </div>

              {/* Loading overlay */}
              {!videoLoaded && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                  {clip.thumbnailUrl && (
                    <img src={clip.thumbnailUrl} alt=""
                      className="absolute inset-0 w-full h-full object-cover opacity-[0.15] pointer-events-none" />
                  )}
                  <div className="relative z-10 flex flex-col items-center gap-2 px-6 text-center">
                    {saveError ? (
                      <>
                        <AlertCircle size={22} className="text-red-400 flex-shrink-0" />
                        <p className="text-[12px] text-red-400/80 font-medium leading-relaxed max-w-[300px]">{saveError}</p>
                        <p className="text-[11px] text-white/20 max-w-[260px]">Clip info was imported but the video could not be saved for editing. Check the dev server console for details.</p>
                      </>
                    ) : (
                      <>
                        <Loader2 size={24} className="text-violet-400 animate-spin" />
                        {saving && <span className="text-[12px] text-white/30 tracking-wide">Downloading clip…</span>}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Status pill */}
              {(saving || uploading) && videoLoaded && (
                <div className="absolute top-3 left-3 flex items-center gap-1.5 text-[11px] text-white/45
                  bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-full border border-white/[0.06]">
                  <Loader2 size={10} className="animate-spin" />
                  {uploading ? "Uploading…" : "Saving to server…"}
                </div>
              )}

              {/* Speed badge */}
              {speed !== 1 && (
                <div className="absolute top-3 right-3 text-[11px] text-violet-300 bg-violet-600/20 backdrop-blur-md
                  px-2 py-0.5 rounded-full border border-violet-500/25 font-mono font-medium">
                  {speed}×
                </div>
              )}

              {/* Aspect-ratio indicator */}
              {cropEnabled && (
                <div className="absolute bottom-3 left-3 text-[11px] text-white/30 font-medium tracking-wider uppercase">
                  {ASPECTS[cropAspect].label} · {ASPECTS[cropAspect].sub}
                  {previewZoom > 1.001 && <span className="text-violet-300/60"> · {previewZoom.toFixed(1)}×</span>}
                </div>
              )}

            </div>

            {/* Transport — play/step/jump, split and undo, always one tap away */}
            <div className="flex items-center gap-1 px-2 sm:px-3 h-12 bg-d0c border-t border-white/[0.06] flex-shrink-0">
              <div className="flex items-center gap-0.5">
                <TransportBtn label="Go to start (Home)" onClick={() => seekTo(0)} className="hidden sm:flex"><SkipBack size={15} /></TransportBtn>
                <TransportBtn label="Back 1 frame (,)" onClick={() => stepFrames(-1)}><StepBack size={15} /></TransportBtn>
                <button type="button" onClick={togglePlay} aria-label={playing ? "Pause (Space)" : "Play (Space)"} title={playing ? "Pause (Space)" : "Play (Space)"}
                  className="w-10 h-10 mx-0.5 flex items-center justify-center rounded-full bg-white text-black hover:bg-white/90 active:scale-95 transition-all">
                  {playing ? <Pause size={17} className="fill-black" /> : <Play size={17} className="fill-black ml-0.5" />}
                </button>
                <TransportBtn label="Forward 1 frame (.)" onClick={() => stepFrames(1)}><StepForward size={15} /></TransportBtn>
                <TransportBtn label="Go to end (End)" onClick={() => seekTo(Math.max(0, timelineDuration - 0.05))} className="hidden sm:flex"><SkipForward size={15} /></TransportBtn>
              </div>

              <div className="ml-1.5 sm:ml-2 font-mono tabular-nums text-[12px] leading-none select-none">
                <span className="text-white/85">{formatTimecode(currentTime)}</span>
                <span className="text-white/25"> / {formatTimecode(timelineDuration)}</span>
              </div>

              <div className="flex-1" />

              <button type="button" onClick={handleSplit} title="Split at playhead (S)"
                className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12px] font-semibold text-violet-200
                  bg-violet-500/[0.1] hover:bg-violet-500/20 border border-violet-500/25 transition-colors">
                <Scissors size={13} /> <span className="hidden sm:inline">Split</span>
              </button>
              <div className="w-px h-5 bg-white/[0.08] mx-1" />
              <TransportBtn label="Undo (Ctrl+Z)" onClick={undo} disabled={!history.canUndo}><Undo2 size={15} /></TransportBtn>
              <TransportBtn label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!history.canRedo}><Redo2 size={15} /></TransportBtn>
              <TransportBtn label="Keyboard shortcuts (?)" onClick={() => setShortcutsOpen(true)} className="hidden lg:flex"><Keyboard size={15} /></TransportBtn>
              <TransportBtn label={previewCompact ? "Bigger preview" : "Smaller preview"} onClick={() => setPreviewCompact((v) => !v)} className="lg:hidden">
                {previewCompact ? <Maximize2 size={15} /> : <Minimize2 size={15} />}
              </TransportBtn>
            </div>

            {/* Timeline */}
            <div className="bg-d0c border-t border-white/[0.04] flex-shrink-0 flex flex-col h-[160px] lg:h-[196px]">
              <div className="flex-1 min-h-0">
                <ClipTimeline
                  clips={clips} currentTime={currentTime}
                  onSeek={seekTo}
                  onTrimEdge={handleTrimEdge}
                  onTrimDragStart={handleTrimDragStart}
                  onReorder={handleReorderClip}
                  onDelete={handleDeleteClip}
                  onSplit={handleSplit}
                  onTrimToPlayhead={handleTrimToPlayhead}
                  onClipVolume={handleClipVolume}
                  tracks={timelineTracks}
                  onTrackChange={handleTrackChange}
                  onTrackDelete={handleTrackDelete}
                  onAddMedia={handleAddMedia}
                  videoSrc={srcUrl || undefined}
                  sourceDuration={clip?.duration ?? 0}
                  markers={[
                    ...(cropEnabled ? cropKeys.map((k) => ({ id: k.id!, time: k.time })) : []),
                    ...zoomKeys.map((k) => ({ id: k.id!, time: k.time })),
                  ]}
                />
              </div>
            </div>
          </div>

          {/* ── Inspector ──────────────────────────────────────────────────────── */}
          {/* Full width below the preview on mobile; fixed side panel on desktop. */}
          <div className="w-full lg:w-[340px] xl:w-[380px] bg-d0c border-t lg:border-t-0 lg:border-l border-white/[0.06] flex flex-col flex-shrink-0 min-h-0">

            {/* Clip header */}
            <div className="px-4 pt-3.5 pb-3 border-b border-white/[0.04]">
              <div className="flex items-start gap-2.5 mb-2.5">
                {clip.thumbnailUrl ? (
                  <img src={clip.thumbnailUrl} alt=""
                    className="w-14 h-9 object-cover rounded-md flex-shrink-0 bg-white/[0.04]" />
                ) : (
                  <div className="w-14 h-9 rounded-md flex-shrink-0 bg-white/[0.03] border border-white/[0.05] flex items-center justify-center">
                    <Film size={13} className="text-white/15" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  {editingTitle ? (
                    <textarea
                      autoFocus
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
                        if (e.key === "Escape") setEditingTitle(false);
                      }}
                      onBlur={commitTitle}
                      rows={2}
                      className="w-full bg-white/[0.05] border border-violet-500/35 rounded-md px-1.5 py-1 mb-0.5
                        text-[12px] font-semibold text-white/85 leading-snug outline-none resize-none
                        focus:border-violet-500/55 focus:ring-2 focus:ring-violet-500/10 transition-all"
                    />
                  ) : (
                    <button type="button" onClick={startTitleEdit} title="Edit title"
                      className="group/title w-full text-left mb-0.5 cursor-text">
                      <p className="text-[12px] font-semibold text-white/70 group-hover/title:text-white/90 leading-snug line-clamp-2 transition-colors">
                        {clip.title}
                        <Pencil size={10} className="inline-block ml-1.5 -mt-px text-white/20 group-hover/title:text-violet-300 transition-colors" />
                      </p>
                    </button>
                  )}
                  <div className="flex items-center gap-2">
                    {clip.platform !== "local" && (
                      <p className="text-[11px] text-white/20 font-mono">@{clip.streamer}</p>
                    )}
                    <button type="button" onClick={suggestTitles} disabled={titleIdeasLoading}
                      title="Let AI suggest a title from the clip's frames and transcript"
                      className="flex items-center gap-1 text-[11px] text-violet-400/60 hover:text-violet-300 disabled:opacity-50 transition-colors duration-200 font-medium">
                      {titleIdeasLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                      {titleIdeasLoading ? "Thinking…" : "AI title"}
                    </button>
                  </div>
                </div>
              </div>

              {/* AI title suggestions — click one to use it */}
              {titleIdeasError && (
                <p className="text-[11px] text-red-400/70 mb-2">{titleIdeasError}</p>
              )}
              {titleIdeas.length > 0 && (
                <div className="mb-2.5 space-y-1">
                  {subtitles.length === 0 && (
                    <p className="text-[10px] text-white/25 leading-relaxed">
                      Tip: generate subtitles first — the AI reads the transcript and titles get much sharper.
                    </p>
                  )}
                  {titleIdeas.map((t, i) => (
                    <button key={i} type="button" onClick={() => applyTitle(t)}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg bg-violet-500/[0.06] border border-violet-500/15
                        text-[11px] text-white/65 leading-snug hover:bg-violet-500/15 hover:border-violet-500/30
                        transition-colors duration-150">
                      {t}
                    </button>
                  ))}
                  <button type="button" onClick={() => setTitleIdeas([])}
                    className="w-full text-center text-[11px] text-white/20 hover:text-white/40 py-0.5 transition-colors">
                    dismiss
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2">
                {pc && (
                  <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${pc.bg} ${pc.text} border border-white/[0.05]`}>
                    <span className={`w-1 h-1 rounded-full ${pc.dot} flex-shrink-0`} />
                    {pc.label}
                  </span>
                )}
                <span className="text-[11px] text-white/20 font-mono tabular-nums">{formatTime(clip.duration)}</span>
                <button type="button" onClick={downloadToPC} disabled={downloading}
                  className="ml-auto flex items-center gap-1 text-[11px] text-white/25 hover:text-violet-300 disabled:opacity-40 transition-colors duration-200">
                  {downloading ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                  {downloading ? "Saving…" : "Save to PC"}
                </button>
              </div>
            </div>

            {/* ── Tab bar ── */}
            <div role="tablist" aria-label="Editor tools" className="grid grid-cols-7 border-b border-white/[0.06] flex-shrink-0 bg-d0c">
              {([
                { id: "ai"    as const, icon: Sparkles,  label: "AI",    badge: !!(editStyle || aiChanges.length > 0 || virality || cover) },
                { id: "edit"  as const, icon: Scissors,  label: "Edit",  badge: clips.length > 1 || speed !== 1 || highlights.length > 0 },
                { id: "frame" as const, icon: Crop,      label: "Frame", badge: cropEnabled || zoom > 1.001 || zoomKeys.length > 0 },
                { id: "text"  as const, icon: TypeIcon,  label: "Text",  badge: !!(caption || subtitles.length > 0 || introText || outroText) },
                { id: "look"  as const, icon: Palette,   label: "Look",  badge: brightness !== 0 || contrast !== 0 || saturation !== 0 || colorFilter !== "none" || effects.length > 0 || fadeIn > 0 || fadeOut > 0 || vignette || mirror },
                { id: "audio" as const, icon: Music,     label: "Audio", badge: !!(musicServerUrl || videoVolume !== 100 || videoPitch !== 0 || loudnorm || volumeKeys.length > 0) },
                { id: "media" as const, icon: Layers,    label: "Media", badge: assets.length > 0 },
              ]).map(({ id, icon: Icon, label, badge }) => (
                <button key={id} type="button" role="tab" aria-selected={activeTab === id}
                  onClick={() => { setActiveTab(id); setOpenSection(null); }}
                  className={`relative flex flex-col items-center gap-1 pt-2.5 pb-2 border-b-2 transition-colors duration-150 ${
                    activeTab === id
                      ? "text-violet-200 border-violet-500 bg-violet-500/[0.06]"
                      : "text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-white/[0.02]"
                  }`}>
                  <Icon size={15} />
                  <span className="text-[10px] font-semibold tracking-wide">{label}</span>
                  {badge && (
                    <span className="absolute top-1.5 right-[calc(50%-14px)] w-1.5 h-1.5 rounded-full bg-violet-400 shadow-[0_0_4px_rgba(51,92,186,0.8)]" />
                  )}
                </button>
              ))}
            </div>

            {/* ── Scrollable section content ── */}
            {/* On mobile this flows in the page scroll; on desktop it's a bounded scroll region. */}
            <div className="lg:flex-1 lg:min-h-0 overflow-visible lg:overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/[0.08]">

            {/* ── AI Studio: style + Auto-edit + assistant ── */}
            {activeTab === "ai" && (
            <div className="px-4 pt-4 pb-3 border-b border-white/[0.04]">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <p className="text-[14px] font-semibold text-white/90 leading-tight">AI Studio</p>
                  <p className="text-[12px] text-white/40 mt-0.5 leading-snug">Let AI do the edit, then fine-tune any tab.</p>
                </div>
                {history.canUndo && (
                  <button type="button" onClick={undo} title="Undo (Ctrl+Z)"
                    className="flex-shrink-0 flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white bg-white/[0.04] border border-white/[0.07] px-2 py-1 rounded-md transition-colors">
                    <RotateCcw size={11} /> Undo
                  </button>
                )}
              </div>

              {!singleClip && <p className="text-[11px] text-amber-400/60 leading-relaxed mb-2">{multiClipNote}</p>}

              {/* Style: presets, copied styles, or none */}
              <p className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-1.5">Editing style</p>
              <div className="flex items-center gap-1.5 mb-1.5">
                <StylePicker value={editStyle} builtin={styles.builtin} saved={styles.saved}
                  onChange={selectEditStyle} onCopyNew={() => setCopyStyleOpen(true)}
                  onDelete={(s) => { void styles.remove(s); if (editStyle?.ref === s.ref) setEditStyle(null); }}
                  disabled={autoLoading} />
                <button type="button" onClick={() => setCopyStyleOpen(true)} disabled={autoLoading}
                  title="Copy the editing style of any short"
                  className="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium text-zinc-400
                    bg-white/[0.03] border border-white/[0.08] hover:text-white hover:border-white/[0.16] disabled:opacity-40 transition-colors">
                  <Wand2 size={11} /> Copy
                </button>
              </div>
              {editStyle && (
                <div className="mb-2 space-y-1.5">
                  <StyleTags style={editStyle.style} />
                  <button type="button" onClick={() => applyStyleLook(editStyle)} disabled={autoLoading || aiLoading || !clip}
                    title="Apply only the look (framing, captions, grade) — keeps your cuts and timing"
                    className="text-[11px] text-violet-300/80 hover:text-violet-200 disabled:opacity-40 transition-colors">
                    Apply look only →
                  </button>
                </div>
              )}

              {/* One-click Auto-edit — the model watches the clip and edits it */}
              <button type="button" onClick={runAutoEdit} disabled={autoLoading || aiLoading || !clip || !singleClip}
                title={singleClip ? "AI watches the clip and edits it: hook, trim, zooms, captions" : multiClipNote}
                className="w-full flex items-center justify-center gap-2 h-11 mt-1 rounded-xl text-[13px] font-semibold text-white
                  bg-gradient-to-b from-violet-500 to-violet-700 border border-violet-400/40
                  shadow-[0_0_22px_rgba(51,92,186,0.35),0_1px_0_rgba(255,255,255,0.12)_inset]
                  hover:from-violet-400 hover:to-violet-600 active:scale-[0.99]
                  disabled:opacity-40 disabled:shadow-none transition-all duration-200 ease-out">
                {autoLoading ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} className="fill-white" />}
                {autoLoading ? "Editing…" : editStyle ? `Auto-edit in “${editStyle.name}”` : "Auto-edit this clip"}
              </button>

              {autoLoading && autoSteps.length > 0 && (
                <div className="mt-2 space-y-1">
                  {autoSteps.map((s, i) => (
                    <div key={s} className={cn("flex items-center gap-1.5 text-[11px]",
                      i < autoStep ? "text-zinc-500" : i === autoStep ? "text-zinc-200" : "text-zinc-600")}>
                      {i < autoStep ? <Check size={11} className="text-violet-400" />
                        : i === autoStep ? <Loader2 size={11} className="animate-spin text-violet-300" />
                        : <span className="w-2 h-2 rounded-full border border-white/15 mx-px" />}
                      {s}
                    </div>
                  ))}
                </div>
              )}

              {/* Auto-edit option: clean up dead air before the model plans the edit */}
              {!autoLoading && (
                <button type="button" onClick={() => setAutoEditTighten((v) => !v)} disabled={aiLoading}
                  title="Auto-edit removes silent gaps first, then edits the tightened clip"
                  className="flex items-center gap-1.5 mt-1.5 mb-2 text-[11px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors">
                  <span className={cn(
                    "flex items-center justify-center w-3 h-3 rounded-sm border transition-colors",
                    autoEditTighten ? "bg-violet-500/30 border-violet-500/50 text-violet-200" : "border-white/15 text-transparent",
                  )}>
                    <Check size={10} strokeWidth={3} />
                  </span>
                  Cut dead air first
                </button>
              )}

              {/* Why: the editor's reasoning for the last Auto-edit */}
              {aiNotes.length > 0 && (
                <div className="mb-2 rounded-lg bg-white/[0.02] border border-white/[0.06] px-2.5 py-2">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-zinc-600 mb-1">Why these edits</p>
                  <ul className="space-y-0.5">
                    {aiNotes.map((n, i) => (
                      <li key={i} className="text-[11px] text-zinc-400 leading-snug flex gap-1.5">
                        <span className="text-violet-400/70">•</span>{n}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Quick-prompt chips — adapt to what the clip still needs */}
              <p className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mt-3 mb-1.5">Or ask for a change</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {[
                  ...(cropAspect === "original" ? ["Make it vertical"] : []),
                  ...(subtitles.length === 0 ? ["Add karaoke subtitles"] : ["Yellow impact captions"]),
                  "Punch-in on the biggest reaction",
                  ...(!caption ? ["Hook text at the top"] : []),
                  "Cut the slow intro",
                  ...(!loudnorm ? ["Level the audio"] : []),
                  "Flash on the peak",
                ].slice(0, 6).concat([
                  ...(!splitOn ? ["Facecam on top, gameplay below"] : ["Fit the facecam"]),
                  ...(clips.length > 1 ? ["Mute segment 2"] : ["Cut out the boring middle"]),
                  ...(musicLocalUrl || musicServerUrl ? ["Music quieter under speech"] : []),
                ]).map((q) => (
                  <button key={q} type="button" onClick={() => { setAiPrompt(q); }} disabled={aiLoading || autoLoading}
                    className="text-[11px] text-zinc-300 bg-white/[0.04] hover:bg-violet-500/15 hover:text-white hover:border-violet-500/30
                      border border-white/[0.07] px-2.5 py-1 rounded-full transition-colors disabled:opacity-40">
                    {q}
                  </button>
                ))}
              </div>

              <div className="flex gap-1.5">
                <DInput
                  placeholder='Ask for anything — e.g. "facecam on top, mute segment 2, yellow subtitles"'
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") runAiEdit(); }}
                  disabled={aiLoading || autoLoading}
                  className="flex-1 text-[12px]"
                />
                <button type="button" onClick={runAiEdit} disabled={aiLoading || autoLoading || !aiPrompt.trim()}
                  aria-label="Run AI edit"
                className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg
                    bg-violet-600/15 border border-violet-500/25 text-violet-400
                    hover:bg-violet-600/25 hover:border-violet-500/45 hover:text-violet-300
                    disabled:opacity-35 transition-all duration-200 ease-out">
                  {aiLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                </button>
              </div>

              {aiStatus && (
                <p className={`text-[11px] font-medium mt-1.5 flex items-center gap-1 ${aiStatus.ok ? "text-violet-400/70" : "text-red-400/70"}`}>
                  <span>{aiStatus.ok ? "✓" : "✕"}</span>
                  {aiStatus.msg}
                </p>
              )}

              {/* What changed + one-click undo */}
              {aiChanges.length > 0 && (
                <div className="mt-2 flex items-start gap-2">
                  <div className="flex-1 flex flex-wrap gap-1">
                    {aiChanges.map((c, i) => (
                      <span key={`${c}-${i}`} className="text-[10px] text-violet-300/80 bg-violet-500/[0.1] border border-violet-500/20 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                        {c}
                      </span>
                    ))}
                  </div>
                  {history.canUndo && (
                    <button type="button" onClick={undo}
                      className="flex-shrink-0 flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white
                        bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] px-2 py-1 rounded-md transition-colors">
                      <RotateCcw size={11} /> Undo
                    </button>
                  )}
                </div>
              )}

              {/* Session log of assistant requests — click to reuse a prompt */}
              {aiLog.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-white/[0.04] space-y-1">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-zinc-600">Recent requests</p>
                  {aiLog.slice(0, 4).map((l) => (
                    <button key={l.id} type="button" onClick={() => setAiPrompt(l.prompt)} disabled={aiLoading || autoLoading}
                      title="Reuse this request"
                      className="w-full flex items-center gap-2 text-left text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors">
                      <span className="flex-1 truncate">“{l.prompt}”</span>
                      <span className="flex-shrink-0 text-zinc-600">{l.changes.length ? `${l.changes.length} change${l.changes.length === 1 ? "" : "s"}` : "no change"}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            )}

            {/* ── Auto-Highlights ── */}
            <Section icon={Wand2} label="Auto-Highlights" hidden={activeTab !== "edit"} {...sec("highlights")}
              active={highlights.length > 0}
              summary={highlights.length > 0 ? `${highlights.length} found` : "AI"}>
              <button type="button" onClick={findHighlights} disabled={analyzing}
                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg
                  bg-violet-600/15 border border-violet-500/25 text-violet-200 text-[12px] font-semibold
                  hover:bg-violet-600/25 hover:border-violet-500/40 disabled:opacity-50 transition-all duration-200">
                {analyzing
                  ? <><Loader2 size={12} className="animate-spin" /> Scanning audio…</>
                  : <><Wand2 size={12} /> {highlights.length > 0 ? "Re-scan" : "Find highlights"}</>}
              </button>
              <p className="text-[11px] text-white/20 leading-relaxed">
                Scans the audio for loud, hype moments and suggests clip windows to trim to.
              </p>
              {!singleClip && <p className="text-[11px] text-amber-400/60 leading-relaxed">{multiClipNote} (applying one).</p>}
              {highlightMsg && (
                <p className="text-[11px] text-amber-400/70 leading-relaxed">{highlightMsg}</p>
              )}
              {highlights.length > 0 && (
                <div className="space-y-1">
                  {highlights.map((h, i) => {
                    const active = Math.abs(trimStart - h.start) < 0.5 && Math.abs(trimEnd - h.end) < 0.5;
                    return (
                      <div key={h.id}
                        className={`flex items-center gap-2 rounded-md px-2 py-1.5 border transition-colors ${
                          active ? "bg-violet-600/15 border-violet-500/30" : "bg-black/25 border-white/[0.05]"
                        }`}>
                        <span className="text-[11px] font-bold text-white/30 w-3 tabular-nums">{i + 1}</span>
                        <button type="button" onClick={() => seekTo(h.time)}
                          className="font-mono text-[11px] text-violet-300/80 hover:text-violet-200 tabular-nums w-9 text-left">
                          {formatTime(h.time)}
                        </button>
                        <div className="h-1.5 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
                          <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-400"
                            style={{ width: `${Math.max(6, h.score)}%` }} />
                        </div>
                        <span className="text-[11px] text-white/35 tabular-nums w-5 text-right">{h.score}</span>
                        <button type="button" onClick={() => applyHighlight(h)} disabled={!singleClip}
                          title={singleClip ? undefined : multiClipNote}
                          className={`text-[11px] font-semibold px-2 py-1 rounded-md transition-colors disabled:opacity-40 ${
                            active ? "bg-violet-500/25 text-violet-200" : "bg-white/[0.05] text-white/45 hover:text-violet-300 hover:bg-violet-500/15"
                          }`}>
                          {active ? "Set" : "Use"}
                        </button>
                      </div>
                    );
                  })}
                  <p className="text-[10px] text-white/20">Click a time to preview · &ldquo;Use&rdquo; trims the clip to that moment.</p>
                </div>
              )}
            </Section>

            {/* ── Trim ── numeric fallback for the common single-clip case; once
                the timeline has 2+ clips, editing moves to the drag handles on
                the timeline scrubber above (these fields would otherwise
                silently collapse the multi-clip timeline into one clip). */}
            <Section icon={Scissors} label="Trim" hidden={activeTab !== "edit"} {...sec("trim")}
              active={trimStart > 0 || (effectiveDuration > 0 && trimEnd < effectiveDuration - 0.05)}
              summary={formatTime(trimEnd - trimStart)}>
              {clips.length > 1 ? (
                <p className="text-[11px] text-white/30 leading-relaxed">
                  {clips.length} segments on the timeline — drag a segment&rsquo;s edges on the timeline to trim, drag its body to reorder, or use Q / W to trim to the playhead.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-1.5">
                    {([
                      { label: "Start", value: trimStart, max: trimEnd - 0.5, set: setTrimStart },
                      { label: "End",   value: trimEnd,   min: trimStart + 0.5, max: effectiveDuration, set: setTrimEnd },
                    ] as const).map(({ label, value, max, set, ...rest }) => (
                      <div key={label}>
                        <p className="text-[10px] text-zinc-600 mb-1 uppercase tracking-wider font-semibold">{label}</p>
                        <DInput
                          type="number"
                          {...rest}
                          max={max}
                          step={0.5}
                          value={value.toFixed(1)}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            set(v);
                            // v is SOURCE-absolute — seek the real video directly
                            // rather than through seekTo() (timeline time).
                            if (videoRef.current) videoRef.current.currentTime = v;
                            setCurrentTime(label === "Start" ? 0 : v - trimStart);
                          }}
                          className="text-center font-mono text-[12px]"
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}
              <p className="text-[11px] text-center font-mono text-violet-400/40 tabular-nums">
                {formatTime(trimEnd - trimStart)} selected
              </p>
            </Section>

            {/* ── Auto-tighten (remove dead air + fillers) ── */}
            <Section icon={Zap} label="Auto-tighten" hidden={activeTab !== "edit"} {...sec("tighten")}
              summary="Cut dead air">
              <button type="button" onClick={runAutoTighten} disabled={tightenLoading || !singleClip}
                title={singleClip ? undefined : multiClipNote}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg
                  bg-violet-600/15 border border-violet-500/25 text-violet-200 text-[12px] font-semibold
                  hover:bg-violet-600/25 hover:border-violet-500/40 disabled:opacity-50 transition-all">
                {tightenLoading
                  ? <><Loader2 size={11} className="animate-spin" /> Tightening…</>
                  : <><Zap size={11} /> Remove dead air{subtitles.length > 0 ? " + fillers" : ""}</>}
              </button>
              <p className="text-[11px] text-white/20 leading-relaxed">
                Detects silent gaps{subtitles.length > 0 ? " and “um/uh” fillers from the transcript" : ""} and re-renders the clip without them.
                It replaces the working clip and resets timeline edits, so run it early.
              </p>
              {!singleClip && <p className="text-[11px] text-amber-400/60 leading-relaxed">{multiClipNote}</p>}
              {tightenMsg && <p className="text-[11px] text-amber-400/70 leading-relaxed">{tightenMsg}</p>}
            </Section>

            {/* ── Virality score ── */}
            <Section icon={Gauge} label="Virality score" hidden={activeTab !== "ai"} {...sec("virality")}
              active={!!virality}
              summary={virality ? `${virality.score}/100` : "Rate it"}>
              <button type="button" onClick={runVirality} disabled={viralityLoading || !singleClip}
                title={singleClip ? undefined : multiClipNote}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg
                  bg-violet-600/15 border border-violet-500/25 text-violet-200 text-[12px] font-semibold
                  hover:bg-violet-600/25 hover:border-violet-500/40 disabled:opacity-50 transition-all">
                {viralityLoading
                  ? <><Loader2 size={11} className="animate-spin" /> Scoring…</>
                  : <><Gauge size={11} /> {virality ? "Re-score" : "Score this clip"}</>}
              </button>
              {!singleClip && <p className="text-[11px] text-amber-400/60 leading-relaxed">{multiClipNote}</p>}
              {virality && (() => {
                const c = virality.score >= 70 ? "#34C759" : virality.score >= 45 ? "#FFD60A" : "#FF453A";
                return (
                  <div className="space-y-2.5 pt-0.5">
                    <div className="flex items-center gap-3">
                      <div className="relative flex items-center justify-center w-14 h-14 flex-shrink-0">
                        <svg viewBox="0 0 36 36" className="w-14 h-14 -rotate-90">
                          <circle cx="18" cy="18" r="15.5" fill="none" stroke="#ffffff14" strokeWidth="3" />
                          <circle cx="18" cy="18" r="15.5" fill="none" stroke={c} strokeWidth="3" strokeLinecap="round"
                            strokeDasharray={`${(virality.score / 100) * 97.4} 97.4`} />
                        </svg>
                        <span className="absolute text-[15px] font-bold tabular-nums" style={{ color: c }}>{virality.score}</span>
                      </div>
                      <div className="min-w-0">
                        {virality.verdict && <p className="text-[12px] font-semibold text-white/80 leading-snug">{virality.verdict}</p>}
                        <p className="text-[11px] text-white/35 mt-1">Hook strength {virality.hookStrength}/100</p>
                        <div className="h-1 mt-1 rounded-full bg-white/[0.06] overflow-hidden w-28">
                          <div className="h-full rounded-full" style={{ width: `${virality.hookStrength}%`, background: c }} />
                        </div>
                      </div>
                    </div>
                    {virality.reasons.length > 0 && (
                      <div className="space-y-1">
                        {virality.reasons.map((r, i) => (
                          <p key={i} className="text-[11px] text-white/55 leading-snug flex gap-1.5">
                            <span className="text-violet-400/60 flex-shrink-0">•</span>{r}
                          </p>
                        ))}
                      </div>
                    )}
                    {virality.fixes.length > 0 && (
                      <div className="space-y-1 border-t border-white/[0.05] pt-2">
                        <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">To raise the score</p>
                        {virality.fixes.map((f, i) => (
                          <p key={i} className="text-[11px] text-white/55 leading-snug flex gap-1.5">
                            <Wand2 size={11} className="text-violet-400/60 flex-shrink-0 mt-0.5" />{f}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              <p className="text-[11px] text-white/20 leading-relaxed">
                AI rates the hook, pacing, and payoff for short-form. Guidance only — it doesn’t change your edit.
              </p>
            </Section>

            {/* ── AI cover ── */}
            <Section icon={ImageIcon} label="AI cover" hidden={activeTab !== "ai"} {...sec("cover")}
              active={!!cover}
              summary={cover ? "Ready" : "Make one"}>
              <button type="button" onClick={() => runCover()} disabled={coverLoading || !singleClip}
                title={singleClip ? undefined : multiClipNote}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg
                  bg-sky-600/15 border border-sky-500/25 text-sky-200 text-[12px] font-semibold
                  hover:bg-sky-600/25 hover:border-sky-500/40 disabled:opacity-50 transition-all">
                {coverLoading
                  ? <><Loader2 size={11} className="animate-spin" /> Generating…</>
                  : <><ImageIcon size={11} /> {cover ? "New cover" : "Generate cover"}</>}
              </button>
              {!singleClip && <p className="text-[11px] text-amber-400/60 leading-relaxed">{multiClipNote}</p>}
              {cover && (
                <div className="space-y-2.5 pt-0.5">
                  <div className="flex gap-3">
                    <img src={cover.url} alt="Generated cover" draggable={false}
                      className="w-[84px] aspect-[9/16] object-cover rounded-md border border-white/10 flex-shrink-0 bg-black" />
                    <div className="min-w-0 space-y-2">
                      {cover.reason && <p className="text-[11px] text-white/45 leading-snug">{cover.reason}</p>}
                      <a href={cover.url} download
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-300 hover:text-sky-200">
                        <Download size={10} /> Download cover
                      </a>
                    </div>
                  </div>
                  {cover.hooks.length > 1 && (
                    <div className="space-y-1.5 border-t border-white/[0.05] pt-2">
                      <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Try another hook</p>
                      <div className="flex flex-wrap gap-1.5">
                        {cover.hooks.map((h, i) => (
                          <button key={i} type="button" disabled={coverLoading || !singleClip} onClick={() => runCover(h)}
                            className={`px-2 py-1 rounded-md text-[11px] font-medium transition-all disabled:opacity-50 ${
                              h === cover.chosenHook
                                ? "bg-sky-600/25 border border-sky-500/40 text-sky-100"
                                : "bg-white/[0.04] border border-white/10 text-white/55 hover:bg-white/[0.08]"
                            }`}>
                            {h}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <p className="text-[11px] text-white/20 leading-relaxed">
                AI picks the most scroll-stopping frame and burns on a hook. Download it as your TikTok / Reels / Shorts cover.
              </p>
            </Section>

            {/* ── Subtitles (Style tab) ── */}
            <Section icon={Languages} label="Subtitles" hidden={activeTab !== "text"} {...sec("subtitles")}
              active={subtitles.length > 0}
              summary={subtitles.length > 0 ? `${subtitles.length} lines` : "Off"}
              badge={subtitles.length > 0
                ? <button type="button" onClick={(e) => { e.stopPropagation(); setSubtitles([]); setSubtitleMsg(""); }}
                    className="text-[11px] text-white/20 hover:text-violet-300 transition-colors duration-150 font-medium">clear</button>
                : undefined}>
              <div className="flex items-center gap-1.5">
                <select
                  value={subtitleLang}
                  onChange={(e) => setSubtitleLang(e.target.value)}
                  className="flex-1 bg-d08 border border-white/[0.07] rounded-lg px-2 py-1.5 text-[12px] text-white/70 outline-none focus:border-violet-500/40 transition-colors"
                >
                  {SUB_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
                <button type="button" onClick={() => generateSubtitles()} disabled={subtitlesLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600/15 border border-violet-500/25 text-violet-200 text-[12px] font-semibold hover:bg-violet-600/25 hover:border-violet-500/40 disabled:opacity-50 transition-all flex-shrink-0">
                  {subtitlesLoading
                    ? <><Loader2 size={11} className="animate-spin" /> Transcribing…</>
                    : <><Languages size={11} /> {subtitles.length > 0 ? "Redo" : "Generate"}</>}
                </button>
              </div>
              <p className="text-[11px] text-white/20 leading-relaxed">
                AI transcribes the speech{subtitleLang !== "original" ? " and translates it" : ""} and burns timed subtitles in on export.
              </p>
              {subtitleMsg && <p className="text-[11px] text-amber-400/70 leading-relaxed">{subtitleMsg}</p>}
              {/* Always shown (even with zero lines) so a subtitle can be
                  added from scratch without transcribing first. */}
              <SubtitlePanel
                subtitles={subtitles} clips={clips} onSeek={seekTo}
                onUpdateText={updateSubtitle} onUpdateTiming={retimeSubtitle}
                onSplit={splitSubtitle} onMerge={mergeSubtitles}
                onAdd={addSubtitle} onDelete={removeSubtitle}
                onBeginEdit={beginSubtitleEdit}
              />
              {subtitles.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Caption style</p>
                  <div className="grid grid-cols-3 gap-1">
                    {([
                      { k: "classic", label: "Classic", hint: "Lines" },
                      { k: "karaoke", label: "Karaoke", hint: "Word lights up" },
                      { k: "word", label: "Word", hint: "One at a time" },
                    ] as const).map(({ k, label, hint }) => (
                      <button key={k} type="button" onClick={() => setSubtitleStyle(k)} title={hint}
                        className={cn(
                          "py-1.5 rounded-lg text-[11px] font-semibold border transition-colors",
                          subtitleStyle === k
                            ? "bg-violet-600/20 border-violet-500/40 text-violet-200"
                            : "bg-white/[0.03] border-white/[0.06] text-white/50 hover:text-white/80 hover:bg-white/[0.06]"
                        )}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {subtitleStyle !== "classic" && (
                    <label className="flex items-center justify-between gap-2 pt-0.5">
                      <span className="text-[11px] text-white/35">Highlight colour</span>
                      <input type="color" value={`#${subtitleHighlight}`}
                        onChange={(e) => setSubtitleHighlight(e.target.value.replace("#", "").toUpperCase())}
                        className="w-7 h-6 rounded bg-transparent border border-white/10 cursor-pointer p-0" />
                    </label>
                  )}
                  {subtitleStyle !== "classic" && (
                    <button type="button" onClick={toggleSubtitleEmoji} disabled={emojiLoading}
                      className={cn(
                        "w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors disabled:opacity-50",
                        subtitleEmoji
                          ? "bg-violet-600/20 border-violet-500/40 text-violet-200"
                          : "bg-white/[0.03] border-white/[0.06] text-white/50 hover:text-white/80 hover:bg-white/[0.06]"
                      )}>
                      {emojiLoading
                        ? <><Loader2 size={11} className="animate-spin" /> Adding emoji…</>
                        : <><Sparkles size={11} /> {subtitleEmoji ? (hasEmoji ? "Auto-emoji on" : "Auto-emoji (no picks)") : "Auto-emoji"}</>}
                    </button>
                  )}
                  {subtitleStyle !== "classic" && (
                    <p className="text-[11px] text-white/20 leading-relaxed">
                      AI drops a fitting emoji on the punchy keywords — the Opus Clip / CapCut look.
                    </p>
                  )}
                  {subtitleStyle !== "classic" && (
                    <div className="space-y-1.5 pt-1">
                      <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Spoken word</p>
                      <div className="grid grid-cols-3 gap-1">
                        {([
                          { k: "color", label: "Colour" },
                          { k: "box", label: "Box" },
                          { k: "scale", label: "Bigger" },
                        ] as const).map(({ k, label }) => (
                          <button key={k} type="button" onClick={() => setSubtitleLook((l) => ({ ...l, activeMode: k }))}
                            className={cn(
                              "py-1.5 rounded-lg text-[11px] font-semibold border transition-colors",
                              subtitleLook.activeMode === k
                                ? "bg-violet-600/20 border-violet-500/40 text-violet-200"
                                : "bg-white/[0.03] border-white/[0.06] text-white/50 hover:text-white/80 hover:bg-white/[0.06]"
                            )}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        {([
                          { k: "uppercase", label: "ALL CAPS" },
                          { k: "pop", label: "Pop in" },
                        ] as const).map(({ k, label }) => (
                          <button key={k} type="button" onClick={() => setSubtitleLook((l) => ({ ...l, [k]: !l[k] }))}
                            aria-pressed={subtitleLook[k]}
                            className={cn(
                              "py-1.5 rounded-lg text-[11px] font-semibold border transition-colors",
                              subtitleLook[k]
                                ? "bg-violet-600/20 border-violet-500/40 text-violet-200"
                                : "bg-white/[0.03] border-white/[0.06] text-white/50 hover:text-white/80 hover:bg-white/[0.06]"
                            )}>
                            {label}
                          </button>
                        ))}
                      </div>
                      {subtitleStyle === "karaoke" && (
                        <DSlider resetTo={0} label="Words on screen" value={subtitleLook.wordsPerLine} min={0} max={6} step={1}
                          onChange={(v) => setSubtitleLook((l) => ({ ...l, wordsPerLine: Math.round(v) }))}
                          format={(v) => (v < 1 ? "Phrase" : `${Math.round(v)}`)} />
                      )}
                      <DSlider resetTo={1} label="Outline" value={subtitleLook.outline} min={0} max={3} step={0.25}
                        onChange={(v) => setSubtitleLook((l) => ({ ...l, outline: v }))}
                        format={(v) => (v === 0 ? "None" : `${v.toFixed(2)}×`)} />
                    </div>
                  )}
                  <DSlider resetTo={1} label="Size" value={subtitleSize} min={0.5} max={2.5} step={0.05}
                    onChange={setSubtitleSize} format={(v) => `${v.toFixed(2)}×`} />
                  <div className="flex items-center gap-2 text-[11px] text-white/25">
                    <Move size={11} className="text-white/20" />
                    Drag the subtitle on the preview to reposition
                    <span className="ml-auto font-mono text-white/25 tabular-nums">{Math.round(subtitleX)}, {Math.round(subtitleY)}</span>
                    <button type="button" onClick={() => { setSubtitleX(50); setSubtitleY(88); setSubtitleSize(1); }}
                      className="text-white/25 hover:text-violet-300 transition-colors">
                      <RotateCcw size={11} />
                    </button>
                  </div>
                </div>
              )}
              {subtitles.length > 0 && <TextStylePicker style={textStyle} onChange={setTextStyle} />}
            </Section>

            {/* ── Music ── */}
            <Section icon={Music} label="Music Track" hidden={activeTab !== "audio"} {...sec("music")}
              active={!!musicServerUrl}
              summary={musicFileName ? `${musicFileName.slice(0, 16)}${musicFileName.length > 16 ? "…" : ""}` : "None"}>
              {musicFileName ? (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2 bg-black/30 border border-white/[0.06] rounded-lg px-2.5 py-2">
                    {musicUploading
                      ? <Loader2 size={10} className="animate-spin text-violet-400/50 flex-shrink-0" />
                      : <Music size={10} className="text-violet-400/50 flex-shrink-0" />}
                    <span className="text-[11px] text-white/45 truncate flex-1 font-medium">{musicFileName}</span>
                    <button type="button"
                      onClick={() => { setMusicFileName(""); setMusicServerUrl(""); setMusicLocalUrl(""); setMusicDuration(0); }}
                      className="text-white/15 hover:text-white/50 transition-colors duration-150 flex-shrink-0">
                      <X size={10} />
                    </button>
                  </div>
                  {!musicUploading && musicServerUrl && (
                    <>
                      <DSlider resetTo={80} label="Music volume" value={musicVolume} min={0} max={100} onChange={setMusicVolume} format={(v) => `${v}%`} />
                      <DSlider resetTo={100} label="Original audio" value={videoVolume} min={0} max={100} onChange={setVideoVolume} format={(v) => `${v}%`} />
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold flex-1">Play for (s)</span>
                        <DInput type="number" min={0} max={600} step={0.5}
                          value={musicDuration ? musicDuration.toFixed(1) : ""}
                          placeholder="full"
                          onChange={(e) => setMusicDuration(Math.max(0, Number(e.target.value) || 0))}
                          className="w-20 text-center font-mono text-[12px]" />
                      </div>
                      <p className="text-[10px] text-white/20 leading-relaxed">Leave empty (or 0) to play across the whole clip.</p>
                    </>
                  )}
                </div>
              ) : (
                <button type="button" onClick={() => musicInputRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-white/[0.02]
                    border border-dashed border-white/[0.08] rounded-lg text-[11px] text-white/25 font-medium
                    hover:text-violet-300 hover:border-violet-500/30 hover:bg-violet-500/[0.04]
                    transition-all duration-200 ease-out">
                  <Music size={11} />
                  Add background music
                </button>
              )}
            </Section>

            {/* ── Assets ── */}
            <Section icon={Layers} label="Assets"
              hidden={activeTab !== "media"} {...sec("assets")}
              active={assets.length > 0}
              summary={assets.length > 0 ? `${assets.length} added` : "None"}
              badge={assets.length > 0 ? <span className="text-[11px] text-violet-400/60 font-mono bg-violet-500/10 px-1.5 py-px rounded">{assets.length}</span> : undefined}>
              <button type="button" onClick={runAutoBroll} disabled={brollLoading || !singleClip}
                title={singleClip ? undefined : multiClipNote}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 mb-1.5 rounded-lg
                  bg-violet-600/15 border border-violet-500/25 text-violet-200 text-[12px] font-semibold
                  hover:bg-violet-600/25 hover:border-violet-500/40 disabled:opacity-50 transition-all">
                {brollLoading
                  ? <><Loader2 size={11} className="animate-spin" /> Finding B-roll…</>
                  : <><Sparkles size={11} /> Auto B-roll</>}
              </button>
              <p className="text-[11px] text-white/20 leading-relaxed mb-2">
                AI reads the transcript, picks the visual moments, and drops in matching stock footage.
              </p>
              {!singleClip && <p className="text-[11px] text-amber-400/60 leading-relaxed mb-2">{multiClipNote}</p>}
              {brollMsg && <p className="text-[11px] text-amber-400/70 leading-relaxed mb-2">{brollMsg}</p>}
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold mb-1.5">Sound effects · at playhead</p>
              <div className="grid grid-cols-3 gap-1 mb-2.5">
                {SFX_KEYS.map((k) => (
                  <button key={k} type="button" onClick={() => addSfx(k, currentTime)} title={SFX_LIBRARY[k].use}
                    className="flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors
                      bg-white/[0.03] border-white/[0.06] text-white/50 hover:text-violet-200 hover:bg-violet-600/15 hover:border-violet-500/30">
                    <Volume2 size={10} />{SFX_LIBRARY[k].label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5 mb-2.5">
                <button type="button" onClick={() => soundAssetRef.current?.click()}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg
                    bg-white/[0.02] border border-dashed border-white/[0.08] text-[11px] text-white/25 font-medium
                    hover:text-violet-300 hover:border-violet-500/30 hover:bg-violet-500/[0.04]
                    transition-all duration-200 ease-out">
                  <Plus size={11} /><Volume2 size={10} />Sound
                </button>
                <button type="button" onClick={() => imageAssetRef.current?.click()}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg
                    bg-white/[0.02] border border-dashed border-white/[0.08] text-[11px] text-white/25 font-medium
                    hover:text-violet-300 hover:border-violet-500/30 hover:bg-violet-500/[0.04]
                    transition-all duration-200 ease-out">
                  <Plus size={11} /><ImageIcon size={10} />Image
                </button>
                <button type="button" onClick={() => videoAssetRef.current?.click()}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg
                    bg-white/[0.02] border border-dashed border-white/[0.08] text-[11px] text-white/25 font-medium
                    hover:text-violet-300 hover:border-violet-500/30 hover:bg-violet-500/[0.04]
                    transition-all duration-200 ease-out">
                  <Plus size={11} /><Film size={10} />Video
                </button>
              </div>
              {assets.length === 0 && (
                <div className="flex flex-col items-center gap-1.5 py-5 text-center">
                  <Layers size={20} className="text-white/[0.07]" />
                  <p className="text-[11px] text-white/15 font-medium">No assets added</p>
                  <p className="text-[10px] text-white/10">Sound effects · Image &amp; video overlays</p>
                </div>
              )}
              {assets.map((a) => (
                <div key={a.id} className="bg-black/25 border border-white/[0.05] rounded-lg p-2.5 space-y-2">
                  <div className="flex items-center gap-1.5">
                    {a.type === "sound"
                      ? <Volume2 size={11} className="text-violet-400/50 flex-shrink-0" />
                      : a.type === "video"
                        ? <Film size={11} className="text-violet-400/50 flex-shrink-0" />
                        : <ImageIcon size={11} className="text-violet-400/50 flex-shrink-0" />}
                    {a.uploading
                      ? <Loader2 size={11} className="animate-spin text-violet-400/50 flex-shrink-0" />
                      : null}
                    <span className="text-[11px] text-white/45 truncate flex-1 font-medium">{a.name}</span>
                    <button type="button" onClick={() => removeAsset(a.id)}
                      className="text-white/15 hover:text-white/50 transition-colors duration-150 flex-shrink-0">
                      <X size={11} />
                    </button>
                  </div>
                  <div className={`grid gap-1.5 ${a.type === "image" ? "grid-cols-2" : "grid-cols-3"}`}>
                    <div>
                      <p className="text-[10px] text-zinc-600 mb-0.5 uppercase tracking-wider font-semibold">At (s)</p>
                      <DInput type="number" min={0} max={timelineDuration} step={0.5}
                        value={a.timestamp.toFixed(1)}
                        onChange={(e) => updateAsset(a.id, { timestamp: Math.max(0, Number(e.target.value)) })}
                        className="text-center font-mono text-[12px]" />
                    </div>
                    {a.type !== "image" && (
                      <div>
                        <p className="text-[10px] text-zinc-600 mb-0.5 uppercase tracking-wider font-semibold">Vol %</p>
                        <DInput type="number" min={0} max={200} step={5}
                          value={a.volume}
                          onChange={(e) => updateAsset(a.id, { volume: Math.max(0, Math.min(200, Number(e.target.value))) })}
                          className="text-center font-mono text-[12px]" />
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] text-zinc-600 mb-0.5 uppercase tracking-wider font-semibold">For (s)</p>
                      <DInput type="number" min={0.5} max={60} step={0.5}
                        value={a.duration.toFixed(1)}
                        onChange={(e) => updateAsset(a.id, { duration: Math.max(0.5, Math.min(60, Number(e.target.value))) })}
                        className="text-center font-mono text-[12px]" />
                    </div>
                  </div>
                  {a.type !== "sound" && (
                    <div className="grid grid-cols-3 gap-1">
                      {[
                        { label: "X %", key: "x" as const, max: 100 },
                        { label: "Y %", key: "y" as const, max: 100 },
                        { label: "Size%", key: "scale" as const, max: 200 },
                      ].map(({ label, key, max }) => (
                        <div key={key}>
                          <p className="text-[10px] text-zinc-600 mb-0.5 uppercase tracking-wider font-semibold">{label}</p>
                          <DInput type="number" min={0} max={max} step={1}
                            value={Math.round(a[key])}
                            onChange={(e) => updateAsset(a.id, { [key]: Math.max(0, Math.min(max, Number(e.target.value))) })}
                            className="text-center font-mono text-[11px] px-1" />
                        </div>
                      ))}
                      <p className="col-span-3 text-[10px] text-violet-400/40 flex items-center gap-1 mt-0.5">
                        <Move size={10} className="text-violet-400/60" /> Drag it in the preview to place it
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </Section>

            {/* ── Aspect Ratio ── */}
            <Section icon={Crop} label="Aspect Ratio" hidden={activeTab !== "frame"} {...sec("aspect")}
              active={cropEnabled}
              summary={cropEnabled ? `${ASPECTS[cropAspect].label}${blurFill ? " · blur" : splitOn ? ` · split ${split.panels.length}` : ""}` : "Original"}>
              <div className="grid grid-cols-3 gap-1.5">
                {ASPECT_KEYS.map((key) => {
                  const a = ASPECTS[key];
                  const active = cropAspect === key;
                  return (
                    <button key={key} type="button" onClick={() => setCropAspect(key)}
                      className={`py-2 rounded-lg text-center border transition-all duration-200 ease-out ${
                        active
                          ? "bg-violet-600/15 border-violet-500/35 shadow-[0_0_10px_rgba(51,92,186,0.12)]"
                          : "bg-white/[0.02] border-white/[0.05] hover:border-white/[0.09] hover:bg-white/[0.04]"
                      }`}>
                      <div className={`text-[12px] font-bold font-mono ${active ? "text-violet-300" : "text-white/30"}`}>{a.label}</div>
                      <div className={`text-[10px] uppercase tracking-wider font-semibold mt-0.5 ${active ? "text-violet-400/60" : "text-white/15"}`}>{a.sub}</div>
                    </button>
                  );
                })}
              </div>

              {/* ── Auto face-tracking reframe ── */}
              <button type="button" onClick={runAutoReframe} disabled={reframeLoading || autoLoading || aiLoading || !clip || !singleClip}
                title={singleClip ? undefined : multiClipNote}
                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg
                  bg-gradient-to-r from-violet-600/25 to-fuchsia-600/20 border border-violet-500/35 text-violet-200 text-[12px] font-semibold
                  hover:from-violet-600/35 hover:to-fuchsia-600/30 hover:border-violet-500/50
                  disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200">
                {reframeLoading ? <Loader2 size={11} className="animate-spin" /> : <ScanFace size={11} />}
                {reframeLoading ? "Tracking subject…" : cropEnabled ? "Auto-reframe (track speaker)" : "Auto-reframe to vertical"}
              </button>
              <p className="text-[10px] text-white/25 leading-relaxed -mt-1">
                AI finds the speaker and pans the crop to keep them centered. Sets motion-crop keyframes you can tweak.
              </p>
              {!singleClip && <p className="text-[10px] text-amber-400/60 leading-relaxed -mt-1">{multiClipNote}</p>}

              {cropEnabled && (
                <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                  {([
                    { m: "crop" as const, label: "Crop", sub: "Fill & cut sides" },
                    { m: "blur" as const, label: "Blur fill", sub: "Whole video + blur" },
                    { m: "split" as const, label: "Split", sub: "2–4 screens" },
                  ]).map(({ m, label, sub }) => (
                    <button key={m} type="button" onClick={() => setCropFill(m)}
                      className={`flex-1 py-1.5 text-center transition-colors ${
                        cropFill === m ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
                      }`}>
                      <div className="text-[11px] font-semibold">{label}</div>
                      <div className="text-[10px] text-white/25">{sub}</div>
                    </button>
                  ))}
                </div>
              )}
              {splitOn ? (
                <button type="button" onClick={() => setOpenSection("split")}
                  className="w-full text-left text-[11px] text-violet-300/70 hover:text-violet-200 leading-relaxed">
                  Split screen is on — edit the screens in <span className="underline">Split screen</span> above.
                </button>
              ) : cropFill === "blur" && cropEnabled ? (
                <p className="text-[11px] text-white/25 leading-relaxed">
                  The whole video sits centered; a blurred, zoomed copy fills the rest. Crop position, motion crop and zoom don&apos;t apply in this mode.
                </p>
              ) : cropEnabled && (() => {
                const rounded = Math.round(previewCropX);
                const posLabel = (v: number) => v === 50 ? "Center" : v < 50 ? `Left ${50 - v}` : `Right ${v - 50}`;
                const sortedKeys = [...cropKeys].sort((a, b) => a.time - b.time);
                return (
                <>
                  <div className="pt-1">
                    <DSlider resetTo={50} label="Crop position" value={rounded} min={0} max={100} onChange={setCropPos}
                      format={posLabel} />
                    <div className="flex gap-1 mt-1.5">
                      {([
                        { label: "Left", val: 0 },
                        { label: "Center", val: 50 },
                        { label: "Right", val: 100 },
                      ] as const).map(({ label, val }) => (
                        <button key={label} type="button" onClick={() => setCropPos(val)}
                          className={`flex-1 py-1 text-[11px] rounded-md font-semibold uppercase tracking-wider border transition-all duration-200 ${
                            rounded === val
                              ? "bg-violet-600/20 text-violet-300 border-violet-500/35"
                              : "bg-white/[0.03] text-white/25 border-white/[0.05] hover:text-white/45 hover:border-white/[0.09]"
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-violet-400/50 font-medium flex items-center gap-1 mt-1.5">
                      <Move size={11} className="text-violet-400" /> Drag the preview to reframe
                    </p>
                  </div>

                  {/* ── Motion crop (keyframes) ── */}
                  <div className="pt-2.5 mt-1 border-t border-white/[0.05] space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">Motion crop</span>
                      {cropKeys.length > 1 && (
                        <div className="flex rounded-md overflow-hidden border border-white/[0.08]">
                          {([
                            { m: true,  label: "Pan" },
                            { m: false, label: "Cut" },
                          ] as const).map(({ m, label }) => (
                            <button key={label} type="button" onClick={() => setCropSmooth(m)}
                              className={`px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                                cropSmooth === m ? "bg-violet-600/25 text-violet-300" : "text-white/25 hover:text-white/45"
                              }`}>
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <button type="button" onClick={addCropKey}
                      className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md
                        bg-violet-600/15 border border-violet-500/25 text-violet-300 text-[11px] font-semibold
                        hover:bg-violet-600/25 hover:border-violet-500/40 transition-all duration-200">
                      <Plus size={10} /> Keyframe @ {formatTime(currentTime)} · {posLabel(rounded)}
                    </button>

                    {sortedKeys.length > 0 ? (
                      <div className="space-y-1">
                        {sortedKeys.map((k) => {
                          const active = Math.abs(k.time - currentTime) < 0.25;
                          return (
                            <div key={k.id}
                              className={`flex items-center gap-1.5 rounded-md px-2 py-1 border transition-colors ${
                                active ? "bg-violet-600/15 border-violet-500/30" : "bg-black/25 border-white/[0.05]"
                              }`}>
                              <button type="button" onClick={() => seekTo(k.time)}
                                className="font-mono text-[11px] text-violet-300/80 hover:text-violet-200 tabular-nums">
                                {formatTime(k.time)}
                              </button>
                              <span className="text-[11px] text-white/40 flex-1">{posLabel(k.x)}</span>
                              <button type="button" onClick={() => removeCropKey(k.id!)}
                                className="text-white/20 hover:text-red-400 transition-colors">
                                <X size={11} />
                              </button>
                            </div>
                          );
                        })}
                        <p className="text-[10px] text-white/20 leading-relaxed">
                          {cropKeys.length < 2
                            ? "Add another keyframe at a later time to start the move."
                            : cropSmooth ? "Crop pans smoothly between keyframes." : "Crop snaps at each keyframe."}
                        </p>
                      </div>
                    ) : (
                      <p className="text-[10px] text-white/20 leading-relaxed">
                        Move the crop over time: scrub to a moment, reframe, add a keyframe — e.g. Left for 0–10s, Center after.
                      </p>
                    )}
                  </div>
                </>
                );
              })()}
            </Section>

            {/* ── Speed ── */}
            <Section icon={Gauge} label="Speed" hidden={activeTab !== "edit"} {...sec("speed")}
              active={speed !== 1}
              summary={`${speed}×`}
              badge={speed !== 1 ? <span className="text-[11px] text-violet-400/60 font-mono bg-violet-500/10 px-1.5 py-px rounded">{speed}×</span> : undefined}>
              <div className="grid grid-cols-3 gap-1">
                {SPEED_OPTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => setSpeed(s)}
                    className={`py-1.5 rounded-md text-[12px] font-mono font-semibold border transition-all duration-200 ease-out ${
                      speed === s
                        ? "bg-violet-600/20 border-violet-500/40 text-violet-300 shadow-[0_0_8px_rgba(51,92,186,0.15)]"
                        : "bg-white/[0.02] border-white/[0.05] text-white/25 hover:text-white/50 hover:border-white/[0.09]"
                    }`}>
                    {s}×
                  </button>
                ))}
              </div>
            </Section>

            {/* ── Split screen ── its own section (not buried under Aspect Ratio)
                so it's findable; enabling it from "Original" picks 9:16. */}
            <Section icon={LayoutGrid} label="Split screen" hidden={activeTab !== "frame"} {...sec("split")}
              active={splitOn}
              summary={splitOn ? `${split.panels.length} screens` : "Off"}>
              <button type="button" onClick={toggleSplit}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-[12px] font-semibold transition-all duration-200 ${
                  splitOn
                    ? "bg-violet-600/15 border-violet-500/35 text-violet-200"
                    : "bg-white/[0.03] border-white/[0.07] text-white/60 hover:text-white/80 hover:border-white/[0.12]"
                }`}>
                <span>{splitOn ? "Split screen on" : "Turn on split screen"}</span>
                <span className={`w-7 h-4 rounded-full relative transition-colors ${splitOn ? "bg-violet-500" : "bg-white/15"}`}>
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${splitOn ? "left-3.5" : "left-0.5"}`} />
                </span>
              </button>
              {splitOn ? (
                <SplitControls
                  videoRef={videoRef} mediaEls={splitMediaRef} split={split} onChange={setSplit}
                  srcW={srcDims.w} srcH={srcDims.h} outW={splitOut.w} outH={splitOut.h}
                />
              ) : (
                <p className="text-[11px] text-white/30 leading-relaxed">
                  Show 2–4 parts of the stream at once, e.g. the facecam corner on top and the gameplay below.
                </p>
              )}
            </Section>

            {/* ── Zoom (Style tab) ── */}
            <Section icon={ZoomIn} label="Zoom" hidden={activeTab !== "frame"} {...sec("zoom")}
              active={zoom > 1.001 || zoomKeys.length > 0}
              summary={zoomKeys.length > 0 ? `${zoomKeys.length} kf` : zoom > 1.001 ? `${zoom.toFixed(2)}×` : "Off"}
              badge={zoom > 1.001 || zoomKeys.length > 0
                ? <button type="button" onClick={(e) => { e.stopPropagation(); setZoom(1); setZoomKeys([]); setZoomDirty(false); }}
                    className="text-[11px] text-white/20 hover:text-violet-300 transition-colors duration-150 font-medium">reset</button>
                : undefined}>
              {(() => {
                const z = Math.round(previewZoom * 100) / 100;
                const sortedZoomKeys = [...zoomKeys].sort((a, b) => a.time - b.time);
                return (
                  <>
                    <DSlider resetTo={1} label="Zoom level" value={z} min={1} max={3} step={0.05}
                      onChange={setZoomVal} format={(v) => `${v.toFixed(2)}×`} />
                    <p className="text-[11px] text-white/20 leading-relaxed">
                      Punches in toward the crop position. 1.00× is off.
                    </p>

                    {/* ── Motion zoom (keyframes) ── */}
                    <div className="pt-2.5 mt-1 border-t border-white/[0.05] space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">Motion zoom</span>
                        {zoomKeys.length > 1 && (
                          <div className="flex rounded-md overflow-hidden border border-white/[0.08]">
                            {([
                              { m: true,  label: "Ramp" },
                              { m: false, label: "Cut" },
                            ] as const).map(({ m, label }) => (
                              <button key={label} type="button" onClick={() => setZoomSmooth(m)}
                                className={`px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                                  zoomSmooth === m ? "bg-violet-600/25 text-violet-300" : "text-white/25 hover:text-white/45"
                                }`}>
                                {label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <button type="button" onClick={addZoomKey}
                        className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md
                          bg-violet-600/15 border border-violet-500/25 text-violet-300 text-[11px] font-semibold
                          hover:bg-violet-600/25 hover:border-violet-500/40 transition-all duration-200">
                        <Plus size={10} /> Keyframe @ {formatTime(currentTime)} · {z.toFixed(2)}×
                      </button>

                      {sortedZoomKeys.length > 0 && (
                        <div className="space-y-1">
                          {sortedZoomKeys.map((k) => {
                            const active = Math.abs(k.time - currentTime) < 0.25;
                            return (
                              <div key={k.id}
                                className={`flex items-center gap-1.5 rounded-md px-2 py-1 border transition-colors ${
                                  active ? "bg-violet-600/15 border-violet-500/30" : "bg-black/25 border-white/[0.05]"
                                }`}>
                                <button type="button" onClick={() => seekTo(k.time)}
                                  className="font-mono text-[11px] text-violet-300/80 hover:text-violet-200 tabular-nums">
                                  {formatTime(k.time)}
                                </button>
                                <span className="text-[11px] text-white/40 flex-1">{k.z.toFixed(2)}×</span>
                                <button type="button" onClick={() => removeZoomKey(k.id!)}
                                  className="text-white/20 hover:text-red-400 transition-colors">
                                  <X size={11} />
                                </button>
                              </div>
                            );
                          })}
                          <p className="text-[10px] text-white/20 leading-relaxed">
                            {zoomKeys.length < 2
                              ? "Add another keyframe at a later time to animate the zoom."
                              : zoomSmooth ? "Zoom ramps smoothly between keyframes." : "Zoom snaps at each keyframe."}
                          </p>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}
            </Section>

            {/* ── Volume (Audio tab only) ── */}
            <Section icon={Volume2} label="Video Audio" hidden={activeTab !== "audio"} {...sec("volume")}
              active={videoVolume !== 100 || videoPitch !== 0 || volumeKeys.length > 0 || loudnorm}
              summary={volumeKeys.length > 0 ? `${volumeKeys.length} kf` : `${videoVolume}%${videoPitch !== 0 ? ` · ${videoPitch > 0 ? "+" : ""}${videoPitch}st` : ""}`}
              badge={videoVolume !== 100 || videoPitch !== 0 || volumeKeys.length > 0 || loudnorm
                ? <button type="button" onClick={(e) => { e.stopPropagation(); setVideoVolume(100); setVideoPitch(0); setVolumeKeys([]); setLoudnorm(false); }}
                    className="text-[11px] text-white/20 hover:text-violet-300 transition-colors duration-150 font-medium">reset</button>
                : undefined}>
              <DSlider resetTo={100} label={musicFileName ? "Original audio" : "Video volume"} value={videoVolume} min={0} max={100} onChange={setVideoVolume} format={(v) => `${v}%`} />
              <DSlider resetTo={0} label="Pitch" value={videoPitch} min={-12} max={12} step={1}
                onChange={setVideoPitch} format={(v) => v === 0 ? "0" : `${v > 0 ? "+" : ""}${v} st`} />
              <p className="text-[10px] text-white/20 leading-relaxed">Pitch shifts the voice up/down (semitones) without changing speed. Applied on export.</p>

              {/* ── Volume keyframes (ducking) ── */}
              <div className="pt-2.5 mt-1 border-t border-white/[0.05] space-y-2">
                <span className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">Volume keyframes</span>
                <button type="button"
                  onClick={() => setVolumeKeys((prev) => [...prev.filter((k) => Math.abs(k.time - currentTime) > 0.15),
                    { id: uid(), time: currentTime, v: videoVolume }].sort((a, b) => a.time - b.time))}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md
                    bg-violet-600/15 border border-violet-500/25 text-violet-300 text-[11px] font-semibold
                    hover:bg-violet-600/25 hover:border-violet-500/40 transition-all duration-200">
                  <Plus size={10} /> Keyframe @ {formatTime(currentTime)} · {videoVolume}%
                </button>
                {volumeKeys.length > 0 && (
                  <div className="space-y-1">
                    {volumeKeys.map((k) => (
                      <div key={k.id} className="flex items-center gap-1.5 rounded-md px-2 py-1 border bg-black/25 border-white/[0.05]">
                        <button type="button" onClick={() => seekTo(k.time)}
                          className="font-mono text-[11px] text-violet-300/80 hover:text-violet-200 tabular-nums">
                          {formatTime(k.time)}
                        </button>
                        <span className="text-[11px] text-white/40 flex-1">{Math.round(k.v)}%</span>
                        <button type="button" onClick={() => setVolumeKeys((prev) => prev.filter((x) => x.id !== k.id))}
                          className="text-white/20 hover:text-red-400 transition-colors">
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                    <p className="text-[10px] text-white/20 leading-relaxed">
                      {volumeKeys.length < 2
                        ? "Add another keyframe to ramp the volume over time (e.g. duck under a voiceover)."
                        : "Volume ramps smoothly between keyframes; the slider sets the level for the next keyframe."}
                    </p>
                  </div>
                )}
              </div>

              {/* ── Auto-level ── */}
              <button type="button" onClick={() => setLoudnorm((v) => !v)}
                className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-semibold border transition-all duration-200 ${
                  loudnorm
                    ? "bg-violet-600/20 border-violet-500/40 text-violet-300"
                    : "bg-white/[0.02] border-white/[0.05] text-white/30 hover:text-white/55 hover:border-white/[0.09]"
                }`}>
                <Gauge size={11} /> {loudnorm ? "Auto-level audio: on" : "Auto-level audio (loudness normalize)"}
              </button>
              {loudnorm && <p className="text-[10px] text-white/20 leading-relaxed">Evens out quiet/loud passages to a social-media loudness target. Applied on export.</p>}
            </Section>

            {/* ── Visual Adjustments (Style tab only) ── */}
            <Section icon={SlidersHorizontal} label="Visual" hidden={activeTab !== "look"} {...sec("visual")}
              active={brightness !== 0 || contrast !== 0 || saturation !== 0 || colorFilter !== "none" || mirror}
              summary={
                colorFilter !== "none" ? COLOR_FILTERS[colorFilter].label
                : brightness !== 0 || contrast !== 0 || saturation !== 0 ? "Adjusted"
                : mirror ? "Mirrored" : "Default"
              }
              badge={brightness !== 0 || contrast !== 0 || saturation !== 0 || colorFilter !== "none" || mirror
                ? <button type="button" onClick={(e) => { e.stopPropagation(); setBrightness(0); setContrast(0); setSaturation(0); setColorFilter("none"); setMirror(false); }}
                    className="text-[11px] text-white/20 hover:text-violet-300 transition-colors duration-150 font-medium">
                    reset
                  </button>
                : undefined}>
              {/* Filter presets */}
              <div>
                <span className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider flex items-center gap-1 mb-1.5">
                  <Palette size={11} /> Filter
                </span>
                <div className="grid grid-cols-4 gap-1">
                  {COLOR_FILTER_KEYS.map((k) => (
                    <button key={k} type="button" onClick={() => setColorFilter(k)}
                      className={`py-1.5 rounded-md text-[11px] font-semibold border transition-all duration-200 ${
                        colorFilter === k
                          ? "bg-violet-600/20 border-violet-500/40 text-violet-300"
                          : "bg-white/[0.02] border-white/[0.05] text-white/30 hover:text-white/55 hover:border-white/[0.09]"
                      }`}>
                      {COLOR_FILTERS[k].label}
                    </button>
                  ))}
                </div>
              </div>

              <DSlider resetTo={0} label="Brightness" value={brightness} min={-50} max={50} onChange={setBrightness}
                format={(v) => v === 0 ? "0" : v > 0 ? `+${v}` : String(v)} />
              <DSlider resetTo={0} label="Contrast" value={contrast} min={-50} max={50} onChange={setContrast}
                format={(v) => v === 0 ? "0" : v > 0 ? `+${v}` : String(v)} />
              <DSlider resetTo={0} label="Saturation" value={saturation} min={-50} max={50} onChange={setSaturation}
                format={(v) => v === 0 ? "0" : v > 0 ? `+${v}` : String(v)} />

              {/* Mirror + vignette */}
              <div className="grid grid-cols-2 gap-1">
                <button type="button" onClick={() => setMirror((m) => !m)}
                  className={`flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-semibold border transition-all duration-200 ${
                    mirror
                      ? "bg-violet-600/20 border-violet-500/40 text-violet-300"
                      : "bg-white/[0.02] border-white/[0.05] text-white/30 hover:text-white/55 hover:border-white/[0.09]"
                  }`}>
                  <FlipHorizontal2 size={11} /> {mirror ? "Mirrored" : "Mirror"}
                </button>
                <button type="button" onClick={() => setVignette((v) => !v)}
                  className={`flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-semibold border transition-all duration-200 ${
                    vignette
                      ? "bg-violet-600/20 border-violet-500/40 text-violet-300"
                      : "bg-white/[0.02] border-white/[0.05] text-white/30 hover:text-white/55 hover:border-white/[0.09]"
                  }`}>
                  <SunMedium size={11} /> Vignette
                </button>
              </div>
            </Section>

            {/* ── Timed Effects (Style tab) ── */}
            <Section icon={Sparkles} label="Effects" hidden={activeTab !== "look"} {...sec("effects")}
              active={effects.length > 0}
              summary={effects.length > 0 ? `${effects.length} segment${effects.length > 1 ? "s" : ""}` : "Off"}
              badge={effects.length > 0
                ? <button type="button" onClick={(e) => { e.stopPropagation(); setEffects([]); }}
                    className="text-[11px] text-white/20 hover:text-violet-300 transition-colors duration-150 font-medium">clear</button>
                : undefined}>
              <div className="grid grid-cols-3 gap-1">
                {EFFECT_KEYS.map((k) => (
                  <button key={k} type="button" onClick={() => setEffectType(k)}
                    className={`py-1.5 rounded-md text-[11px] font-semibold border transition-all duration-200 ${
                      effectType === k
                        ? "bg-violet-600/20 border-violet-500/40 text-violet-300"
                        : "bg-white/[0.02] border-white/[0.05] text-white/30 hover:text-white/55 hover:border-white/[0.09]"
                    }`}>
                    {EFFECTS[k].label}
                  </button>
                ))}
              </div>

              <button type="button"
                onClick={() => {
                  const start = currentTime;
                  const end = Math.min(Math.max(timelineDuration, start + 0.3), start + 2);
                  setEffects((prev) => [...prev, { id: uid(), type: effectType, start, end }]
                    .sort((a, b) => a.start - b.start));
                }}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md
                  bg-violet-600/15 border border-violet-500/25 text-violet-300 text-[11px] font-semibold
                  hover:bg-violet-600/25 hover:border-violet-500/40 transition-all duration-200">
                <Plus size={10} /> {EFFECTS[effectType].label} @ {formatTime(currentTime)}
              </button>

              {effects.length > 0 && (
                <div className="space-y-1">
                  {effects.map((s) => {
                    const isActive = currentTime >= s.start && currentTime <= s.end;
                    return (
                      <div key={s.id}
                        className={`flex items-center gap-1.5 rounded-md px-2 py-1 border transition-colors ${
                          isActive ? "bg-violet-600/15 border-violet-500/30" : "bg-black/25 border-white/[0.05]"
                        }`}>
                        <span className="text-[11px] font-semibold text-white/55 w-9">{EFFECTS[s.type].label}</span>
                        <button type="button" onClick={() => seekTo(s.start)}
                          className="font-mono text-[11px] text-violet-300/80 hover:text-violet-200 tabular-nums">
                          {formatTime(s.start)}
                        </button>
                        <span className="text-[11px] text-white/25">→</span>
                        <button type="button" onClick={() => seekTo(s.end)}
                          className="font-mono text-[11px] text-violet-300/80 hover:text-violet-200 tabular-nums">
                          {formatTime(s.end)}
                        </button>
                        <button type="button"
                          onClick={() => setEffects((prev) => prev.map((x) =>
                            x.id === s.id && currentTime > x.start ? { ...x, end: currentTime } : x))}
                          className="text-[10px] text-white/25 hover:text-violet-300 transition-colors flex-1 text-right"
                          title="Set this segment's end to the playhead">
                          end here
                        </button>
                        <button type="button" onClick={() => setEffects((prev) => prev.filter((x) => x.id !== s.id))}
                          className="text-white/20 hover:text-red-400 transition-colors">
                          <X size={11} />
                        </button>
                      </div>
                    );
                  })}
                  <p className="text-[10px] text-white/20 leading-relaxed">
                    Effects apply only inside their time window — scrub the playhead to see them.
                  </p>
                </div>
              )}
            </Section>

            {/* ── Fade in / out (Cut tab) ── */}
            <Section icon={Blend} label="Fade" hidden={activeTab !== "look"} {...sec("fade")}
              active={fadeIn > 0 || fadeOut > 0}
              summary={fadeIn > 0 || fadeOut > 0
                ? [fadeIn > 0 && `in ${fadeIn.toFixed(1)}s`, fadeOut > 0 && `out ${fadeOut.toFixed(1)}s`].filter(Boolean).join(" · ")
                : "Off"}
              badge={fadeIn > 0 || fadeOut > 0
                ? <button type="button" onClick={(e) => { e.stopPropagation(); setFadeIn(0); setFadeOut(0); }}
                    className="text-[11px] text-white/20 hover:text-violet-300 transition-colors duration-150 font-medium">reset</button>
                : undefined}>
              <DSlider resetTo={0} label="Fade in" value={fadeIn} min={0} max={3} step={0.1} onChange={setFadeIn}
                format={(v) => v === 0 ? "Off" : `${v.toFixed(1)}s`} />
              <DSlider resetTo={0} label="Fade out" value={fadeOut} min={0} max={3} step={0.1} onChange={setFadeOut}
                format={(v) => v === 0 ? "Off" : `${v.toFixed(1)}s`} />
              <p className="text-[10px] text-white/20 leading-relaxed">
                Fades the picture and audio from/to black at the clip edges. Audio fade applies on export.
              </p>
            </Section>

            {/* ── Caption ── */}
            <Section icon={TypeIcon} label="Caption" hidden={activeTab !== "text"} {...sec("caption")}
              active={!!caption}
              summary={caption ? `“${caption.slice(0, 14)}${caption.length > 14 ? "…" : ""}”` : "Off"}>
              <DInput
                placeholder="Text burned into video…"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
              />
              <button type="button" onClick={suggestCaptions} disabled={captionIdeasLoading}
                title="Let AI suggest hook text from the clip's frames and transcript"
                className="flex items-center gap-1 text-[11px] text-violet-400/60 hover:text-violet-300 disabled:opacity-50 transition-colors duration-200 font-medium">
                {captionIdeasLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                {captionIdeasLoading ? "Thinking…" : "AI caption"}
              </button>
              {captionIdeasError && (
                <p className="text-[11px] text-red-400/70">{captionIdeasError}</p>
              )}
              {captionIdeas.length > 0 && (
                <div className="space-y-1">
                  {captionIdeas.map((t, i) => (
                    <button key={i} type="button" onClick={() => { setCaption(t); setCaptionIdeas([]); }}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg bg-violet-500/[0.06] border border-violet-500/15
                        text-[11px] text-white/65 leading-snug hover:bg-violet-500/15 hover:border-violet-500/30
                        transition-colors duration-150">
                      {t}
                    </button>
                  ))}
                  <button type="button" onClick={() => setCaptionIdeas([])}
                    className="w-full text-center text-[11px] text-white/20 hover:text-white/40 py-0.5 transition-colors">
                    dismiss
                  </button>
                </div>
              )}
              {caption && (
                <>
                  <div className="flex gap-1.5">
                    {([
                      { label: "Top", x: 50, y: 12 },
                      { label: "Center", x: 50, y: 50 },
                      { label: "Bottom", x: 50, y: 88 },
                    ] as const).map((pos) => {
                      const active = Math.abs(captionX - pos.x) < 2 && Math.abs(captionY - pos.y) < 4;
                      return (
                        <button key={pos.label} type="button" onClick={() => { setCaptionX(pos.x); setCaptionY(pos.y); }}
                          className={`flex-1 py-1.5 text-[11px] rounded-md font-semibold uppercase tracking-wider transition-all duration-200 ease-out border ${
                            active
                              ? "bg-violet-600/20 text-violet-300 border-violet-500/35 shadow-[0_0_8px_rgba(51,92,186,0.15)]"
                              : "bg-white/[0.03] text-white/20 border-white/[0.05] hover:text-white/40 hover:border-white/[0.09]"
                          }`}>
                          {pos.label}
                        </button>
                      );
                    })}
                  </div>
                  <DSlider resetTo={1} label="Text size" value={captionSize} min={0.5} max={2.5} step={0.05}
                    onChange={setCaptionSize} format={(v) => `${v.toFixed(2)}×`} />
                  <p className="text-[11px] text-violet-400/50 font-medium flex items-center gap-1">
                    <Move size={11} className="text-violet-400" /> Drag the caption in the preview to place it
                    <span className="ml-auto font-mono text-white/25 tabular-nums">{Math.round(captionX)}, {Math.round(captionY)}</span>
                  </p>
                  <TextStylePicker style={textStyle} onChange={setTextStyle} />

                  {/* ── Timing — show the caption only inside a window ── */}
                  <div className="pt-2 mt-1 border-t border-white/[0.05] space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">Timing</span>
                      {(captionStart > 0 || captionEnd > 0) && (
                        <button type="button" onClick={() => { setCaptionStart(0); setCaptionEnd(0); }}
                          className="text-[11px] text-white/20 hover:text-violet-300 transition-colors font-medium">whole clip</button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      <button type="button" onClick={() => setCaptionStart(currentTime)}
                        className="py-1.5 rounded-md text-[11px] font-semibold border bg-white/[0.02] border-white/[0.05] text-white/30 hover:text-white/55 hover:border-white/[0.09] transition-all">
                        Start @ {formatTime(captionStart > 0 ? captionStart : currentTime)}
                      </button>
                      <button type="button" onClick={() => setCaptionEnd(currentTime)}
                        className="py-1.5 rounded-md text-[11px] font-semibold border bg-white/[0.02] border-white/[0.05] text-white/30 hover:text-white/55 hover:border-white/[0.09] transition-all">
                        End @ {captionEnd > 0 ? formatTime(captionEnd) : "clip end"}
                      </button>
                    </div>
                    <p className="text-[10px] text-white/20 leading-relaxed">
                      {captionStart > 0 || captionEnd > 0
                        ? `Caption shows ${captionStart > 0 ? `from ${formatTime(captionStart)}` : "from the start"} ${captionEnd > 0 ? `to ${formatTime(captionEnd)}` : "to the end"}.`
                        : "Move the playhead, then set when the caption appears/disappears. Default: the whole clip."}
                    </p>
                  </div>
                </>
              )}
            </Section>

            {/* ── Intro / Outro ── */}
            <Section icon={Clapperboard} label="Intro / Outro" hidden={activeTab !== "text"} {...sec("introoutro")}
              active={!!(introText || outroText)}
              summary={introText || outroText ? [introText && "Intro", outroText && "Outro"].filter(Boolean).join(" + ") : "Off"}
              badge={<span className="text-[10px] text-zinc-600 font-mono">3s card</span>}>
              {([
                { key: "intro", label: "Intro text", val: introText, set: setIntroText, ph: "e.g. Best moments 🔥" },
                { key: "outro", label: "Outro text", val: outroText, set: setOutroText, ph: "e.g. Follow @channel" },
              ] as const).map(({ key, label, val, set, ph }) => (
                <div key={key}>
                  <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold mb-1.5">{label}</p>
                  <DInput placeholder={ph} value={val} onChange={(e) => set(e.target.value)} />
                </div>
              ))}
            </Section>

            </div>{/* end scrollable content */}

            <CopyStyleModal open={copyStyleOpen} onClose={() => setCopyStyleOpen(false)} save={styles.save}
              currentClipUrl={fetchableUrl(localVideoUrl) ? localVideoUrl : fetchableUrl(clip?.videoUrl) ? clip?.videoUrl : undefined}
              onSaved={(s) => { selectEditStyle(s); setAiStatus({ ok: true, msg: `Style “${s.name}” saved — Auto-edit will use it` }); setTimeout(() => setAiStatus(null), 5000); }} />

            {/* ── Process ── sticky to the bottom of the screen on phones */}
            <div className="sticky bottom-0 z-30 lg:static px-4 py-3 border-t border-white/[0.08] lg:border-white/[0.04] flex-shrink-0
              bg-d0c/95 backdrop-blur-md lg:bg-transparent lg:backdrop-blur-none pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {processError && (
                <div className="mb-3 flex items-start gap-1.5 text-[11px] text-red-400 bg-red-500/[0.07]
                  border border-red-500/15 rounded-lg px-3 py-2">
                  <AlertCircle size={10} className="flex-shrink-0 mt-px" />
                  <span>{processError}</span>
                </div>
              )}

              {/* Settings chips */}
              <div className="hidden lg:flex flex-wrap gap-1 mb-3">
                {[
                  { show: cropEnabled,                  text: ASPECTS[cropAspect].label.replace(":", "∶") },
                  { show: cropEnabled && cropKeys.length === 0 && cropX !== 50, text: cropX < 50 ? `←${50 - cropX}` : `→${cropX - 50}` },
                  { show: cropEnabled && cropKeys.length > 0, text: `⟿ ${cropKeys.length} kf${cropSmooth ? "" : " cut"}` },
                  { show: zoom > 1.001 && zoomKeys.length === 0, text: `${zoom.toFixed(1)}×🔍` },
                  { show: zoomKeys.length > 0,          text: `🔍 ${zoomKeys.length} kf${zoomSmooth ? "" : " cut"}` },
                  { show: speed !== 1,                  text: `${speed}×` },
                  { show: brightness !== 0,             text: `B${brightness > 0 ? "+" : ""}${brightness}` },
                  { show: contrast !== 0,               text: `C${contrast > 0 ? "+" : ""}${contrast}` },
                  { show: videoVolume !== 100,           text: `Vol ${videoVolume}%` },
                  { show: videoPitch !== 0,             text: `${videoPitch > 0 ? "+" : ""}${videoPitch}st` },
                  { show: subtitles.length > 0,         text: `CC ${subtitles.length}` },
                  { show: !!musicServerUrl,              text: `♪ ${musicVolume}%` },
                  { show: !!(introText || outroText),    text: [introText && "In", outroText && "Out"].filter(Boolean).join("+") },
                  { show: assets.filter((a) => !a.uploading).length > 0, text: `${assets.filter((a) => !a.uploading).length} asset(s)` },
                ].filter((x) => x.show).map(({ text }) => (
                  <span key={text} className="text-[10px] text-violet-400/50 bg-violet-500/[0.07] border border-violet-500/15 px-1.5 py-0.5 rounded-full font-mono whitespace-nowrap">
                    {text}
                  </span>
                ))}
              </div>

              <div className="flex gap-1.5">
                {/* Save edited video to PC */}
                <button type="button" onClick={() => processClip("save")} disabled={processing}
                  className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-[12px] font-semibold
                    transition-all duration-200 ease-out disabled:opacity-50 flex-shrink-0
                    bg-white/[0.05] hover:bg-white/[0.09] text-white/70 hover:text-white
                    border border-white/[0.09] hover:border-white/[0.15]">
                  {processing && processMode === "save"
                    ? <Loader2 size={13} className="animate-spin" />
                    : saveDone
                      ? <Check size={13} className="text-green-400" />
                      : <Save size={13} />}
                  <span>{processing && processMode === "save" ? "Saving…" : saveDone ? "Saved" : "Save"}</span>
                </button>

                {/* Process & schedule (publish) */}
                <button type="button" onClick={() => processClip("schedule")} disabled={processing}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold
                    transition-all duration-200 ease-out disabled:opacity-50
                    bg-gradient-to-b from-violet-600 to-violet-700
                    hover:from-violet-500 hover:to-violet-600
                    shadow-[0_0_20px_rgba(51,92,186,0.3),0_1px_0_rgba(255,255,255,0.08)_inset]
                    hover:shadow-[0_0_28px_rgba(51,92,186,0.45),0_1px_0_rgba(255,255,255,0.08)_inset]
                    text-white border border-violet-500/40">
                  {processing && processMode === "schedule"
                    ? <><Loader2 size={13} className="animate-spin" /> {
                        processPhase === "loading-ff"    ? "Loading FFmpeg…" :
                        processPhase === "loading-video" ? "Loading video…"  :
                        processPhase === "uploading"     ? "Uploading…"       :
                        "Processing…"
                      }</>
                    : <><Zap size={13} className="fill-white" /> Process &amp; Schedule</>}
                </button>
              </div>
              {saveDone && (
                <p className="text-[11px] text-green-400/70 font-medium mt-2 flex items-center gap-1 justify-center">
                  <Check size={11} /> Edited video downloaded to your PC
                </p>
              )}
              {processing && (
                <div className="mt-2 space-y-1">
                  {processPhase === "encoding" && processProgress > 0 && (
                    <div className="relative h-0.5 rounded-full bg-white/[0.06] overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-violet-700 to-violet-400 transition-all duration-300"
                        style={{ width: `${processProgress}%` }}
                      />
                    </div>
                  )}
                  <p className="text-[11px] text-zinc-600 text-center tracking-wide font-mono">
                    {processPhase === "loading-ff"    && "Downloading FFmpeg WASM (~31 MB) · one-time"}
                    {processPhase === "loading-video" && "Fetching video into browser…"}
                    {processPhase === "encoding"      && (processProgress > 0 ? `Encoding ${processProgress}%` : "Starting encoder…")}
                    {processPhase === "uploading"     && "Uploading processed clip…"}
                    {!processPhase                   && "Preparing…"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

      ) : (
        /* ── Empty state ──────────────────────────────────────────────────────── */
        <EmptyState fetching={fetching} onFile={handleLocalFile} onBrowse={() => fileInputRef.current?.click()} />
      )}

    </div>
  );
}

export default function ClipsPage() {
  return <Suspense><ClipsInner /></Suspense>;
}
