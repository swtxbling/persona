import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "../../lib/api";
import { ownerHeaders, useChosenManager, useShownManager } from "../../lib/manager-choice";
import { mainRuntimeSummary, type MainExecution } from "../../lib/main-runtime";
import { sameValue } from "../../lib/stable-lines";
import { useStore, type Conn } from "../../lib/store";
import type { AssistantInfo } from "../../lib/types";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const noopSubscribe = () => () => {};

export type MainRuntimeAssistant = Pick<AssistantInfo, "main" | "main_machine_id">;

export interface MainRuntimeFetchParams {
  chosen: string | null;
  manager: string;
  main: string;
  machine?: string;
  signal: AbortSignal;
}

export interface MainRuntimeBadgeViewProps {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  onCollapse: () => void;
}

export interface MainRuntimeBadgeDeps {
  /** Optional scope partition (value or getter); switching it resets loaded state/expanded UI, aborts polling, and fences stale responses. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled assistant info (value or getter; bypasses `useStore(s => s.assistant)` when supplied). */
  assistant?: MainRuntimeAssistant | null | (() => MainRuntimeAssistant | null);
  /** Subscribe to assistant changes when `assistant` is a getter. */
  subscribeAssistant?: (listener: () => void) => () => void;
  /** Controlled hub connection state (value or getter; bypasses `useStore(s => s.conn)` when supplied). */
  conn?: Conn | (() => Conn);
  /** Subscribe to connection changes when `conn` is a getter. */
  subscribeConn?: (listener: () => void) => () => void;
  /** Controlled shown manager id (value or getter; bypasses `useShownManager` when supplied). */
  shownManager?: string | (() => string);
  /** Subscribe to shown manager changes when `shownManager` is a getter. */
  subscribeShownManager?: (listener: () => void) => () => void;
  /** Controlled chosen manager id (value or getter; bypasses `useChosenManager` when supplied). */
  chosenManager?: string | null | (() => string | null);
  /** Subscribe to chosen manager changes when `chosenManager` is a getter. */
  subscribeChosenManager?: (listener: () => void) => () => void;
  /** Shared fallback subscription for getter deps without a dedicated subscriber. */
  subscribe?: (listener: () => void) => () => void;
  /** Controlled main-runtime fetcher (bypasses `api("/assistant?view=main-runtime")` when supplied). */
  fetchMainRuntime?: (params: MainRuntimeFetchParams) => MainExecution | undefined | Promise<MainExecution | undefined>;
  /** Controlled document visibility state (value or getter; bypasses `document.visibilityState` and global listener when supplied). */
  documentVisibility?: DocumentVisibilityState | (() => DocumentVisibilityState);
  /** Subscribe to visibility changes (bypasses `document.addEventListener("visibilitychange")` when supplied). */
  subscribeVisibility?: (listener: () => void) => () => void;
  /** Poll interval in milliseconds (defaults to `15_000`). */
  pollIntervalMs?: number;
  /** Controlled timer scheduler (defaults to `setTimeout`). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Controlled timer cancellation (defaults to `clearTimeout`). */
  clearTimer?: (handle: unknown) => void;
  /** Error observer invoked when fetching main-runtime fails in the active scope. */
  onError?: (error: unknown) => void;
  /** Optional custom view renderer (defaults to `<MainRuntimeBadgeView>`). */
  renderView?: (props: MainRuntimeBadgeViewProps) => ReactNode;
}

export interface MainRuntimeBadgeProps {
  sid?: string;
  starting?: boolean;
  deps?: MainRuntimeBadgeDeps;
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

function useCachedExternalValue<T>(
  source: T | (() => T) | undefined,
  subscribe: ((listener: () => void) => () => void) | undefined,
): T | undefined {
  const cache = useRef<{ has: boolean; value: T | undefined }>({ has: false, value: undefined });
  const getSnapshot = useCallback((): T | undefined => {
    const next = typeof source === "function" ? (source as () => T)() : source;
    if (cache.current.has && sameValue(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { has: true, value: next };
    return next;
  }, [source]);
  const sub = subscribe && typeof source === "function" ? subscribe : noopSubscribe;
  return useSyncExternalStore(sub, getSnapshot, getSnapshot);
}

/** Pure presentational view for the main chat's compact runtime header line. */
export function MainRuntimeBadgeView({ summary, expanded, onToggle, onCollapse }: MainRuntimeBadgeViewProps) {
  if (!summary) return null;
  return (
    <div className="flex shrink-0 justify-end px-3 pb-1 sm:px-4">
      <button
        type="button"
        data-main-runtime
        className="group relative min-w-0 max-w-full rounded-control px-2 py-1 text-xs text-ink-2 hover:bg-hover focus-visible:outline focus-visible:outline-accent"
        aria-label={summary}
        aria-expanded={expanded}
        onClick={onToggle}
        onBlur={onCollapse}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCollapse(); } }}
      >
        <span className="block truncate">{summary}</span>
        <span
          aria-hidden
          className={`pointer-events-none absolute end-0 top-full z-20 max-w-full w-max rounded-control bg-tooltip-bg px-2 py-1 text-start text-tooltip-fg shadow-overlay [overflow-wrap:anywhere] ${expanded ? "block" : "hidden group-hover:block group-focus-visible:block"}`}
        >
          {summary}
        </span>
      </button>
    </div>
  );
}

function DefaultAssistantBridge({ render }: { render: (assistant: MainRuntimeAssistant | null) => ReactNode }) {
  const assistant = useStore((s) => s.assistant);
  return <>{render(assistant)}</>;
}

function DefaultConnBridge({ render }: { render: (conn: Conn) => ReactNode }) {
  const conn = useStore((s) => s.conn);
  return <>{render(conn)}</>;
}

function DefaultShownManagerBridge({ render }: { render: (manager: string) => ReactNode }) {
  const manager = useShownManager();
  return <>{render(manager)}</>;
}

function DefaultChosenManagerBridge({ render }: { render: (chosen: string | null) => ReactNode }) {
  const chosen = useChosenManager();
  return <>{render(chosen)}</>;
}

interface MainRuntimeBadgeBodyProps {
  sid?: string;
  starting?: boolean;
  assistant: MainRuntimeAssistant | null;
  conn: Conn;
  manager: string;
  chosen: string | null;
  controlledVisibility?: DocumentVisibilityState;
  hasControlledVisibility: boolean;
  outerScopeToken: string;
  readOuterScopeToken: () => string;
  deps?: MainRuntimeBadgeDeps;
}

function MainRuntimeBadgeBody({
  sid,
  starting,
  assistant,
  conn,
  manager,
  chosen,
  controlledVisibility,
  hasControlledVisibility,
  outerScopeToken,
  readOuterScopeToken,
  deps,
}: MainRuntimeBadgeBodyProps) {
  const main = assistant?.main;
  const machine = assistant?.main_machine_id;
  const show = !sid || sid === main;
  const activeMain = show ? main : undefined;
  const intervalMs = typeof deps?.pollIntervalMs === "number" && Number.isFinite(deps.pollIntervalMs) && deps.pollIntervalMs >= 0
    ? deps.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;

  const identityScope = JSON.stringify([outerScopeToken, sid ?? "", show, activeMain ?? "", machine ?? "", manager, chosen ?? ""]);
  const [identity, setIdentity] = useState<{ key: string; epoch: number }>(() => ({ key: identityScope, epoch: 1 }));
  const effectiveIdentityEpoch = identity.key === identityScope ? identity.epoch : identity.epoch + 1;
  if (identity.key !== identityScope) {
    setIdentity({ key: identityScope, epoch: effectiveIdentityEpoch });
  }

  const fetchScope = JSON.stringify([effectiveIdentityEpoch, conn, intervalMs]);
  const [fetchState, setFetchState] = useState<{ key: string; epoch: number }>(() => ({ key: fetchScope, epoch: 1 }));
  const effectiveFetchEpoch = fetchState.key === fetchScope ? fetchState.epoch : fetchState.epoch + 1;
  if (fetchState.key !== fetchScope) {
    setFetchState({ key: fetchScope, epoch: effectiveFetchEpoch });
  }

  const [data, setData] = useState<{ identityEpoch: number; manager: string; report: MainExecution } | undefined>(undefined);
  const [expandedState, setExpandedState] = useState<{ epoch: number; expanded: boolean }>({ epoch: 0, expanded: false });
  const expanded = expandedState.epoch === effectiveIdentityEpoch && expandedState.expanded;

  const activeIdentityEpochRef = useRef(0);
  const activeFetchEpochRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const clearActiveTimerRef = useRef<(() => void) | null>(null);
  const triggerLoadRef = useRef<(() => void) | null>(null);
  const depsRef = useRef(deps);
  const readScopeTokenRef = useRef(readOuterScopeToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    readScopeTokenRef.current = readOuterScopeToken;
  });

  useLayoutEffect(() => {
    activeIdentityEpochRef.current = effectiveIdentityEpoch;
    return () => {
      if (activeIdentityEpochRef.current === effectiveIdentityEpoch) activeIdentityEpochRef.current = 0;
    };
  }, [effectiveIdentityEpoch]);

  useLayoutEffect(() => {
    activeFetchEpochRef.current = effectiveFetchEpoch;
    return () => {
      if (activeFetchEpochRef.current === effectiveFetchEpoch) activeFetchEpochRef.current = 0;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      clearActiveTimerRef.current?.();
      clearActiveTimerRef.current = null;
      triggerLoadRef.current = null;
    };
  }, [effectiveFetchEpoch]);

  const capturedIdentityEpoch = effectiveIdentityEpoch;
  const capturedFetchEpoch = effectiveFetchEpoch;
  const capturedScopeToken = outerScopeToken;

  useEffect(() => {
    if (!activeMain) return;
    const controller = new AbortController();
    activeControllerRef.current = controller;

    let hasTimer = false;
    let timerHandle: unknown = undefined;
    let pending = false;

    const clearTimerNow = () => {
      if (!hasTimer) return;
      const handle = timerHandle;
      hasTimer = false;
      timerHandle = undefined;
      try {
        const customClear = depsRef.current?.clearTimer;
        if (customClear) customClear(handle);
        else clearTimeout(handle as ReturnType<typeof setTimeout>);
      } catch {
        // Timer cleanup errors stay non-blocking.
      }
    };
    clearActiveTimerRef.current = clearTimerNow;

    const isCurrent = () =>
      !controller.signal.aborted
      && activeFetchEpochRef.current === capturedFetchEpoch
      && activeIdentityEpochRef.current === capturedIdentityEpoch
      && readScopeTokenRef.current() === capturedScopeToken;

    const readVisibility = (): DocumentVisibilityState => {
      const vis = depsRef.current?.documentVisibility;
      if (vis !== undefined) return typeof vis === "function" ? vis() : vis;
      return typeof document !== "undefined" ? document.visibilityState : "visible";
    };

    const reportError = (err: unknown) => {
      try {
        depsRef.current?.onError?.(err);
      } catch {
        // Error observer failures stay non-blocking so polling recovery continues.
      }
    };

    const load = async () => {
      if (!isCurrent() || readVisibility() === "hidden" || pending) return;
      clearTimerNow();
      pending = true;
      try {
        const customFetch = depsRef.current?.fetchMainRuntime;
        const report = await (customFetch
          ? customFetch({ chosen, manager, main: activeMain, machine, signal: controller.signal })
          : api<MainExecution>("/assistant?view=main-runtime", {
              headers: ownerHeaders(chosen ?? undefined),
              signal: controller.signal,
            }));
        if (isCurrent()) {
          setData(report && report.session_id === activeMain && report.state
            ? { identityEpoch: capturedIdentityEpoch, manager, report }
            : undefined);
        }
      } catch (err) {
        if (isCurrent()) {
          setData(undefined);
          reportError(err);
        }
      } finally {
        pending = false;
        if (isCurrent()) {
          try {
            const schedule = depsRef.current?.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
            timerHandle = schedule(() => {
              hasTimer = false;
              timerHandle = undefined;
              if (isCurrent()) void load();
            }, intervalMs);
            hasTimer = true;
          } catch (err) {
            if (isCurrent()) reportError(err);
          }
        }
      }
    };

    triggerLoadRef.current = () => {
      if (isCurrent() && readVisibility() === "visible") void load();
    };

    void load();

    return () => {
      controller.abort();
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
      clearTimerNow();
      if (clearActiveTimerRef.current === clearTimerNow) clearActiveTimerRef.current = null;
      triggerLoadRef.current = null;
    };
  }, [activeMain, machine, manager, chosen, intervalMs, capturedIdentityEpoch, capturedFetchEpoch, capturedScopeToken]);

  const subscribeVisibility = deps?.subscribeVisibility;
  useEffect(() => {
    if (!activeMain) return;
    if (subscribeVisibility) {
      return subscribeVisibility(() => {
        triggerLoadRef.current?.();
      });
    }
    if (hasControlledVisibility) return;
    const onVisible = () => {
      triggerLoadRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeMain, subscribeVisibility, hasControlledVisibility]);

  const prevControlledVisibilityRef = useRef(controlledVisibility);
  useEffect(() => {
    const prev = prevControlledVisibilityRef.current;
    prevControlledVisibilityRef.current = controlledVisibility;
    if (hasControlledVisibility && !subscribeVisibility && prev !== "visible" && controlledVisibility === "visible") {
      triggerLoadRef.current?.();
    }
  }, [hasControlledVisibility, subscribeVisibility, controlledVisibility]);

  const report =
    data
    && data.identityEpoch === effectiveIdentityEpoch
    && data.manager === manager
    && data.report.session_id === activeMain
    && (!machine || !data.report.machine_id || data.report.machine_id === machine)
      ? data.report
      : undefined;

  if (!show || (!assistant && !starting)) return null;
  const summary = mainRuntimeSummary(main, report, starting);
  // nothing known about where the main chat runs: no line at all (not "not reported")
  if (!summary) return null;

  const handleToggle = () => {
    if (activeIdentityEpochRef.current !== capturedIdentityEpoch || readScopeTokenRef.current() !== capturedScopeToken) return;
    setExpandedState((cur) => ({
      epoch: capturedIdentityEpoch,
      expanded: cur.epoch === capturedIdentityEpoch ? !cur.expanded : true,
    }));
  };

  const handleCollapse = () => {
    if (activeIdentityEpochRef.current !== capturedIdentityEpoch || readScopeTokenRef.current() !== capturedScopeToken) return;
    setExpandedState({ epoch: capturedIdentityEpoch, expanded: false });
  };

  const viewProps: MainRuntimeBadgeViewProps = {
    summary,
    expanded,
    onToggle: handleToggle,
    onCollapse: handleCollapse,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <MainRuntimeBadgeView {...viewProps} />;
}

/** A separate, compact header line so the main badge never competes with composer controls. */
export function MainRuntimeBadge({ sid, starting, deps }: MainRuntimeBadgeProps = {}) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey ?? deps?.subscribe);

  // Keep controlled inputs and scope tracking in the identity-stable outer component so direct <-> getter+subscribe switches never remount.
  const controlledAssistant = useCachedExternalValue(deps?.assistant, deps?.subscribeAssistant ?? deps?.subscribe);
  const controlledConn = useCachedExternalValue(deps?.conn, deps?.subscribeConn ?? deps?.subscribe);
  const controlledShownManager = useCachedExternalValue(deps?.shownManager, deps?.subscribeShownManager ?? deps?.subscribe);
  const controlledChosenManager = useCachedExternalValue(deps?.chosenManager, deps?.subscribeChosenManager ?? deps?.subscribe);
  const controlledVisibility = useCachedExternalValue(deps?.documentVisibility, deps?.subscribeVisibility ?? deps?.subscribe);

  const needDefaultAssistant = deps?.assistant === undefined;
  const needDefaultConn = deps?.conn === undefined;
  const needDefaultShownManager = deps?.shownManager === undefined;
  const needDefaultChosenManager = deps?.chosenManager === undefined;
  const hasControlledVisibility = deps?.documentVisibility !== undefined;

  const renderBody = (assistant: MainRuntimeAssistant | null, conn: Conn, manager: string, chosen: string | null) => (
    <MainRuntimeBadgeBody
      sid={sid}
      starting={starting}
      assistant={assistant}
      conn={conn}
      manager={manager}
      chosen={chosen}
      controlledVisibility={controlledVisibility}
      hasControlledVisibility={hasControlledVisibility}
      outerScopeToken={trackedScope.token}
      readOuterScopeToken={trackedScope.readToken}
      deps={deps}
    />
  );

  const renderWithChosen = (assistant: MainRuntimeAssistant | null, conn: Conn, manager: string) => (
    needDefaultChosenManager
      ? <DefaultChosenManagerBridge render={(chosen) => renderBody(assistant, conn, manager, chosen)} />
      : renderBody(assistant, conn, manager, controlledChosenManager ?? null)
  );

  const renderWithShown = (assistant: MainRuntimeAssistant | null, conn: Conn) => (
    needDefaultShownManager
      ? <DefaultShownManagerBridge render={(manager) => renderWithChosen(assistant, conn, manager)} />
      : renderWithChosen(assistant, conn, controlledShownManager ?? "")
  );

  const renderWithConn = (assistant: MainRuntimeAssistant | null) => (
    needDefaultConn
      ? <DefaultConnBridge render={(conn) => renderWithShown(assistant, conn)} />
      : renderWithShown(assistant, controlledConn ?? "online")
  );

  if (needDefaultAssistant) {
    return <DefaultAssistantBridge render={renderWithConn} />;
  }
  return renderWithConn(controlledAssistant ?? null);
}
