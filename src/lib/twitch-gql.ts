// Keyless Twitch access via the public GQL API — the same mechanism the
// website player uses, and the same one the clips fetch route already relies
// on. No TWITCH_CLIENT_ID/SECRET needed. Not every public client ID still
// works, so we rotate until one does and remember it.

const GQL_CLIENT_IDS = [
  "kd1unb4b3q4t58fwlpcbzcbnm76a8fp",
  "kimne78kx3ncx6brgo4mv6wki8h31s1",
  "ue6znezmtq1l2iqlm5eiwtui2g6a78v",
];
let workingCid = GQL_CLIENT_IDS[0];

async function postGql(cid: string, body: unknown): Promise<Response> {
  return fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-Id": cid, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

export async function twitchGql<T>(body: unknown): Promise<T> {
  const ids = [workingCid, ...GQL_CLIENT_IDS.filter((c) => c !== workingCid)];
  let lastErr: Error | null = null;
  let sawNetworkError = false;
  for (const cid of ids) {
    // fetch() itself throwing (vs. a non-2xx response) means the network call
    // never landed — a transient blip, not a bad client-ID. Rotating through
    // the other IDs won't fix that, so give it one bare retry per ID before
    // moving on, rather than surfacing a raw "fetch failed" to the user.
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await postGql(cid, body);
      } catch (err) {
        sawNetworkError = true;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (!res) continue;
    if (res.status === 400) { lastErr = new Error("Client-ID rejected"); continue; }
    if (!res.ok) { lastErr = new Error(`Twitch GQL returned ${res.status}`); continue; }
    workingCid = cid;
    return (await res.json()) as T;
  }
  if (sawNetworkError) {
    throw new Error(`Could not reach Twitch — network error (${lastErr?.message ?? "unknown"}). Try again in a moment.`);
  }
  throw lastErr ?? new Error("Twitch GQL request failed");
}

/** Accepts "login", "@login", or a twitch.tv/<login> URL. */
export function parseTwitchLogin(input: string): string {
  return String(input).trim()
    .replace(/^@/, "")
    .replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//i, "")
    .split(/[/?#]/)[0]
    .toLowerCase();
}

// ─── Top clips (keyless) ───────────────────────────────────────────────────────
// The website's Clips tab is backed by User.clips, which the public GQL exposes
// already view-sorted for a period bucket — so this replaces the Helix /clips
// listing without TWITCH_CLIENT_ID/SECRET, the same way the VOD list does.

export type TopClip = {
  id: string;
  url: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  creator_name: string;
  vod_offset: number | null;
};

type ClipsQuery = {
  data?: {
    user?: {
      id: string;
      displayName?: string;
      login?: string;
      profileImageURL?: string;
      clips?: {
        edges?: {
          node?: {
            id?: string;
            slug?: string;
            url?: string;
            title?: string;
            viewCount?: number;
            createdAt?: string;
            durationSeconds?: number;
            thumbnailURL?: string;
            videoOffsetSeconds?: number | null;
            curator?: { displayName?: string; login?: string };
          };
        }[];
      } | null;
    } | null;
  };
};

/** Twitch only buckets clips by period; map an arbitrary day window onto it. */
function clipPeriod(days: number): "LAST_DAY" | "LAST_WEEK" | "LAST_MONTH" | "ALL_TIME" {
  if (days <= 1) return "LAST_DAY";
  if (days <= 7) return "LAST_WEEK";
  if (days <= 30) return "LAST_MONTH";
  return "ALL_TIME";
}

/** Top clips (view-ranked) for a channel within `days`, plus channel info. */
export async function getTopClips(login: string, days: number, limit: number) {
  const period = clipPeriod(days);
  const first = Math.min(100, Math.max(1, Math.floor(limit) || 20));
  const res = await twitchGql<ClipsQuery>({
    query: `{
      user(login: ${JSON.stringify(login)}) {
        id displayName login profileImageURL(width: 70)
        clips(first: ${first}, criteria: { period: ${period} }) {
          edges { node {
            id slug url title viewCount createdAt durationSeconds
            thumbnailURL videoOffsetSeconds
            curator { displayName login }
          } }
        }
      }
    }`,
  });
  const user = res.data?.user;
  if (!user) return null;
  const clips: TopClip[] = (user.clips?.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is NonNullable<typeof n> => !!n?.slug)
    .map((n) => ({
      id: n.id ?? n.slug!,
      url: n.url ?? `https://clips.twitch.tv/${n.slug}`,
      title: n.title ?? "Untitled clip",
      view_count: n.viewCount ?? 0,
      created_at: n.createdAt ?? new Date().toISOString(),
      thumbnail_url: n.thumbnailURL ?? "",
      duration: n.durationSeconds ?? 0,
      creator_name: n.curator?.displayName ?? n.curator?.login ?? "Unknown",
      vod_offset: n.videoOffsetSeconds ?? null,
    }));
  return {
    channel: {
      login: user.login ?? login,
      displayName: user.displayName ?? login,
      avatar: user.profileImageURL ?? "",
    },
    clips,
  };
}

// ─── VOD list ─────────────────────────────────────────────────────────────────

type VideosQuery = {
  data?: {
    user?: {
      id: string;
      displayName?: string;
      login?: string;
      profileImageURL?: string;
      videos?: {
        edges?: {
          node?: {
            id: string;
            title?: string;
            lengthSeconds?: number;
            createdAt?: string;
            viewCount?: number;
            previewThumbnailURL?: string;
            status?: string;   // "RECORDING" while the broadcast is still live
          };
        }[];
      };
      stream?: { id: string; createdAt?: string } | null;
    } | null;
  };
};

export async function getArchiveVods(login: string) {
  const res = await twitchGql<VideosQuery>({
    query: `{
      user(login: ${JSON.stringify(login)}) {
        id displayName login profileImageURL(width: 70)
        videos(first: 30, type: ARCHIVE, sort: TIME) {
          edges { node { id title lengthSeconds createdAt viewCount status previewThumbnailURL(width: 640, height: 360) } }
        }
      }
    }`,
  });
  const user = res.data?.user;
  if (!user) return null;
  return {
    channel: {
      id: user.id,
      login: user.login ?? login,
      displayName: user.displayName ?? login,
      avatar: user.profileImageURL ?? "",
    },
    vods: (user.videos?.edges ?? [])
      .map((e) => e.node)
      .filter((n): n is NonNullable<typeof n> => !!n?.id && (n.lengthSeconds ?? 0) > 0)
      .map((n) => ({
        uuid: n.id,
        title: n.title || "Untitled stream",
        startTime: n.createdAt ?? new Date().toISOString(),
        durationSec: n.lengthSeconds ?? 0,
        views: n.viewCount ?? 0,
        thumbnail: n.previewThumbnailURL ?? "",
        // Still being broadcast — its length keeps growing and its playlist
        // has no end. Scheduled clipping waits for it to finish; Live mode
        // clips it in windows as it records.
        recording: n.status === "RECORDING",
      })),
  };
}

export type LiveStatus = {
  live: boolean;
  startedAt: string | null;
  // The in-progress archive of the current broadcast (null when the channel
  // is offline, or live with VODs disabled / subscriber-only).
  recordingVod: { uuid: string; title: string; durationSec: number; startTime: string } | null;
  // Newest archive VOD of any status (lets a pass finish a stream that ended).
  latestVod: { uuid: string; durationSec: number; recording: boolean } | null;
};

/** Is the channel live right now, and is its broadcast being recorded? One cheap GQL call. */
export async function getLiveStatus(login: string): Promise<LiveStatus | null> {
  const res = await twitchGql<VideosQuery>({
    query: `{
      user(login: ${JSON.stringify(login)}) {
        id
        stream { id createdAt }
        videos(first: 1, type: ARCHIVE, sort: TIME) {
          edges { node { id title lengthSeconds createdAt status } }
        }
      }
    }`,
  });
  const user = res.data?.user;
  if (!user) return null;
  const v = user.videos?.edges?.[0]?.node;
  const latestVod = v?.id ? { uuid: v.id, durationSec: v.lengthSeconds ?? 0, recording: v.status === "RECORDING" } : null;
  return {
    live: !!user.stream,
    startedAt: user.stream?.createdAt ?? null,
    recordingVod: user.stream && v?.id && v.status === "RECORDING"
      ? { uuid: v.id, title: v.title || "Live stream", durationSec: v.lengthSeconds ?? 0, startTime: v.createdAt ?? user.stream.createdAt ?? new Date().toISOString() }
      : null,
    latestVod,
  };
}

// ─── Chat replay ──────────────────────────────────────────────────────────────
// VideoCommentsByOffsetOrCursor is the persisted query the VOD page's chat
// replay uses. Each page is ~50 comments with exact offsets, so the time they
// span gives the chat rate at that point in the stream.

const COMMENTS_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";

type CommentsPage = {
  data?: {
    video?: {
      comments?: {
        edges?: {
          node?: {
            contentOffsetSeconds?: number;
            commenter?: { login?: string } | null;
            message?: { fragments?: { text?: string }[] };
          };
        }[];
      } | null;
    } | null;
  };
};

// `author` is the commenter's login when the replay exposes it (deleted
// accounts come back null) — used to weigh chatter diversity in scoring.
export type ChatSample = { offset: number; text: string; author?: string };

function commentsOp(videoId: string, offsetSec: number) {
  return {
    operationName: "VideoCommentsByOffsetOrCursor",
    variables: { videoID: videoId, contentOffsetSeconds: offsetSec },
    extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } },
  };
}

function parseCommentsPage(page: CommentsPage): ChatSample[] | null {
  const edges = page.data?.video?.comments?.edges;
  if (!edges) return null;
  return edges
    .map((e) => e.node)
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => ({
      offset: n.contentOffsetSeconds ?? 0,
      text: (n.message?.fragments ?? []).map((f) => f.text ?? "").join(""),
      author: n.commenter?.login || undefined,
    }));
}

/** Fetch chat pages at several offsets in one batched GQL request. */
export async function getChatPages(videoId: string, offsets: number[]): Promise<(ChatSample[] | null)[]> {
  const res = await twitchGql<CommentsPage[]>(offsets.map((t) => commentsOp(videoId, t)));
  if (!Array.isArray(res)) return offsets.map(() => null);
  return res.map((page) => parseCommentsPage(page));
}

// ─── VOD playback (for cutting sections with ffmpeg) ──────────────────────────

type TokenQuery = {
  data?: { videoPlaybackAccessToken?: { value?: string; signature?: string } | null };
};
type VideoMetaQuery = {
  data?: {
    video?: {
      title?: string;
      lengthSeconds?: number;
      previewThumbnailURL?: string;
      owner?: { displayName?: string; login?: string };
    } | null;
  };
};

export async function getVodPlaylistUrl(videoId: string): Promise<string> {
  const res = await twitchGql<TokenQuery>({
    operationName: "PlaybackAccessToken_Template",
    query:
      "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }",
    variables: { isLive: false, login: "", isVod: true, vodID: videoId, playerType: "site" },
  });
  const tok = res.data?.videoPlaybackAccessToken;
  if (!tok?.value || !tok.signature) {
    throw new Error("Twitch wouldn't grant playback for this VOD (it may be subscriber-only).");
  }
  const params = new URLSearchParams({
    sig: tok.signature,
    token: tok.value,
    allow_source: "true",
    player: "twitchweb",
  });
  return `https://usher.ttvnw.net/vod/${videoId}.m3u8?${params}`;
}

export async function getVodMeta(videoId: string) {
  const res = await twitchGql<VideoMetaQuery>({
    query: `{
      video(id: ${JSON.stringify(videoId)}) {
        title lengthSeconds previewThumbnailURL(width: 640, height: 360)
        owner { displayName login }
      }
    }`,
  });
  return res.data?.video ?? null;
}
