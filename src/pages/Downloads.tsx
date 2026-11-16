import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { DownloadJob } from "../types";
import { useStore, type MessageKey } from "../store";
import { Empty, Img, Modal } from "../components/ui";
import { IBack, IDownload } from "../icons";
import { resumeOf } from "../lib/watchFilter";

export default function DownloadsPage({
  onBack, bottomInset = 0,
}: {
  onBack?: () => void;
  wide?: boolean;
  bottomInset?: number;
}) {
  const { push, toast, t, history } = useStore();
  const [items, setItems] = useState<DownloadJob[]>([]);
  const [dir, setDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);
  const [ffmpegCanInstall, setFfmpegCanInstall] = useState(false);
  const [ffmpegAsk, setFfmpegAsk] = useState(false);
  const [ffmpegBusy, setFfmpegBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.downloadList();
      setItems(res?.items || []);
      if (res?.dir) setDir(res.dir);
    } catch (e) {
      toast((e as Error).message || t("downloads.loadFailed"), "info");
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  const refreshFfmpeg = useCallback(async () => {
    try {
      const st = await api.ffmpegStatus();
      setFfmpegOk(!!st?.available);
      setFfmpegCanInstall(!!st?.can_install);
    } catch {
      setFfmpegOk(false);
      setFfmpegCanInstall(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshFfmpeg();
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [refresh, refreshFfmpeg]);

  const installFfmpeg = async () => {
    setFfmpegAsk(false);
    setFfmpegBusy(true);
    toast(t("downloads.ffmpegInstalling"), "info");
    try {
      await api.ffmpegInstall();
      setFfmpegOk(true);
      setFfmpegCanInstall(false);
      toast(t("downloads.ffmpegInstalled"), "ok");
    } catch (e) {
      toast((e as Error).message || t("downloads.ffmpegFailed"), "info");
      void refreshFfmpeg();
    } finally {
      setFfmpegBusy(false);
    }
  };

  const active = useMemo(
    () => items.filter((j) => j.status === "queued" || j.status === "running" || j.status === "error"),
    [items],
  );
  const done = useMemo(() => items.filter((j) => j.status === "done"), [items]);
  const detail = useMemo(
    () => (detailId ? items.find((j) => j.id === detailId) || null : null),
    [detailId, items],
  );

  useEffect(() => {
    if (detailId && !items.some((j) => j.id === detailId)) setDetailId(null);
  }, [detailId, items]);

  const playEp = (job: DownloadJob, ep: number) => {
    push({
      kind: "feed",
      videoIds: [job.video_id],
      index: 0,
      title: job.title,
      scrollMode: "episodes",
      startEp: ep,
      ...resumeOf(history, job.video_id),
    });
  };

  const openJob = (job: DownloadJob) => {
    if (job.mode === "series") {
      setDetailId(job.id);
      return;
    }
    playEp(job, job.ep || 1);
  };

  const remove = async (job: DownloadJob, ep?: number | null) => {
    try {
      const targetEp = ep === undefined
        ? (job.mode === "series" ? null : job.ep)
        : ep;
      await api.downloadDelete(job.video_id, targetEp);
      toast(t("downloads.deleted"), "ok");
      void refresh();
    } catch (e) {
      toast((e as Error).message || t("downloads.deleteFailed"), "info");
    }
  };

  const changePath = async () => {
    try {
      const res = await api.downloadPickDir();
      if (!res?.dir) return;
      setDir(res.dir);
      toast(t("downloads.pathChanged"), "ok");
      void refresh();
    } catch (e) {
      toast((e as Error).message || t("downloads.pathFailed"), "info");
    }
  };

  const openPath = async () => {
    try {
      await api.downloadOpenDir();
    } catch (e) {
      toast((e as Error).message || t("downloads.openFailed"), "info");
    }
  };

  const resetPath = async () => {
    try {
      const res = await api.downloadResetDir();
      setDir(res.dir);
      toast(t("downloads.pathChanged"), "ok");
      void refresh();
    } catch (e) {
      toast((e as Error).message || t("downloads.pathFailed"), "info");
    }
  };

  if (detail) {
    return (
      <SeriesDetail
        job={detail}
        bottomInset={bottomInset}
        t={t}
        onBack={() => setDetailId(null)}
        onPlay={(ep) => playEp(detail, ep)}
        onRemoveEp={(ep) => void remove(detail, ep)}
        onRemoveAll={() => void remove(detail, null)}
      />
    );
  }

  return (
    <div className="absolute inset-0 bg-bg flex flex-col z-20">
      <div className="shrink-0 px-3 pb-2 flex items-center gap-2" style={{ paddingTop: "calc(var(--sat, 0px) + 10px)" }}>
        {onBack ? (
          <button onClick={onBack} aria-label={t("common.back")} className="w-9 h-9 rounded-full flex items-center justify-center text-on pressable">
            <IBack size={18} />
          </button>
        ) : null}
        <div className="flex-1 min-w-0">
          <div className="text-[17px] font-bold text-on leading-tight">{t("downloads.title")}</div>
          <div className="text-[11px] text-mut">{t("downloads.hint")}</div>
        </div>
      </div>

      <div className="shrink-0 mx-3 mb-3 rounded-2xl bg-s2 border border-s3 p-3">
        <div className="text-[11px] font-semibold text-mut">{t("downloads.pathLabel")}</div>
        <div className="mt-1 text-[12px] text-on break-all leading-snug">{dir || "…"}</div>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button onClick={() => void changePath()} className="h-8 px-3 rounded-full bg-primary text-on-primary text-[12px] font-bold pressable">
            {t("downloads.changePath")}
          </button>
          <button onClick={() => void openPath()} className="h-8 px-3 rounded-full bg-s3 text-on text-[12px] font-semibold pressable">
            {t("downloads.openPath")}
          </button>
          <button onClick={() => void resetPath()} className="h-8 px-3 rounded-full bg-s3 text-mut text-[12px] font-semibold pressable">
            {t("downloads.resetPath")}
          </button>
        </div>
      </div>

      {ffmpegOk === false && (
        <div className="shrink-0 mx-3 mb-3 rounded-2xl bg-s2 border border-s3 p-3">
          <div className="text-[12px] text-on leading-snug">{t("downloads.ffmpegMissing")}</div>
          {ffmpegCanInstall && (
            <button
              disabled={ffmpegBusy}
              onClick={() => setFfmpegAsk(true)}
              className="mt-2.5 h-8 px-3 rounded-full bg-primary text-on-primary text-[12px] font-bold pressable disabled:opacity-50"
            >
              {ffmpegBusy ? t("downloads.ffmpegInstalling") : t("downloads.ffmpegInstall")}
            </button>
          )}
        </div>
      )}
      <Modal open={ffmpegAsk} onClose={() => !ffmpegBusy && setFfmpegAsk(false)}>
        <div className="p-4">
          <div className="text-[15px] font-bold text-on">{t("downloads.ffmpegTitle")}</div>
          <div className="mt-2 text-[12px] text-mut leading-relaxed">{t("downloads.ffmpegBody")}</div>
          <div className="mt-4 flex gap-2">
            <button
              disabled={ffmpegBusy}
              onClick={() => setFfmpegAsk(false)}
              className="flex-1 h-9 rounded-full bg-s4 text-on text-[12px] font-semibold pressable"
            >
              {t("common.cancel")}
            </button>
            <button
              disabled={ffmpegBusy}
              onClick={() => void installFfmpeg()}
              className="flex-1 h-9 rounded-full bg-primary text-on-primary text-[12px] font-bold pressable disabled:opacity-50"
            >
              {t("common.confirm")}
            </button>
          </div>
        </div>
      </Modal>

      <div className="flex-1 scroll-y px-3" style={{ paddingBottom: Math.max(24, bottomInset + 16) }}>
        {loading && !items.length && <div className="py-10 text-center text-[13px] text-mut">{t("common.loading")}…</div>}
        {!loading && !items.length && <Empty icon={<IDownload size={26} />} title={t("downloads.empty")} />}

        {!!active.length && (
          <section className="mb-4">
            <div className="text-[13px] font-extrabold text-on mb-2">{t("downloads.queueActive")}</div>
            <div className="flex flex-col gap-2.5">
              {active.map((job) => (
                <JobRow key={job.id} job={job} t={t} onOpen={openJob} onRemove={(j) => void remove(j)} />
              ))}
            </div>
          </section>
        )}

        {!!done.length && (
          <section>
            <div className="text-[13px] font-extrabold text-on mb-2">{t("downloads.queueDone")}</div>
            <div className="flex flex-col gap-2.5">
              {done.map((job) => (
                <JobRow key={job.id} job={job} t={t} onOpen={openJob} onRemove={(j) => void remove(j)} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function fmtBytes(n?: number) {
  const v = Number(n) || 0;
  if (v <= 0) return "";
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)} GB`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} MB`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)} KB`;
  return `${v} B`;
}

function JobRow({
  job, t, onOpen, onRemove,
}: {
  job: DownloadJob;
  t: (k: MessageKey, p?: Record<string, string | number>) => string;
  onOpen: (job: DownloadJob) => void;
  onRemove: (job: DownloadJob) => void | Promise<void>;
}) {
  const ready = job.status === "done";
  const size = fmtBytes(job.file_size);
  const readyCount = job.mode === "series"
    ? (job.ready_eps?.length ?? 0)
    : (ready ? 1 : 0);
  return (
    <div className="rounded-2xl bg-s2 border border-s3 p-3 flex gap-3">
      <button
        className="relative w-[72px] shrink-0 rounded-xl overflow-hidden bg-s3 pressable"
        style={{ paddingTop: "96px" }}
        onClick={() => onOpen(job)}
      >
        <Img src={job.cover} />
        {ready && (
          <span className="absolute left-1 top-1 px-1 py-0.5 rounded text-[8px] font-bold text-white bg-primary">
            {t("downloads.offlineReady")}
          </span>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-bold text-on clamp-2 leading-snug">{job.title}</div>
        <div className="text-[11px] text-mut mt-1">
          {job.mode === "series"
            ? (ready
              ? t("downloads.seriesReadyMeta", { ready: readyCount, n: job.total_eps })
              : t("downloads.seriesMeta", { n: job.total_eps }))
            : t("downloads.epMeta", { ep: job.ep })}
          {" · "}
          {statusLabel(job, t)}
          {size ? ` · ${size}` : ""}
        </div>
        {(job.status === "running" || job.status === "queued") && (
          <div className="mt-2 h-1.5 rounded-full bg-s4 overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${Math.max(2, Math.round((job.progress || 0) * 100))}%` }} />
          </div>
        )}
        {!!job.message && (
          <div className={`text-[11px] mt-1 clamp-2 ${job.status === "error" ? "text-danger" : "text-mut"}`}>{job.message}</div>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {ready && (
            <>
              <button
                onClick={() => onOpen(job)}
                className="h-7 px-2.5 rounded-full bg-primary text-on-primary text-[11px] font-bold pressable"
              >
                {job.mode === "series" ? t("downloads.pickEpisode") : t("downloads.playOffline")}
              </button>
              {job.mode !== "series" && (
                <button
                  onClick={() => {
                    void api.downloadOpenFile(job.video_id, job.ep || 1).catch(() => {});
                  }}
                  className="h-7 px-2.5 rounded-full bg-s3 text-on text-[11px] font-semibold pressable"
                >
                  {t("downloads.openFile")}
                </button>
              )}
            </>
          )}
          {job.mode === "series" && (job.status === "running" || job.status === "queued" || job.status === "error") && (
            <button
              onClick={() => onOpen(job)}
              className="h-7 px-2.5 rounded-full bg-s3 text-on text-[11px] font-semibold pressable"
            >
              {t("downloads.viewEpisodes")}
            </button>
          )}
          <button
            onClick={() => void onRemove(job)}
            className="h-7 px-2.5 rounded-full bg-s3 text-danger text-[11px] font-semibold pressable"
          >
            {t("common.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

function SeriesDetail({
  job, bottomInset, t, onBack, onPlay, onRemoveEp, onRemoveAll,
}: {
  job: DownloadJob;
  bottomInset: number;
  t: (k: MessageKey, p?: Record<string, string | number>) => string;
  onBack: () => void;
  onPlay: (ep: number) => void;
  onRemoveEp: (ep: number) => void;
  onRemoveAll: () => void;
}) {
  const ready = new Set(job.ready_eps || []);
  const total = Math.max(1, job.total_eps || 1);
  const eps = Array.from({ length: total }, (_, i) => i + 1);
  const size = fmtBytes(job.file_size);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col z-20">
      <div className="shrink-0 px-3 pb-2 flex items-center gap-2" style={{ paddingTop: "calc(var(--sat, 0px) + 10px)" }}>
        <button onClick={onBack} aria-label={t("common.back")} className="w-9 h-9 rounded-full flex items-center justify-center text-on pressable">
          <IBack size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[17px] font-bold text-on leading-tight clamp-1">{job.title}</div>
          <div className="text-[11px] text-mut">
            {t("downloads.seriesReadyMeta", { ready: ready.size, n: total })}
            {size ? ` · ${size}` : ""}
          </div>
        </div>
        <button
          onClick={onRemoveAll}
          className="h-8 px-3 rounded-full bg-s3 text-danger text-[11px] font-semibold pressable"
        >
          {t("downloads.deleteAll")}
        </button>
      </div>

      <div className="shrink-0 mx-3 mb-3 rounded-2xl bg-s2 border border-s3 p-3 flex gap-3">
        <div className="relative w-[56px] shrink-0 rounded-xl overflow-hidden bg-s3" style={{ paddingTop: "74px" }}>
          <Img src={job.cover} />
        </div>
        <div className="flex-1 min-w-0 self-center">
          <div className="text-[12px] text-mut leading-snug">{t("downloads.pickEpisodeHint")}</div>
          {(job.status === "running" || job.status === "queued") && (
            <div className="mt-2 h-1.5 rounded-full bg-s4 overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${Math.max(2, Math.round((job.progress || 0) * 100))}%` }} />
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 scroll-y px-3" style={{ paddingBottom: Math.max(24, bottomInset + 16) }}>
        <div className="grid grid-cols-1 gap-2">
          {eps.map((ep) => {
            const isReady = ready.has(ep);
            const isCurrent = (job.status === "running" || job.status === "queued") && job.ep === ep;
            return (
              <div key={ep} className="rounded-2xl bg-s2 border border-s3 px-3 py-2.5 flex items-center gap-3">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 ${
                  isReady ? "bg-primary text-on-primary" : isCurrent ? "bg-primary/20 text-primary" : "bg-s3 text-mut"
                }`}>
                  {ep}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-on">{t("downloads.epMeta", { ep })}</div>
                  <div className={`text-[11px] mt-0.5 ${isReady ? "text-mut" : isCurrent ? "text-primary" : "text-dim"}`}>
                    {isReady
                      ? t("downloads.offlineReady")
                      : isCurrent
                        ? statusLabel(job, t)
                        : t("downloads.epNotReady")}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 justify-end">
                  {isReady && (
                    <>
                      <button
                        onClick={() => onPlay(ep)}
                        className="h-7 px-2.5 rounded-full bg-primary text-on-primary text-[11px] font-bold pressable"
                      >
                        {t("downloads.playOffline")}
                      </button>
                      <button
                        onClick={() => { void api.downloadOpenFile(job.video_id, ep).catch(() => {}); }}
                        className="h-7 px-2.5 rounded-full bg-s3 text-on text-[11px] font-semibold pressable"
                      >
                        {t("downloads.openFile")}
                      </button>
                      <button
                        onClick={() => onRemoveEp(ep)}
                        className="h-7 px-2.5 rounded-full bg-s3 text-danger text-[11px] font-semibold pressable"
                      >
                        {t("common.delete")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function statusLabel(job: DownloadJob, t: (k: MessageKey, p?: Record<string, string | number>) => string) {
  if (job.status === "done") return t("downloads.done");
  if (job.status === "running") return t("downloads.running", { p: Math.round((job.progress || 0) * 100) });
  if (job.status === "queued") return t("downloads.queued");
  if (job.status === "error") return t("downloads.error");
  return job.status;
}
