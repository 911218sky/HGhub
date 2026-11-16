import { en } from "./en";
import { zh } from "./zh";
import { zhTW } from "./zh-TW";
import type { Locale, MessageKey } from "./types";

export type { Locale, MessageKey } from "./types";

const catalogs = { zh, "zh-TW": zhTW, en } as const;

export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem("hghub_locale");
    if (saved === "zh" || saved === "zh-TW" || saved === "en") return saved;
  } catch { /* ignore */ }
  const lang = (navigator.language || "zh").toLowerCase();
  if (lang.startsWith("zh")) {
    // Taiwan / Hong Kong / Macau / explicit Traditional → zh-TW
    if (
      lang.includes("tw")
      || lang.includes("hk")
      || lang.includes("mo")
      || lang.includes("hant")
    ) {
      return "zh-TW";
    }
    return "zh";
  }
  return "en";
}

export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const table = catalogs[locale] || catalogs.zh;
  let text = table[key] ?? catalogs.zh[key] ?? String(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

export { zh, zhTW, en };
