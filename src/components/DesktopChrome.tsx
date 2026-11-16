import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore, type Tab } from "../store";
import { APP_VERSION } from "../api";
import { Avatar } from "./ui";
import {
  IClose, IDownload, IDownloadF, IGrid, IGridF, IHome, IHomeF, IMinus, IMoon, IPlus, IRestore, ISearch, ISettings, ISidebar,
  ISquare, ISun, ITrophy, IUser, IUserF, Logo,
} from "../icons";

const appWindow = () => getCurrentWindow();

export function DesktopTitleBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { theme, setTheme, setTab, platform, t } = useStore();
  const [maxed, setMaxed] = useState(false);
  const [nativeFs, setNativeFs] = useState(false);

  useEffect(() => {
    let un: (() => void) | undefined;
    const sync = () => {
      appWindow().isMaximized().then(setMaxed).catch(() => {});
      appWindow().isFullscreen().then(setNativeFs).catch(() => {});
    };
    sync();
    appWindow().onResized(sync)
      .then((f: () => void) => { un = f; }).catch(() => {});
    return () => { un?.(); };
  }, []);

  return (
    <header className={`win-titlebar ${nativeFs ? "is-native-fs" : ""}`} data-tauri-drag-region
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("button")) appWindow().toggleMaximize().catch(() => {}); }}>
      <div className="win-wordmark" data-tauri-drag-region>
        <Logo size={24} />
        <span>HG<span className="win-wordmark-light">hub</span></span>
      </div>
      <button className="win-caption-tool" aria-label={collapsed ? t("chrome.expandSidebar") : t("chrome.collapseSidebar")} onClick={onToggle}>
        <ISidebar size={17} strokeWidth={1.7} />
      </button>
      <div className="win-drag-region" data-tauri-drag-region />
      <button className="win-caption-tool" aria-label={t("chrome.toggleTheme")} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <ISun size={17} strokeWidth={1.7} /> : <IMoon size={17} strokeWidth={1.7} />}
      </button>
      <button className="win-caption-tool" aria-label={t("chrome.search")} onClick={() => setTab("search")}>
        <ISearch size={17} strokeWidth={1.7} />
      </button>
      {platform !== "macos" && (
        <div className="win-caption-buttons">
          <button aria-label={t("chrome.minimize")} onClick={() => appWindow().minimize().catch(() => {})}><IMinus size={15} strokeWidth={1.5} /></button>
          <button aria-label={maxed ? t("chrome.restore") : t("chrome.maximize")} onClick={() => appWindow().toggleMaximize().catch(() => {})}>
            {maxed ? <IRestore size={14} strokeWidth={1.5} /> : <ISquare size={14} strokeWidth={1.5} />}
          </button>
          <button className="win-close" aria-label={t("chrome.close")} onClick={() => appWindow().close().catch(() => {})}><IClose size={16} strokeWidth={1.5} /></button>
        </div>
      )}
    </header>
  );
}

export function DesktopRail({ collapsed }: { collapsed: boolean }) {
  const { tab, setTab, user, setLoginOpen, push, platform, stack, t } = useStore();
  const top = stack[stack.length - 1];
  const railPage: "ranks" | "settings" | "posts" | null =
    top?.kind === "settings" ? "settings"
      : top?.kind === "ranks" ? "ranks"
        : top?.kind === "posts" || top?.kind === "post" ? "posts"
          : null;
  const onTab = (key: Tab | "search") => !railPage && tab === key;
  const items: { key: Tab; labelKey: "nav.home" | "nav.discover" | "nav.downloads" | "nav.me"; Icon: typeof IHome; Filled: typeof IHomeF }[] = [
    { key: "home", labelKey: "nav.home", Icon: IHome, Filled: IHomeF },
    { key: "category", labelKey: "nav.discover", Icon: IGrid, Filled: IGridF },
    { key: "downloads", labelKey: "nav.downloads", Icon: IDownload, Filled: IDownloadF },
    { key: "profile", labelKey: "nav.me", Icon: IUser, Filled: IUserF },
  ];
  return (
    <nav className={`win-sidebar ${collapsed ? "is-compact" : ""}`} aria-label={t("nav.main")}>
      <div className="win-sidebar-inner">
        <button className={`win-search-launch ${onTab("search") ? "is-selected" : ""}`}
          onClick={() => setTab("search")} aria-label={t("nav.search")}>
          <ISearch size={19} strokeWidth={1.7} />
          <span className="win-nav-copy">{t("nav.searchAnything")}</span>
          <kbd className="win-nav-key">/</kbd>
        </button>
        <div className="win-nav-items">
          {items.map(({ key, labelKey, Icon, Filled }) => (
            <button key={key} aria-current={onTab(key) ? "page" : undefined}
              className={`win-nav-item ${onTab(key) ? "is-selected" : ""}`}
              onClick={() => setTab(key)}>
              <span className="win-nav-symbol">{onTab(key) ? <Filled size={21} /> : <Icon size={21} strokeWidth={1.7} />}</span>
              <span className="win-nav-copy">{t(labelKey)}</span>
            </button>
          ))}
          <button className={`win-nav-item ${railPage === "posts" ? "is-selected" : ""}`}
            aria-current={railPage === "posts" ? "page" : undefined}
            onClick={() => { if (railPage !== "posts") push({ kind: "posts" }); }}>
            <span className="win-nav-symbol"><IPlus size={21} strokeWidth={2} /></span>
            <span className="win-nav-copy">{t("nav.community")}</span>
          </button>
          <button className={`win-nav-item ${railPage === "ranks" ? "is-selected" : ""}`}
            aria-current={railPage === "ranks" ? "page" : undefined}
            onClick={() => { if (railPage !== "ranks") push({ kind: "ranks" }); }}>
            <span className="win-nav-symbol"><ITrophy size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">{t("nav.ranks")}</span>
          </button>
          <button className={`win-nav-item ${railPage === "settings" ? "is-selected" : ""}`}
            aria-current={railPage === "settings" ? "page" : undefined}
            onClick={() => { if (railPage !== "settings") push({ kind: "settings" }); }}>
            <span className="win-nav-symbol"><ISettings size={21} strokeWidth={1.7} /></span>
            <span className="win-nav-copy">{t("nav.settings")}</span>
          </button>
        </div>
        <div className="win-sidebar-bottom">
          <button className="win-account" onClick={() => { setTab("profile"); if (!user) setLoginOpen(true); }}>
            <Avatar size={34} hue={350} name={user?.nickname} icon={user ? undefined : <IUser size={17} />} />
            <span className="win-account-copy">
              <strong>{user?.nickname || t("nav.signIn")}</strong>
              <small>{user ? t("nav.signedInHint") : t("nav.guestHint")}</small>
            </span>
          </button>
          <span className="win-sidebar-version">HGhub for {platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} {APP_VERSION}</span>
        </div>
      </div>
    </nav>
  );
}
