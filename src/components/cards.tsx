import { memo, type CSSProperties } from "react";
import { fmt } from "../api";
import type { RankItem, VideoCard } from "../types";
import { IFireF, IHeartF, IPlayF } from "../icons";
import { Img } from "./ui";

const RANK_MEDAL = ["#FFD24A", "#C5CED8", "#E8A87C"] as const;

export function WaterfallCard({ v, onOpen }: { v: VideoCard; onOpen: () => void }) {
  const ratio = 1.32;
  const isNew = v.is_new || v.badge === "新上架";
  return (
    <button onClick={onOpen}
      className="relative w-full overflow-hidden text-left bg-s2 pressable block rounded-xl"
      style={{ paddingTop: `${ratio * 100}%` }}>
      <Img src={v.cover} />
      <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/92 via-black/45 to-transparent" />
      {isNew ? (
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold text-white bg-primary shadow-[0_2px_8px_var(--p-glow)]">
          新上架
        </span>
      ) : (
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold brand-grad">
          {v.is_finished ? "Completed" : `Updated to Ep ${v.episode_count}`}
        </span>
      )}
      <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-black/45 backdrop-blur-sm text-[9px] font-semibold text-white/90">
        <IPlayF size={9} />{fmt(v.hot)}
      </span>
      <div className="absolute inset-x-0 bottom-0 p-2">
        <div className="text-[12px] font-medium text-white leading-snug clamp-2 tsh">{v.title}</div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-white/65 truncate max-w-[60%]">{v.author?.name || "HGhub"}</span>
          <span className="flex items-center gap-0.5 text-[10px] text-white/75"><IHeartF size={10} className="text-primary" />{fmt(v.like_count)}</span>
        </div>
      </div>
    </button>
  );
}

export function Masonry({ videos, onOpen, wide = false, gap = "gap-1.5" }: {
  videos: VideoCard[]; onOpen: (v: VideoCard) => void; wide?: boolean; gap?: string;
}) {
  const mb = gap === "gap-1" ? "mb-1" : "mb-1.5";
  return (
    <div className={`${wide ? "columns-3 xl:columns-4" : "columns-2"} ${gap} [column-fill:balance]`}>
      {videos.map((v) => (
        <div key={v.id} className={`break-inside-avoid ${mb}`}>
          <WaterfallCard v={v} onOpen={() => onOpen(v)} />
        </div>
      ))}
    </div>
  );
}

export function RowCard({ v, onOpen }: { v: VideoCard; onOpen: () => void }) {
  const isNew = v.is_new || v.badge === "新上架";
  return (
    <button onClick={onOpen} className="w-[108px] shrink-0 text-left snap-start pressable group">
      <div className="relative w-full rounded-xl overflow-hidden bg-s2" style={{ paddingTop: "133%" }}>
        <Img src={v.cover} />
        <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
        {isNew ? (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[8.5px] font-bold text-white bg-primary shadow-[0_2px_8px_var(--p-glow)]">
            新上架
          </span>
        ) : (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[8.5px] font-bold brand-grad">
            {v.is_finished ? "Done" : `${v.episode_count} eps`}
          </span>
        )}
        {v.score > 0 && (
          <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md text-[8.5px] font-bold text-white/95 bg-black/55 tsh">
            {v.score.toFixed(1)}
          </span>
        )}
        <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 text-[9px] font-semibold text-white/90 tsh"><IPlayF size={9} />{fmt(v.hot)}</span>
      </div>
      <div className="mt-1.5 text-[12px] font-medium text-on clamp-1 leading-tight">{v.title}</div>
      <div className="text-[10px] text-mut clamp-1 mt-0.5">{v.tags?.slice(0, 2).join(" · ")}</div>
    </button>
  );
}

export function RankPodium({ items, onOpen, heatLabel }: {
  items: RankItem[];
  onOpen: (index: number) => void;
  heatLabel: string;
}) {
  if (items.length < 3) return null;
  const slots = [
    { item: items[1], place: 2, delay: "40ms" },
    { item: items[0], place: 1, delay: "0ms" },
    { item: items[2], place: 3, delay: "80ms" },
  ];
  return (
    <div className="flex items-end gap-2 px-1 pt-3 pb-2">
      {slots.map(({ item, place, delay }) => {
        const first = place === 1;
        const medal = RANK_MEDAL[place - 1];
        const listIndex = items.findIndex((x) => x.video_id === item.video_id);
        return (
          <button
            key={item.video_id}
            onClick={() => onOpen(listIndex)}
            className={`a-podium flex-1 min-w-0 text-left pressable ${first ? "pb-1" : "pb-0"}`}
            style={{ animationDelay: delay }}>
            <div
              className={`relative overflow-hidden bg-s2 ${first ? "rounded-xl ring-2 ring-[#FFD24A]/90" : "rounded-lg"}`}
              style={{ paddingTop: first ? "132%" : "118%" }}>
              <Img src={item.cover} />
              <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/92 via-black/45 to-transparent" />
              <span
                className="absolute top-1.5 left-1.5 min-w-[22px] h-[22px] px-1 rounded-md flex items-center justify-center text-[13px] font-black leading-none"
                style={{ color: "#111", background: medal }}>
                {place}
              </span>
              <span className="absolute bottom-1.5 inset-x-1.5 flex items-center justify-between gap-1">
                <span className="text-[10px] font-semibold text-white/80 tsh truncate">{heatLabel}</span>
                <span className="flex items-center gap-0.5 text-[11px] font-bold text-white tsh tabular-nums">
                  <IFireF size={11} className="text-primary" />{fmt(item.metric_value)}
                </span>
              </span>
            </div>
            <div className={`mt-1.5 ${first ? "text-[13px] font-bold" : "text-[12px] font-semibold"} text-on clamp-2 leading-tight`}>
              {item.title}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export const RankRow = memo(function RankRow({ item, index, onOpen, animate }: {
  item: { rank: number; video_id: number; title: string; cover: string; tags: string[]; score: number; metric_value: number; metric_label: string };
  index: number;
  onOpen: (index: number) => void;
  animate?: boolean;
}) {
  const medal = item.rank <= 3 ? RANK_MEDAL[item.rank - 1] : undefined;
  const style: CSSProperties = {
    ...(animate ? { animationDelay: `${Math.min(index * 28, 240)}ms` } : null),
    ...(index >= 10 ? { contentVisibility: "auto", containIntrinsicSize: "0 76px" } : null),
  };
  return (
    <button
      onClick={() => onOpen(index)}
      className={`w-full flex items-center gap-3 py-2.5 px-1 text-left pressable ${animate ? "a-rank-in" : ""}`}
      style={style}>
      <span
        className={`w-8 text-center text-[20px] font-black shrink-0 tabular-nums leading-none ${medal ? "" : "text-dim/80"}`}
        style={medal ? { color: medal } : undefined}>
        {item.rank}
      </span>
      <div className="relative w-[52px] h-[70px] rounded-lg overflow-hidden bg-s2 shrink-0">
        <Img src={item.cover} />
      </div>
      <div className="flex-1 min-w-0 py-0.5">
        <div className="text-[14px] font-semibold text-on clamp-2 leading-snug">{item.title}</div>
        {item.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {item.tags.slice(0, 2).map((tag) => (
              <span key={tag} className="px-1.5 py-px rounded text-[10px] text-mut bg-s3/80">{tag}</span>
            ))}
          </div>
        )}
      </div>
      <span className="flex items-center gap-0.5 shrink-0 text-[12px] font-bold tabular-nums text-primary">
        <IFireF size={12} />
        {fmt(item.metric_value)}
      </span>
    </button>
  );
});
