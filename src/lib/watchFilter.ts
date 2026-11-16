import type { WatchProgress } from "../store";

/** Meaningful watch — ignore bare play-URL opens with almost no progress. */
export function isWatchedForRecs(h: WatchProgress): boolean {
  if (h.ep > 1) return true;
  if (h.t >= 30) return true;
  if (h.dur > 0 && h.t / h.dur >= 0.25) return true;
  return false;
}

/** Series IDs that should be hidden / sunk in recommendation-like lists. */
export function watchedIdSet(history: WatchProgress[]): Set<number> {
  return new Set(history.filter(isWatchedForRecs).map((h) => h.id));
}

/** Resume position for opening a series in episode Feed mode. */
export function resumeOf(
  history: WatchProgress[],
  id: number,
): { startEp?: number; startTime?: number } {
  const h = history.find((x) => x.id === id);
  if (!h) return {};
  return {
    ...(h.ep > 0 ? { startEp: h.ep } : {}),
    ...(h.t > 1 ? { startTime: h.t } : {}),
  };
}

/**
 * Soft-filter watched IDs out of a page.
 * If that would empty the page and `keepIfEmpty` is set, keep up to `minKeep`
 * originals so the feed/UI does not stall on an all-watched chunk.
 */
export function softFilterWatched<T>(
  items: T[],
  watched: Set<number>,
  getId: (item: T) => number,
  opts?: { keepIfEmpty?: boolean; minKeep?: number },
): T[] {
  const fresh = items.filter((x) => !watched.has(getId(x)));
  if (fresh.length > 0) return fresh;
  if (!opts?.keepIfEmpty || items.length === 0) return [];
  const n = Math.min(opts.minKeep ?? 3, items.length);
  return items.slice(0, n);
}

/** Stable partition: unwatched first, watched last (relative order preserved). */
export function deprioritizeWatched<T>(
  items: T[],
  watched: Set<number>,
  getId: (item: T) => number,
): T[] {
  if (watched.size === 0 || items.length === 0) return items;
  const fresh: T[] = [];
  const seen: T[] = [];
  for (const item of items) {
    (watched.has(getId(item)) ? seen : fresh).push(item);
  }
  return seen.length === 0 ? items : [...fresh, ...seen];
}
