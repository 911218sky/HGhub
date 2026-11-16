import { useEffect, useState } from "react";
import { api, APP_VERSION, fmt, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Img } from "../components/ui";
import { IChevR, IClock, IDownload, ILogout, ISettings, IStar, IUser } from "../icons";

export default function Profile({ wide }: { wide: boolean }) {
  const { user, setLoginOpen, logout, history, favs, clearHistory, push, setTab: setNavTab, t } = useStore();
  const [tab, setTab] = useState<"fav" | "history">("fav");
  const [cards, setCards] = useState<Detail[]>([]);
  const [loading, setLoading] = useState(false);

  const ids = tab === "fav" ? favs : history.map((h) => h.id);
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);
  const platformLabel = platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows";

  useEffect(() => {
    let alive = true;
    if (!ids.length) { setCards([]); return; }
    setLoading(true);
    Promise.allSettled(ids.slice(0, 12).map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        setCards(rs.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<Detail>).value));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ids.join(",")]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-1 flex items-center" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="text-[20px] font-bold text-on leading-none">{t("profile.title")}</div>
        {isMobile && (
          <button onClick={() => push({ kind: "settings" })} aria-label={t("profile.settings")}
            className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-mut pressable">
            <ISettings size={18} strokeWidth={1.7} />
          </button>
        )}
      </div>

      <div className="flex-1 scroll-y px-3 pt-3 pb-24">
        {user ? (
          <div className="relative flex flex-col items-center text-center a-rise pt-2 pb-1">
            <Avatar size={88} name={user.nickname} hue={350} ring />
            <div className="mt-3 text-[20px] font-bold text-on leading-tight max-w-full px-6 truncate">{user.nickname}</div>
            <div className="text-[12px] text-dim mt-1">@{user.username} · ID {user.id}</div>
            <div className="flex items-start justify-center gap-10 mt-4 w-full">
              <div className="flex flex-col items-center min-w-[56px]">
                <span className="text-[18px] font-bold text-on leading-none tabular-nums">{fmt(user.counts?.like)}</span>
                <span className="text-[11px] text-mut mt-1.5">{t("profile.likes")}</span>
              </div>
              <div className="flex flex-col items-center min-w-[56px]">
                <span className="text-[18px] font-bold text-on leading-none tabular-nums">{fmt(user.counts?.collect)}</span>
                <span className="text-[11px] text-mut mt-1.5">{t("profile.favorites")}</span>
              </div>
              <div className="flex flex-col items-center min-w-[56px]">
                <span className="text-[18px] font-bold text-on leading-none tabular-nums">{fmt(user.counts?.following)}</span>
                <span className="text-[11px] text-mut mt-1.5">{t("profile.following")}</span>
              </div>
            </div>
            <button onClick={async () => { await logout(); }}
              className="absolute top-2 right-1 w-9 h-9 rounded-full flex items-center justify-center text-mut pressable" aria-label={t("profile.logout")}>
              <ILogout size={17} />
            </button>
          </div>
        ) : (
          <button onClick={() => setLoginOpen(true)}
            className="w-full flex flex-col items-center text-center pressable a-rise pt-2 pb-1">
            <Avatar size={88} icon={<IUser size={36} />} hue={350} ring />
            <div className="mt-3 text-[20px] font-bold text-on leading-tight">{t("profile.guest")}</div>
            <div className="text-[12px] text-dim mt-1">{t("profile.guestHint")}</div>
            <div className="flex items-start justify-center gap-10 mt-4 w-full">
              <div className="flex flex-col items-center min-w-[56px]">
                <span className="text-[18px] font-bold text-on leading-none tabular-nums">{favs.length}</span>
                <span className="text-[11px] text-mut mt-1.5">{t("profile.favorites")}</span>
              </div>
              <div className="flex flex-col items-center min-w-[56px]">
                <span className="text-[18px] font-bold text-on leading-none tabular-nums">{history.length}</span>
                <span className="text-[11px] text-mut mt-1.5">{t("profile.tabHistory")}</span>
              </div>
            </div>
            <span className="mt-4 inline-flex items-center gap-0.5 h-9 pl-5 pr-3.5 rounded-full bg-primary text-on-primary text-[13px] font-bold">
              {t("profile.login")}<IChevR size={14} />
            </span>
          </button>
        )}

        <button
          onClick={() => setNavTab("downloads")}
          className="mt-4 w-full flex items-center gap-3 rounded-2xl p-3.5 text-left pressable border border-s3 bg-s2"
        >
          <span className="w-10 h-10 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <IDownload size={18} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[15px] font-bold text-on">{t("downloads.title")}</span>
            <span className="block text-[11px] text-mut mt-0.5">{t("downloads.hint")}</span>
          </span>
          <IChevR size={16} className="text-mut" />
        </button>

        <div className="flex items-stretch mt-5 border-b border-s3">
          {([["fav", "profile.tabFav"], ["history", "profile.tabHistory"]] as const).map(([k, key]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`relative flex-1 h-10 text-[14px] pressable ${tab === k ? "text-on font-bold" : "text-mut font-medium"}`}>
              {t(key)}
              {tab === k && (
                <span className="absolute left-1/2 -translate-x-1/2 bottom-0 w-8 h-[2.5px] rounded-full bg-primary" />
              )}
            </button>
          ))}
        </div>

        <div className="mt-2.5">
          {loading ? (
            <div className="flex justify-center py-8"><div className="w-7 h-7 spinner" /></div>
          ) : cards.length ? (
            <div className="grid grid-cols-3 gap-[3px]">
              {cards.map((c) => {
                const p = progressOf(c.id);
                return (
                <button key={c.id} onClick={() => push({
                  kind: "feed", videoIds: [c.id], index: 0,
                  title: tab === "fav" ? t("profile.tabFav") : t("profile.tabHistory"),
                  scrollMode: "episodes",
                  startEp: p?.ep, startTime: p?.t,
                })}
                  className="relative overflow-hidden bg-s1 pressable" style={{ paddingTop: "133%" }}>
                  <Img src={c.cover} />
                  {!!p && (
                    <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-sm bg-black/70 text-[9.5px] text-white/95 leading-none">
                      {t("profile.ep", { n: p.ep })}{p.t > 3 ? ` · ${fmtTime(p.t)}` : ""}
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent pt-8 pb-1.5 px-1.5">
                    <div className="text-[10.5px] text-white clamp-2 leading-tight">{c.title}</div>
                  </div>
                </button>
                );
              })}
            </div>
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? t("profile.emptyFav") : t("profile.emptyHistory")}
              sub={tab === "fav" ? t("profile.emptyFavSub") : t("profile.emptyHistorySub")}
              action={t("profile.browse")} onAction={() => push({ kind: "ranks" })} />
          )}
          {cards.length > 0 && tab === "history" && (
            <button onClick={clearHistory} className="mt-3 w-full h-9 rounded-full text-[12px] text-mut pressable border border-s3">{t("profile.clearHistory")}</button>
          )}
        </div>

        <div className="text-center text-[10px] text-dim mt-5">{t("profile.client", { v: APP_VERSION, platform: platformLabel })}</div>
      </div>
    </div>
  );
}
