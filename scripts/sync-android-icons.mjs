#!/usr/bin/env node
/**
 * Sync tracked Android icons into the generated Android project.
 *
 * Why: `src-tauri/gen/` is not in git; CI and fresh machines re-run
 * `tauri android init`, which writes Tauri's default icons and ignores
 * `src-tauri/icons/android/`. Local copies look fine; CI builds get the default.
 *
 * Usage:
 *   node scripts/sync-android-icons.mjs
 *   (also run via tauri.conf.json beforeBuildCommand)
 */
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src-tauri", "icons", "android");
const dest = join(root, "src-tauri", "gen", "android", "app", "src", "main", "res");

if (!existsSync(src)) {
  console.log(`[icons] skip: missing ${src}`);
  process.exit(0);
}
if (!existsSync(dest)) {
  console.log("[icons] skip: gen/android not generated yet (run tauri android init first)");
  process.exit(0);
}

cpSync(src, dest, { recursive: true, force: true });
console.log(`[icons] Android icons synced → ${dest}`);
