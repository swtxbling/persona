// The assistant's rename dialog, loaded only on its first open (lazyDialog), so it stays out of the first-screen
// bundle (#6401). The rename itself goes through PATCH /managers/{id}, which the hub keeps for every device.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { errorText } from "../../lib/api";
import { NAME_MAX, renameManager, validName, type Manager } from "../../lib/managers";
import { Button, Dialog, toast } from "../../ui/atoms";
import { t } from "../../i18n";

export type RenameNoticeTone = "ok" | "error" | "info";

export interface RenameAssistantDialogViewProps {
  open: boolean;
  draft: string;
  currentName: string;
  valid: boolean;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}

export interface RenameAssistantDialogDeps {
  /** Optional scope partition (value or getter); switching it resets draft/busy and aborts in-flight renames. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Rename the assistant manager (sync or async; defaults to `lib/managers.renameManager`). */
  renameManager?: (id: string, name: string, signal: AbortSignal) => { manager: Manager } | void | Promise<{ manager: Manager } | void>;
  /** Custom name validator (defaults to `lib/managers.validName`). */
  validName?: (name: string) => boolean;
  /** Show toast notifications (defaults to `atoms.toast`). */
  notify?: (message: string, tone?: RenameNoticeTone) => void;
  /** Format thrown rename errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when rename throws or rejects in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<RenameAssistantDialogView>`). */
  renderView?: (props: RenameAssistantDialogViewProps) => ReactNode;
}

export interface RenameAssistantDialogProps {
  open: boolean;
  onClose: () => void;
  manager: Manager | null;
  currentName: string;
  deps?: RenameAssistantDialogDeps;
}

interface PendingOp {
  epoch: number;
  seq: number;
  controller: AbortController;
}

const noopSubscribe = () => () => {};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<unknown>).then === "function";
}

function safeFormatError(fmt: ((error: unknown) => string) | undefined, error: unknown): string {
  if (!fmt) return errorText(error);
  try {
    return fmt(error);
  } catch {
    return errorText(error);
  }
}

function safeNotify(notify: ((message: string, tone?: RenameNoticeTone) => void) | undefined, message: string, tone?: RenameNoticeTone) {
  try {
    if (notify) notify(message, tone);
    else toast(message, tone);
  } catch {
    // Notification failures stay non-blocking so recovery never leaves busy stuck.
  }
}

function useTrackedScope(
  source: string | (() => string) | undefined,
  subscribe: ((listener: () => void) => () => void) | undefined,
) {
  const isGetter = typeof source === "function";
  const read = useCallback(() => (typeof source === "function" ? source() : (source ?? "")), [source]);
  const readRef = useRef(read);
  const committedRef = useRef<{ value: string; version: number } | null>(null);
  const snapRef = useRef<{ value: string; version: number } | null>(null);

  const sub = useCallback((listener: () => void) => {
    if (!subscribe || !isGetter) return noopSubscribe();
    return subscribe(() => {
      const next = readRef.current();
      const cur = committedRef.current;
      if (!cur || next !== cur.value) {
        committedRef.current = { value: next, version: (cur?.version ?? 0) + 1 };
      }
      listener();
    });
  }, [subscribe, isGetter]);

  const getSnapshot = useCallback(() => {
    const next = read();
    const cur = committedRef.current;
    if (cur && next === cur.value) return cur;
    const nextVersion = cur ? cur.version + 1 : 0;
    if (snapRef.current && snapRef.current.value === next && snapRef.current.version === nextVersion) {
      return snapRef.current;
    }
    snapRef.current = { value: next, version: nextVersion };
    return snapRef.current;
  }, [read]);

  const snap = useSyncExternalStore(sub, getSnapshot, getSnapshot);

  useLayoutEffect(() => {
    readRef.current = read;
    committedRef.current = snap;
  }, [read, snap]);

  const readToken = useCallback(() => {
    const cur = readRef.current();
    const committed = committedRef.current;
    return committed && committed.value === cur ? `${committed.version}:${cur}` : `drift:${cur}`;
  }, []);

  return { value: snap.value, token: `${snap.version}:${snap.value}`, readToken };
}

/** Pure presentational dialog view for renaming an assistant manager. */
export function RenameAssistantDialogView({
  open,
  draft,
  currentName,
  valid,
  busy,
  onDraftChange,
  onSave,
  onClose,
}: RenameAssistantDialogViewProps) {
  const unchanged = draft.trim() === currentName;
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={t("assistant-profile.name_dialog_title")}
      footer={
        <>
          <Button tone="quiet" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button tone="primary" busy={busy} disabled={!valid || unchanged} onClick={onSave}>
            {t("settings-managers.save")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !unchanged) onSave();
        }}
      >
        <input
          autoFocus
          value={draft}
          maxLength={NAME_MAX * 2}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder={t("assistant-profile.name_placeholder")}
          aria-label={t("settings-managers.name")}
          className="w-full rounded-control bg-inset px-3 py-2 text-sm leading-5 text-ink shadow-hairline outline-none focus:ring-2 focus:ring-accent"
        />
      </form>
    </Dialog>
  );
}

export function RenameAssistantDialog({
  open,
  onClose,
  manager,
  currentName,
  deps,
}: RenameAssistantDialogProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const dialogScope = JSON.stringify([trackedScope.token, open, manager?.id ?? null]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: dialogScope, epoch: 1 }));
  const effectiveEpoch = scope.key === dialogScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== dialogScope) {
    setScope({ key: dialogScope, epoch: effectiveEpoch });
  }

  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });
  const busy = busyState.epoch === effectiveEpoch && busyState.busy;

  const [draftState, setDraftState] = useState<{ epoch: number; baseName: string; value: string }>(() => ({
    epoch: 1,
    baseName: currentName,
    value: currentName,
  }));
  const draft = draftState.epoch === effectiveEpoch && (busy || draftState.baseName === currentName)
    ? draftState.value
    : currentName;

  const ok = (deps?.validName ?? validName)(draft);

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingRef = useRef<PendingOp | null>(null);
  const depsRef = useRef(deps);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  const managerRef = useRef(manager);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    onCloseRef.current = onClose;
    openRef.current = open;
    managerRef.current = manager;
    readScopeTokenRef.current = trackedScope.readToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pendingRef.current?.controller.abort();
      pendingRef.current = null;
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  const reportError = (msg: string) => {
    try {
      depsRef.current?.onError?.(msg);
    } catch {
      // Error observer failures stay non-blocking so recovery never leaves busy stuck.
    }
  };

  const handleDraftChange = (value: string) => {
    if (!isScopeLive() || !openRef.current) return;
    setDraftState({ epoch: capturedEpoch, baseName: currentName, value });
  };

  const handleClose = () => {
    if (pendingRef.current !== null) return;
    onCloseRef.current();
  };

  const save = () => {
    const activeManager = managerRef.current;
    if (!isScopeLive() || !openRef.current || !activeManager || !ok || draft.trim() === currentName || pendingRef.current !== null) return;
    const nextName = draft.trim();
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && opSeqRef.current === runSeq;

    const finishError = (err: unknown) => {
      if (!isRunCurrent()) return;
      const msg = safeFormatError(depsRef.current?.formatError, err);
      safeNotify(depsRef.current?.notify, t("assistant-profile.name_failed", { error: msg }), "error");
      reportError(msg);
    };

    let res: { manager: Manager } | void | Promise<{ manager: Manager } | void>;
    try {
      res = depsRef.current?.renameManager
        ? depsRef.current.renameManager(activeManager.id, nextName, controller.signal)
        : renameManager(activeManager.id, nextName);
    } catch (err) {
      finishError(err);
      return;
    }

    if (!isThenable(res)) {
      if (isRunCurrent()) {
        safeNotify(depsRef.current?.notify, t("assistant-profile.name_saved"), "ok");
        onCloseRef.current();
      }
      return;
    }

    pendingRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setBusyState({ epoch: capturedEpoch, busy: true });
    void (async () => {
      let succeeded = false;
      try {
        await res;
        if (!isRunCurrent()) return;
        succeeded = true;
      } catch (err) {
        finishError(err);
      } finally {
        if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
        if (activeEpochRef.current === capturedEpoch && opSeqRef.current === runSeq) {
          setBusyState({ epoch: capturedEpoch, busy: false });
        }
      }
      if (succeeded && isRunCurrent()) {
        safeNotify(depsRef.current?.notify, t("assistant-profile.name_saved"), "ok");
        onCloseRef.current();
      }
    })();
  };

  const viewProps: RenameAssistantDialogViewProps = {
    open,
    draft,
    currentName,
    valid: ok,
    busy,
    onDraftChange: handleDraftChange,
    onSave: save,
    onClose: handleClose,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <RenameAssistantDialogView {...viewProps} />;
}
