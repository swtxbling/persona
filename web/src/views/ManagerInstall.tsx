// Making an assistant and installing it (docs/assistant/managers.md "Install codes"): the dialog that asks for its name, and the
// one-time install code with its countdown (and the install commands when the hub gives them). Settings › Assistants
// and the sidebar's switcher both open them, so they live outside the settings chunk.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../i18n";
import { clock, secondsLeft } from "../lib/connect-device";
import { createManager, managerError, NAME_MAX, renewCode, validName, type InstallCode, type Manager } from "../lib/managers";
import { sameValue } from "../lib/stable-lines";
import { Button, copyText, cx, Dialog, IconButton, toast, useNow } from "../ui/atoms";
import { inputClass } from "./assistant/parts";

/** A code on screen: the manager it installs, and whether it replaces one already installed somewhere. */
export interface ShownCode {
  id: string;
  name: string;
  code: InstallCode;
  /** Never installed: once its code runs out the hub may have dropped it, and a new code makes it again (renewCode). */
  fresh?: boolean;
}

export type CreateManagerResult = InstallCode & { manager: Manager };
export type ManagerNoticeTone = "ok" | "error" | "info";

export interface NewManagerViewProps {
  open: boolean;
  name: string;
  valid: boolean;
  busy: boolean;
  error: string;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export interface NewManagerDeps {
  /** Optional scope partition (value or getter); switching it resets draft/error/busy and aborts in-flight creation. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Create a manager and its initial install code (sync or async; defaults to `lib/managers.createManager`). */
  createManager?: (name: string, signal: AbortSignal) => CreateManagerResult | Promise<CreateManagerResult>;
  /** Custom name validator (defaults to `lib/managers.validName`). */
  validName?: (name: string) => boolean;
  /** Format thrown creation errors (defaults to `lib/managers.managerError`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when creation throws or rejects in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<NewManagerView>`). */
  renderView?: (props: NewManagerViewProps) => ReactNode;
}

export interface NewManagerProps {
  open: boolean;
  onClose: () => void;
  onMade: (m: Manager, code: InstallCode) => void;
  deps?: NewManagerDeps;
}

export interface CopyLineViewProps {
  text: string;
  big?: boolean;
  disabled?: boolean;
  onCopy: (text: string) => void;
}

export interface CodeDialogCommand {
  label: string;
  text: string;
}

export interface CodeDialogViewProps {
  open: boolean;
  shown: ShownCode;
  secondsLeft: number;
  commands: readonly CodeDialogCommand[];
  busy: boolean;
  copyingText?: string | null;
  onClose: () => void;
  onRenew: () => void;
  onCopy: (text: string) => void;
}

export interface CodeDialogDeps {
  /** Optional scope partition (value or getter); switching it resets `last`, aborts in-flight work, and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled clock timestamp or getter (ms); bypasses `useNow(1000)` when supplied. */
  now?: number | (() => number);
  /** Subscribe to controlled clock ticks when `now` is a getter. */
  subscribeNow?: (listener: () => void) => () => void;
  /** Renew an expired install code (sync or async; defaults to `lib/managers.renewCode`). */
  renewCode?: (id: string, name: string, fresh: boolean, signal: AbortSignal) => { id: string; code: InstallCode } | Promise<{ id: string; code: InstallCode }>;
  /** Copy a code or command line (sync or async; defaults to `atoms.copyText`). */
  copyText?: (text: string, signal?: AbortSignal) => boolean | void | Promise<boolean | void>;
  /** Show notifications (defaults to `atoms.toast`). */
  notify?: (message: string, tone?: ManagerNoticeTone) => void;
  /** Format thrown errors (defaults to `lib/managers.managerError`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when renew or copy throws or rejects in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<CodeDialogView>`). */
  renderView?: (props: CodeDialogViewProps) => ReactNode;
}

export interface CodeDialogProps {
  shown: ShownCode | null;
  onClose: () => void;
  onCode: (c: InstallCode, id: string) => void;
  deps?: CodeDialogDeps;
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
  if (!fmt) return managerError(error);
  try {
    return fmt(error);
  } catch {
    return managerError(error);
  }
}

function safeNotify(notify: ((message: string, tone?: ManagerNoticeTone) => void) | undefined, message: string, tone?: ManagerNoticeTone) {
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

function useCachedNow(
  source: number | (() => number) | undefined,
  subscribe: ((listener: () => void) => () => void) | undefined,
): number | undefined {
  const isGetter = typeof source === "function";
  const read = useCallback(() => (typeof source === "function" ? source() : source), [source]);
  const cache = useRef<{ has: boolean; value: number | undefined }>({ has: false, value: undefined });

  const sub = useCallback((listener: () => void) => {
    if (!subscribe || !isGetter) return noopSubscribe();
    return subscribe(listener);
  }, [subscribe, isGetter]);

  const getSnapshot = useCallback((): number | undefined => {
    const next = read();
    if (cache.current.has && sameValue(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { has: true, value: next };
    return next;
  }, [read]);

  return useSyncExternalStore(sub, getSnapshot, getSnapshot);
}

/** Pure presentational dialog view for creating a new assistant manager. */
export function NewManagerView({ open, name, valid, busy, error, onNameChange, onSubmit, onClose }: NewManagerViewProps) {
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      width={400}
      title={t("settings-managers.new")}
      footer={
        <>
          <Button tone="quiet" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button tone="primary" busy={busy} disabled={!valid} onClick={onSubmit}>{t("settings-managers.create")}</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input
          autoFocus
          value={name}
          maxLength={NAME_MAX * 2}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t("settings-managers.name_placeholder")}
          aria-label={t("settings-managers.name")}
          className={inputClass}
        />
      </form>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">{t("settings-managers.new_hint")}</p>
      {error && <p role="alert" className="mt-2 text-[12.5px] text-red">{error}</p>}
    </Dialog>
  );
}

export function NewManager({ open, onClose, onMade, deps }: NewManagerProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const dialogScope = JSON.stringify([trackedScope.token, open]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: dialogScope, epoch: 1 }));
  const effectiveEpoch = scope.key === dialogScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== dialogScope) {
    setScope({ key: dialogScope, epoch: effectiveEpoch });
  }

  const [nameState, setNameState] = useState<{ epoch: number; value: string }>({ epoch: 0, value: "" });
  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });
  const [errorState, setErrorState] = useState<{ epoch: number; message: string }>({ epoch: 0, message: "" });

  const name = nameState.epoch === effectiveEpoch ? nameState.value : "";
  const busy = busyState.epoch === effectiveEpoch && busyState.busy;
  const error = errorState.epoch === effectiveEpoch ? errorState.message : "";
  const ok = (deps?.validName ?? validName)(name);

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingRef = useRef<PendingOp | null>(null);
  const depsRef = useRef(deps);
  const onCloseRef = useRef(onClose);
  const onMadeRef = useRef(onMade);
  const openRef = useRef(open);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    onCloseRef.current = onClose;
    onMadeRef.current = onMade;
    openRef.current = open;
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

  const handleNameChange = (value: string) => {
    if (!isScopeLive() || !openRef.current) return;
    setNameState({ epoch: capturedEpoch, value });
  };

  const handleClose = () => {
    if (pendingRef.current !== null) return;
    onCloseRef.current();
  };

  const make = () => {
    if (!isScopeLive() || !openRef.current || !ok || pendingRef.current !== null) return;
    const trimmed = name.trim();
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && opSeqRef.current === runSeq;

    const finishError = (err: unknown) => {
      if (!isRunCurrent()) return;
      const msg = safeFormatError(depsRef.current?.formatError, err);
      setErrorState({ epoch: capturedEpoch, message: msg });
      reportError(msg);
    };

    setErrorState({ epoch: capturedEpoch, message: "" });
    let res: CreateManagerResult | Promise<CreateManagerResult>;
    try {
      res = depsRef.current?.createManager
        ? depsRef.current.createManager(trimmed, controller.signal)
        : createManager(trimmed);
    } catch (err) {
      finishError(err);
      return;
    }

    if (!isThenable(res)) {
      if (isRunCurrent()) {
        try {
          onMadeRef.current(res.manager, res);
        } catch (err) {
          finishError(err);
        }
      }
      return;
    }

    pendingRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setBusyState({ epoch: capturedEpoch, busy: true });
    void (async () => {
      try {
        const awaited = await res;
        if (!isRunCurrent()) return;
        onMadeRef.current(awaited.manager, awaited);
      } catch (err) {
        finishError(err);
      } finally {
        if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
        if (activeEpochRef.current === capturedEpoch && opSeqRef.current === runSeq) {
          setBusyState({ epoch: capturedEpoch, busy: false });
        }
      }
    })();
  };

  const viewProps: NewManagerViewProps = {
    open,
    name,
    valid: ok,
    busy,
    error,
    onNameChange: handleNameChange,
    onSubmit: make,
    onClose: handleClose,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <NewManagerView {...viewProps} />;
}

/** Pure presentational copyable line for an install code or command. */
export function CopyLineView({ text, big, disabled = false, onCopy }: CopyLineViewProps) {
  return (
    <div className="flex items-center gap-2 rounded-control bg-inset px-2.5 py-1.5 shadow-hairline">
      {/* a command wraps so all of it can be read before it is pasted; the code is one short line */}
      <code className={cx("min-w-0 flex-1 font-mono text-ink select-all", big ? "truncate text-[14px]" : "break-all text-[12px] leading-relaxed")} title={text}>{text}</code>
      <IconButton
        icon="copy"
        label={t("settings-managers.copy")}
        size={24}
        iconSize={12}
        disabled={disabled}
        onClick={() => onCopy(text)}
      />
    </div>
  );
}

/** Pure presentational dialog view for an install code, commands, countdown, and renewal. */
export function CodeDialogView({
  open,
  shown,
  secondsLeft: left,
  commands,
  busy,
  copyingText = null,
  onClose,
  onRenew,
  onCopy,
}: CodeDialogViewProps) {
  const copyBusy = copyingText !== null;
  return (
    <Dialog open={open} onClose={onClose} width={480} title={t("settings-managers.code_for", { name: shown.name })} footer={<Button tone="primary" onClick={onClose}>{t("settings-managers.done")}</Button>}>
      {left === 0 ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-[13px] text-ink-2">{t("settings-managers.expired")}</p>
          <Button tone="primary" busy={busy} onClick={onRenew}>{t("settings-managers.new_code")}</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[12px] text-ink-3">
              <span className="flex-1">{t("settings-managers.code_title")}</span>
              <span className="tabular-nums">{t("settings-managers.expires_in", { time: clock(left) })}</span>
            </div>
            <CopyLineView text={shown.code.code} big disabled={copyBusy} onCopy={onCopy} />
          </div>
          {commands.map((c) => (
            <div key={c.label}>
              <div className="mb-1 text-[12px] text-ink-3">{c.label}</div>
              <CopyLineView text={c.text} disabled={copyBusy} onCopy={onCopy} />
            </div>
          ))}
          <p className="text-[12px] leading-relaxed text-ink-3">{t(commands.length ? "settings-managers.commands_note" : "settings-managers.code_note")}</p>
        </div>
      )}
    </Dialog>
  );
}

function DefaultNowBridge({ render }: { render: (now: number) => ReactNode }) {
  const now = useNow(1000);
  return <>{render(now)}</>;
}

interface CodeDialogBodyProps extends CodeDialogProps {
  now: number;
  outerScopeToken: string;
  readOuterScopeToken: () => string;
}

function CodeDialogBody({ shown, onClose, onCode, deps, now, outerScopeToken, readOuterScopeToken }: CodeDialogBodyProps) {
  const [scopePartition, setScopePartition] = useState<{ token: string; epoch: number }>(() => ({ token: outerScopeToken, epoch: 1 }));
  const effectiveScopeEpoch = scopePartition.token === outerScopeToken ? scopePartition.epoch : scopePartition.epoch + 1;
  if (scopePartition.token !== outerScopeToken) {
    setScopePartition({ token: outerScopeToken, epoch: effectiveScopeEpoch });
  }

  // Keep the last shown code during exit animation within the same scope, and clear it immediately when scope changes.
  const [lastState, setLastState] = useState<{ scopeEpoch: number; shown: ShownCode | null }>(() => ({
    scopeEpoch: effectiveScopeEpoch,
    shown,
  }));
  if (lastState.scopeEpoch !== effectiveScopeEpoch) {
    setLastState({ scopeEpoch: effectiveScopeEpoch, shown });
  } else if (shown && !sameValue(lastState.shown, shown)) {
    setLastState({ scopeEpoch: effectiveScopeEpoch, shown });
  }
  const effectiveLast = lastState.scopeEpoch === effectiveScopeEpoch ? lastState.shown : null;

  const shownKey = shown
    ? JSON.stringify([
        shown.id,
        shown.name,
        Boolean(shown.fresh),
        shown.code.code,
        shown.code.expires_at,
        shown.code.commands?.service ?? null,
        shown.code.commands?.docker ?? null,
      ])
    : null;
  const targetKey = JSON.stringify([outerScopeToken, shownKey]);
  const [target, setTarget] = useState<{ key: string; epoch: number }>(() => ({ key: targetKey, epoch: 1 }));
  const effectiveEpoch = target.key === targetKey ? target.epoch : target.epoch + 1;
  if (target.key !== targetKey) {
    setTarget({ key: targetKey, epoch: effectiveEpoch });
  }

  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });
  const [copyState, setCopyState] = useState<{ epoch: number; text: string | null }>({ epoch: 0, text: null });

  const busy = busyState.epoch === effectiveEpoch && busyState.busy;
  const copyingText = copyState.epoch === effectiveEpoch ? copyState.text : null;

  const activeEpochRef = useRef(0);
  const renewSeqRef = useRef(0);
  const copySeqRef = useRef(0);
  const pendingRenewRef = useRef<PendingOp | null>(null);
  const pendingCopyRef = useRef<PendingOp | null>(null);
  const depsRef = useRef(deps);
  const shownRef = useRef(shown);
  const onCloseRef = useRef(onClose);
  const onCodeRef = useRef(onCode);
  const readScopeTokenRef = useRef(readOuterScopeToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    shownRef.current = shown;
    onCloseRef.current = onClose;
    onCodeRef.current = onCode;
    readScopeTokenRef.current = readOuterScopeToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pendingRenewRef.current?.controller.abort();
      pendingRenewRef.current = null;
      pendingCopyRef.current?.controller.abort();
      pendingCopyRef.current = null;
      renewSeqRef.current += 1;
      copySeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const s = shown ?? effectiveLast;
  if (!s) return null;

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = outerScopeToken;

  const isTargetLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  const reportError = (msg: string) => {
    try {
      depsRef.current?.onError?.(msg);
    } catch {
      // Error observer failures stay non-blocking so recovery never leaves busy stuck.
    }
  };

  const again = () => {
    const active = shownRef.current;
    if (!isTargetLive() || !active || pendingRenewRef.current !== null) return;
    const controller = new AbortController();
    const runSeq = ++renewSeqRef.current;
    const isRunCurrent = () =>
      !controller.signal.aborted
      && isTargetLive()
      && renewSeqRef.current === runSeq;

    const finishError = (err: unknown) => {
      if (!isRunCurrent()) return;
      const msg = safeFormatError(depsRef.current?.formatError, err);
      safeNotify(depsRef.current?.notify, msg, "error");
      reportError(msg);
    };

    let res: { id: string; code: InstallCode } | Promise<{ id: string; code: InstallCode }>;
    try {
      res = depsRef.current?.renewCode
        ? depsRef.current.renewCode(active.id, active.name, Boolean(active.fresh), controller.signal)
        : renewCode(active.id, active.name, Boolean(active.fresh));
    } catch (err) {
      finishError(err);
      return;
    }

    if (!isThenable(res)) {
      if (isRunCurrent()) {
        try {
          onCodeRef.current(res.code, res.id);
        } catch (err) {
          finishError(err);
        }
      }
      return;
    }

    pendingRenewRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setBusyState({ epoch: capturedEpoch, busy: true });
    void (async () => {
      try {
        const awaited = await res;
        if (!isRunCurrent()) return;
        onCodeRef.current(awaited.code, awaited.id);
      } catch (err) {
        finishError(err);
      } finally {
        if (pendingRenewRef.current?.seq === runSeq) pendingRenewRef.current = null;
        if (activeEpochRef.current === capturedEpoch && renewSeqRef.current === runSeq) {
          setBusyState({ epoch: capturedEpoch, busy: false });
        }
      }
    })();
  };

  const handleCopy = (text: string) => {
    if (!isTargetLive() || !shownRef.current || pendingCopyRef.current !== null) return;
    const controller = new AbortController();
    const runSeq = ++copySeqRef.current;
    const isRunCurrent = () =>
      !controller.signal.aborted
      && isTargetLive()
      && copySeqRef.current === runSeq;

    const finishCopyError = (err: unknown) => {
      if (!isRunCurrent()) return;
      const msg = safeFormatError(depsRef.current?.formatError, err);
      if (depsRef.current?.notify) safeNotify(depsRef.current.notify, msg, "error");
      reportError(msg);
    };

    let res: boolean | void | Promise<boolean | void>;
    try {
      res = depsRef.current?.copyText
        ? depsRef.current.copyText(text, controller.signal)
        : copyText(text);
    } catch (err) {
      finishCopyError(err);
      return;
    }

    if (!isThenable(res)) return;

    pendingCopyRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setCopyState({ epoch: capturedEpoch, text });
    void (async () => {
      try {
        await res;
      } catch (err) {
        finishCopyError(err);
      } finally {
        if (pendingCopyRef.current?.seq === runSeq) pendingCopyRef.current = null;
        if (activeEpochRef.current === capturedEpoch && copySeqRef.current === runSeq) {
          setCopyState({ epoch: capturedEpoch, text: null });
        }
      }
    })();
  };

  const left = secondsLeft(s.code.expires_at, now);
  const commands = [
    { label: t("settings-managers.install_service"), text: s.code.commands?.service },
    { label: t("settings-managers.install_docker"), text: s.code.commands?.docker },
  ].filter((c): c is CodeDialogCommand => !!c.text);

  const viewProps: CodeDialogViewProps = {
    open: Boolean(shown),
    shown: s,
    secondsLeft: left,
    commands,
    busy,
    copyingText,
    onClose: () => onCloseRef.current(),
    onRenew: again,
    onCopy: handleCopy,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <CodeDialogView {...viewProps} />;
}

/** The install code (and commands), its countdown, and once it ran out New installation code. */
export function CodeDialog(props: CodeDialogProps) {
  const { deps } = props;
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const controlledNow = useCachedNow(deps?.now, deps?.subscribeNow);

  if (deps?.now === undefined) {
    return (
      <DefaultNowBridge
        render={(tick) => (
          <CodeDialogBody
            {...props}
            now={tick}
            outerScopeToken={trackedScope.token}
            readOuterScopeToken={trackedScope.readToken}
          />
        )}
      />
    );
  }

  return (
    <CodeDialogBody
      {...props}
      now={controlledNow!}
      outerScopeToken={trackedScope.token}
      readOuterScopeToken={trackedScope.readToken}
    />
  );
}
