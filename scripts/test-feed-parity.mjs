/**
 * Verifies mobile/desktop Feed gesture parity helpers + source wiring.
 * Run: node scripts/test-feed-parity.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const ok = (name) => console.log(`  ✓ ${name}`);
const fail = (name, err) => {
  failures.push(name);
  console.error(`  ✗ ${name}: ${err?.message || err}`);
};

console.log("feed-parity: helpers");
const vite = await createViteServer({
  root,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
try {
  const mod = await vite.ssrLoadModule("/src/lib/feedGestures.ts");

  assert.equal(mod.isDoubleTap(1000, 1200), true);
  assert.equal(mod.isDoubleTap(1000, 1400), false);
  ok("isDoubleTap window");

  assert.equal(mod.singleTapAction(true), "wake");
  assert.equal(mod.singleTapAction(false), "toggle");
  ok("singleTapAction idle/wake");

  assert.equal(mod.swipeNavAction(-80, 5), "detail");
  assert.equal(mod.swipeNavAction(80, 5), "back");
  assert.equal(mod.swipeNavAction(-40, 5), null);
  assert.equal(mod.swipeNavAction(-80, 90), null);
  ok("swipeNavAction detail/back");

  assert.equal(mod.holdLockArmed(200, 120), true);
  assert.equal(mod.holdLockArmed(200, 180), false);
  ok("holdLockArmed threshold");

  assert.equal(mod.isHorizontalSwipeIntent(20, 5), true);
  assert.equal(mod.isHorizontalSwipeIntent(10, 5), false);
  assert.equal(mod.isVerticalPanIntent(12), true);
  assert.equal(mod.isVerticalPanIntent(4), false);
  ok("swipe/pan intent classifiers");

  /* Simulate shared tap state machine used by mobile + desktop. */
  {
    let last = 0;
    const actions = [];
    const tap = (now, idle) => {
      if (mod.isDoubleTap(last, now)) {
        last = 0;
        actions.push("like");
        return;
      }
      last = now;
      actions.push(mod.singleTapAction(idle));
    };
    tap(1000, true);   // wake
    tap(1300, false);  // toggle (outside double window)
    tap(2000, false);  // arm
    tap(2150, false);  // like (double)
    assert.deepEqual(actions, ["wake", "toggle", "toggle", "like"]);
    ok("tap state machine wake/toggle/like");
  }
} catch (e) {
  fail("helpers", e);
} finally {
  await vite.close();
}

console.log("feed-parity: Feed.tsx wiring");
try {
  const feed = await readFile(resolve(root, "src/components/Feed.tsx"), "utf8");
  const checks = [
    ["imports feedGestures", /from ["']\.\.\/lib\/feedGestures["']/],
    ["shared handleSurfaceTap", /const handleSurfaceTap = /],
    ["desktop pointer gestures enabled", /if \(isDesktop && e\.pointerType === "touch"\) return/],
    ["no desktop-only early return onDown", /const onDown[\s\S]*?if \(controlsLocked \|\| !active/],
    ["swipe uses helper", /swipeNavAction\(/],
    ["hold lock uses helper", /holdLockArmed\(/],
    ["keyboard detail shortcut", /case "i": case "I":/],
    ["desktop follow button", /isDesktop && \([\s\S]*onFollow/],
    ["desktop detail entry", /setPanel\("detail"\)/],
    ["mobile volume slider", /aria-label=\{t\("player\.volume"\)\}/],
    ["hold overlay on both platforms", /\{holdSpeed && \(/],
    ["shared detail/episodes panel", /detailEpisodesPanel/],
  ];
  for (const [name, re] of checks) {
    assert.ok(re.test(feed), `missing: ${name}`);
    ok(name);
  }
} catch (e) {
  fail("Feed wiring", e);
}

console.log("feed-parity: VideoSurface click typing");
try {
  const vs = await readFile(resolve(root, "src/components/VideoSurface.tsx"), "utf8");
  assert.match(vs, /onClick\?: \(e: React\.MouseEvent<HTMLVideoElement>\) => void/);
  ok("VideoSurface onClick accepts MouseEvent");
} catch (e) {
  fail("VideoSurface", e);
}

if (failures.length) {
  console.error(`\nFAILED ${failures.length} check(s)`);
  process.exit(1);
}
console.log("\nAll feed-parity checks passed.");
void pathToFileURL; // keep import used for older tooling
