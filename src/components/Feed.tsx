import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, cover, fmt, fmtTime, isMobile } from "../api";
import type { Detail, Episode, Post, VideoCard } from "../types";
import { useStore } from "../store";
import { Avatar, Img, Sheet } from "./ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import PlayerControls from "./PlayerControls";
import PlaybackLock from "./PlaybackLock";
import { ArticlePanel, CommentsPanel, EpisodesPanel } from "./Panels";
import { setBackHandler } from "../back";
import {
  IBack, IBoltF, IChevR, IChevronDown, IChevronUp, IClose, ICommentF, ICompress, IExpand, IFileText, IHeart, IHeartF,
  IDownload, ILink, IList, ILockF, IPauseF, IPlayF, ISearch, IStar, IStarF, IVol, IVolMute,
} from "../icons";

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  /** Vertical snap scrolls series (Home) or episodes within one series. */
  scrollMode?: "series" | "episodes";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
  startEp?: number;
  startTime?: number;
};

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function Feed({
  videoIds, startIndex = 0, title = "", mode, kind = "video", scrollMode = "series",
  active, bottomInset, onBack, onNearEnd, startEp, startTime,
}: Props) {
  const store = useStore();
  const { isLiked, isFav, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, muted, setMuted, volume, setVolume, videoFit, setVideoFit, toast, addHistory, user, setLoginOpen, t, push, history } = store;
  const isDesktop = !isMobile;
  const episodeMode = scrollMode === "episodes" && kind === "video";
  const seriesId = episodeMode ? (videoIds[0] || 0) : 0;
  const bootId = episodeMode ? seriesId : (videoIds[startIndex] || 0);

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const [index, setIndex] = useState(() => (episodeMode ? 0 : startIndex));
  const [epMap, setEpMap] = useState<Record<number, number>>(() => (startEp && bootId ? { [bootId]: startEp } : {}));
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [cards] = useState<Record<number, VideoCard>>({});
  const [posts, setPosts] = useState<Record<number, Post>>({});
  const progScrollRef = useRef(false);
  const progScrollTimer = useRef(0);
  const progAnimRef = useRef(0);
  const wheelLockRef = useRef(0);
  const wheelAccRef = useRef(0);
  const pendingIndexRef = useRef(episodeMode ? 0 : startIndex);
  const scrollSettleTimer = useRef(0);
  const userScrollingRef = useRef(false);
  const [epReady, setEpReady] = useState(!episodeMode);

  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  const uiTimeAt = useRef(0);
  const TIME_UI_MS = 125; /* ~8 Hz UI clock — avoids Feed re-render every media tick */
  const setTimeUi = (t: number, force = false) => {
    timeRef.current = t;
    const now = performance.now();
    if (force || now - uiTimeAt.current >= TIME_UI_MS) {
      uiTimeAt.current = now;
      setTime(t);
    }
  };
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(false);
  const [controlsLocked, setControlsLocked] = useState(false);
  const [rate, setRate] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState("");
  
  const [playTry, setPlayTry] = useState(0);
  const [panel, setPanel] = useState<"episodes" | "comments" | "article" | "detail" | "download" | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  
  const resumeRef = useRef<{ key: string; t: number } | null>(
    startTime && startTime > 1 && bootId ? { key: `${bootId}:${startEp || 1}`, t: startTime } : null,
  );
  
  const liveRef = useRef({ id: 0, ep: 1, dur: 0, t: 0 });
  const lastSaveRef = useRef(0);
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = store.fs;
  const setFs = store.setFs;
  const clean = store.clean;
  const setClean = store.setClean;

  
  const [vpLandscape, setVpLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  );

  
  const lastTapRef = useRef<{ time: number; timer: number | null }>({ time: 0, timer: null });
  const clearTapTimer = () => {
    if (lastTapRef.current.timer) {
      window.clearTimeout(lastTapRef.current.timer);
      lastTapRef.current.timer = null;
    }
  };

  
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, wake]);
  useEffect(() => {
    if (paused) { setIdle(false); window.clearTimeout(idleTimer.current); }
  }, [paused]);
  const [fullscreen, setFullscreen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  
  const [holdSpeed, setHoldSpeed] = useState(false);
  const [speedLock, setSpeedLock] = useState(false);
  const [lockArmed, setLockArmed] = useState(false);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  
  const [rotatePrompt, setRotatePrompt] = useState(false);
  const rotateDeclinedRef = useRef(false);
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0, gesturing: false });
  const pinchRef = useRef<{
    dist0: number; midX0: number; midY0: number; scale0: number; x0: number; y0: number;
  } | null>(null);
  
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; startX: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub" | "pan" | "swipe"; base: number; width: number; playing: boolean;
    el: HTMLDivElement; pointerId: number;
  } | null>(null);

  const epSlides = useMemo(() => {
    if (!episodeMode || !seriesId) return [] as Episode[];
    const eps = details[seriesId]?.episodes || [];
    return [...eps].sort((a, b) => a.ep_num - b.ep_num);
  }, [episodeMode, seriesId, details]);

  const slides = useMemo(() => {
    if (episodeMode) {
      if (epSlides.length) {
        return epSlides.map((e) => ({ key: `ep-${e.ep_num}`, vid: seriesId, epNum: e.ep_num }));
      }
      return seriesId ? [{ key: "ep-pending", vid: seriesId, epNum: startEp || 1 }] : [];
    }
    return videoIds.map((vid) => ({ key: `v-${vid}`, vid, epNum: 0 }));
  }, [episodeMode, epSlides, seriesId, startEp, videoIds]);

  const slideCount = slides.length;
  const curId = episodeMode ? seriesId : videoIds[index];
  const detail = details[curId];
  /* Until episode list boots, keep startEp/epMap so history resume is not wiped by index 0. */
  const curEp = episodeMode
    ? (epReady
      ? (epSlides[index]?.ep_num || epMap[curId] || 1)
      : (epMap[curId] || startEp || 1))
    : (epMap[curId] || 1);
  const playKey = `${curId}:${curEp}`;
  const playUrl = playUrls[playKey] || "";
  useEffect(() => { videoRef.current?.trace("page.active", { active, view: mode, video_id: curId, episode: curEp, scrollMode }); }, [active, mode, curId, curEp, scrollMode]);
  const episodes = detail?.episodes || [];
  const post = posts[curId];

  /* Jump to startEp once episode list is available, then treat index as source of truth. */
  useEffect(() => {
    if (!episodeMode || epReady || !epSlides.length || !seriesId) return;
    const target = startEp || epMap[seriesId] || 1;
    const found = epSlides.findIndex((e) => e.ep_num === target);
    const idx = found < 0 ? 0 : found;
    setIndex(idx);
    setEpMap((m) => ({ ...m, [seriesId]: epSlides[idx]?.ep_num || target }));
    setEpReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeMode, epSlides, seriesId, epReady]);

  /* Episode mode: keep epMap in sync with vertical slide index after boot. */
  useEffect(() => {
    if (!episodeMode || !epReady || !seriesId || !epSlides.length) return;
    const ep = epSlides[Math.min(index, epSlides.length - 1)]?.ep_num;
    if (!ep) return;
    setEpMap((m) => (m[seriesId] === ep ? m : { ...m, [seriesId]: ep }));
  }, [episodeMode, epReady, seriesId, epSlides, index]);

  
  const onTimeTick = (t: number) => {
    liveRef.current = { id: curId, ep: curEp, dur: duration, t };
    timeRef.current = t;
    if (!barScrub.current && gesture.current?.mode !== "scrub" && gesture.current?.mode !== "swipe") {
      setTimeUi(t);
    }
    const now = Date.now();
    if (duration > 0 && now - lastSaveRef.current > 5000) {
      lastSaveRef.current = now;
      addHistory(curId, curEp, t, duration);
    }
  };

  
  const onDurationTick = (d: number) => {
    setDuration(d);
    liveRef.current = { ...liveRef.current, dur: d };
    const r = resumeRef.current;
    if (r && r.key === playKey && r.t > 1 && (!d || r.t < d - 3)) {
      resumeRef.current = null;
      videoRef.current?.seek(r.t, "history_resume");
      setTimeUi(r.t, true);
    }
  };

  
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: t("feed.authorGossip"),
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || cards[curId]?.title || "",
        cover: detail?.cover || cards[curId]?.cover || "",
        desc: detail?.description || "",
        author: detail?.author?.name || t("feed.authorDrama"),
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? cards[curId]?.like_count ?? 0,
        comment: detail?.counts?.comment ?? cards[curId]?.comment_count ?? 0,
        collect: detail?.counts?.collect ?? cards[curId]?.collect_count ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const hasVideo = kind === "video" || !!post?.video_url;
  const articleHtml = kind === "post" && !hasVideo ? (post?.content || "") : "";

  
  const shareLink = () => {
    const u = kind === "post" ? (posts[curId]?.video_url || meta.title) : `https://huangguoai.com/video/${curId}/`;
    navigator.clipboard?.writeText(u).then(() => toast(t("feed.shareCopied"), "ok")).catch(() => {});
  };

  
  const effRate = holdSpeed || speedLock ? 2 : rate;
  
  const barProgress = barPct ?? (duration ? time / duration : 0);
  
  const isLandscapeVideo = vsize.w > vsize.h && vsize.h > 0;
  /* Mobile FS is true immersive (no CSS rotate). Compact chrome when system is landscape. */
  const fsChromeCompact = Boolean(fs && (vpLandscape || isLandscapeVideo));

  
  /* iOS may pause AVPlayer/WebKit during rotate/fullscreen; re-assert play() across the transition window. */
  const keepPlayingTimers = useRef<number[]>([]);
  const keepPlayingThroughTransition = useCallback(() => {
    keepPlayingTimers.current.forEach((id) => window.clearTimeout(id));
    keepPlayingTimers.current = [];
    const el = videoRef.current?.el();
    const shouldPlay = el ? !el.paused : !paused;
    if (!shouldPlay) return;
    for (const delay of [50, 150, 300, 500, 800, 1200]) {
      const tid = window.setTimeout(() => {
        const v = videoRef.current?.el();
        if (v && v.paused && !v.ended) {
          videoRef.current?.play();
        }
      }, delay);
      keepPlayingTimers.current.push(tid);
    }
  }, [paused]);

  useEffect(() => () => {
    keepPlayingTimers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  
  useEffect(() => {
    if (isDesktop) return undefined;
    const onViewportChange = () => {
      const isLand = window.innerWidth > window.innerHeight;
      setVpLandscape((prev) => {
        if (prev === isLand) return prev;
        if (!active) return isLand;
        // Rotated back to portrait: leave fullscreen if needed, clear prompt.
        if (!isLand) {
          rotateDeclinedRef.current = false;
          setRotatePrompt(false);
          if (fs) {
            setFs(false);
            invoke("set_orientation", { landscape: false }).catch(() => {});
            try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
            keepPlayingThroughTransition();
          }
          return isLand;
        }
        // Rotated to landscape: never auto-switch — ask the user first.
        if (!fs && !rotateDeclinedRef.current) {
          setRotatePrompt(true);
        }
        return isLand;
      });
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, [isDesktop, active, setFs, keepPlayingThroughTransition, fs]);

  
  const enterFs = useCallback(() => {
    keepPlayingThroughTransition();
    setClean(false);
    setRotatePrompt(false);
    rotateDeclinedRef.current = false;
    setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
    setFs(true);
    invoke("set_immersive", { hide: true }).catch(() => {});
    if (isLandscapeVideo) {
      invoke("set_orientation", { landscape: true }).catch(() => {});
      try {
        (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
      } catch { /* ignore */ }
    }
  }, [isLandscapeVideo, setClean, setFs, keepPlayingThroughTransition]);

  const exitFs = useCallback(() => {
    keepPlayingThroughTransition();
    setClean(false);
    setRotatePrompt(false);
    setFs(false);
    setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
    invoke("set_immersive", { hide: false }).catch(() => {});
    invoke("set_orientation", { landscape: false }).catch(() => {});
    try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
  }, [setClean, setFs, keepPlayingThroughTransition]);

  const acceptRotate = useCallback(() => {
    rotateDeclinedRef.current = false;
    setRotatePrompt(false);
    enterFs();
  }, [enterFs]);

  const declineRotate = useCallback(() => {
    rotateDeclinedRef.current = true;
    setRotatePrompt(false);
  }, []);

  useEffect(() => {
    if (!active) setRotatePrompt(false);
  }, [active]);

  
  useEffect(() => {
    if (!isDesktop && fs && isLandscapeVideo) {
      invoke("set_orientation", { landscape: true }).catch(() => {});
    }
  }, [isDesktop, fs, isLandscapeVideo]);

  /* Entering FS: clear parallax transforms + keep system bars in sync. */
  useEffect(() => {
    if (isDesktop) return;
    if (fs) {
      const el = boxRef.current;
      if (el) {
        el.querySelectorAll<HTMLElement>(".feed-slide-inner").forEach((inner) => {
          inner.style.removeProperty("transform");
          inner.style.removeProperty("opacity");
        });
      }
      invoke("set_immersive", { hide: true }).catch(() => {});
    } else {
      invoke("set_immersive", { hide: false }).catch(() => {});
    }
  }, [fs, isDesktop]);

  
  const commitIndex = useCallback((i: number) => {
    const clamped = Math.max(0, Math.min(Math.max(slideCount - 1, 0), i));
    pendingIndexRef.current = clamped;
    setIndex((prev) => (prev === clamped ? prev : clamped));
    if (!episodeMode && onNearEnd && clamped >= slideCount - 3) onNearEnd();
  }, [slideCount, episodeMode, onNearEnd]);

  /* Keep snap position aligned after layout/fs changes — never fight an in-flight gesture. */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    if (fs) {
      el.scrollTop = 0;
      return undefined;
    }
    if (progScrollRef.current || userScrollingRef.current) return undefined;
    const syncScroll = () => {
      const box = boxRef.current;
      if (!box || fs || progScrollRef.current || userScrollingRef.current) return;
      const target = index * (box.clientHeight || 1);
      if (Math.abs(box.scrollTop - target) < 2) return;
      box.scrollTop = target;
    };
    syncScroll();
    const raf = requestAnimationFrame(syncScroll);
    return () => cancelAnimationFrame(raf);
  }, [fs, vpLandscape, index, slideCount]);

  const unlockProgScroll = useCallback(() => {
    progScrollRef.current = false;
    window.clearTimeout(progScrollTimer.current);
    if (progAnimRef.current) {
      cancelAnimationFrame(progAnimRef.current);
      progAnimRef.current = 0;
    }
  }, []);

  /** Visual page-flip feel without React re-renders (DOM only). */
  const paintSlideMotion = useCallback((el: HTMLElement) => {
    if (prefersReducedMotion()) return;
    const h = el.clientHeight || 1;
    const prog = el.scrollTop / h;
    const sections = el.querySelectorAll<HTMLElement>(":scope > .feed-slide");
    sections.forEach((sec, i) => {
      const inner = sec.querySelector<HTMLElement>(".feed-slide-inner");
      if (!inner) return;
      const d = i - prog;
      const ad = Math.abs(d);
      if (ad >= 1.2) {
        inner.style.removeProperty("transform");
        inner.style.removeProperty("opacity");
        return;
      }
      const t = Math.min(ad, 1);
      /* Stronger parallax + soft fade — closer to mobile dual-slide fling. */
      const scale = 1 - t * 0.08;
      const ty = d * -10;
      const op = 1 - t * 0.22;
      inner.style.transform = `translate3d(0, ${ty.toFixed(2)}%, 0) scale(${scale.toFixed(4)})`;
      inner.style.opacity = op.toFixed(3);
    });
  }, []);

  const clearSlideMotion = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    el.querySelectorAll<HTMLElement>(".feed-slide-inner").forEach((inner) => {
      inner.style.removeProperty("transform");
      inner.style.removeProperty("opacity");
    });
  }, []);

  const onScroll = useCallback(() => {
    if (fs || pinchRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    el.classList.add("is-scrolling");
    paintSlideMotion(el);
    const h = el.clientHeight || 1;
    const i = Math.max(0, Math.min(Math.max(slideCount - 1, 0), Math.round(el.scrollTop / h)));
    pendingIndexRef.current = i;
    if (!progScrollRef.current) userScrollingRef.current = true;
    window.clearTimeout(scrollSettleTimer.current);
    /* Commit after snap settles — avoids remounting video mid-fling. */
    scrollSettleTimer.current = window.setTimeout(() => {
      userScrollingRef.current = false;
      el.classList.remove("is-scrolling");
      clearSlideMotion(el);
      commitIndex(pendingIndexRef.current);
    }, 140);
  }, [slideCount, fs, commitIndex, paintSlideMotion, clearSlideMotion]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const onScrollEnd = () => {
      userScrollingRef.current = false;
      window.clearTimeout(scrollSettleTimer.current);
      el.classList.remove("is-scrolling");
      clearSlideMotion(el);
      commitIndex(pendingIndexRef.current);
    };
    el.addEventListener("scrollend", onScrollEnd);
    return () => el.removeEventListener("scrollend", onScrollEnd);
  }, [commitIndex, clearSlideMotion]);

  const scrollToIndex = useCallback((next: number, smooth = true) => {
    const el = boxRef.current;
    if (!el || slideCount < 1) return;
    const clamped = Math.max(0, Math.min(slideCount - 1, next));
    const target = clamped * el.clientHeight;
    const start = el.scrollTop;
    unlockProgScroll();
    progScrollRef.current = true;
    userScrollingRef.current = false;
    pendingIndexRef.current = clamped;
    el.classList.add("is-paging");

    const settle = () => {
      unlockProgScroll();
      el.classList.remove("is-paging");
      clearSlideMotion(el);
      if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
      commitIndex(clamped);
    };

    const useSmooth = smooth && !prefersReducedMotion() && Math.abs(target - start) > 2;
    if (!useSmooth) {
      el.scrollTop = target;
      settle();
      return;
    }

    /* Page-flip: distance-scaled duration + ease that eases in then out (mobile-like). */
    const dist = target - start;
    const duration = Math.min(520, Math.max(280, 260 + Math.abs(dist) * 0.12));
    const t0 = performance.now();
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      el.scrollTop = start + dist * easeInOutCubic(p);
      paintSlideMotion(el);
      if (p < 1) {
        progAnimRef.current = requestAnimationFrame(step);
      } else {
        progAnimRef.current = 0;
        settle();
      }
    };
    progAnimRef.current = requestAnimationFrame(step);
    progScrollTimer.current = window.setTimeout(settle, duration + 120);
  }, [slideCount, unlockProgScroll, commitIndex, paintSlideMotion, clearSlideMotion]);

  const go = useCallback((delta: number) => {
    scrollToIndex(pendingIndexRef.current + delta, true);
  }, [scrollToIndex]);

  /*
   * Desktop wheel:
   * - Trackpad / pixel flings → native scroll-snap (same continuity as mobile).
   * - Notch mouse wheel → one video per gesture with animated page-flip.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !active) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (fs || pinchRef.current || controlsLocked || panel) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;

      /* Don't fight an in-flight page animation. */
      if (progScrollRef.current) {
        e.preventDefault();
        return;
      }

      const mag = Math.abs(e.deltaY);
      const trackpadLike = e.deltaMode === 0 && mag > 0 && mag < 42 && !e.ctrlKey;
      if (trackpadLike) {
        /* Let CSS snap-y mandatory + onScroll paint handle the fling. */
        wheelAccRef.current = 0;
        return;
      }

      e.preventDefault();
      const now = performance.now();
      if (now < wheelLockRef.current) return;
      wheelAccRef.current += e.deltaY;
      if (Math.abs(wheelAccRef.current) < 24) return;
      const dir = wheelAccRef.current > 0 ? 1 : -1;
      wheelAccRef.current = 0;
      wheelLockRef.current = now + 200;
      go(dir);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active, fs, controlsLocked, panel, go]);

  
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = (episodeMode ? 0 : startIndex) * (el.clientHeight || 1);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    window.clearTimeout(progScrollTimer.current);
    window.clearTimeout(scrollSettleTimer.current);
    if (progAnimRef.current) cancelAnimationFrame(progAnimRef.current);
  }, []);

  
  useEffect(() => {
    let alive = true;
    const need = episodeMode
      ? (seriesId ? [seriesId] : [])
      : [videoIds[index], videoIds[index + 1], videoIds[index + 2], videoIds[index - 1]].filter(Boolean);
    need.forEach((id) => {
      if (details[id]) return;
      api.video(id).then((d) => { if (alive) setDetails((m) => ({ ...m, [id]: d })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, videoIds, episodeMode, seriesId]);

  
  useEffect(() => {
    if (kind !== "post") return;
    let alive = true;
    [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean).forEach((id) => {
      if (posts[id]) return;
      api.post(id).then((p) => { if (alive) setPosts((m) => ({ ...m, [id]: p })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, index, videoIds]);

  
  useEffect(() => {
    if (!curId) return;
    if (playUrls[playKey]) return;
    let alive = true;
    api.play(curId, curEp)
      .then((info) => {
        if (!alive) return;
        if (!info?.video_url) throw new Error(t("feed.noPlayUrl"));
        setPlayUrls((m) => ({ ...m, [playKey]: info.video_url }));
        addHistory(curId, curEp);
      })
      .catch((e) => { if (alive) setErr((e as Error).message || t("feed.playUrlFailed")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, curEp, playTry]);

  /* Prefetch next/prev play URLs (no history write) so swipe can start immediately. */
  useEffect(() => {
    let alive = true;
    const targets: { id: number; ep: number }[] = [];
    if (episodeMode && seriesId && epSlides.length) {
      [index - 1, index + 1, index + 2].forEach((i) => {
        const ep = epSlides[i]?.ep_num;
        if (ep) targets.push({ id: seriesId, ep });
      });
    } else if (!episodeMode) {
      [index - 1, index + 1, index + 2].forEach((i) => {
        const id = videoIds[i];
        if (id) targets.push({ id, ep: epMap[id] || 1 });
      });
    }
    targets.forEach(({ id, ep }) => {
      const key = `${id}:${ep}`;
      if (playUrls[key]) return;
      api.play(id, ep)
        .then((info) => {
          if (!alive || !info?.video_url) return;
          setPlayUrls((m) => (m[key] ? m : { ...m, [key]: info.video_url }));
        })
        .catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeMode, seriesId, epSlides, index, videoIds]);

  
  useEffect(() => {
    timeRef.current = 0;
    uiTimeAt.current = 0;
    setTime(0); setDuration(0); setBuffered(0); setErr(""); setDescOpen(false);
    /* Soft waiting — warm handoff often already has a frame, avoid hard spinner cut. */
    setWaiting(true);
    setPaused(false);
    setVsize({ w: 0, h: 0 });
    setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
    const soft = window.setTimeout(() => setWaiting(false), 700);
    return () => window.clearTimeout(soft);
  }, [playKey]);

  
  useEffect(() => {
    setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
    if (!fs && boxRef.current) {
      const el = boxRef.current;
      requestAnimationFrame(() => {
        el.scrollTop = index * (el.clientHeight || 1);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs]);

  
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  
  useEffect(() => () => {
    clearTapTimer();
    const s = liveRef.current;
    if (s.id && s.dur) addHistory(s.id, s.ep, s.t, s.dur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  
  useEffect(() => {
    if (!active || controlsLocked) return;
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (panel) { if (e.key === "Escape") setPanel(null); return; }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); go(1); break;
        case "ArrowUp": e.preventDefault(); go(-1); break;
        case " ": e.preventDefault(); videoRef.current?.toggle(); break;
        case "ArrowLeft": e.preventDefault(); videoRef.current?.seek(Math.max(0, timeRef.current - 5), "keyboard_shortcut"); break;
        case "ArrowRight": e.preventDefault(); videoRef.current?.seek(timeRef.current + 5, "keyboard_shortcut"); break;
        case "f": case "F": toggleFull(); break;
        case "t": case "T": setTheater((v) => !v); break;
        case "m": case "M": setMuted((v) => !v); break;
        case "l": case "L": onLike(); break;
        case "s": case "S": onFav(); break;
        case "c": case "C": setPanel("comments"); break;
        case "e": case "E": enterSeries(); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked, panel, index]);

  
  useEffect(() => {
    if (panel) {
      setBackHandler(() => { setPanel(null); return true; });
      return () => setBackHandler(null);
    }
    /* Context episode feed: hardware/back should exit series → previous page. */
    if (mode === "context" && onBack) {
      setBackHandler(() => { onBack(); return true; });
      return () => setBackHandler(null);
    }
    setBackHandler(null);
    return undefined;
  }, [panel, mode, onBack]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = () => {
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  
  const cancelSingleGesture = () => {
    clearTapTimer();
    const g = gesture.current;
    if (g?.timer) window.clearTimeout(g.timer);
    gesture.current = null;
    if (holdRef.current) {
      holdRef.current = false;
      setHoldSpeed(false);
    }
    lockArmedRef.current = false;
    setLockArmed(false);
    setScrub(null);
    scrubTarget.current = null;
  };

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked) return;
    if (e.touches.length === 2) {
      cancelSingleGesture();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist0 = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX0 = (t0.clientX + t1.clientX) / 2;
      const midY0 = (t0.clientY + t1.clientY) / 2;
      pinchRef.current = {
        dist0,
        midX0,
        midY0,
        scale0: zoom.scale,
        x0: zoom.x,
        y0: zoom.y,
      };
    }
  };

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked) return;
    if (e.touches.length === 2 && pinchRef.current) {
      const p = pinchRef.current;
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      const nextScale = Math.max(0.85, Math.min(3.5, p.scale0 * (dist / p.dist0)));
      const dx = midX - p.midX0;
      const dy = midY - p.midY0;
      const maxX = Math.max(0, (nextScale - 1) * window.innerWidth * 0.55);
      const maxY = Math.max(0, (nextScale - 1) * window.innerHeight * 0.55);
      const nextX = Math.max(-maxX, Math.min(maxX, p.x0 + dx));
      const nextY = Math.max(-maxY, Math.min(maxY, p.y0 + dy));
      setZoom({ scale: nextScale, x: nextX, y: nextY, gesturing: true });
    }
  };

  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    if (pinchRef.current && e.touches.length < 2) {
      pinchRef.current = null;
      setZoom((prev) =>
        prev.scale < 1.08
          ? { scale: 1, x: 0, y: 0, gesturing: false }
          : { ...prev, gesturing: false },
      );
    }
  };

  
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked || !active || !e.isPrimary || pinchRef.current || gesture.current || e.button !== 0) return;
    const el = e.currentTarget;
    const span = el.clientWidth || 1;
    /* Do NOT capture yet — vertical pan must stay with the snap scroller. */
    const g = {
      x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      t: Date.now(), base: timeRef.current, width: span,
      playing: videoRef.current?.el()?.paused === false,
      mode: "idle" as "idle" | "hold" | "scrub" | "pan" | "swipe",
      el,
      pointerId: e.pointerId,
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle" || pinchRef.current) return;
        clearTapTimer();
        cur.mode = "hold";
        holdRef.current = true;
        setHoldSpeed(true);
        setLockArmed(false);
        lockArmedRef.current = false;
        try { cur.el.setPointerCapture(cur.pointerId); } catch { /* ignore */ }
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, 380) as unknown as number,
    };
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pinchRef.current) {
      cancelSingleGesture();
      return;
    }
    const g = gesture.current;
    if (!g || isDesktop || !e.isPrimary) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;

    
    if (g.mode === "hold") {
      const upDist = g.startY - e.clientY;
      const armed = upDist > 64;
      if (armed !== lockArmedRef.current) {
        lockArmedRef.current = armed;
        setLockArmed(armed);
      }
      return;
    }

    if (g.mode === "idle") {
      if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        /* Horizontal → clean-mode swipe (seek stays on the progress bar). */
        clearTapTimer();
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "swipe";
        try { g.el.setPointerCapture(g.pointerId); } catch { /* ignore */ }
      } else if (Math.abs(dy) > 10) {
        /* Hand vertical flick to native snap — drop our gesture entirely. */
        clearTapTimer();
        if (g.timer) window.clearTimeout(g.timer);
        gesture.current = null;
      }
      return;
    }

    /* "swipe" tracks dx until pointer up; no live UI needed. */
  };

  const onUp = (e?: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (pinchRef.current) return;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      if (!cancelled && lockArmedRef.current) {
        setSpeedLock(true);
        toast(t("feed.speedLocked"), "info");
      }
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }
    if (g.mode === "swipe") {
      if (!cancelled && e) {
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        /* Left swipe → clean (清屏); right swipe → restore chrome. */
        if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.1) {
          setClean(dx < 0);
          wake();
        }
      }
      return;
    }

    if (cancelled || g.mode !== "idle") return;
    const moveDist = e ? Math.hypot(e.clientX - g.x, e.clientY - g.y) : 0;
    if (Date.now() - g.t < 280 && moveDist < 18) {
      const now = Date.now();
      if (now - lastTapRef.current.time < 300) {
        /* Double-tap → like (Douyin-style); single-tap handles pause. */
        clearTapTimer();
        lastTapRef.current.time = 0;
        onLike();
        setClean(false);
      } else {
        lastTapRef.current.time = now;
        clearTapTimer();
        lastTapRef.current.timer = window.setTimeout(() => {
          lastTapRef.current.timer = null;
          /* Single tap → play / pause (mobile users expect this). */
          videoRef.current?.toggle();
          setClean(false);
          wake();
        }, 220) as unknown as number;
      }
    }
  };

  useEffect(() => {
    if (!active || controlsLocked) onUp(undefined, true);
    // Cancel pending gestures when the page is hidden or controls are locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked]);

  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    gesture.current = null;
  }, [playKey]);

  const lockControls = () => { setPanel(null); setControlsLocked(true); };

  
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => {
      if (holdRef.current || pinchRef.current || fs || e.touches.length >= 2) {
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, slideCount, fs]);

  
  const barPctAt = (barEl: HTMLElement | null, clientX: number, clientY: number) => {
    const r = barEl?.getBoundingClientRect();
    if (!r) return null;
    const span = r.width;
    if (!span) return null;
    const raw = (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (barEl: HTMLElement | null, clientX: number, clientY: number) => {
    const pct = barPctAt(barEl, clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    videoRef.current?.trace("seek.input.down", { input: "mobile_bar" });
    barScrub.current = true;
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(el, e.clientX, e.clientY);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    videoRef.current?.trace("seek.input.move", { input: "mobile_bar" });
    barSeekTo(e.currentTarget as HTMLElement, e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    const pct = barPctAt(e.currentTarget as HTMLElement, e.clientX, e.clientY) ?? barPct;
    setBarPct(null);
    if (pct != null && duration > 0) {
      const target = Math.max(0, Math.min(duration - 0.15, pct * duration));
      setErr("");
      setTimeUi(target, true);
      videoRef.current?.trace("seek.input.up", { input: "mobile_bar", target });
      videoRef.current?.seek(target, "mobile_bar");
    }
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast(t("feed.pipUnsupported"), "info");
    } catch { toast(t("feed.pipFailed"), "info"); }
  };

  const requireLogin = () => { if (!user) { setLoginOpen(true); return false; } return true; };

  const onLike = () => {
    if (!curId) return;
    const on = toggleLikeLocal(curId);
    setHeartBurst((n) => n + 1);
    toast(on ? t("feed.liked") : t("feed.unliked"), on ? "heart" : "info");
    if (requireLogin()) { if (kind === "post") api.postLike(curId, on).catch(() => {}); else api.like(curId, curEp, on).catch(() => {}); }
  };

  const onFav = () => {
    if (!curId) return;
    const on = toggleFavLocal(curId);
    toast(on ? t("feed.faved") : t("feed.unfaved"), on ? "star" : "info");
    if (requireLogin()) { if (kind === "post") api.postCollect(curId, on).catch(() => {}); else api.collect(curId, on).catch(() => {}); }
  };

  const onDownload = (selection: { mode: "series" } | { mode: "episodes"; eps: number[] }) => {
    if (!curId || kind !== "video") return;
    setPanel(null);
    const id = curId;
    const run = async () => {
      if (selection.mode === "series") {
        toast(t("downloads.startingSeries"), "info");
        const job = await api.downloadStart(id, curEp || 1, "series");
        if (job?.status === "done") toast(t("downloads.alreadyHave"), "ok");
        else toast(t("downloads.started"), "ok");
        store.setTab("downloads");
        return;
      }
      const eps = [...new Set(selection.eps.filter((e) => e > 0))].sort((a, b) => a - b);
      if (!eps.length) return;
      const total = Math.max(episodes.length || 1, ...eps);
      if (eps.length === total && eps[0] === 1 && eps.every((e, i) => e === i + 1)) {
        toast(t("downloads.startingSeries"), "info");
        const job = await api.downloadStart(id, eps[0], "series");
        if (job?.status === "done") toast(t("downloads.alreadyHave"), "ok");
        else toast(t("downloads.started"), "ok");
        store.setTab("downloads");
        return;
      }
      toast(t("downloads.startingSelected", { n: eps.length }), "info");
      let already = 0;
      let queued = 0;
      for (const ep of eps) {
        const job = await api.downloadStart(id, ep, "episode");
        if (job?.status === "done") already += 1;
        else queued += 1;
      }
      if (queued === 0) toast(t("downloads.alreadyHave"), "ok");
      else if (already > 0) toast(t("downloads.startedPartial", { n: queued, skip: already }), "ok");
      else toast(t("downloads.started"), "ok");
      store.setTab("downloads");
    };
    run().catch((e) => toast((e as Error).message || t("downloads.failed"), "info"));
  };

  const onFollow = () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    if (!uid) return;
    const on = toggleFollowLocal(uid);
    toast(on ? t("feed.followed", { name: detail?.author?.name || "" }) : t("feed.unfollowed"), on ? "ok" : "info");
    if (requireLogin()) api.follow(uid, on).catch(() => {});
  };

  /** Home discovery → lock into this series' episodes (stack overlay with back). */
  const enterSeries = useCallback(() => {
    if (!curId || kind !== "video") return;
    if (episodeMode) {
      setPanel("episodes");
      return;
    }
    const prog = history.find((h) => h.id === curId);
    push({
      kind: "feed",
      videoIds: [curId],
      index: 0,
      title: meta.title || detail?.title || title || t("feed.enterSeries"),
      scrollMode: "episodes",
      startEp: curEp || prog?.ep || 1,
      startTime: timeRef.current > 1 ? timeRef.current : (prog?.t && prog.t > 1 ? prog.t : undefined),
    });
  }, [curId, kind, episodeMode, history, push, meta.title, detail?.title, title, t, curEp]);

  const pickEp = (ep: number) => {
    setPanel(null);
    if (episodeMode) {
      const i = epSlides.findIndex((e) => e.ep_num === ep);
      if (i < 0) return;
      setEpMap((m) => ({ ...m, [curId]: ep }));
      scrollToIndex(i, true);
      return;
    }
    /* Series-mode Home: picking an ep should enter the series feed, not stay on mixed feed. */
    push({
      kind: "feed",
      videoIds: [curId],
      index: 0,
      title: meta.title || detail?.title || title || t("feed.enterSeries"),
      scrollMode: "episodes",
      startEp: ep,
      startTime: ep === curEp && timeRef.current > 1 ? timeRef.current : undefined,
    });
  };

  const likeCount = useMemo(() => {
    const base = meta.like;
    return base + (isLiked(curId) ? 1 : 0);
  }, [meta.like, curId, isLiked]);

  if (!slideCount) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>;
  }

  /* Default / user choice = native aspect (contain). Cover only when user picks 放大铺满. */
  const effectiveFit: "contain" | "cover" = isDesktop
    ? "contain"
    : (fs || vpLandscape) && isLandscapeVideo
      ? "contain"
      : videoFit;

  return (
    <div
      className={`hg-player-ui absolute inset-0 overflow-hidden bg-black player-root ${controlsLocked ? "is-locked" : ""} ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      <div className="absolute inset-0" inert={controlsLocked}>
      {!fs && (
        <div className="absolute inset-0 scale-110 blur-3xl opacity-25 pointer-events-none">
          {posterUrl && <img src={posterUrl} alt="" className="w-full h-full object-cover" />}
        </div>
      )}

      <div ref={boxRef} onScroll={onScroll}
        className={`feed-snap absolute inset-y-0 left-0 no-bar ${fs ? "overflow-hidden" : "overflow-y-scroll snap-y snap-mandatory overscroll-y-contain"}`}
        style={{ right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
        {slides.map((slide, i) => {
          const vid = slide.vid;
          const isActive = i === index;
          const inWindow = Math.abs(i - index) <= 1;
          const slideEp = episodeMode ? slide.epNum : (epMap[vid] || 1);
          const slidePlayUrl = playUrls[`${vid}:${slideEp}`] || "";
          const slideCover = details[vid]?.cover || posts[vid]?.cover || cards[vid]?.cover || "";
          const slidePoster = cover(slideCover, 900);
          /* Off-window: cover placeholder (not empty black) so flings stay continuous. */
          if (!inWindow) {
            return (
              <section
                key={slide.key}
                aria-hidden
                style={fs ? { display: "none" } : undefined}
                className="feed-slide relative w-full h-full snap-start snap-always overflow-hidden bg-black">
                {!!slideCover && <Img src={slideCover} eager={false} />}
              </section>
            );
          }
          return (
            <section
              key={slide.key}
              style={!isActive && fs ? { display: "none" } : undefined}
              className={`feed-slide relative w-full h-full snap-start snap-always ${isActive ? "is-active" : "is-near"} ${fs && isActive ? "" : "overflow-hidden"}`}>
              {/* One VideoSurface per slide — warm→active flips props (no remount) for handoff. */}
              <div className={`feed-slide-inner ${isActive && !isDesktop && fs ? "fs-immersive" : "absolute inset-0"}`}>
                {!!slidePlayUrl ? (
                  <div
                    className={`absolute inset-0 overflow-hidden ${isActive ? "" : "pointer-events-none"}`}
                    style={{ touchAction: isActive && (fs || zoom.scale > 1.05) ? "none" : "pan-y" }}
                    onTouchStart={isActive ? onTouchStart : undefined}
                    onTouchMove={isActive ? onTouchMove : undefined}
                    onTouchEnd={isActive ? onTouchEnd : undefined}
                    onTouchCancel={isActive ? onTouchEnd : undefined}
                    onPointerDown={isActive ? onDown : undefined}
                    onPointerMove={isActive ? onMove : undefined}
                    onPointerUp={isActive ? (e) => onUp(e, false) : undefined}
                    onPointerCancel={isActive ? (e) => onUp(e, true) : undefined}
                    onLostPointerCapture={isActive ? (e) => onUp(e, true) : undefined}>
                    <VideoSurface
                      ref={isActive ? videoRef : undefined}
                      src={slidePlayUrl}
                      poster={fs && isActive ? undefined : slidePoster}
                      autoPlay={isActive}
                      active={isActive && active}
                      warm={!isActive}
                      diagnosticContext={isActive ? { active, view: mode, kind, video_id: curId, episode: curEp, scrollMode } : undefined}
                      muted={isActive ? muted : true}
                      volume={isActive ? volume : 0}
                      rate={isActive ? effRate : 1}
                      fit={effectiveFit}
                      scale={isActive ? zoom.scale : 1}
                      panX={isActive ? zoom.x : 0}
                      panY={isActive ? zoom.y : 0}
                      isGesturing={isActive ? zoom.gesturing : false}
                      onClick={isActive ? () => { if (isDesktop) videoRef.current?.toggle(); } : undefined}
                      onTime={isActive ? onTimeTick : undefined}
                      onDuration={isActive ? onDurationTick : undefined}
                      onSize={isActive ? (w, h) => setVsize({ w, h }) : undefined}
                      onPlaying={isActive ? () => { setPaused(false); setWaiting(false); setErr(""); } : undefined}
                      onPause={isActive ? () => setPaused(true) : undefined}
                      onWaiting={isActive ? () => setWaiting(true) : undefined}
                      onEnded={isActive ? () => {
                        if (episodeMode) {
                          if (index < slideCount - 1) go(1);
                          return;
                        }
                        const next = episodes.find((e) => e.ep_num === curEp + 1);
                        if (next) pickEp(next.ep_num);
                      } : undefined}
                      onError={isActive ? (m) => setErr(m) : undefined}
                    />
                  </div>
                ) : (
                  <div className="absolute inset-0">
                    <Img src={slideCover || (isActive ? detail?.cover : "") || ""} eager />
                    <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.12)" }} />
                  </div>
                )}

                {isActive && !!slidePlayUrl && (
                  <>
                  {!isDesktop && scrub && (
                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none" style={{ background: "rgba(0,0,0,.25)" }}>
                      <span className="text-[26px] font-bold hg-ink tabular-nums hg-ov-shadow">{fmtTime(scrub.target)}</span>
                      <span className="text-[11px] hg-ink-4 mt-1 tabular-nums">/ {fmtTime(duration)}</span>
                      <div className="mt-4 w-[62%] h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.25)" }}>
                        <div className="h-full bg-white" style={{ width: `${scrub.pct}%` }} />
                      </div>
                    </div>
                  )}

                  {paused && !err && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                      <span className="w-[66px] h-[66px] rounded-full flex items-center justify-center backdrop-blur-md"
                        style={{ background: "rgba(0,0,0,.55)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)" }}>
                        <IPlayF size={28} className="hg-ink ml-0.5" />
                      </span>
                    </div>
                  )}
                  {waiting && !err && !paused && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"><div className="w-9 h-9 spinner" /></div>
                  )}
                  {err && (
                    <div className="absolute inset-0 z-30 flex items-center justify-center">
                      <div className="rounded-xl p-5 flex flex-col items-center gap-3 text-[13px] hg-ink-2" style={{ background: "rgba(0,0,0,.74)" }}>
                        <span>{t("feed.loadFailed")}</span>
                        <span className="text-[10.5px] hg-ink-4 max-w-[240px] text-center break-all">{err}</span>
                        <button className="px-4 py-1.5 rounded-full hg-chip-strong hg-link text-[12.5px] font-semibold pressable"
                          onClick={() => { setErr(""); setWaiting(true); videoRef.current?.reload(); }}>
                          {t("feed.reload")}
                        </button>
                      </div>
                    </div>
                  )}

                  {!isDesktop && (!clean || holdSpeed) && (holdSpeed || speedLock || rate !== 1) && (
                    <button
                      onClick={() => {
                        if (speedLock) { setSpeedLock(false); toast(t("feed.speedUnlocked"), "info"); }
                        else if (rate !== 1 && !holdSpeed) setRate(1);
                      }}
                      className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full backdrop-blur-md text-[12px] font-bold elev-2 pressable ${speedLock ? "bg-primary text-on-primary" : "hg-chip hg-gold"}`}
                      style={{ top: fsChromeCompact ? 14 : "calc(var(--sat, 0px) + 54px)" }}>
                      <IBoltF size={13} />
                      {effRate}x {speedLock ? t("feed.speedLockedHint") : holdSpeed ? t("feed.speedHolding") : t("feed.speed")}
                    </button>
                  )}
                  {!isDesktop && holdSpeed && (
                    <div
                      className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 h-10 rounded-xl backdrop-blur-md elev-2 transition-all duration-200 ${lockArmed ? "bg-primary text-on-primary scale-110" : "hg-chip-strong hg-ink-2"}`}
                      style={{ top: "38%" }}>
                      <ILockF size={16} />
                      <span className="text-[12.5px] font-bold">{lockArmed ? t("feed.releaseLock") : t("feed.slideToLock")}</span>
                    </div>
                  )}

                  {!isDesktop && fs && !clean && !controlsLocked && (
                    <>
                      <div className="absolute right-4 z-40 flex items-center gap-2"
                        style={{ top: fsChromeCompact ? 14 : "calc(var(--sat, 0px) + 8px)" }}>
                        <button onClick={lockControls} aria-label={t("feed.lockControls")} title={t("feed.lockControls")} aria-pressed={false}
                          className="hg-chip-strong w-9 h-9 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
                          <ILockF size={17} />
                        </button>
                        <button onClick={exitFs} aria-label={t("feed.exitFs")}
                          className="hg-chip-strong w-9 h-9 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
                          <ICompress size={18} />
                        </button>
                      </div>
                      {zoom.scale > 1.05 && (
                        <button
                          onClick={() => setZoom({ scale: 1, x: 0, y: 0, gesturing: false })}
                          className="hg-chip-strong absolute left-4 z-40 px-3 h-8 rounded-full backdrop-blur-md text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1"
                          style={{ top: fsChromeCompact ? 14 : "calc(var(--sat, 0px) + 8px)" }}>
                          {t("feed.resetZoom", { n: zoom.scale.toFixed(1) })}
                        </button>
                      )}
                      <div className="absolute inset-x-0 z-30 px-4" style={{ bottom: fsChromeCompact ? 46 : "calc(var(--sab, 0px) + 52px)", height: 26 }}>
                        <div className="relative h-full" style={{ touchAction: "none" }}
                          onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                          <div className={`absolute inset-x-0 bottom-[10px] rounded-full transition-all ${barPct !== null ? "h-[5px]" : "h-[3px]"}`}
                            style={{ background: "rgba(255,255,255,.3)" }}>
                            <div className="h-full rounded-full bg-white" style={{ width: `${barProgress * 100}%` }} />
                          </div>
                          {barPct !== null && (
                            <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-2.5 py-1 rounded-md hg-chip-strong backdrop-blur-md text-[12px] font-bold tabular-nums whitespace-nowrap">
                              {fmtTime(barPct * (duration || 0))} / {fmtTime(duration)}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="absolute inset-x-0 z-40 flex items-center gap-3 px-4"
                        style={{ bottom: fsChromeCompact ? 10 : "calc(var(--sab, 0px) + 10px)" }}>
                        <button onClick={() => videoRef.current?.toggle()}
                          className="hg-chip shrink-0 w-9 h-9 rounded-full flex items-center justify-center pressable">
                          {paused ? <IPlayF size={18} /> : <IPauseF size={17} />}
                        </button>
                        <span className="shrink-0 text-[11.5px] font-semibold hg-ink-2 tabular-nums">{fmtTime(time)}</span>
                        <button
                          onClick={() => {
                            if (speedLock) { setSpeedLock(false); return; }
                            const seq = [1, 1.25, 1.5, 2];
                            const idx = seq.indexOf(rate);
                            setRate(seq[(idx + 1) % seq.length]);
                          }}
                          className={`ml-auto shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[12px] font-bold pressable ${effRate !== 1 ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>
                          <IBoltF size={12} />{effRate}x
                        </button>
                        <span className="shrink-0 text-[11.5px] hg-ink-4 tabular-nums">{fmtTime(duration)}</span>
                      </div>
                    </>
                  )}
                  </>
                )}
              </div>

              {isActive && kind === "video" && !playUrl && !!err && (
                <div className="absolute inset-0 z-30 flex items-center justify-center">
                  <div className="rounded-xl p-5 flex flex-col items-center gap-3 text-[13px] hg-ink-2" style={{ background: "rgba(0,0,0,.74)" }}>
                    <span>{t("feed.loadFailed")}</span>
                    <span className="text-[10.5px] hg-ink-4 max-w-[240px] text-center break-all">{err}</span>
                    <button className="px-4 py-1.5 rounded-full hg-chip-strong hg-link text-[12.5px] font-semibold pressable"
                      onClick={() => { setErr(""); setWaiting(true); setPlayTry((n) => n + 1); }}>
                      {t("feed.reload")}
                    </button>
                  </div>
                </div>
              )}

              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full text-[13.5px] font-semibold pressable elev-3"
                    style={{ background: "rgba(255,255,255,.94)", color: "#0b0e15" }}>
                    <IFileText size={17} />{t("feed.viewArticle")}
                  </button>
                </div>
              )}

              {!fs && !clean && (
                <div className="absolute inset-0 pointer-events-none"
                  style={{ background: "linear-gradient(0deg, rgba(8,11,15,.86) 0, rgba(11,14,20,.18) 26%, transparent 48%)" }} />
              )}

              {isActive && !fs && !clean && !isDesktop && rotatePrompt && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 z-30 w-[min(320px,calc(100%-32px))] rounded-2xl px-3.5 py-3 elev-3 a-rise"
                  style={{ top: "58%", background: "rgba(12,14,18,.92)", backdropFilter: "blur(12px)" }}
                >
                  <div className="text-[12.5px] text-white/90 leading-snug text-center">{t("feed.rotatePrompt")}</div>
                  <div className="mt-2.5 flex gap-2">
                    <button
                      type="button"
                      onClick={declineRotate}
                      className="flex-1 h-9 rounded-full bg-white/10 text-white/85 text-[12px] font-semibold pressable"
                    >
                      {t("feed.rotateDismiss")}
                    </button>
                    <button
                      type="button"
                      onClick={acceptRotate}
                      className="flex-1 h-9 rounded-full bg-primary text-on-primary text-[12px] font-bold pressable"
                    >
                      {t("feed.rotateConfirm")}
                    </button>
                  </div>
                </div>
              )}

              {isActive && !fs && !clean && !isDesktop && !rotatePrompt && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-2"
                  style={{ top: "64%" }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (zoom.scale > 1.05) {
                        setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
                        setVideoFit("contain");
                      } else {
                        setVideoFit((f) => (f === "contain" ? "cover" : "contain"));
                      }
                    }}
                    className="hg-chip-strong backdrop-blur-md px-3 h-7 rounded-full text-[11.5px] font-semibold flex items-center gap-1.5 pressable elev-1">
                    {zoom.scale > 1.05
                      ? t("feed.resetZoom", { n: zoom.scale.toFixed(1) })
                      : videoFit === "contain"
                        ? t("feed.fill")
                        : t("feed.fit")}
                  </button>
                  {isLandscapeVideo && (
                    <button
                      type="button"
                      onClick={enterFs}
                      className="hg-chip-strong backdrop-blur-md px-3 h-7 rounded-full text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1">
                      <IExpand size={12} />{t("feed.landscapeFs")}
                    </button>
                  )}
                </div>
              )}

              {!fs && !clean && mode === "context" && onBack ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <button onClick={onBack} aria-label={episodeMode ? t("feed.exitSeries") : t("feed.back")} title={episodeMode ? t("feed.exitSeries") : t("feed.back")}><IBack size={17} /></button>
                    <span>{title || meta.title}</span>
                    <small>{index + 1} / {slideCount}</small>
                  </div>
                ) : (
                  <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5" style={{ top: "calc(var(--sat, 0px) + 8px)", paddingRight: 148 }}>
                    <button onClick={onBack} aria-label={episodeMode ? t("feed.exitSeries") : t("feed.back")}
                      className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><IBack size={20} /></button>
                    <span className="text-[14.5px] font-semibold hg-ink hg-ov-shadow truncate">{title || meta.title}</span>
                    <span className="ml-auto px-2 py-0.5 rounded-full hg-chip text-[11px] font-semibold" style={{ color: "rgba(255,255,255,.9)" }}>{index + 1} / {slideCount}</span>
                  </div>
                )
              ) : null}

              {!fs && !clean && !isDesktop && (
                <div className="absolute right-2.5 z-20 flex flex-col items-center gap-[18px]"
                  style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 96}px)` }}>
                  <div className="relative mb-1">
                    <div className="w-12 h-12 rounded-full overflow-hidden border-2 border-white bg-s3">
                      <div className="w-full h-full flex items-center justify-center text-[13px] font-bold text-white" style={{ background: "linear-gradient(135deg,#fe2c55,#ff7a45)" }}>
                        {(meta.author || "HG").slice(0, 1).toUpperCase()}
                      </div>
                    </div>
                    <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-primary text-white flex items-center justify-center text-[14px] font-bold leading-none">+</span>
                  </div>
                  <button onClick={onLike} className="flex flex-col items-center gap-1 pressable" aria-pressed={isLiked(curId)} aria-label={t("feed.like")}>
                    <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                      {isLiked(curId) ? <IHeartF size={32} className="text-neon" /> : <IHeart size={32} className="hg-ink hg-ov-shadow" />}
                    </span>
                    <span className="hg-social-count hg-ink-2">{fmt(likeCount)}</span>
                  </button>
                  <button onClick={() => setPanel("comments")} className="flex flex-col items-center gap-1 pressable" aria-label={t("feed.comments")}>
                    <ICommentF size={30} className="hg-ink hg-ov-shadow" />
                    <span className="hg-social-count hg-ink-2">{fmt(meta.comment)}</span>
                  </button>
                  <button onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={isFav(curId)} aria-label={t("feed.favorite")}>
                    {isFav(curId) ? <IStarF size={30} className="hg-gold" /> : <IStar size={30} className="hg-ink hg-ov-shadow" />}
                    <span className="hg-social-count hg-ink-2">{fmt(meta.collect)}</span>
                  </button>
                  {kind === "video" && (
                    <button onClick={enterSeries} className="flex flex-col items-center gap-1 pressable"
                      aria-label={episodeMode ? t("feed.episodes") : t("feed.enterSeries")}>
                      <IList size={28} className="hg-ink hg-ov-shadow" />
                      <span className="hg-social-count hg-ink-2">{episodeMode ? t("feed.episodes") : t("feed.enterSeries")}</span>
                    </button>
                  )}
                  {kind === "video" && (
                    <button onClick={() => setPanel("download")} className="flex flex-col items-center gap-1 pressable"
                      aria-label={t("downloads.save")}>
                      <IDownload size={28} className="hg-ink hg-ov-shadow" />
                      <span className="hg-social-count hg-ink-2">{t("downloads.save")}</span>
                    </button>
                  )}
                  <button onClick={shareLink} className="flex flex-col items-center gap-1 pressable" aria-label={t("feed.share")}>
                    <ILink size={28} className="hg-ink hg-ov-shadow" />
                    <span className="hg-social-count hg-ink-2">{t("feed.share")}</span>
                  </button>
                </div>
              )}

              {!fs && isDesktop && (
              <div className="absolute z-20 flex flex-col items-center desktop-social">
                <div className="desktop-browse-inline">
                  <button onClick={() => go(-1)} disabled={index === 0} aria-label={t("feed.previous")} title={t("feed.previous")}>
                    <IChevronUp size={19} strokeWidth={1.8} />
                  </button>
                  <button onClick={() => go(1)} disabled={index >= slideCount - 1} aria-label={t("feed.next")} title={t("feed.next")}>
                    <IChevronDown size={19} strokeWidth={1.8} />
                  </button>
                  <small>{String(index + 1).padStart(2, "0")} / {String(slideCount).padStart(2, "0")}</small>
                </div>

                {kind === "video" && (
                  <>
                    <button onClick={onLike} className="flex flex-col items-center gap-1 pressable" aria-pressed={isLiked(curId)}>
                      <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                        {isLiked(curId) ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
                      </span>
                      <span className="hg-social-count">{fmt(likeCount)}</span>
                    </button>

                    <button onClick={() => setPanel("comments")} className="flex flex-col items-center gap-1 pressable">
                      <ICommentF size={27} className="text-white tsh" />
                      <span className="hg-social-count">{fmt(meta.comment)}</span>
                    </button>

                    <button onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={isFav(curId)}>
                      {isFav(curId) ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
                      <span className="hg-social-count">{fmt(meta.collect)}</span>
                    </button>

                    <button onClick={enterSeries} className="flex flex-col items-center gap-1 pressable"
                      aria-label={episodeMode ? t("feed.episodes") : t("feed.enterSeries")}>
                      <IList size={26} className="text-white tsh" />
                      <span className="hg-social-count">{episodeMode ? t("feed.episodes") : t("feed.enterSeries")}</span>
                    </button>

                    <button onClick={() => setPanel("download")} className="flex flex-col items-center gap-1 pressable"
                      aria-label={t("downloads.save")}>
                      <IDownload size={26} className="text-white tsh" />
                      <span className="hg-social-count">{t("downloads.save")}</span>
                    </button>
                  </>
                )}

                <button onClick={shareLink} className="flex flex-col items-center gap-1 pressable">
                  <ILink size={25} className="text-white tsh" />
                  <span className="hg-social-count">{t("feed.share")}</span>
                </button>
              </div>
              )}

              {!fs && isDesktop && (
              <div className="desktop-video-meta">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-bold text-white tsh truncate">@{meta.author}</span>
                  {episodes.length > 0 && (
                    <span className="shrink-0 px-1.5 py-px rounded-md text-[10px] font-bold text-white"
                      style={{ background: "rgba(255,255,255,.16)" }}>
                      {t("feed.ep", { cur: curEp, total: episodes.length })}
                    </span>
                  )}
                  {!!meta.score && (
                    <span className="shrink-0 text-[11px] font-bold hg-gold hg-ov-shadow">{meta.score.toFixed(1)}</span>
                  )}
                </div>

                <p className="mt-1 text-[13.5px] leading-snug hg-ink-2 hg-ov-shadow clamp-2">{meta.title}</p>

                <button onClick={() => setDescOpen((v) => !v)} className="mt-1 text-left w-full pressable group">
                  <p className={`text-[11.5px] leading-relaxed hg-ink-4 ${descOpen ? "" : "clamp-1"}`}>
                    {meta.desc || t("feed.noDesc")}
                  </p>
                  <span className="text-[10.5px] hg-link font-semibold">{descOpen ? t("feed.less") : t("feed.more")}</span>
                </button>
              </div>
              )}

              {!fs && !clean && !isDesktop && (
                <div className="absolute inset-x-0 z-20" style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset}px)` }}>
                  <div className="absolute inset-x-0 bottom-0 h-[190px] pointer-events-none"
                    style={{ background: "linear-gradient(0deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.42) 45%, transparent 100%)" }} />
                  <div className="relative px-4 pb-1">
                    <p className="text-[15px] font-bold leading-snug hg-ink hg-ov-shadow">@{meta.author || t("feed.creator")}</p>
                    <button type="button" onClick={mode === "home" ? enterSeries : () => setPanel("detail")}
                      className="mt-1 text-left pressable">
                      <p className="text-[13px] font-medium leading-snug hg-ink-2 hg-ov-shadow clamp-2">{meta.title}</p>
                    </button>
                  </div>
                  <div className="relative pt-1 pb-2">
                    <button onClick={mode === "home" ? enterSeries : () => setPanel("detail")}
                      className="px-4 flex items-center gap-0.5 text-[11px] font-medium hg-ink hg-ov-shadow pressable">
                      {mode === "home" ? t("feed.enterSeries") : t("feed.details", { n: curEp })}
                      <IChevR size={11} />
                    </button>
                    {isActive && (
                      <div className="mx-4 mt-1.5 relative" style={{ height: 22, touchAction: "none" }}
                        onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                        <div className={`absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full transition-all ${barPct !== null ? "h-[4px]" : "h-[2px]"}`}
                          style={{ background: "rgba(255,255,255,.28)" }}>
                          <div className="h-full rounded-full"
                            style={{ width: `${barProgress * 100}%`, background: "#fe2c55", transition: barPct !== null ? "none" : "width .25s linear" }} />
                        </div>
                        {barPct !== null && (
                          <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-2.5 py-1 rounded-md hg-chip-strong backdrop-blur-md text-[12px] font-bold tabular-nums whitespace-nowrap">
                            {fmtTime(barPct * (duration || 0))} / {fmtTime(duration)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {isDesktop && (
        <PlayerControls
          paused={paused} time={time} duration={duration} buffered={buffered} rate={rate}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          seekEnabled={active && !controlsLocked}
          seekKey={playKey}
          nextDisabled={episodeMode
            ? index >= slideCount - 1
            : !episodes.some((e) => e.ep_num === curEp + 1) && index >= slideCount - 1}
          nextTitle={episodeMode || episodes.some((e) => e.ep_num === curEp + 1) ? t("feed.nextEp") : t("feed.nextDown")}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t, source) => { videoRef.current?.seek(t, source); setTimeUi(t, true); }}
          onSeekInteraction={(phase, input, target, pointerTarget) => videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget })}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onLock={lockControls}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onNext={() => {
            if (episodeMode) {
              go(1);
              return;
            }
            const nx = episodes.find((e) => e.ep_num === curEp + 1);
            if (nx) pickEp(nx.ep_num);
            else go(1);
          }}
        />
      )}

      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
            ) : panel === "comments" ? (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            ) : panel === "download" ? (
              <DownloadPickPanel ep={curEp || 1} total={episodes.length || 1} onPick={onDownload} onClose={() => setPanel(null)} />
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <Sheet open={panel === "comments"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "72vh" }}>
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          <Sheet open={panel === "article"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "78vh" }}>
              <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={post?.hot} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          <Sheet open={panel === "download"} onClose={() => setPanel(null)}>
            <div className="flex flex-col px-4 pt-2 pb-6" style={{ maxHeight: "78vh" }}>
              <DownloadPickPanel ep={curEp || 1} total={episodes.length || 1} onPick={onDownload} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          <Sheet open={panel === "detail" || panel === "episodes"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "72vh" }}>
              <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
                <div className="flex flex-1 bg-s3 rounded-(--r-ctl) p-1">
                  {([["detail", "feed.detail"], ["episodes", "feed.episodes"]] as const).map(([k, key]) => (
                    <button key={k} onClick={() => setPanel(k)}
                      className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${panel === k ? "text-on-sec" : "text-mut"}`}
                      style={panel === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{t(key)}</button>
                  ))}
                </div>
                <button onClick={() => setPanel(null)} aria-label={t("common.close")}
                  className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
                  <IClose size={14} />
                </button>
              </div>

              <div className="flex-1 min-h-0">
                {panel === "episodes" ? (
                  <EpisodesPanel bare videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
                ) : (
                  <div className="h-full scroll-y px-4 pb-5">
                    <div className="flex gap-3">
                      <div className="relative w-[84px] shrink-0 rounded-(--r-sm) overflow-hidden bg-s3" style={{ aspectRatio: "3 / 4" }}>
                        <Img src={meta.cover} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13.5px] font-bold text-on leading-snug clamp-2">{meta.title}</div>
                        <div className="flex items-center gap-2 mt-1.5">
                          {!!meta.score && <span className="text-[12px] font-bold text-amber">{meta.score.toFixed(1)}</span>}
                          {episodes.length > 0 && <span className="text-[10.5px] text-mut">{t("feed.episodesCount", { n: episodes.length })}</span>}
                        </div>
                        <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                          <span>{t("profile.likes")} {fmt(meta.like)}</span>
                          <span>{t("feed.saves")} {fmt(meta.collect)}</span>
                          <span>{t("feed.comments")} {fmt(meta.comment)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center gap-2.5 rounded-(--r-md) bg-s2 p-2.5">
                      <Avatar size={34} name={meta.author} hue={220} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-semibold text-on truncate">{meta.author}</div>
                        <div className="text-[10px] text-mut">{t("feed.author")}</div>
                      </div>
                      {meta.authorId > 0 && (
                        <button onClick={onFollow}
                          className={`h-7 px-3 rounded-full text-[11px] font-semibold pressable ${store.follows.includes(meta.authorId) ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
                          {store.follows.includes(meta.authorId) ? t("feed.followingBtn") : t("feed.follow")}
                        </button>
                      )}
                    </div>

                    <div className="mt-4">
                      <div className="text-[11px] font-semibold text-dim mb-1.5">{t("feed.about")}</div>
                      <p className="text-[11.5px] leading-relaxed text-mut whitespace-pre-wrap">{meta.desc || t("feed.noDesc")}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Sheet>
        </>
      )}
      </div>
      {!isDesktop && !fs && !clean && !controlsLocked && active && (
        <div className="absolute right-3 z-40 flex items-center gap-2" style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
          <button onClick={() => setMuted(m => !m)} aria-label={muted ? t("feed.unmute") : t("feed.mute")}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
            {muted ? <IVolMute size={17} /> : <IVol size={17} />}
          </button>
          <button onClick={lockControls} aria-label={t("feed.lockControls")} title={t("feed.lockControls")} aria-pressed={false}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ILockF size={17} /></button>
          <button onClick={() => store.setTab("search")} aria-label={t("nav.search")}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ISearch size={18} /></button>
        </div>
      )}
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => { setControlsLocked(false); wake(); }} />}
    </div>
  );
}

function DownloadPickPanel({
  ep, total, onPick, onClose,
}: {
  ep: number;
  total: number;
  onPick: (selection: { mode: "series" } | { mode: "episodes"; eps: number[] }) => void;
  onClose: () => void;
}) {
  const { t } = useStore();
  const count = Math.max(1, total || 1);
  const allEps = useMemo(() => Array.from({ length: count }, (_, i) => i + 1), [count]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set([Math.min(Math.max(1, ep), count)]));
  const selectedCount = selected.size;
  const allSelected = selectedCount === count;

  const toggle = (n: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3 py-2 min-h-0">
      <div className="flex items-center justify-between px-1">
        <div>
          <div className="text-[15px] font-extrabold text-on">{t("downloads.pickTitle")}</div>
          <div className="text-[11px] text-mut mt-0.5">{t("downloads.pickSelectHint")}</div>
        </div>
        <button onClick={onClose} aria-label={t("common.close")}
          className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={14} />
        </button>
      </div>

      <div className="flex items-center gap-2 px-1">
        <button
          onClick={() => setSelected(allSelected ? new Set() : new Set(allEps))}
          className="h-8 px-3 rounded-full bg-s3 text-on text-[12px] font-semibold pressable"
        >
          {allSelected ? t("downloads.clearSelect") : t("downloads.selectAll")}
        </button>
        <span className="text-[11px] text-mut">{t("downloads.selectedCount", { n: selectedCount })}</span>
      </div>

      <div className="max-h-[42vh] overflow-y-auto px-1">
        <div className="grid grid-cols-5 gap-2">
          {allEps.map((n) => {
            const on = selected.has(n);
            return (
              <button
                key={n}
                onClick={() => toggle(n)}
                className={`h-10 rounded-(--r-sm) text-[12px] font-semibold pressable ${
                  on ? "bg-primary text-on-primary" : "bg-s3 text-on/80"
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2 px-1 pt-1">
        <button
          disabled={!selectedCount}
          onClick={() => {
            if (!selectedCount) return;
            if (allSelected) onPick({ mode: "series" });
            else onPick({ mode: "episodes", eps: [...selected].sort((a, b) => a - b) });
          }}
          className="w-full h-11 rounded-2xl bg-primary text-on-primary text-[14px] font-bold pressable disabled:opacity-40"
        >
          {allSelected
            ? t("downloads.pickSeries")
            : t("downloads.downloadSelected", { n: selectedCount })}
        </button>
        {!allSelected && (
          <button
            onClick={() => onPick({ mode: "series" })}
            className="w-full h-10 rounded-2xl bg-s2 border border-primary/25 text-on text-[13px] font-semibold pressable"
          >
            {t("downloads.pickSeries")} · {t("downloads.seriesMeta", { n: count })}
          </button>
        )}
      </div>
    </div>
  );
}
