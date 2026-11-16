import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type Hls from "hls.js";

/** Keep asynchronous autoplay and error recovery subject to the latest page activity. */
export function usePlaybackActivity(
  videoRef: RefObject<HTMLVideoElement | null>, hlsRef: RefObject<Hls | null>,
  { active, autoPlay, src, warm = false, trace }: {
    active: boolean; autoPlay: boolean; src: string; warm?: boolean;
    trace: (event: string, data?: Record<string, unknown>) => void;
  },
) {
  const latest = useRef({ active, warm, trace }); latest.current = { active, warm, trace };
  const wanted = useRef(autoPlay);
  const mounted = useRef(true);
  const previous = useRef(active);
  useLayoutEffect(() => { wanted.current = autoPlay; }, [src, autoPlay]);

  const play = useCallback((source: string, automatic = false) => {
    const v = videoRef.current;
    if (!v) return;
    if (!mounted.current || !latest.current.active || (automatic && !wanted.current)) {
      latest.current.trace("play.blocked", { source, inactive: !latest.current.active, play_wanted: wanted.current });
      return;
    }
    wanted.current = true;
    const hls = hlsRef.current;
    if (hls?.levels.length && !hls.loadingEnabled) hls.startLoad(v.currentTime);
    latest.current.trace("play.request", { source });
    v.play().then(() => {
      // The page may have changed while play() was pending.
      if (!mounted.current || !latest.current.active) v.pause();
    }).catch(e => latest.current.trace("play.rejected", { source, error_name: e?.name }));
  }, []);
  const pause = useCallback((source = "handle") => {
    wanted.current = false;
    latest.current.trace("pause.request", { source });
    videoRef.current?.pause();
  }, []);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    mounted.current = true;
    const hls = hlsRef.current;
    if (!active) {
      // Don't clobber play-intent while warming a neighbor (paused ≠ user stopped).
      if (!warm && v.readyState >= 2) wanted.current = !v.paused;
      v.pause();
      if (warm) {
        /* Neighbor warm: keep a short buffer, do not tear down the loader. */
        if (hls?.levels.length && !hls.loadingEnabled) {
          try { hls.startLoad(0); } catch { /* ignore */ }
        }
        latest.current.trace("page.warming", { play_wanted: wanted.current });
      } else {
        if (hls?.levels.length) hls.stopLoad();
        latest.current.trace("page.suspended", { play_wanted: wanted.current });
      }
    } else if (!previous.current) {
      /* warm → active handoff: honor autoPlay even if warm pause cleared wanted. */
      if (autoPlay) wanted.current = true;
      if (hls?.levels.length && !hls.loadingEnabled) {
        try { hls.startLoad(v.currentTime || 0); } catch { /* ignore */ }
      }
      if (wanted.current) play("page_active", true);
    }
    previous.current = active;
  }, [active, warm, autoPlay, play]);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const guard = () => {
      if (latest.current.active) return;
      latest.current.trace("play.blocked", { source: "media_event", inactive: true });
      v.pause();
      if (!latest.current.warm && hlsRef.current?.levels.length) hlsRef.current.stopLoad();
    };
    v.addEventListener("play", guard);
    v.addEventListener("playing", guard);
    return () => { mounted.current = false; v.removeEventListener("play", guard); v.removeEventListener("playing", guard); v.pause(); };
  }, []);
  return {
    play,
    pause,
    isActive: () => mounted.current && latest.current.active,
    shouldLoad: () => mounted.current && (latest.current.active || latest.current.warm),
  };
}
