import { useCallback, useEffect, useState } from "react";
import { api, isMobile } from "../api";
import type { User } from "../types";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { IClose, ILogin } from "../icons";

const FALLBACK_SITE = "https://huangguoai.com";

export default function LoginModal() {
  const { loginOpen, setLoginOpen, setUser, toast, t } = useStore();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [opening, setOpening] = useState(false);

  const openOfficialRegister = useCallback(async () => {
    setOpening(true);
    setErr("");
    try {
      let url = FALLBACK_SITE;
      try {
        const st = await api.lineState();
        if (st?.base) url = st.base.replace(/\/+$/, "");
      } catch { /* use fallback */ }
      await api.openUrl(url);
      toast(t("login.openedSite"), "ok");
    } catch (e) {
      setErr((e as Error).message || t("login.openSiteFailed"));
    } finally {
      setOpening(false);
    }
  }, [t, toast]);

  const submit = async () => {
    const name = username.trim();
    if (!name || !password) { setErr(t("login.needCreds")); return; }
    if (!/^[a-zA-Z0-9_]{4,20}$/.test(name)) {
      setErr(t("login.usernameRule"));
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const res = await api.login(name, password);
      setUser(res.user as User);
      setPassword("");
      setLoginOpen(false);
      if (res.line_switched) toast(t("login.switchedLine"), "info");
      toast(t("login.welcome", { name: (res.user as User)?.nickname || name }), "ok");
    } catch (e) {
      setErr((e as Error).message || t("login.error"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!loginOpen) {
      setErr("");
      setBusy(false);
      setOpening(false);
    }
  }, [loginOpen]);

  const body = (
    <div className="p-5 pt-4">
      <div className="flex items-start gap-3 mb-4">
        <span className="w-11 h-11 rounded-full bg-primary text-on-primary flex items-center justify-center shrink-0 shadow-[0_4px_16px_var(--p-glow)]">
          <ILogin size={20} />
        </span>
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="text-[17px] font-bold text-on leading-tight">{t("login.signInTitle")}</div>
          <div className="text-[11.5px] text-dim mt-0.5">{t("login.hintWeb")}</div>
        </div>
        <button onClick={() => setLoginOpen(false)} aria-label={t("common.close")} className="w-8 h-8 rounded-full flex items-center justify-center text-mut pressable shrink-0 -mr-1">
          <IClose size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t("login.username")}
          className="h-11 px-3.5 rounded-lg bg-s4/80 text-[14px] text-on placeholder-mut outline-none border border-transparent focus:border-primary/60 focus:bg-s4" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder={t("login.password")}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          className="h-11 px-3.5 rounded-lg bg-s4/80 text-[14px] text-on placeholder-mut outline-none border border-transparent focus:border-primary/60 focus:bg-s4" />
        {err && <div className="text-[12px] text-danger -mt-1">{err}</div>}
        <button onClick={() => void submit()} disabled={busy}
          className="mt-1 h-11 rounded-full bg-primary text-on-primary text-[15px] font-bold pressable disabled:opacity-60 shadow-[0_6px_20px_var(--p-glow)]">
          {busy ? t("login.wait") : t("login.submit")}
        </button>
        <button onClick={() => void openOfficialRegister()} disabled={opening}
          className="h-11 rounded-full bg-s3 text-on text-[14px] font-semibold pressable disabled:opacity-60">
          {opening ? t("login.wait") : t("login.registerOnSite")}
        </button>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={loginOpen} onClose={() => setLoginOpen(false)}>{body}</Sheet>
    : <Modal open={loginOpen} onClose={() => setLoginOpen(false)} width={360}>{body}</Modal>;
}
