import { useEffect, useState } from "react";
import { api, hostOf, isMobile, type LineItem, type LineProbe, type LineState } from "../api";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { ICheck, IClose, IRefresh, ISettings } from "../icons";

type ProbeMap = Record<string, LineProbe>;

function Row({ item, current, probe, busy, disabled, onPick, onProbe }: {
  item: LineItem; current: boolean; probe?: LineProbe; busy: boolean; disabled: boolean;
  onPick: (url: string) => void; onProbe: (url: string) => void;
}) {
  const { t } = useStore();
  return (
    <div className={`flex items-center gap-2 px-3.5 py-2.5 ${current ? "bg-s3/70" : ""}`}>
      <button onClick={() => onPick(item.url)} disabled={disabled} className="flex-1 min-w-0 text-left pressable disabled:opacity-60">
        <div className="flex items-center gap-1.5 text-[12.5px] text-on">
          <span className="truncate">{item.name || item.host || hostOf(item.url)}</span>
          {current && <ICheck size={13} className="text-mint shrink-0" />}
        </div>
        <div className="text-[10.5px] text-mut truncate mt-0.5">{item.url}</div>
      </button>
      <span
        title={probe ? (probe.error || (probe.status ? `HTTP ${probe.status}` : "")) : ""}
        className={`text-[10.5px] tabular-nums shrink-0 ${probe ? (probe.ok ? "text-mint" : "text-danger") : "text-dim"}`}>
        {busy ? "…" : probe ? (probe.ok ? `${probe.ms}ms` : probe.status ? `HTTP ${probe.status}` : t("line.failed")) : "—"}
      </span>
      <button onClick={() => onProbe(item.url)} disabled={busy || disabled}
        className="shrink-0 h-7 px-2.5 rounded-(--r-sm) bg-s4 text-[11px] text-on/80 pressable disabled:opacity-50">{t("line.probe")}</button>
    </div>
  );
}

export default function LinePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, setUser, t } = useStore();
  const [state, setState] = useState<LineState | null>(null);
  const [mirrors, setMirrors] = useState<LineItem[] | null>(null);
  const [mirrorErr, setMirrorErr] = useState("");
  const [loadingMirrors, setLoadingMirrors] = useState(false);
  const [probes, setProbes] = useState<ProbeMap>({});
  const [probing, setProbing] = useState("");
  const [switching, setSwitching] = useState("");

  const readState = () => {
    api.lineState().then(setState).catch((e) => toast((e as Error).message || t("line.loadFailed"), "info"));
  };

  const readMirrors = async () => {
    setLoadingMirrors(true);
    setMirrorErr("");
    try {
      const res = await api.lineMirrors();
      setMirrors(res?.items || []);
    } catch (e) {
      setMirrors([]);
      setMirrorErr((e as Error).message || t("line.mirrorsFailed"));
    } finally {
      setLoadingMirrors(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    readState();
    if (mirrors === null) void readMirrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const probe = async (list: LineItem[], key: string) => {
    if (!list.length) return;
    setProbing(key);
    try {
      const res = await api.lineProbe(list.map((x) => x.url));
      setProbes((p) => {
        const next = { ...p };
        for (const r of res) next[r.url] = r;
        return next;
      });
    } catch (e) {
      toast((e as Error).message || t("line.probeFailed"), "info");
    } finally {
      setProbing("");
    }
  };

  const pick = async (url: string) => {
    if (switching || state?.base === url) return;
    setSwitching(url);
    try {
      const next = await api.lineSet(url);
      if (next !== state?.base) setUser(null);
      setState((s) => (s ? { ...s, base: next } : s));
      toast(t("line.switched", { host: hostOf(next) }), "ok");
    } catch (e) {
      toast((e as Error).message || t("line.switchFailed"), "info");
    } finally {
      setSwitching("");
    }
  };

  const fixed = state?.fixed || [];
  const busyAll = !!probing || !!switching;

  const body = (
    <div className="flex flex-col min-h-0" style={{ maxHeight: isMobile ? "74vh" : "min(72vh, 620px)" }}>
      <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ISettings size={16} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-bold text-on leading-tight">{t("line.title")}</div>
          <div className="text-[10.5px] text-mut mt-0.5 truncate">{t("line.current", { host: state ? hostOf(state.base) : t("common.loading") })}</div>
        </div>
        <button onClick={onClose} aria-label={t("common.close")} className="w-8 h-8 rounded-full bg-s3/80 flex items-center justify-center text-mut pressable"><IClose size={16} /></button>
      </div>

      <div className="flex-1 scroll-y px-3 pb-4">
        <div className="flex items-center gap-2 px-1 mt-1 mb-1.5">
          <span className="text-[10.5px] font-semibold text-dim tracking-wide">{t("line.fixed")}</span>
          <span className="text-[10px] text-dim">{t("line.fixedHint")}</span>
          <button onClick={() => probe(fixed, "fixed")} disabled={busyAll || !fixed.length}
            className="ml-auto text-[10.5px] text-primary pressable disabled:opacity-50">
            {probing === "fixed" ? t("line.probing") : t("line.probeAll")}
          </button>
        </div>
        <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {fixed.map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
          {!fixed.length && <div className="px-3.5 py-3 text-[11px] text-mut">{t("common.loading")}…</div>}
        </div>

        <div className="flex items-center gap-2 px-1 mt-4 mb-1.5">
          <span className="text-[10.5px] font-semibold text-dim tracking-wide">{t("line.mirrors")}</span>
          <span className="text-[10px] text-dim">{t("line.mirrorsHint")}</span>
          <button onClick={() => { void readMirrors(); }} disabled={loadingMirrors}
            className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-primary pressable disabled:opacity-50">
            <IRefresh size={12} />{loadingMirrors ? t("line.fetching") : t("line.refresh")}
          </button>
        </div>
        <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {loadingMirrors && <div className="flex justify-center py-6"><div className="w-6 h-6 spinner" /></div>}
          {!loadingMirrors && mirrorErr && (
            <div className="px-3.5 py-3">
              <div className="text-[11.5px] text-danger">{t("line.mirrorsFailed")}</div>
              <div className="text-[10.5px] text-mut mt-1 break-all">{mirrorErr}</div>
            </div>
          )}
          {!loadingMirrors && !mirrorErr && mirrors?.length === 0 && (
            <div className="px-3.5 py-3 text-[11px] text-mut">{t("line.mirrorsEmpty")}</div>
          )}
          {!loadingMirrors && (mirrors || []).map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
        </div>
        {!loadingMirrors && !!mirrors?.length && (
          <div className="flex justify-end px-1 mt-2">
            <button onClick={() => probe(mirrors, "mirrors")} disabled={busyAll}
              className="text-[10.5px] text-primary pressable disabled:opacity-50">
              {probing === "mirrors" ? t("line.probing") : t("line.probeAllN", { n: mirrors.length })}
            </button>
          </div>
        )}

        <div className="text-[10px] text-dim leading-relaxed px-1 mt-4">
          {t("line.hint")}
        </div>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={onClose}>{body}</Sheet>
    : <Modal open={open} onClose={onClose} width={460}>{body}</Modal>;
}
