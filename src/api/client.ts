// The ONE module that talks to the backend — the network mirror of the
// engine-adapter rule (src/engine/adapter.ts is the only module touching
// @haelp/teto; this is the only module touching fetch / the API origin).
// A test (src/api/boundary.test.ts) enforces it.
//
// All requests carry credentials: the session is an HttpOnly cookie set by
// the Discord OAuth callback. localhost:5173 -> localhost:8000 is same-site,
// so the cookie flows in dev; the server's CORS allows the frontend origin.

const API_BASE: string = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

// ---- DTOs (the server's camelCase wire schemas) ----

export interface MeDto {
  id: string;
  username: string;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface TagDto {
  slug: string;
  label: string;
  category: "opener" | "skill";
}

export interface ReplayDto {
  id: string;
  fileHash: string;
  storageKey: string;
  sizeBytes: number;
  filename: string;
  playerUsername: string;
  playerUserid: string | null;
  uploaderUsername: string | null;
  gamemode: string;
  seed: number | null;
  bagtype: string | null;
  frames: number;
  pps: number | null;
  apm: number | null;
  vsscore: number | null;
  pieceCount: number | null;
  style: string | null;
  reconstructable: boolean;
  reconstructableReason: string | null;
  uploadedAt: string;
}

export interface SegmentDto {
  id: string;
  replayId: string;
  authorUsername: string | null;
  startPiece: number;
  endPiece: number;
  title: string;
  description: string;
  difficulty: number | null;
  thumbnailKey: string | null;
  /** Author-computed practice stats; unverified until `verified` is set. */
  hints: Record<string, unknown> | null;
  tagSlugs: string[];
  ups: number;
  downs: number;
  /** Wilson score lower bound over (ups, downs); sort=top orders by it. */
  score: number;
  /** The requesting user's vote (-1/0/1); 0 when logged out. */
  myVote: number;
  verified: boolean;
  status: string;
  createdAt: string;
}

export interface SegmentWithReplayDto extends SegmentDto {
  replay: ReplayDto;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- auth ----

/** Href that starts the Discord OAuth flow (full-page navigation). */
export function discordLoginUrl(): string {
  return `${API_BASE}/auth/login/discord`;
}

/** The logged-in user, or null when there is no (valid) session. */
export async function getMe(): Promise<MeDto | null> {
  try {
    return await request<MeDto>("/me");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export async function logout(): Promise<void> {
  // The endpoint 307s to the frontend; don't follow it from fetch.
  await fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
    redirect: "manual",
  });
}

// ---- catalog ----

function query(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) q.append(k, String(item));
    else q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function listTags(): Promise<TagDto[]> {
  return request("/tags");
}

export function listReplays(params: {
  player?: string;
  mode?: string;
  style?: string;
  ppsMin?: number;
  ppsMax?: number;
  limit?: number;
  cursor?: string;
} = {}): Promise<Page<ReplayDto>> {
  return request(
    `/replays${query({
      player: params.player,
      mode: params.mode,
      style: params.style,
      pps_min: params.ppsMin,
      pps_max: params.ppsMax,
      limit: params.limit,
      cursor: params.cursor,
    })}`,
  );
}

export function getReplay(
  id: string,
): Promise<ReplayDto & { segments: SegmentDto[] }> {
  return request(`/replays/${id}`);
}

/** The raw .ttr bytes for a stored replay (for loading into the trainer). */
export async function getReplayFile(id: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}/replays/${id}/file`, {
    credentials: "include",
  });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.blob();
}

export function uploadReplay(file: File): Promise<ReplayDto> {
  const form = new FormData();
  form.append("file", file);
  return request("/replays", { method: "POST", body: form });
}

export interface SegmentFilters {
  tags?: string[];
  mode?: string;
  difficulty?: number;
  player?: string;
  style?: string;
  ppsMin?: number;
  ppsMax?: number;
  apmMin?: number;
  apmMax?: number;
}

export type SegmentSort = "new" | "top";

export function listSegments(
  params: SegmentFilters & {
    sort?: SegmentSort;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<Page<SegmentWithReplayDto>> {
  return request(
    `/segments${query({
      tag: params.tags,
      mode: params.mode,
      difficulty: params.difficulty,
      player: params.player,
      style: params.style,
      pps_min: params.ppsMin,
      pps_max: params.ppsMax,
      apm_min: params.apmMin,
      apm_max: params.apmMax,
      sort: params.sort,
      limit: params.limit,
      cursor: params.cursor,
    })}`,
  );
}

/** Cast (1/-1) or clear (0) the logged-in user's vote on a segment. */
export function voteSegment(
  id: string,
  value: -1 | 0 | 1,
): Promise<SegmentDto> {
  return request(`/segments/${id}/vote`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

// ---- reports + moderation ----

export interface ReportDto {
  id: string;
  reason: string;
  reporterUsername: string | null;
  createdAt: string;
  /** Exactly one of these is set — the report's target. */
  segment: SegmentDto | null;
  replay: ReplayDto | null;
}

/** File a report against exactly one segment or replay (auth required). */
export function createReport(input: {
  segmentId?: string;
  replayId?: string;
  reason: string;
}): Promise<ReportDto> {
  return request("/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** The moderation queue, newest first (admin only). */
export function listReports(): Promise<ReportDto[]> {
  return request("/admin/reports");
}

export type ModerateAction = "hide" | "remove" | "restore";

/** Set a segment's status via moderation (admin only). */
export function moderateSegment(
  id: string,
  action: ModerateAction,
): Promise<SegmentDto> {
  return request(`/admin/segments/${id}/moderate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

/** <img src> for a segment's stored thumbnail (public, streamed by the API). */
export function segmentThumbnailUrl(id: string): string {
  return `${API_BASE}/segments/${id}/thumbnail`;
}

export function getSegment(id: string): Promise<SegmentWithReplayDto> {
  return request(`/segments/${id}`);
}

export interface CreateSegmentInput {
  replayId: string;
  startPiece: number;
  endPiece: number;
  title: string;
  description?: string;
  difficulty?: number | null;
  /** Tag names: vocabulary slugs and/or free text (server slugifies). */
  tags?: string[];
  /** Author-computed practice stats; stored unverified. */
  hints?: Record<string, unknown>;
  /** PNG rendered from the window's final board snapshot. */
  thumbnail?: Blob | null;
}

/** Publish a training segment (auth required). */
export function createSegment(input: CreateSegmentInput): Promise<SegmentDto> {
  const form = new FormData();
  form.append("replay_id", input.replayId);
  form.append("start_piece", String(input.startPiece));
  form.append("end_piece", String(input.endPiece));
  form.append("title", input.title);
  if (input.description) form.append("description", input.description);
  if (input.difficulty != null) form.append("difficulty", String(input.difficulty));
  if (input.tags?.length) form.append("tags", input.tags.join(","));
  if (input.hints) form.append("hints", JSON.stringify(input.hints));
  if (input.thumbnail) form.append("thumbnail", input.thumbnail, "thumbnail.png");
  return request("/segments", { method: "POST", body: form });
}
