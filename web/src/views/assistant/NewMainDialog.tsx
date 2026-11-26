import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { api, ApiError, credentialOwner, errorText, onCredentialChange } from "../../lib/api";
import { archivedMainTitle, NEW_MAIN_PATH, newMainBody } from "../../lib/compaction";
import { forgetMainClearedIf, markMainCleared } from "../../lib/main-clear";
import { chosenManager, onManagerChoice } from "../../lib/manager-choice";
import { navigate } from "../../lib/router";
import { refreshAssistant } from "../../lib/store";
import type { Session } from "../../lib/types";
import { Button, Dialog, toast } from "../../ui/atoms";
import { Switch } from "./parts";

function safeCredentialOwner(): string {
  try {
    return typeof localStorage === "undefined" ? "" : credentialOwner();
  } catch {
    return "";
  }
}

let ambientScopeGeneration = 0;
const bumpAmbientScope = () => {
  ambientScopeGeneration += 1;
};
onManagerChoice(bumpAmbientScope);
onCredentialChange(bumpAmbientScope);

export interface NewMainResult {
  ok: boolean;
  archived?: string;
  carried?: boolean;
}

export interface NewMainDialogDeps {
  startNewMain?: (carry: boolean, expect: string) => Promise<NewMainResult>;
  refresh?: () => Promise<unknown>;
  navigateMain?: () => void;
  notify?: (text: string, tone: "ok" | "error" | "info") => void;
  markCleared?: (sid: string) => void;
  forgetCleared?: () => void;
  scopeKey?: string;
}

export interface NewMainDialogProps {
  open: boolean;
  onClose: () => void;
  session: Session;
  scopeKey?: string;
  onNavigate?: () => void;
  deps?: NewMainDialogDeps;
}

/** Archives the main conversation (renamed "Old main chat · until <date>") and leaves none: the next message starts the new one. */
export function NewMainDialog({ open, onClose, session, scopeKey, onNavigate, deps }: NewMainDialogProps) {
  const effectiveScope = JSON.stringify([scopeKey ?? deps?.scopeKey ?? "", session.machine_id, session.session_id, session.manager ?? ""]);
  const [instance, setInstance] = useState<{ scope: string; open: boolean; epoch: number }>(() => ({
    scope: effectiveScope,
    open,
    epoch: 1,
  }));
  const scopeChanged = instance.scope !== effectiveScope;
  const openedFresh = open && !instance.open;
  const effectiveEpoch = scopeChanged || openedFresh ? instance.epoch + 1 : instance.epoch;
  if (scopeChanged || instance.open !== open) {
    setInstance({ scope: effectiveScope, open, epoch: effectiveEpoch });
  }

  const [carryState, setCarryState] = useState<{ epoch: number; carry: boolean }>(() => ({ epoch: effectiveEpoch, carry: true }));
  const [busyEpoch, setBusyEpoch] = useState<number | null>(null);
  const carry = carryState.epoch === effectiveEpoch ? carryState.carry : true;
  const busy = busyEpoch === effectiveEpoch;

  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const activeEpochRef = useRef(effectiveEpoch);
  const busyLockRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onNavigateRef = useRef(onNavigate);
  const depsRef = useRef(deps);

  useLayoutEffect(() => {
    openRef.current = open;
    activeEpochRef.current = effectiveEpoch;
    onCloseRef.current = onClose;
    onNavigateRef.current = onNavigate;
    depsRef.current = deps;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeEpochRef.current = 0;
    };
  }, []);

  useEffect(() => {
    busyLockRef.current = false;
  }, [effectiveEpoch]);

  const setCarry = (next: boolean) => setCarryState({ epoch: effectiveEpoch, carry: next });

  const go = async () => {
    const capturedEpoch = activeEpochRef.current;
    const trackAmbient = scopeKey === undefined && depsRef.current?.scopeKey === undefined;
    const startedManager = trackAmbient ? (chosenManager() ?? "") : "";
    const startedOwner = trackAmbient ? safeCredentialOwner() : "";
    const startedAmbientGen = trackAmbient ? ambientScopeGeneration : 0;
    const isAmbientCurrent = () =>
      !trackAmbient
      || ((chosenManager() ?? "") === startedManager
        && safeCredentialOwner() === startedOwner
        && ambientScopeGeneration === startedAmbientGen);
    const isCurrent = () =>
      mountedRef.current
      && openRef.current
      && activeEpochRef.current === capturedEpoch
      && isAmbientCurrent();
    if (busyLockRef.current || !isCurrent()) return;
    busyLockRef.current = true;
    setBusyEpoch(capturedEpoch);
    const targetSid = session.session_id;
    const markedManager = chosenManager() ?? "";
    const customMarkCleared = depsRef.current?.markCleared;
    const markCleared = customMarkCleared ?? ((sid: string) => markMainCleared(sid, markedManager));
    const clearOwnMarked = () => {
      if (!customMarkCleared) forgetMainClearedIf(targetSid, markedManager);
    };
    const forgetCleared = () => {
      clearOwnMarked();
      depsRef.current?.forgetCleared?.();
    };
    const startNewMain = depsRef.current?.startNewMain
      ?? ((includeSummary: boolean, expect: string) => api<NewMainResult>(NEW_MAIN_PATH, { method: "POST", json: newMainBody(includeSummary, expect) }));
    const refresh = depsRef.current?.refresh ?? (() => refreshAssistant().catch(() => {}));
    const navigateMain = depsRef.current?.navigateMain ?? (() => navigate({ name: "persona" }));
    const notify = depsRef.current?.notify ?? ((text: string, tone: "ok" | "error" | "info") => toast(text, tone));

    // Keep the docked conversation layout across early hub pushes and refresh so the composer never jumps to the
    // centered welcome screen and back when the next message starts the new main chat.
    markCleared(targetSid);

    // `refresh()` updates `assistant.main` in the store, which is expected to flip the caller's `isMain`
    // state and unmount this dialog; once `startNewMain` has settled on the current epoch, only an ambient
    // account/manager switch or an explicit scope change while still mounted should cancel navigation/toast.
    const finishToMain = async (message: string, tone: "ok" | "info") => {
      await refresh();
      if (!isAmbientCurrent()) {
        clearOwnMarked();
        return;
      }
      if (mountedRef.current && activeEpochRef.current !== capturedEpoch) {
        clearOwnMarked();
        return;
      }
      onCloseRef.current();
      navigateMain();
      onNavigateRef.current?.();
      notify(message, tone);
    };

    try {
      const r = await startNewMain(carry, targetSid);
      if (!isCurrent()) {
        if (!isAmbientCurrent() || mountedRef.current) clearOwnMarked();
        return;
      }
      await finishToMain(
        r.carried ? t("assistant-assistantchat.new_main_done_carried") : t("assistant-assistantchat.new_main_done"),
        "ok",
      );
    } catch (e) {
      if (!isCurrent()) {
        clearOwnMarked();
        return;
      }
      forgetCleared();
      if (e instanceof ApiError && e.code === "main_changed") {
        // Another device replaced it already: show what the hub has now.
        await finishToMain(t("assistant-assistantchat.new_main_elsewhere"), "info");
      } else {
        notify(t("assistant-assistantchat.new_main_failed", { error: errorText(e) }), "error");
      }
    } finally {
      if (activeEpochRef.current === capturedEpoch) {
        busyLockRef.current = false;
        if (mountedRef.current) setBusyEpoch((cur) => (cur === capturedEpoch ? null : cur));
      }
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={t("assistant-assistantchat.new_main_title")}
      footer={
        <>
          <Button tone="quiet" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button tone="primary" busy={busy} onClick={() => void go()}>{t("assistant-assistantchat.new_main")}</Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">{t("assistant-assistantchat.new_main_body", { title: archivedMainTitle() })}</p>
      <div className="mt-3 flex items-start gap-3 rounded-control bg-inset px-3 py-2.5 shadow-hairline">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-ink">{t("assistant-assistantchat.carry_summary")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{t("assistant-assistantchat.carry_summary_hint")}</div>
        </div>
        <Switch checked={carry} onChange={setCarry} label={t("assistant-assistantchat.carry_summary")} disabled={busy} />
      </div>
    </Dialog>
  );
}
