/** Pure helpers shared by Feed mobile/desktop gesture parity. */

export function isDoubleTap(lastTapAt: number, now: number, windowMs = 300): boolean {
  return now - lastTapAt < windowMs;
}

export function singleTapAction(idle: boolean): "wake" | "toggle" {
  return idle ? "wake" : "toggle";
}

/** Left → detail, right → back. Null if movement is too small / too vertical. */
export function swipeNavAction(
  dx: number,
  dy: number,
  opts: { minDx?: number; ratio?: number } = {},
): "detail" | "back" | null {
  const minDx = opts.minDx ?? 56;
  const ratio = opts.ratio ?? 1.1;
  if (Math.abs(dx) <= minDx || Math.abs(dx) <= Math.abs(dy) * ratio) return null;
  return dx < 0 ? "detail" : "back";
}

export function holdLockArmed(startY: number, clientY: number, threshold = 64): boolean {
  return startY - clientY > threshold;
}

export function isHorizontalSwipeIntent(dx: number, dy: number, minDx = 16, ratio = 1.2): boolean {
  return Math.abs(dx) > minDx && Math.abs(dx) > Math.abs(dy) * ratio;
}

export function isVerticalPanIntent(dy: number, minDy = 10): boolean {
  return Math.abs(dy) > minDy;
}
