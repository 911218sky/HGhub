import React, { useEffect, useRef, useState } from "react";
import { fmtTime, platform } from "../api";
import { useStore } from "../store";
import { useSeekInput } from "../useSeekInput";
import PlaybackLock from "./PlaybackLock";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import { ICompress, IExpand, ILockF, IPauseF, IPlayF, IVol, IVolMute } from "../icons";

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  active?: boolean;
  muted?: boolean;
  loop?: boolean;
  onEnded?: () => void;
  onPlaying?: () => void;
  onTogglePlay?: (playing: boolean) => void;
  onToggleMute?: () => void;
  controls?: boolean;
  className?: string;
  diagnosticContext?: Record<string, unknown>;
};

/** Post/detail chrome over the shared VideoSurface engine (same HLS/recover path as Feed). */
export default function Player({
  src, poster, autoPlay, active = true, muted = false, loop = false, onEnded, onPlaying,
  onTogglePlay, onToggleMute, controls = true, className = "", diagnosticContext = {},
}: Props) {
  const { t } = useStore();
  const videoRef = useRef<VideoHandle>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hideChromeTimer = useRef(0);
  const chromeOn = useRef(true);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [full, setFull] = useState(false);
  const [rate, setRate] = useState(1);
  const [errMsg, setErrMsg] = useState("");
  const [controlsLocked, setControlsLocked] = useState(false);
  const [chrome, setChrome] = useState(true);
  const seek = useSeekInput({
    time, duration, enabled: active && !controlsLocked, resetKey: src,
    onInteraction: (phase, input, target, pointerTarget) =>
      videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget }),
    onSeek: (target, input) => {
      videoRef.current?.seek(target, `legacy_${input}`);
      setWaiting(true);
      setTime(target);
    },
  });

  useEffect(() => {
    setErrMsg("");
    setPlaying(false);
    setWaiting(!!autoPlay);
    setTime(0);
    setDuration(0);
    setRate(1);
  }, [src, autoPlay]);

  useEffect(() => {
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const bumpChrome = () => {
    if (!chromeOn.current) {
      chromeOn.current = true;
      setChrome(true);
    }
    window.clearTimeout(hideChromeTimer.current);
    if (!playing || controlsLocked) return;
    hideChromeTimer.current = window.setTimeout(() => {
      chromeOn.current = false;
      setChrome(false);
    }, 3200);
  };

  useEffect(() => {
    bumpChrome();
    return () => window.clearTimeout(hideChromeTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, playing, controlsLocked]);

  const toggle = () => {
    bumpChrome();
    videoRef.current?.toggle();
  };

  const cycleRate = () => {
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 2 : 1;
    videoRef.current?.rate(next);
    setRate(next);
  };

  const toggleFull = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  const pct = duration > 0 ? (seek.time / duration) * 100 : 0;

  return (
    <div
      ref={wrapRef}
      className={`relative bg-black overflow-hidden group ${className}`}
      onPointerDown={bumpChrome}
      onMouseMove={bumpChrome}
    >
      <div className="absolute inset-0" inert={controlsLocked}>
        <VideoSurface
          ref={videoRef}
          src={src}
          poster={poster}
          autoPlay={autoPlay}
          active={active}
          muted={muted}
          loop={loop}
          diagnosticContext={{ view: "post_detail", ...diagnosticContext }}
          onTime={setTime}
          onDuration={setDuration}
          onClick={toggle}
          onPlaying={() => {
            setPlaying(true);
            setWaiting(false);
            setErrMsg("");
            onTogglePlay?.(true);
            onPlaying?.();
          }}
          onPause={() => {
            setPlaying(false);
            onTogglePlay?.(false);
          }}
          onWaiting={() => setWaiting(true)}
          onEnded={() => { if (active) onEnded?.(); }}
          onError={(m) => setErrMsg(m)}
          className="w-full h-full"
        />

        {errMsg && (
          <div className="absolute left-2 top-2 z-30 max-w-[80%] rounded bg-black/70 px-2 py-1 text-[10px] leading-tight text-red-300 break-all">
            {errMsg}
          </div>
        )}

        {waiting && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-9 h-9 spinner" />
          </div>
        )}

        {!playing && !waiting && (
          <button onClick={toggle} aria-label={t("player.play")}
            className="absolute inset-0 flex items-center justify-center">
            <span className="w-16 h-16 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center elev-2 pressable">
              <IPlayF size={26} className="text-white ml-0.5" />
            </span>
          </button>
        )}

        {controls && (
          <div className={`absolute inset-x-0 bottom-0 px-3 pb-2 pt-8 bg-gradient-to-t from-black/80 to-transparent transition-opacity ${chrome || !playing ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
            <input aria-label={t("player.seek")} type="range" {...seek.inputProps}
              className="hg-range w-full" style={{ ...seek.inputProps.style, "--fill": `${pct}%` } as React.CSSProperties} />
            <div className="flex items-center gap-3 mt-1 text-white">
              <button onClick={toggle} aria-label={playing ? t("player.pause") : t("player.play")} className="pressable">
                {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
              </button>
              <button onClick={() => onToggleMute?.()} aria-label={muted ? t("player.unmute") : t("player.mute")} className="pressable">
                {muted ? <IVolMute size={16} /> : <IVol size={16} />}
              </button>
              <span className="text-[11px] tabular-nums text-white/85">{fmtTime(seek.time)} / {fmtTime(duration)}</span>
              <div className="flex-1" />
              <button onClick={() => setControlsLocked(true)} aria-label={t("feed.lockControls")} title={t("feed.lockControls")} aria-pressed={false} className="pressable">
                <ILockF size={16} />
              </button>
              <button onClick={cycleRate} aria-label={t("player.speed")} className="text-[11px] font-bold text-white/85 pressable tabular-nums">{rate}x</button>
              {platform !== "android" && platform !== "ios" && (
                <button onClick={toggleFull} aria-label={full ? t("feed.exitFs") : t("feed.fullscreen")} className="pressable">
                  {full ? <ICompress size={16} /> : <IExpand size={16} />}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => setControlsLocked(false)} />}
    </div>
  );
}
