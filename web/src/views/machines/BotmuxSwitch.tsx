// "Also show botmux sessions" in a machine page's header, beside its engine (#2575, #2842, iOS BotmuxSwitchModel): whether
// this computer's botmux sessions are listed beside its engine's, one click to flip. GET / PUT
// /api/v1/machines/{mid}/botmux {"on"}; the hub keeps it per machine (hub.json's machines[].botmux is the default, on
// when unset) and tells the node at once.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, enc, errorText } from "../../lib/api";
import { sameValue } from "../../lib/stable-lines";
import { cx, toast } from "../../ui/atoms";
import { t } from "../../i18n";

export type BotmuxNoticeTone = "ok" | "error" | "info";
export type BotmuxReadResult = { on: boolean } | boolean | null;
export type BotmuxSaveResult = { on: boolean } | boolean | void;

export interface BotmuxSwitchViewProps {
  on: boolean | null;
  saving?: boolean;
  onToggle: (next: boolean) => void;
}

export interface BotmuxSwitchDeps {
  /** Optional scope partition (value or getter); switching it aborts in-flight requests, resets state, and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled switch value or getter (bypasses initial `GET /machines/{mid}/botmux` when supplied). */
  on?: boolean | null | (() => boolean | null);
  /** Subscribe to controlled switch value updates when `on` is a getter. */
  subscribeOn?: (listener: () => void) => () => void;
  /** Read the machine's botmux state (defaults to `GET /machines/{mid}/botmux`). */
  readBotmux?: (machineID: string, signal: AbortSignal) => Promise<BotmuxReadResult> | BotmuxReadResult;
  /** Persist a botmux toggle (defaults to `PUT /machines/{mid}/botmux`). */
  saveBotmux?: (machineID: string, next: boolean, signal: AbortSignal) => Promise<BotmuxSaveResult> | BotmuxSaveResult;
  /** Show toast notifications (defaults to `atoms.toast`). */
  notify?: (message: string, tone?: BotmuxNoticeTone) => void;
  /** Format thrown save errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when saving fails in the active scope. */
  onError?: (message: string, error: unknown) => void;
  /** Optional custom view renderer (defaults to `<BotmuxSwitchView>`). */
  renderView?: (props: BotmuxSwitchViewProps) => ReactNode;
}

export interface BotmuxSwitchProps {
  machineID: string;
  deps?: BotmuxSwitchDeps;
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

function safeNotify(notify: ((message: string, tone?: BotmuxNoticeTone) => void) | undefined, message: string, tone?: BotmuxNoticeTone) {
  try {
    if (notify) notify(message, tone);
    else toast(message, tone);
  } catch {
    // Notification failures stay non-blocking so recovery never leaves saving stuck.
  }
}

function normalizeRead(raw: BotmuxReadResult): boolean | null {
  if (raw === null || typeof raw === "boolean") return raw;
  return raw.on;
}

function normalizeSave(raw: BotmuxSaveResult, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw && typeof raw === "object" && "on" in raw && typeof raw.on === "boolean") return raw.on;
  return fallback;
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

function useCachedSnapshot<T>(read: () => T, subscribe: ((listener: () => void) => () => void) | undefined): T {
  const cache = useRef<{ has: boolean; value: T | undefined }>({ has: false, value: undefined });
  const getSnapshot = useCallback((): T => {
    const next = read();
    if (cache.current.has && sameValue(cache.current.value, next)) {
      return cache.current.value as T;
    }
    cache.current = { has: true, value: next };
    return next;
  }, [read]);
  return useSyncExternalStore(subscribe ?? noopSubscribe, getSnapshot, getSnapshot);
}

/** Pure presentational view for the machine header's botmux toggle pill. */
export function BotmuxSwitchView({ on, saving = false, onToggle }: BotmuxSwitchViewProps) {
  const hintID = useId();
  if (on === null) return null;

  // A pill like the engine's beside it: a dot and "botmux · on / off"; the footer says what it does on hover and to a
  // screen reader. The hover fill is the off state's only, so hovering the on state does not make it look off.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={t("machines-botmuxswitch.label")}
      aria-describedby={hintID}
      title={t("machines-botmuxswitch.footer")}
      data-testid="botmux-switch"
      disabled={saving}
      onClick={() => onToggle(!on)}
      className={cx(
        "touch-hit inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[11px] font-medium shadow-hairline transition-colors disabled:opacity-60",
        on ? "bg-accent-tint text-accent-ink" : "bg-inset text-ink-2 enabled:hover:bg-hover",
      )}
    >
      <span className={cx("size-1.5 shrink-0 rounded-full", on ? "bg-accent" : "bg-ink-3")} />
      botmux
      <span>· {on ? t("machines-botmuxswitch.on") : t("machines-botmuxswitch.off")}</span>
      <span id={hintID} className="sr-only">{t("machines-botmuxswitch.footer")}</span>
    </button>
  );
}

interface PendingOp {
  epoch: number;
  seq: number;
  controller: AbortController;
}

export function BotmuxSwitch({ machineID, deps }: BotmuxSwitchProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);

  const hasControlledOn = deps?.on !== undefined;
  const onDep = deps?.on;
  const readControlledOn = useCallback((): boolean | null => {
    if (onDep === undefined) return null;
    return typeof onDep === "function" ? onDep() : onDep;
  }, [onDep]);
  const controlledOn = useCachedSnapshot(readControlledOn, typeof onDep === "function" ? deps?.subscribeOn : undefined);

  const targetScope = JSON.stringify([trackedScope.token, machineID]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: targetScope, epoch: 1 }));
  const effectiveEpoch = scope.key === targetScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== targetScope) {
    setScope({ key: targetScope, epoch: effectiveEpoch });
  }

  // Uncontrolled hub value (null until answered) and saving / optimistic states, all fenced to the active epoch.
  const [loadedState, setLoadedState] = useState<{ epoch: number; value: boolean | null }>({ epoch: 0, value: null });
  const [savingState, setSavingState] = useState<{ epoch: number; seq: number; saving: boolean }>({ epoch: 0, seq: 0, saving: false });
  const [optimisticState, setOptimisticState] = useState<{ epoch: number; seq: number; base: boolean; value: boolean } | null>(null);

  const saving = savingState.epoch === effectiveEpoch && savingState.saving;
  const activeOptimistic =
    hasControlledOn
    && saving
    && optimisticState !== null
    && optimisticState.epoch === effectiveEpoch
    && optimisticState.seq === savingState.seq
    && optimisticState.base === controlledOn
      ? optimisticState.value
      : null;

  const on: boolean | null = hasControlledOn
    ? (activeOptimistic !== null ? activeOptimistic : controlledOn)
    : (loadedState.epoch === effectiveEpoch ? loadedState.value : null);

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingReadRef = useRef<PendingOp | null>(null);
  const pendingSaveRef = useRef<PendingOp | null>(null);
  const depsRef = useRef(deps);
  const machineIDRef = useRef(machineID);
  const hasControlledOnRef = useRef(hasControlledOn);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    machineIDRef.current = machineID;
    hasControlledOnRef.current = hasControlledOn;
    readScopeTokenRef.current = trackedScope.readToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pendingReadRef.current?.controller.abort();
      pendingReadRef.current = null;
      pendingSaveRef.current?.controller.abort();
      pendingSaveRef.current = null;
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;
  const capturedMachineID = machineID;

  useEffect(() => {
    if (hasControlledOn) {
      pendingReadRef.current?.controller.abort();
      pendingReadRef.current = null;
      return;
    }

    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    pendingReadRef.current?.controller.abort();
    pendingReadRef.current = { epoch: capturedEpoch, seq: runSeq, controller };

    const isReadCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && readScopeTokenRef.current() === capturedScopeToken
      && machineIDRef.current === capturedMachineID
      && !hasControlledOnRef.current
      && pendingReadRef.current?.seq === runSeq;

    void (async () => {
      try {
        const res = depsRef.current?.readBotmux
          ? await depsRef.current.readBotmux(capturedMachineID, controller.signal)
          : await api<{ on: boolean }>(`/machines/${enc(capturedMachineID)}/botmux`, { signal: controller.signal });
        if (!isReadCurrent()) return;
        setLoadedState({ epoch: capturedEpoch, value: normalizeRead(res) });
      } catch {
        // An older hub has no such route: keep the switch hidden.
        if (isReadCurrent()) setLoadedState({ epoch: capturedEpoch, value: null });
      } finally {
        if (pendingReadRef.current?.seq === runSeq) pendingReadRef.current = null;
      }
    })();

    return () => {
      controller.abort();
      if (pendingReadRef.current?.seq === runSeq) pendingReadRef.current = null;
    };
  }, [capturedEpoch, capturedScopeToken, capturedMachineID, hasControlledOn]);

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken
    && machineIDRef.current === capturedMachineID;

  const reportError = (msg: string, err: unknown) => {
    try {
      depsRef.current?.onError?.(msg, err);
    } catch {
      // Error observer failures stay non-blocking so recovery never leaves saving stuck.
    }
  };

  const change = (next: boolean) => {
    if (!isScopeLive() || pendingSaveRef.current !== null || on === null) return;

    // Cancel any superseded initial read so a late GET cannot clobber the user's toggle.
    pendingReadRef.current?.controller.abort();
    pendingReadRef.current = null;

    const prevOn = on;
    const isControlled = hasControlledOnRef.current;
    const targetMachine = machineIDRef.current;
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    pendingSaveRef.current = { epoch: capturedEpoch, seq: runSeq, controller };

    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && pendingSaveRef.current?.seq === runSeq;

    const finishSuccess = (raw: BotmuxSaveResult) => {
      if (!isRunCurrent()) return;
      if (!isControlled) {
        setLoadedState({ epoch: capturedEpoch, value: normalizeSave(raw, next) });
      }
    };

    const finishError = (err: unknown) => {
      if (!isRunCurrent()) return;
      if (!isControlled) {
        setLoadedState({ epoch: capturedEpoch, value: prevOn });
      }
      const msg = safeFormatError(depsRef.current?.formatError, err);
      safeNotify(depsRef.current?.notify, t("machines-botmuxswitch.save_failed", { error: msg }), "error");
      reportError(msg, err);
    };

    let res: BotmuxSaveResult | Promise<BotmuxSaveResult>;
    try {
      res = depsRef.current?.saveBotmux
        ? depsRef.current.saveBotmux(targetMachine, next, controller.signal)
        : api<{ on: boolean }>(`/machines/${enc(targetMachine)}/botmux`, { method: "PUT", json: { on: next }, signal: controller.signal });
    } catch (err) {
      try {
        finishError(err);
      } finally {
        if (pendingSaveRef.current?.seq === runSeq) pendingSaveRef.current = null;
      }
      return;
    }

    if (!isThenable(res)) {
      try {
        finishSuccess(res);
      } finally {
        if (pendingSaveRef.current?.seq === runSeq) pendingSaveRef.current = null;
      }
      return;
    }

    setSavingState({ epoch: capturedEpoch, seq: runSeq, saving: true });
    if (isControlled) {
      setOptimisticState({ epoch: capturedEpoch, seq: runSeq, base: prevOn, value: next });
    } else {
      setLoadedState({ epoch: capturedEpoch, value: next });
    }

    void (async () => {
      try {
        const awaited = await res;
        finishSuccess(awaited);
      } catch (err) {
        finishError(err);
      } finally {
        if (pendingSaveRef.current?.seq === runSeq) pendingSaveRef.current = null;
        if (activeEpochRef.current === capturedEpoch) {
          setSavingState((prev) => (prev.epoch === capturedEpoch && prev.seq === runSeq ? { epoch: capturedEpoch, seq: runSeq, saving: false } : prev));
          setOptimisticState((prev) => (prev && prev.epoch === capturedEpoch && prev.seq === runSeq ? null : prev));
        }
      }
    })();
  };

  const viewProps: BotmuxSwitchViewProps = {
    on,
    saving,
    onToggle: change,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <BotmuxSwitchView {...viewProps} />;
}
