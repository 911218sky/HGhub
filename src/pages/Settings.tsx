import { useEffect, useState, type ReactNode } from "react";
import { api, APP_VERSION, hostOf, logLine, platform, type UpdateInfo } from "../api";
import { useStore } from "../store";
import { Modal, Toggle } from "../components/ui";
import LinePicker from "../components/LinePicker";
import { copyPlaybackLog, initPlaybackLog, setPlaybackLog, usePlaybackLog } from "../playbackDiagnostics";
import { IBack, IBoltF, IBroom, IChevR, IHeart, IInfo, ILink, ILockF, IMoon, IRefresh, ISettings, ISun, IVolMute } from "../icons";

export default function Settings({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { theme, setTheme, locale, setLocale, t, favs, history, muteOnStartup, setMuteOnStartup, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity, toast } = useStore();
  const [about, setAbout] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const [lineBase, setLineBase] = useState("");
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const playbackLog = usePlaybackLog();
  const [copyingLog, setCopyingLog] = useState(false);

  const readLine = () => {
    api.lineState().then((s) => setLineBase(s.base)).catch(() => {});
  };
  useEffect(readLine, []);
  useEffect(() => { void initPlaybackLog(); }, []);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const info = await api.checkUpdate();
      if (info.has_update) setUpdate(info);
      else toast(t("settings.latest", { v: info.current }), "ok");
    } catch (e) {
      toast((e as Error).message || t("settings.updateFailed"), "info");
    } finally {
      setChecking(false);
    }
  };

  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <>
      <div className="text-[10.5px] font-semibold text-dim tracking-wide px-1 mt-4 mb-1.5">{title}</div>
      <div className="rounded-(--r-md) bg-s2 divide-y divide-s3">{children}</div>
    </>
  );

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 relative overflow-hidden bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
        <div className="relative px-3 pt-2 pb-4">
          <button onClick={onBack} aria-label={t("settings.back")} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></button>
          <div className="px-2 mt-1 flex items-end justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><ISettings size={20} strokeWidth={1.7} /></span>
                <span className="text-[24px] font-bold tracking-wide text-on">{t("settings.title")}</span>
              </div>
              <div className="text-[11px] text-mut mt-1">{t("settings.subtitle")}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-1 pb-10">
        <div className={wide ? "max-w-[720px] mx-auto" : ""}>
          <Section title={t("settings.appearance")}>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary">{theme === "dark" ? <IMoon size={16} /> : <ISun size={16} />}</span>
              <div className="flex-1">
                <div className="text-[12.5px] text-on">{t("settings.dark")}</div>
                <div className="text-[10.5px] text-mut">{t("settings.darkHint")}</div>
              </div>
              <Toggle on={theme === "dark"} onChange={(on) => setTheme(on ? "dark" : "light")} label={t("settings.dark")} />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary text-[11px] font-bold">
                {locale === "en" ? "EN" : locale === "zh-TW" ? "繁" : "简"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">{t("settings.language")}</div>
                <div className="text-[10.5px] text-mut">{t("settings.languageHint")}</div>
              </div>
              <div className="flex flex-wrap justify-end gap-0.5 rounded-full bg-s3 p-0.5 max-w-[220px]">
                {([
                  ["zh", "settings.lang.zh"],
                  ["zh-TW", "settings.lang.zhTW"],
                  ["en", "settings.lang.en"],
                ] as const).map(([l, key]) => (
                  <button
                    key={l}
                    onClick={() => setLocale(l)}
                    className={`px-2.5 h-7 rounded-full text-[11px] font-semibold pressable ${locale === l ? "bg-primary text-on-primary" : "text-mut"}`}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          <Section title={t("settings.playback")}>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IVolMute size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">{t("settings.muteOnStartup")}</div>
                <div className="text-[10.5px] text-mut">{t("settings.muteOnStartupHint")}</div>
              </div>
              <Toggle on={muteOnStartup} onChange={setMuteOnStartup} label={t("settings.muteOnStartup")} />
            </div>
          </Section>

          <Section title={t("settings.data")}>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IHeart size={16} /></span>
              <div className="flex-1">
                <div className="text-[12.5px] text-on">{t("settings.localFavs")}</div>
                <div className="text-[10.5px] text-mut">{t("settings.localFavsMeta", { n: favs.length, m: history.length })}</div>
              </div>
            </div>
            <button onClick={() => setClearOpen(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IBroom size={16} /></span>
              <div className="flex-1">
                <div className="text-[12.5px] text-on">{t("settings.clearCache")}</div>
                <div className="text-[10.5px] text-mut">{t("settings.clearCacheHint")}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </button>
          </Section>

          <Section title={t("settings.network")}>
            <button onClick={() => setLineOpen(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IBoltF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">{t("settings.line")}</div>
                <div className="text-[10.5px] text-mut truncate">{lineBase ? hostOf(lineBase) : t("settings.defaultLine")}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </button>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ILockF size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">{t("settings.strictSecurity")}</div>
                <div className="text-[10.5px] text-mut">
                  {cliRelaxed
                    ? t("settings.strictSecurityCliHint")
                    : t("settings.strictSecurityHint")}
                </div>
              </div>
              <Toggle
                on={strictSecurity}
                disabled={!strictSecurityReady || securityPending}
                onChange={(on) => {
                  void setStrictSecurity(on).then(() => {
                    toast(on ? t("settings.strictOn") : t("settings.strictOff"), "info");
                  }).catch(() => toast(t("settings.strictSaveFailed"), "info"));
                }}
                label={t("settings.strictSecurity")}
              />
            </div>
            <button onClick={async () => {
              try {
                const text = JSON.stringify(await api.netDiag(), null, 2);
                logLine(`[net_diag] ${text}`);
                await navigator.clipboard?.writeText(text);
                toast(t("settings.netDiagCopied"), "ok");
              } catch (e) {
                toast((e as Error).message || t("settings.netDiagFailed"), "info");
              }
            }} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ILink size={16} /></span>
              <div className="flex-1">
                <div className="text-[12.5px] text-on">{t("settings.netDiag")}</div>
                <div className="text-[10.5px] text-mut">{t("settings.netDiagHint")}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </button>
          </Section>

          <Section title={t("settings.diagnostics")}>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IInfo size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">{t("settings.playbackLog")}</div>
                <div className="text-[10.5px] text-mut">{t("settings.playbackLogHint")}</div>
                {playbackLog.error && <div role="alert" className="text-[10.5px] text-danger">{playbackLog.error}</div>}
              </div>
              <Toggle label={t("settings.playbackLog")} on={playbackLog.enabled} disabled={!playbackLog.ready || playbackLog.pending}
                onChange={(on) => { void setPlaybackLog(on).then(() => toast(on ? t("settings.playbackLogOn") : t("settings.playbackLogOff"), "ok")).catch(() => toast(t("settings.playbackLogSaveFailed"), "info")); }} />
            </div>
            <button disabled={!playbackLog.ready || playbackLog.pending || copyingLog} onClick={async () => {
              setCopyingLog(true);
              try { await copyPlaybackLog(); toast(t("settings.playbackLogCopied"), "ok"); }
              catch (e) { toast((e as Error).message || t("settings.playbackLogCopyFailed"), "info"); }
              finally { setCopyingLog(false); }
            }} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ILink size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-on">{copyingLog ? t("settings.copying") : t("settings.copyLog")}</div>
                <div className="text-[10.5px] text-mut break-all">{playbackLog.path || t("settings.logLocalOnly")}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </button>
          </Section>

          <Section title={t("settings.other")}>
            <button onClick={checkUpdate} disabled={checking} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IRefresh size={16} /></span>
              <div className="flex-1">
                <div className="text-[12.5px] text-on">{t("settings.checkUpdate")}</div>
                <div className="text-[10.5px] text-mut">{checking ? t("settings.checking") : t("settings.currentVersion", { v: APP_VERSION })}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </button>
            <button onClick={() => setAbout(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><IInfo size={16} /></span>
              <div className="flex-1">
                <div className="text-[12.5px] text-on">{t("settings.about")}</div>
                <div className="text-[10.5px] text-mut">{t("settings.aboutHint", { v: APP_VERSION })}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </button>
          </Section>

          <div className="text-center text-[10px] text-dim mt-5">{t("settings.client", { v: APP_VERSION, platform: platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows" })}</div>
        </div>
      </div>

      <LinePicker open={lineOpen} onClose={() => { setLineOpen(false); readLine(); }} />

      <Modal open={about} onClose={() => setAbout(false)} width={392}>
        <div className="p-5">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-(--r-sm) brand-grad glow-neon flex items-center justify-center text-on-primary text-[17px] font-black">H</span>
            <div>
              <div className="text-[16px] font-bold text-on leading-tight">HGhub</div>
              <div className="text-[11px] text-mut mt-0.5">{t("settings.aboutTagline", { v: APP_VERSION })}</div>
            </div>
          </div>

          <p className="text-[12px] text-on/70 leading-relaxed mt-4">
            {t("settings.aboutDesc")}
          </p>

          <div className="mt-4 rounded-(--r-sm) bg-s3/60 p-3 text-[11px] text-mut leading-relaxed">
            {t("settings.aboutNotice")}
          </div>

          <div className="mt-4 divide-y divide-s3">
            <button onClick={() => { navigator.clipboard?.writeText("https://github.com/911218sky/HGhub").then(() => toast(t("settings.repoCopied"), "ok")).catch(() => {}); }}
              className="w-full flex items-center gap-2 py-2.5 text-left pressable">
              <ILink size={15} className="text-mut" />
              <span className="text-[12px] text-on/85">github.com/911218sky/HGhub</span>
              <span className="ml-auto text-[10.5px] text-primary">{t("settings.copy")}</span>
            </button>
            <button onClick={() => { navigator.clipboard?.writeText("https://huangguoai.com").then(() => toast(t("settings.siteCopied"), "ok")).catch(() => {}); }}
              className="w-full flex items-center gap-2 py-2.5 text-left pressable">
              <ILink size={15} className="text-mut" />
              <span className="text-[12px] text-on/85">huangguoai.com</span>
              <span className="ml-auto text-[10.5px] text-primary">{t("settings.copy")}</span>
            </button>
            <div className="flex items-center gap-2 py-2.5">
              <IInfo size={15} className="text-mut" />
              <span className="text-[12px] text-on/85">PolyForm Noncommercial 1.0.0</span>
              <span className="ml-auto text-[10.5px] text-mut">{t("settings.nonCommercial")}</span>
            </div>
          </div>

          <button onClick={() => setAbout(false)} className="mt-4 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on pressable">{t("settings.gotIt")}</button>
        </div>
      </Modal>

      <Modal open={clearOpen} onClose={() => setClearOpen(false)} width={330}>
        <div className="p-5">
          <div className="text-[14.5px] font-bold text-on">{t("settings.clearCache")}</div>
          <p className="text-[12px] text-mut leading-relaxed mt-2">
            {t("settings.clearCacheBody")}
          </p>
          <div className="flex gap-2 mt-5">
            <button onClick={() => setClearOpen(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on/80 pressable">{t("common.cancel")}</button>
            <button disabled={clearing} onClick={async () => {
              setClearing(true);
              try { await api.clearCache(); } catch { /* ignore */ }
              setClearing(false);
              setClearOpen(false);
              toast(t("settings.cacheCleared"), "ok");
            }} className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[12.5px] font-semibold text-on-primary pressable disabled:opacity-60">
              {clearing ? t("settings.clearing") : t("settings.clearConfirm")}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!update?.has_update} onClose={() => setUpdate(null)} width={392}>
        <div className="p-5">
          <div className="text-[15px] font-bold text-on">{t("settings.updateAvailable")}</div>
          <p className="text-[11.5px] text-mut mt-1.5">
            v{update?.current} → <b className="text-on">v{update?.latest}</b>
            {update?.published_at ? ` · ${update.published_at.slice(0, 10)}` : ""}
          </p>
          {!!update?.notes && (
            <div className="mt-3 max-h-[180px] scroll-y rounded-(--r-sm) bg-s2 p-3 text-[11px] text-mut whitespace-pre-wrap leading-relaxed">{update.notes}</div>
          )}
          <div className="flex gap-2 mt-4">
            <button onClick={() => setUpdate(null)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[12.5px] text-on/80 pressable">{t("settings.later")}</button>
            <button onClick={() => {
              if (!update) return;
              api.openUrl(update.url).catch(() => {
                navigator.clipboard?.writeText(update.url).then(() => toast(t("settings.downloadCopied"), "ok")).catch(() => {});
              });
            }} className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[12.5px] font-semibold text-on-primary pressable">{t("settings.download")}</button>
          </div>
          <div className="text-[10px] text-dim mt-2.5 break-all">{update?.url}</div>
        </div>
      </Modal>
    </div>
  );
}
