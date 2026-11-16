export type Locale = "zh" | "zh-TW" | "en";

export type MessageKey = keyof typeof import("./zh").zh;

export type Messages = Record<MessageKey, string>;
