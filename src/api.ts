import { invoke } from "@tauri-apps/api/core";
import type {
  CommentPage, Detail, DownloadJob, Paged, PlayInfo, Post, RankItem, User, VideoCard,
} from "./types";

export const APP_VERSION = __APP_VERSION__;

const ua = navigator.userAgent;
/** iPhone UA also contains "like Mac OS X" — detect iOS before macOS; iPadOS masquerades as Mac via touch points. */
export const isIos =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ||
  (typeof navigator.platform === "string" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(ua);
export const isMacos = !isIos && /Macintosh|Mac OS X/i.test(ua);
export const isLinux = !isAndroid && !isIos && /Linux/i.test(ua);
export const platform: "android" | "ios" | "windows" | "macos" | "linux" =
  isAndroid ? "android" : isIos ? "ios" : isMacos ? "macos" : isLinux ? "linux" : "windows";

export const isMobile = isAndroid || isIos;

/** Custom scheme host differs by platform (Tauri async URI scheme docs):
 *  Windows / Android → `http://<scheme>.localhost`
 *  macOS / iOS / Linux → `<scheme>://localhost`
 *  Rust m3u8 rewrite scheme in src-tauri must match. */
export const LOCAL = isMacos || isIos || isLinux ? "hg://localhost" : "http://hg.localhost";

export const isLocalMedia = (src: string) => src.startsWith(`${LOCAL}/`);

/** Cover via local protocol (site covers are AES ciphertext). */
export const cover = (url?: string, _w = 480) =>
  url ? `${LOCAL}/img?u=${encodeURIComponent(url)}` : "";

/** Playlist via local protocol (rewrite segments; avoid CORS / hotlink). */
export const playlist = (url: string) => `${LOCAL}/hls?u=${encodeURIComponent(url)}`;

export const logLine = (msg: string) => invoke("debug_log", { msg }).catch(() => {});

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await invoke(cmd, args)) as T;
  } catch (e) {
    const msg = typeof e === "string" ? e : "Request failed; check your network";
    logLine(`[api] ${cmd} → ${msg}`);
    const status = /^HTTP (\d{3})\b/.exec(msg)?.[1];
    if (status) {
      throw new Error(`Server request failed (HTTP ${status}); retry later or switch lines in Settings`);
    }
    throw new Error(msg.length > 140 ? `${msg.slice(0, 140)}…` : msg);
  }
}

export const api = {
  boot: () =>
    call<{
      user: User | null;
      logged_in: boolean;
      base: string;
      strict_security?: boolean;
      cli_relaxed?: boolean;
    }>("app_boot"),
  securitySet: (strict: boolean) => call<boolean>("security_set", { strict }),
  login: (username: string, password: string) =>
    call<{ user: User; line_switched?: boolean; base?: string }>("api_login", { username, password }),
  register: (username: string, password: string, email = "") =>
    call<{ user: User; line_switched?: boolean; base?: string }>("api_register", { username, password, email }),
  logout: () => call<{ ok: boolean }>("api_logout"),
  me: () => call<User>("api_me"),

  feed: (page = 1, size = 20) => call<Paged<VideoCard>>("api_feed", { page, size }),
  category: (cate: string, page = 1, size = 20) =>
    call<Paged<VideoCard>>("api_category", { cate, page, size }),
  rank: (kind: "hot" | "recommend" | "potential") =>
    call<{ type: string; items: RankItem[] }>("api_rank", { kind }),
  search: (q: string, page = 1, size = 20) =>
    call<{ items: VideoCard[]; pagination: Paged<VideoCard>["pagination"]; keyword: string }>(
      "api_search", { q, page, size },
    ),
  downloadStart: (id: number, ep: number, mode: "episode" | "series") =>
    call<DownloadJob>("api_download_start", { id, ep, mode }),
  downloadList: () => call<{ items: DownloadJob[]; dir?: string }>("api_download_list"),
  downloadDelete: (id: number, ep?: number | null) =>
    call<{ ok: boolean }>("api_download_delete", { id, ep: ep ?? null }),
  downloadDir: () => call<{ dir: string }>("api_download_dir"),
  downloadPickDir: () => call<{ dir: string } | null>("api_download_pick_dir"),
  downloadResetDir: () => call<{ dir: string }>("api_download_reset_dir"),
  downloadOpenDir: () => call<void>("api_download_open_dir"),
  downloadOpenFile: (id: number, ep: number) =>
    call<void>("api_download_open_file", { id, ep }),
  ffmpegStatus: () =>
    call<{ available: boolean; source: string; path?: string | null; can_install?: boolean }>("api_ffmpeg_status"),
  ffmpegInstall: () =>
    call<{ ok: boolean; already?: boolean; path?: string; source?: string }>("api_ffmpeg_install"),
  posts: (page = 1, size = 20) => call<Paged<Post>>("api_posts", { page, size }),
  post: (id: number) => call<Post & { content?: string; video_url?: string }>("api_post", { id }),

  video: (id: number) => call<Detail>("api_video", { id }),
  play: (id: number, ep: number) => call<PlayInfo>("api_play", { id, ep }),

  comments: (id: number, ep: number, page = 1, size = 20) =>
    call<CommentPage>("api_comments", { id, ep, page, size }),
  commentSend: (id: number, ep: number, text: string, replyId?: number) =>
    call<unknown>("api_comment_send", { id, ep, text, replyId: replyId ?? null }),

  clearCache: () => invoke<void>("cache_clear"),
  netDiag: () => invoke<Record<string, unknown>>("net_diag"),
  postLike: (id: number, on: boolean) => invoke<unknown>("api_post_like", { id, on }),
  postCollect: (id: number, on: boolean) => invoke<unknown>("api_post_collect", { id, on }),
  postComments: (id: number, page: number, size: number) => call<CommentPage>("api_post_comments", { id, page, size }),
  like: (id: number, ep: number, on: boolean) => call<unknown>("api_like", { id, ep, on }),
  collect: (id: number, on: boolean) => call<unknown>("api_collect", { id, on }),
  follow: (uid: number, on: boolean) => call<unknown>("api_follow", { uid, on }),

  
  lineState: () => call<LineState>("line_state"),
  lineSet: (url: string) => call<string>("line_set", { url }),
  lineMirrors: () => call<LineMirrors>("line_mirrors"),
  lineProbe: (urls: string[]) => call<LineProbe[]>("line_probe", { urls }),

  
  checkUpdate: () => call<UpdateInfo>("check_update"),
  openUrl: (url: string) => call<void>("open_url", { url }),
};

export type UpdateInfo = {
  current: string;
  latest: string;
  tag?: string;
  has_update: boolean;
  url: string;
  name?: string;
  published_at?: string;
  notes?: string;
};

export type LineItem = { name?: string; url: string; host?: string };
export type LineState = { base: string; default: string; fixed: LineItem[] };
export type LineMirrors = { source: string; script?: string; items: LineItem[] };
export type LineProbe = { url: string; ok: boolean; status?: number; ms: number; error?: string };

export const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
};

export async function selfTest(): Promise<string> {
  const steps: string[] = [];
  try {
    const info = await api.play(117, 3);
    steps.push(`play:${info?.video_url ? "ok" : "empty"}`);
    const hlsUrl = `${LOCAL}/hls?u=${encodeURIComponent(info.video_url)}`;
    const r1 = await fetch(hlsUrl);
    const txt = await r1.text();
    steps.push(`hls:${r1.status}/${txt.length}/${txt.startsWith("#EXTM3U") ? "m3u8" : "bad"}`);
    const keyLine = txt.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
    if (keyLine) {
      const m = keyLine.match(/URI="([^"]+)"/);
      if (m) {
        const rustUrl = m[1];
        steps.push(`rustUrl:${rustUrl.slice(0, 60)}`);
        const inner = decodeURIComponent(rustUrl.split("?u=")[1] || "");
        steps.push(`inner:${inner.slice(0, 50)}`);
        try {
          const rk = await fetch(rustUrl);
          const bk = await rk.arrayBuffer();
          steps.push(`keyRust:${rk.status}/${bk.byteLength}`);
        } catch (e) { steps.push(`keyRust:throw:${(e as Error).message.slice(0, 30)}`); }
        try {
          const rk2 = await fetch(`${LOCAL}/seg?u=${encodeURIComponent(inner)}`);
          const bk2 = await rk2.arrayBuffer();
          steps.push(`keyJs:${rk2.status}/${bk2.byteLength}`);
        } catch (e) { steps.push(`keyJs:throw:${(e as Error).message.slice(0, 30)}`); }
      }
    }
    const segLine = txt.split("\n").find((l) => l && !l.startsWith("#") && l.includes("/seg?u="));
    if (segLine) {
      try {
        const r2 = await fetch(segLine.trim());
        const buf = await r2.arrayBuffer();
        steps.push(`seg:${r2.status}/${buf.byteLength}`);
      } catch (e) { steps.push(`seg:throw:${(e as Error).message.slice(0, 40)}`); }
    } else steps.push("seg:no-line");
  } catch (e) {
    steps.push(`err:${(e as Error).message.slice(0, 60)}`);
  }
  return steps.join(" | ");
}

export const fmt = (n: number | undefined) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(v);
};

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const dur = (s?: number | string) => {
  const n = Number(s) || 0;
  if (n <= 0) return "";
  const m = Math.floor(n / 60);
  const ss = n % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
};

export function directMedia(url: string): string {
  return `${LOCAL}/seg?u=${encodeURIComponent(url)}`;
}

export function mediaUrl(url: string): string {
  return /\.m3u8(\?|$)/i.test(url) ? playlist(url) : directMedia(url);
}
