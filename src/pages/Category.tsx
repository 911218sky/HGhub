import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { Post, VideoCard } from "../types";
import { useStore, type MessageKey } from "../store";
import { Masonry, RowCard } from "../components/cards";
import { Empty, Img } from "../components/ui";
import { IBack, IChevR, IGrid, ITrophy } from "../icons";
import { resumeOf, softFilterWatched, watchedIdSet } from "../lib/watchFilter";

export const CHANNELS = [
  { cate: "ai-duanju" },
  { cate: "ai-manju" },
  { cate: "ai-huanlian" },
  { cate: "ai-mogai" },
] as const;

type ChannelCate = (typeof CHANNELS)[number]["cate"];

function channelNameKey(cate: string): MessageKey {
  return `channel.${cate}.name` as MessageKey;
}
function channelDescKey(cate: string): MessageKey {
  return `channel.${cate}.desc` as MessageKey;
}

export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  const { push, t, history } = useStore();
  const [rows, setRows] = useState<Record<string, VideoCard[]>>({});
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(false);
  const started = useRef(false);
  const pending = useRef(new Set<string>());
  const watched = useMemo(() => watchedIdSet(history), [history]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadPreview = useCallback(async (key: string) => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setLoading(m => ({ ...m, [key]: true }));
    setErrors(m => ({ ...m, [key]: "" }));
    try {
      if (key === "posts") {
        const result = await api.posts(1, 8);
        if (mounted.current) setPosts(result?.items || []);
      } else {
        const result = await api.category(key, 1, 8);
        if (mounted.current) setRows(m => ({ ...m, [key]: result?.items || [] }));
      }
    } catch (error) {
      if (mounted.current) setErrors(m => ({ ...m, [key]: (error as Error).message || t("category.loadFailed") }));
    } finally {
      pending.current.delete(key);
      if (mounted.current) setLoading(m => ({ ...m, [key]: false }));
    }
  }, [t]);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    CHANNELS.forEach(c => { void loadPreview(c.cate); });
    void loadPreview("posts");
  }, [active, loadPreview]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-2" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <div className="flex items-end gap-2.5">
          <span className="text-[26px] font-extrabold text-on leading-none tracking-tight">{t("category.title")}</span>
          <span className="text-[11px] text-mut pb-0.5">{t("category.channels", { n: CHANNELS.length + 1 })}</span>
        </div>
      </div>

      <div className="flex-1 scroll-y pb-24 pt-1">
        <button onClick={() => push({ kind: "ranks" })}
          className="mx-4 mb-4 w-[calc(100%-2rem)] flex items-center gap-3 rounded-2xl p-3.5 text-left pressable group"
          style={{ background: "linear-gradient(135deg, rgba(254,44,85,.18), rgba(254,44,85,.04))" }}>
          <span className="w-10 h-10 rounded-full bg-primary text-on-primary flex items-center justify-center shrink-0"><ITrophy size={18} /></span>
          <span className="flex-1">
            <span className="block text-[15px] font-bold text-on">{t("category.ranksTitle")}</span>
            <span className="block text-[11px] text-mut mt-0.5">{t("category.ranksDesc")}</span>
          </span>
          <IChevR size={16} className="text-primary group-hover:translate-x-0.5 transition-transform" />
        </button>

        {CHANNELS.map((c, ci) => {
          const list = softFilterWatched(rows[c.cate] || [], watched, (v) => v.id, { keepIfEmpty: true, minKeep: 3 });
          const name = t(channelNameKey(c.cate));
          const desc = t(channelDescKey(c.cate));
          return (
            <section key={c.cate} aria-label={name} className="mb-5 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
              <button onClick={() => push({ kind: "channel", cate: c.cate, name })}
                className="w-full flex items-center gap-2.5 px-4 mb-2.5 text-left pressable group">
                <span className="w-1 h-5 rounded-full bg-primary shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block text-[17px] font-extrabold text-on leading-tight">{name}</span>
                  <span className="block text-[11px] text-mut mt-0.5 truncate">{desc}</span>
                </span>
                <span className="flex items-center gap-0.5 text-[12px] font-semibold text-primary/75 group-hover:text-primary transition-colors">
                  {t("category.all")}<IChevR size={14} />
                </span>
              </button>
              <div className="scroll-x flex gap-2.5 px-4 snap-x">
                {list.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({
                    kind: "feed", videoIds: [v.id], index: 0, title: name, scrollMode: "episodes",
                    ...resumeOf(history, v.id),
                  })} />
                ))}
                {!list.length && <PreviewStatus name={name} loading={loading[c.cate] !== false} error={errors[c.cate]} onRetry={() => void loadPreview(c.cate)} />}
              </div>
            </section>
          );
        })}

        <section aria-label={t("category.community")} className="mb-5 a-rise">
          <button onClick={() => push({ kind: "posts" })}
            className="w-full flex items-center gap-2.5 px-4 mb-2.5 text-left pressable group">
            <span className="w-1 h-5 rounded-full bg-primary shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-[17px] font-extrabold text-on leading-tight">{t("category.community")}</span>
              <span className="block text-[11px] text-mut mt-0.5 truncate">{t("category.communityDesc")}</span>
            </span>
            <span className="flex items-center gap-0.5 text-[12px] font-semibold text-primary/75 group-hover:text-primary transition-colors">
              {t("category.all")}<IChevR size={14} />
            </span>
          </button>
          <div className="scroll-x flex gap-2.5 px-4 snap-x">
            {posts.map((post) => (
              <button key={post.id} onClick={() => push({ kind: "post", id: post.id })}
                className="w-[108px] shrink-0 text-left snap-start pressable">
                <div className="relative w-full rounded-xl overflow-hidden bg-s2" style={{ paddingTop: "133%" }}>
                  <Img src={post.cover} />
                  <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
                  <span className="absolute bottom-1.5 right-1.5 text-[9px] font-semibold text-white/90 tsh">{fmt(post.hot)}</span>
                </div>
                <div className="mt-1.5 text-[12px] font-medium text-on clamp-1 leading-tight">{post.title}</div>
              </button>
            ))}
            {!posts.length && <PreviewStatus name={t("category.community")} loading={loading.posts !== false} error={errors.posts} onRetry={() => void loadPreview("posts")} />}
          </div>
        </section>

        <div className="px-4 text-center text-[10.5px] text-dim pt-1">{t("category.end")}</div>
      </div>
      {wide && <div />}
    </div>
  );
}

function PreviewStatus({ name, loading, error, onRetry }: { name: string; loading: boolean; error?: string; onRetry: () => void }) {
  const { t } = useStore();
  return <div className="h-[150px] flex flex-col justify-center items-start gap-2 text-[11.5px] text-dim px-1">
    <span>{loading ? `${t("common.loading")}…` : error || t("category.empty")}</span>
    {!loading && error && <button aria-label={`${t("common.retry")} ${name}`} onClick={onRetry} className="text-primary pressable">{t("common.retry")}</button>}
  </div>;
}

const SORTS = [
  { id: "latest", key: "category.sortLatest" },
  { id: "hot", key: "category.sortHot" },
  { id: "score", key: "category.sortScore" },
] as const;

export function ChannelPage({ cate, name, onBack, wide }: { cate: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, t, history } = useStore();
  const [sort, setSort] = useState<(typeof SORTS)[number]["id"]>("latest");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const displayName = name || t(channelNameKey(cate as ChannelCate));

  const loadMore = async () => {
    if (busy.current || page >= pages) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await api.category(cate, next, 20);
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message || t("category.loadFailed"));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages]);

  const sorted = useMemo(() => [...items].sort((a, b) => {
    if (sort === "hot") return (b.hot || 0) - (a.hot || 0);
    if (sort === "score") return (b.score || 0) - (a.score || 0);
    return b.id - a.id;
  }), [items, sort]);

  const openVideo = useCallback((v: VideoCard) => {
    push({
      kind: "feed",
      videoIds: [v.id],
      index: 0,
      title: displayName,
      scrollMode: "episodes",
      ...resumeOf(history, v.id),
    });
  }, [displayName, history, push]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <button onClick={onBack} aria-label={t("common.back")} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <span className="w-[40px] h-[40px] rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><IGrid size={21} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-bold text-on leading-tight">{displayName}</div>
            <div className="text-[10.5px] text-mut">{t("category.titles", { n: items.length, page, pages: Math.max(pages, 1) })}</div>
          </div>
        </div>
        <div className="px-4 pb-2 flex gap-1 border-b border-s3">
          {SORTS.map((s) => (
            <button key={s.id} onClick={() => setSort(s.id)}
              className="relative px-4 h-9 text-[13px] font-semibold pressable"
              style={{ color: sort === s.id ? "var(--p-on)" : "var(--p-mut)" }}>
              {t(s.key)}
              {sort === s.id && <span className="absolute left-1/2 -translate-x-1/2 bottom-0 w-6 h-[2.5px] rounded-full bg-primary" />}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {sorted.length ? (
          <Masonry videos={sorted} wide={wide} onOpen={openVideo} />
        ) : err ? (
          <Empty icon={<IGrid size={26} />} title={t("category.loadFailed")} sub={err} action={t("common.retry")} onAction={loadMore} />
        ) : (
          <div className="flex justify-center py-10"><div className="w-8 h-8 spinner" /></div>
        )}
        <div ref={sentinel} className="h-10" />
        {loading && <div className="flex justify-center py-3"><div className="w-6 h-6 spinner" /></div>}
        {!loading && page >= pages && sorted.length > 0 && (
          <div className="text-center text-[10.5px] text-dim py-3">{t("category.listEnd")}</div>
        )}
      </div>
    </div>
  );
}
