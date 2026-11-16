import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, type Page, type Tab } from "./store";
import { isMobile, selfTest } from "./api";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { runBack } from "./back";
import Home from "./pages/Home";
import Search, { RankPage } from "./pages/Search";
import Category, { ChannelPage } from "./pages/Category";
import Profile from "./pages/Profile";
import SettingsPage from "./pages/Settings";
import DownloadsPage from "./pages/Downloads";
import Feed from "./components/Feed";
import { PostsPage, PostDetail } from "./pages/Posts";
import LoginModal from "./components/LoginModal";
import { ToastHost } from "./components/ui";
import { DesktopRail, DesktopTitleBar } from "./components/DesktopChrome";
import ResizeHandles from "./components/ResizeHandles";
import { tracePlayback } from "./playbackDiagnostics";
import { IDownload, IDownloadF, IGrid, IGridF, IHome, IHomeF, ISearch, IUser, IUserF } from "./icons";

const TAB_ORDER: Tab[] = ["home", "category", "downloads", "search", "profile"];

function TabBar({ hidden }: { hidden: boolean }) {
  const { tab, setTab, theme, t, stack } = useStore();
  const top = stack[stack.length - 1];
  const overVideo = top?.kind === "feed";
  const lightBar = !overVideo && theme === "light";
  const tabs: { k: Tab; labelKey: "nav.home" | "nav.discover" | "nav.downloads" | "nav.search" | "nav.me"; Icon: typeof IHome; Filled: typeof IHomeF }[] = [
    { k: "home", labelKey: "nav.home", Icon: IHome, Filled: IHomeF },
    { k: "category", labelKey: "nav.discover", Icon: IGrid, Filled: IGridF },
    { k: "downloads", labelKey: "nav.downloads", Icon: IDownload, Filled: IDownloadF },
    { k: "search", labelKey: "nav.search", Icon: ISearch, Filled: ISearch },
    { k: "profile", labelKey: "nav.me", Icon: IUser, Filled: IUserF },
  ];

  return (
    <nav
      className={`hg-tabbar absolute bottom-0 inset-x-0 z-30 ${lightBar ? "is-light" : ""} ${hidden ? "is-hidden" : ""}`}
      aria-hidden={hidden}
      inert={hidden}
      style={{ paddingBottom: "var(--sab, 0px)", background: overVideo ? "#000" : undefined }}
    >
      <div className="h-[49px] flex items-end px-1 pb-1">
        {tabs.map(({ k, labelKey, Icon, Filled }) => {
          const on = tab === k;
          return (
            <button key={k} onClick={() => setTab(k)} className="flex-1 h-full flex flex-col items-center justify-center gap-0.5 pressable">
              {on ? <Filled size={22} style={{ color: overVideo || !lightBar ? "#fff" : "var(--p-primary)" }} /> : <Icon size={22} strokeWidth={1.8} style={{ color: lightBar ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.55)" }} />}
              <span className="text-[10px] leading-none" style={{ fontWeight: on ? 700 : 500, color: on ? (overVideo || !lightBar ? "#fff" : "var(--p-primary)") : (lightBar ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.55)") }}>{t(labelKey)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function StackPage({ page, onBack, wide, top, bottomInset }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number;
}) {
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        scrollMode={page.scrollMode || "series"} startEp={page.startEp} startTime={page.startTime}
        mode="context" active={top} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return <RankPage onBack={onBack} wide={wide} />;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} />;
  if (page.kind === "posts") return <PostsPage onBack={onBack} wide={wide} />;
  if (page.kind === "post") return <PostDetail id={page.id} onBack={onBack} active={top} />;
  if (page.kind === "downloads") return <DownloadsPage onBack={onBack} wide={wide} bottomInset={bottomInset} />;
  return null;
}

function AppBody() {
  const { platform, tab, setTab, stack, pop, loginOpen, setLoginOpen, fs, clean, feedChrome } = useStore();
  const isMobile = platform === "android" || platform === "ios";
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(!isMobile);
  const [collapsed, setCollapsed] = useState(false);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4", "5"].includes(e.key) && !e.repeat) {
        setTab(TAB_ORDER[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen]);

  const vis = (k: Tab) => (tab === k ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none");
  const pageActive = stack.length === 0 && !loginOpen;
  const bottomInset = isMobile ? (fs || clean ? 0 : 49) : 14;
  const stackInset = isMobile ? 0 : 14;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!isMobile && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main">
        <div className={vis("home")}><Home active={pageActive && tab === "home"} bottomInset={bottomInset} /></div>
        <div className={vis("search")}><Search active={pageActive && tab === "search"} wide={wide} /></div>
        <div className={vis("category")}><Category wide={wide} active={pageActive && tab === "category"} /></div>
        <div className={vis("downloads")}><DownloadsPage wide={wide} bottomInset={bottomInset} /></div>
        <div className={vis("profile")}><Profile wide={wide} /></div>

        {stack.map((p, i) => (
          <div key={p.key} className="absolute inset-0 z-30 bg-bg a-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={stackInset} />
          </div>
        ))}

        {isMobile && stack.length === 0 && (
          <TabBar hidden={(tab === "home" && !feedChrome) || fs || clean} />
        )}
      </div>
    </div>
  );
}

function DesktopShell() {
  const [collapsed, setCollapsed] = useState(false);
  const { theater, platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas win-root plat-${platform}`}>
      <DesktopTitleBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative flex-1 min-h-0">
        <ShellInner collapsed={collapsed || theater} theater={theater} />
      </div>
      {platform === "windows" && <ResizeHandles />}
    </div>
  );
}

function ShellInner({ collapsed, theater }: { collapsed: boolean; theater: boolean }) {
  const { stack, pop, loginOpen, setLoginOpen, tab, setTab, platform } = useStore();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (stack.length) pop(); return; }
      if (e.key === "/") { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4", "5"].includes(e.key) && !e.repeat) {
        setTab(TAB_ORDER[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen]);

  const vis = (k: Tab) => (tab === k ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none");
  const pageActive = stack.length === 0 && !loginOpen;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!theater && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main ${theater ? "is-theater-main" : ""}`}>
        <div className={vis("home")}><Home active={pageActive && tab === "home"} bottomInset={14} /></div>
        <div className={vis("search")}><Search active={pageActive && tab === "search"} wide={wide} /></div>
        <div className={vis("category")}><Category wide={wide} active={pageActive && tab === "category"} /></div>
        <div className={vis("downloads")}><DownloadsPage wide={wide} bottomInset={14} /></div>
        <div className={vis("profile")}><Profile wide={wide} /></div>
        {stack.map((p, i) => (
          <div key={p.key} className="absolute inset-0 z-30 bg-bg win-page-in" style={{ boxShadow: "-18px 0 40px rgba(0,0,0,.5)" }}>
            <StackPage page={p} onBack={pop} wide={wide} top={i === stack.length - 1} bottomInset={14} />
          </div>
        ))}
      </div>
    </div>
  );
}

function MobileShell() {
  const { platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas plat-${platform}`}
      style={{ "--sat": "max(env(safe-area-inset-top), 12px)", "--sab": "max(env(safe-area-inset-bottom), 16px)" } as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

export default function App() {
  const { platform, loginOpen, setLoginOpen, tab, setTab, stack, pop, fs, setFs } = useStore();
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })), login_open: loginOpen });
  }, [tab, stack, loginOpen]);

  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (fs) { setFs(false); return; }
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (runBack()) return;
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) { pop(); return; }
    if (tab !== "home") { setTab("home"); return; }
    invoke("plugin:app|exit", { code: 0 }).catch(() => {});
  };

  useEffect(() => {
    if (platform !== "android") return undefined;
    let disposed = false;
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", () => backRef.current())
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => {});
    return () => {
      disposed = true;
      handle?.unregister().catch(() => {});
    };
  }, [platform]);

  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { invoke("debug_log", { msg: r }).catch(() => {}); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      <LoginModal />
      <ToastHost />
      {loginOpen && <div className="hidden" onClick={() => setLoginOpen(false)} />}
    </>
  );
}
