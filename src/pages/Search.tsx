import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { RankItem, VideoCard } from "../types";
import { useStore, type MessageKey } from "../store";
import { Masonry, RankPodium, RankRow } from "../components/cards";
import { Empty } from "../components/ui";
import { IBack, IClose, IFireF, IRefresh, ISearch, ITrophy } from "../icons";
import { resumeOf, softFilterWatched, watchedIdSet } from "../lib/watchFilter";

const HOT_TAG_KEYS = [
  "search.tag.urban",
  "search.tag.comeback",
  "search.tag.period",
  "search.tag.system",
  "search.tag.harem",
  "search.tag.campus",
  "search.tag.xianxia",
  "search.tag.workplace",
  "search.tag.maleLead",
  "search.tag.mature",
  "search.tag.mindBender",
  "search.tag.fantasy",
] as const satisfies readonly MessageKey[];

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, clearSearchHist, t, history } = useStore();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const reqId = useRef(0);
  const hotTags = HOT_TAG_KEYS.map((key) => t(key));

  useEffect(() => {
    if (active && !/Android/i.test(navigator.userAgent)) inputRef.current?.focus();
  }, [active]);

  const run = async (keyword: string, p: number) => {
    // New searches always run; only serialize pagination so rapid Enter doesn't get dropped.
    if (p > 1) {
      if (busy.current) return;
      if (p > pages) return;
    }
    const id = ++reqId.current;
    busy.current = true;
    setLoading(true);
    try {
      const res = await api.search(keyword, p, 20);
      if (id !== reqId.current) return;
      setItems((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      setPages(res?.pagination?.pages || 1);
      setErr(null);
    } catch (e) {
      if (id !== reqId.current) return;
      setErr((e as Error).message || t("search.failed"));
    } finally {
      if (id === reqId.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  const submit = (keyword: string) => {
    const k = keyword.trim();
    if (!k) return;
    setSubmitted(k);
    addSearch(k);
    setItems([]);
    setPage(0);
    setPages(1);
    setErr(null);
    run(k, 1);
  };

  useEffect(() => {
    if (!active) return;
    try {
      const pending = sessionStorage.getItem("hghub_pending_search");
      if (pending) {
        sessionStorage.removeItem("hghub_pending_search");
        setQ(pending);
        submit(pending);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when Search becomes active
  }, [active]);

  const querying = submitted.length > 0;

  const openVideo = useCallback((v: VideoCard) => {
    push({
      kind: "feed",
      videoIds: [v.id],
      index: 0,
      title: t("search.title", { q: submitted }),
      scrollMode: "episodes",
      ...resumeOf(history, v.id),
    });
  }, [history, push, submitted, t]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-3 flex items-center gap-2.5" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <form className="flex-1 flex items-center gap-2.5 h-12 rounded-full bg-s3 px-4 focus-within:bg-s4 focus-within:ring-1 focus-within:ring-primary/35 transition-colors"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={18} className="text-mut shrink-0" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.placeholder")}
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {q && <button type="button" onClick={() => {
            reqId.current += 1;
            busy.current = false;
            setQ("");
            setSubmitted("");
            setItems([]);
            setPage(0);
            setPages(1);
            setErr(null);
            setLoading(false);
          }} className="w-5 h-5 rounded-full bg-s4 flex items-center justify-center text-mut pressable"><IClose size={11} /></button>}
        </form>
        <button onClick={() => push({ kind: "ranks" })} aria-label={t("search.ranks")}
          className="w-11 h-11 rounded-full flex items-center justify-center bg-primary text-on-primary pressable shrink-0">
          <ITrophy size={19} />
        </button>
      </div>

      <div className="flex-1 scroll-y px-4 pb-24">
        {!querying ? (
          <>
            {searchHist.length > 0 && (
              <div className="mt-1 a-rise">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-bold text-on">{t("search.history")}</span>
                  <button onClick={clearSearchHist} className="text-[11px] text-dim pressable">{t("search.clear")}</button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2.5">
                  {searchHist.map((h) => (
                    <button key={h} onClick={() => { setQ(h); submit(h); }} className="px-3.5 h-8 rounded-full bg-s3 text-[12px] text-on/80 pressable">{h}</button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5 a-rise">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[14px] font-bold text-on"><IFireF size={15} className="text-primary" />{t("search.hotTopics")}</span>
                <button onClick={() => push({ kind: "ranks" })} className="text-[12px] text-primary font-bold pressable">{t("search.fullRanks")}</button>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {hotTags.map((tag, i) => (
                  <button key={tag} onClick={() => { setQ(tag); submit(tag); }}
                    className={`px-3.5 h-8 rounded-full text-[12px] font-medium pressable ${i < 3 ? "bg-primary/15 text-primary" : "bg-s2 text-on/85"}`}>{tag}</button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between mt-6 mb-2.5">
              <span className="text-[13px] font-bold text-on">{t("search.recommended")}</span>
              <button onClick={() => submit(hotTags[Math.floor(Math.random() * hotTags.length)])}
                className="flex items-center gap-1 text-[11.5px] text-mut pressable"><IRefresh size={13} />{t("search.refresh")}</button>
            </div>
            <p className="text-[11.5px] text-dim leading-relaxed">
              {t("search.hint")}
            </p>
          </>
        ) : (
          <>
            <div className="text-[11.5px] text-mut mt-1 mb-2.5">{t("search.results", { q: submitted, n: items.length })}</div>
            {items.length ? (
              <>
                <Masonry videos={items} wide={wide} onOpen={openVideo} />
                <div className="flex justify-center py-4">
                  {loading ? <div className="w-6 h-6 spinner" />
                    : page < pages ? (
                      <button onClick={() => run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-on/85 pressable">{t("search.loadMore")}</button>
                    ) : <span className="text-[10.5px] text-dim">{t("search.end")}</span>}
                </div>
              </>
            ) : loading ? (
              <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
            ) : (
              <Empty icon={<ISearch size={26} />} title={err || t("search.noResults")} sub={t("search.tryHint")}
                action={t("search.viewHot")} onAction={() => push({ kind: "ranks" })} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

const RANK_TABS = [
  { k: "hot", labelKey: "ranks.hot", descKey: "ranks.hotDesc" },
  { k: "recommend", labelKey: "ranks.recommend", descKey: "ranks.recommendDesc" },
  { k: "potential", labelKey: "ranks.potential", descKey: "ranks.potentialDesc" },
] as const;

export function RankPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast, t, history } = useStore();
  const [tab, setTab] = useState<"hot" | "recommend" | "potential">("hot");
  const [items, setItems] = useState<RankItem[]>([]);
  const [loading, setLoading] = useState(true);
  const tabIndex = RANK_TABS.findIndex((r) => r.k === tab);
  const meta = RANK_TABS[tabIndex]!;
  const historyRef = useRef(history);
  historyRef.current = history;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.rank(tab)
      .then((res) => {
        if (!alive) return;
        let list = res?.items || [];
        // Recommend tab: prefer unwatched; keep a few if everything was watched.
        if (tab === "recommend") {
          list = softFilterWatched(list, watchedIdSet(historyRef.current), (x) => x.video_id, {
            keepIfEmpty: true,
            minKeep: 6,
          });
        }
        setItems(list);
      })
      .catch((e) => { if (alive) { setItems([]); toast((e as Error).message || t("ranks.loadFailed"), "info"); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, toast, t]);

  const onOpen = useCallback((index: number) => {
    const id = items[index]?.video_id;
    if (!id) return;
    push({
      kind: "feed",
      videoIds: [id],
      index: 0,
      title: t("ranks.charts"),
      scrollMode: "episodes",
      ...resumeOf(historyRef.current, id),
    });
  }, [push, items, t]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div
        className="shrink-0 relative overflow-hidden"
        style={{
          paddingTop: "var(--sat, 0px)",
          background: "linear-gradient(180deg, #1a0a10 0%, #121212 72%)",
        }}>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "radial-gradient(80% 90% at 88% -10%, rgba(254,44,85,.38) 0%, transparent 58%)" }}
        />
        <div className="relative px-3 pt-1">
          <div className="flex items-center gap-1">
            <button onClick={onBack} aria-label={t("common.back")}
              className="w-10 h-10 rounded-full flex items-center justify-center text-white/90 hover:bg-white/8 pressable">
              <IBack size={20} />
            </button>
            <div className="flex-1 min-w-0 py-1">
              <div className="text-[20px] font-extrabold tracking-wide text-white leading-tight">{t("ranks.charts")}</div>
              <div className="text-[11px] text-white/45 mt-0.5 truncate">{t("ranks.updateHint", { desc: t(meta.descKey) })}</div>
            </div>
          </div>

          <div className="relative flex mt-2 border-b border-white/8">
            {RANK_TABS.map((r) => {
              const active = tab === r.k;
              return (
                <button key={r.k} onClick={() => setTab(r.k)}
                  className="relative z-1 flex-1 h-11 text-[14px] font-semibold transition-colors duration-200"
                  style={{ color: active ? "#fff" : "rgba(255,255,255,.48)" }}>
                  {t(r.labelKey)}
                </button>
              );
            })}
            <span
              className="a-tab-ink"
              style={{
                width: `${100 / RANK_TABS.length}%`,
                transform: `translateX(${tabIndex * 100}%)`,
              }}>
              <span className="a-tab-ink-bar" />
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 scroll-y px-3 pt-1.5 pb-8">
        {loading ? (
          <div className="flex justify-center py-12"><div className="w-8 h-8 spinner" /></div>
        ) : items.length ? (
          <>
            {items.length >= 3 && (
              <RankPodium items={items} onOpen={onOpen} heatLabel={t("ranks.heat")} />
            )}
            {items.slice(items.length >= 3 ? 3 : 0).map((it, i) => {
              const index = items.length >= 3 ? i + 3 : i;
              return (
                <RankRow
                  key={`${it.video_id}-${it.rank}`}
                  item={it}
                  index={index}
                  onOpen={onOpen}
                  animate={i < 10}
                />
              );
            })}
          </>
        ) : (
          <Empty icon={<ITrophy size={26} />} title={t("ranks.empty")} sub={t("ranks.emptySub")} />
        )}
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}
