import { LOCAL } from "./api";
import DOMPurify from "dompurify";

/** Site origin for resolving relative article URLs. */
const SITE = "https://huangguoai.com";
// Default strict until Rust app_boot / security_set updates the live value.
let strictSecurity = true;

/** Whether strict security mode is on (default true). */
export function isStrictSecurity(): boolean {
  return strictSecurity;
}

/** Toggle strict security (off falls back to compatible sanitize/link policy). */
export function setStrictSecurity(strict: boolean): void {
  strictSecurity = strict;

}

function isInternalWebviewHost(host: string): boolean {
  const h = host.replace(/\.+$/, "").toLowerCase();
  return h === "tauri.localhost" || h === "hg.localhost" || h === "ipc.localhost";
}

function isPrivateOrLocalHost(host: string): boolean {
  const h = host.replace(/\.+$/, "").toLowerCase();
  if (!h || isInternalWebviewHost(h)) return true;
  if (["localhost", "local", "internal", "home.arpa"].some((s) => h === s || h.endsWith(`.${s}`))) {
    return true;
  }
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1).toLowerCase();
    if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("::ffff:")) {
      return true;
    }
    return false;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    ) {
      return true;
    }
  }
  return false;
}

/** Normalize image URLs to absolute; placeholders (data:) become empty. */
function abs(raw: string, strict = strictSecurity): string {
  const s = (raw || "").trim();
  if (!s) return "";
  try {
    const url = new URL(s, SITE);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return "";
    if (isInternalWebviewHost(url.hostname)) return "";
    if (strict && isPrivateOrLocalHost(url.hostname)) return "";
    return url.href;
  } catch { return ""; }
}

/** Proxy article images through the local protocol (Referer / decrypt). */
function proxyImages(html: string, strict = strictSecurity): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const imgPrefix = `${LOCAL}/img?u=`;
  doc.querySelectorAll("img").forEach((img) => {
    // Lazy images often store the real URL in data-*; src is a placeholder.
    const candidate =
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("src") ||
      "";
    let raw = candidate.trim();
    if (raw.startsWith(imgPrefix)) {
      try { raw = decodeURIComponent(raw.slice(imgPrefix.length)); } catch { raw = ""; }
    }
    const src = abs(raw, strict);
    if (!src) {
      img.remove();
      return;
    }
    img.setAttribute("src", `${imgPrefix}${encodeURIComponent(src)}`);
    img.removeAttribute("srcset");
    img.removeAttribute("data-src");
    img.removeAttribute("data-original");
    img.removeAttribute("data-lazy-src");
    img.removeAttribute("loading");
    img.setAttribute("loading", "lazy");
  });
  // Absolutize article links so they do not resolve against the local origin.
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = (a.getAttribute("href") || "").trim();
    const full = abs(href, strict);
    if (full) {
      a.setAttribute("href", full);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    } else a.removeAttribute("href");
  });
  return doc.body.innerHTML;
}

const STRICT_TAGS = [
  "p", "div", "span", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "strong", "b", "em", "i", "u", "s", "del", "pre", "code",
  "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td",
];
const STRICT_INPUT_ATTR = [
  "href", "src", "alt", "title", "colspan", "rowspan", "start",
  "data-src", "data-original", "data-lazy-src",
];
const STRICT_FINAL_ATTR = [
  "href", "src", "alt", "title", "colspan", "rowspan", "start", "target", "rel", "loading",
];
// Keep DOMPurify safe URL/attr rules and allow this app's macOS image protocol.
const SAFE_FINAL_URI = /^(?:(?:https?|ftp|ftps|tel|mailto|callto|sms|cid|xmpp|matrix):|hg:\/\/localhost\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/** Allow only needed article HTML; no SVG/MathML, events, styles, or executable URLs. */
export function sanitizeHtml(html: string): string {
  // Old WebViews without a sanitizer must refuse HTML rather than render raw markup.
  if (!html || !DOMPurify.isSupported) return "";
  if (!strictSecurity) {
    const pre = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["data-src", "data-original", "data-lazy-src"],
      ALLOWED_URI_REGEXP: SAFE_FINAL_URI,
    });
    const rewritten = proxyImages(pre, false);
    return DOMPurify.sanitize(rewritten, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target", "rel", "loading"],
      ALLOWED_URI_REGEXP: SAFE_FINAL_URI,
    });
  }
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: STRICT_TAGS,
    ALLOWED_ATTR: STRICT_INPUT_ATTR,
    ALLOWED_URI_REGEXP: SAFE_FINAL_URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ["svg", "math"],
  });
  const rewritten = proxyImages(clean, true);
  // Final DOMPurify pass before dangerouslySetInnerHTML to avoid re-parse drift.
  return DOMPurify.sanitize(rewritten, {
    ALLOWED_TAGS: STRICT_TAGS,
    ALLOWED_ATTR: STRICT_FINAL_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ["svg", "math"],
    ALLOWED_URI_REGEXP: SAFE_FINAL_URI,
  });
}

/** Intercept article link clicks so the WebView does not navigate or open unguarded windows. */
export function handleArticleClick(
  e: { target: EventTarget | null; preventDefault: () => void; stopPropagation: () => void },
  onOpenUrl?: (url: string) => void,
): void {
  const el = e.target instanceof Element ? e.target.closest("a") : null;
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  const href = abs(el.getAttribute("href") || "", strictSecurity);
  if (href && onOpenUrl) onOpenUrl(href);
}
