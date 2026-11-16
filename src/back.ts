/** Global back intercept: transient layers consume first, else navigate. */
type Handler = () => boolean;

let handler: Handler | null = null;

export function setBackHandler(h: Handler | null) {
  handler = h;
}

/** Return true if consumed (do not pop navigation). */
export function runBack(): boolean {
  try {
    return handler ? handler() : false;
  } catch {
    return false;
  }
}