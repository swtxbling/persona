// "herdr is not running on <computer>" with "Start", at the top of the Agents list (#1916, lib/herdr-notice.ts): one row per online
// machine on classic herdr whose server does not answer. Asked while the page is visible; a failed start says why in
// words, and the hub's own text with its request id is behind "Copy details" (right click / the copy button), not in the row.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { HERDR_POLL_MS, HerdrWatch, herdrWatched, type HerdrFailure, type HerdrSnapshot } from "../../lib/herdr-notice";
import { sameValue } from "../../lib/stable-lines";
import { useStore } from "../../lib/store";
import type { Machine } from "../../lib/types";
import { contextMenuProps } from "../../ui/context-menu";
import { Icon } from "../../ui/icons";
import { Menu, Spinner, copyText } from "../../ui/atoms";
import type { MenuAt } from "../../ui/menu-model";
import { t } from "../../i18n";

export interface HerdrNoticeRowItem {
  machine: Machine;
  starting: boolean;
  failure?: HerdrFailure;
}

export interface HerdrNoticeRowViewProps {
  machine: Machine;
  starting: boolean;
  failure?: HerdrFailure;
  menu?: MenuAt | null;
  onStart: () => void;
  onCopyDetail: (detail: string) => void;
  onOpenMenu?: (at: MenuAt) => void;
  onCloseMenu?: () => void;
}

export interface HerdrNoticesViewProps {
  rows: readonly HerdrNoticeRowItem[];
  openMenu?: { machineId: string; at: MenuAt } | null;
  onStart: (machineId: string) => void;
  onCopyDetail: (detail: string, machineId: string) => void;
  onOpenMenu: (machineId: string, at: MenuAt) => void;
  onCloseMenu: () => void;
}

export interface HerdrNoticesDeps {
  /** Optional scope partition (value or getter); switching it resets open menus and aborts/fences in-flight poll, start, and copy calls. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled machines list or getter (bypasses `useStore` when supplied). */
  machines?: readonly Machine[] | (() => readonly Machine[]);
  /** Subscribe to machines updates when `machines` is a getter. */
  subscribeMachines?: (listener: () => void) => () => void;
  /** Controlled `HerdrWatch` instance (overrides default `new HerdrWatch()`). */
  watch?: HerdrWatch;
  /** Controlled herdr snapshot or getter (bypasses default `HerdrWatch` when supplied). */
  snapshot?: HerdrSnapshot | (() => HerdrSnapshot);
  /** Subscribe to controlled snapshot updates when `snapshot` is a getter. */
  subscribeSnapshot?: (listener: () => void) => () => void;
  /** Controlled poll handler (sync or async; bypasses `HerdrWatch.refresh` when supplied). */
  refresh?: (watched: Machine[], signal: AbortSignal) => void | Promise<unknown>;
  /** Controlled start handler (sync or async; bypasses `HerdrWatch.start` when supplied). */
  start?: (machineId: string, signal: AbortSignal) => void | Promise<unknown>;
  /** Controlled clipboard copy handler (sync or async; bypasses `atoms.copyText` when supplied). */
  copyText?: (text: string, signal: AbortSignal) => boolean | void | Promise<boolean | void>;
  /** Controlled document visibility state or getter (bypasses `document.visibilityState` and `visibilitychange` listener when supplied). */
  documentVisibility?: DocumentVisibilityState | (() => DocumentVisibilityState);
  /** Subscribe to visibility changes (bypasses `document` `visibilitychange` listener when supplied). */
  subscribeVisibility?: (listener: () => void) => () => void;
  /** Poll interval in milliseconds (defaults to `HERDR_POLL_MS`). */
  pollIntervalMs?: number;
  /** Custom interval scheduler (defaults to global `setInterval`). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** Custom interval canceller (defaults to global `clearInterval`). */
  clearInterval?: (id: unknown) => void;
  /** Error observer invoked when controlled poll, start, or copy throws or rejects in the active scope. */
  onError?: (error: unknown) => void;
  /** Optional custom view renderer (defaults to `<HerdrNoticesView>`). */
  renderView?: (props: HerdrNoticesViewProps) => ReactNode;
}

export interface HerdrNoticesProps {
  watch?: HerdrWatch;
  deps?: HerdrNoticesDeps;
}

const EMPTY_SNAPSHOT: HerdrSnapshot = { stopped: new Set(), starting: new Set(), failures: new Map() };
const EMPTY_MACHINES: readonly Machine[] = [];
const noopSubscribe = () => () => {};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<unknown>).then === "function";
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

/** The machines the rows can be about, as a key: their ids and engines, not each heartbeat of theirs. */
function watchKey(machines: readonly Machine[]): string {
  return machines.filter(herdrWatched).map((m) => `${m.id} ${m.engine ?? ""}`).sort().join("|");
}

/** Pure presentational view for a single stopped-herdr machine notice row. */
export function HerdrNoticeRowView({
  machine,
  starting,
  failure,
  menu = null,
  onStart,
  onCopyDetail,
  onOpenMenu,
  onCloseMenu,
}: HerdrNoticeRowViewProps) {
  const name = machine.name || machine.id;
  return (
    <div data-testid="herdr-notice" className="relative z-10 flex items-start gap-2 rounded-[7px] px-2 py-1.5 [@media(pointer:coarse)]:min-h-11">
      <span className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center text-orange">
        {starting ? <Spinner size={11} /> : <Icon name="warning" size={13} stroke={2.2} />}
      </span>
      <div className="min-w-0 flex-1" aria-live="polite">
        <div className="text-[13px] leading-[1.45] text-ink-2">{starting ? t("herdr-notice.starting", { machine: name }) : t("herdr-notice.not_running", { machine: name })}</div>
        {!starting && failure && (
          <div className="mt-0.5 flex items-start gap-1">
            <span data-testid="herdr-notice-failure" tabIndex={0} {...contextMenuProps((at) => onOpenMenu?.(at))} className="line-clamp-3 min-w-0 flex-1 text-[12px] leading-[1.45] text-red">
              {t("herdr-notice.failed", { reason: failure.text })}
            </span>
            <button type="button" aria-label={t("herdr-notice.copy_detail")} title={t("herdr-notice.copy_detail")} onClick={() => onCopyDetail(failure.detail)} className="touch-hit -mt-0.5 shrink-0 rounded-control p-1 text-ink-3 hover:bg-hover hover:text-ink-2">
              <Icon name="copy" size={12} stroke={2} />
            </button>
          </div>
        )}
      </div>
      {/* Kept while it starts, unseen: the row keeps its height. */}
      <button
        type="button"
        onClick={onStart}
        disabled={starting}
        aria-hidden={starting || undefined}
        tabIndex={starting ? -1 : undefined}
        className={`touch-hit shrink-0 whitespace-nowrap rounded-control px-2 py-0.5 text-[12px] font-medium text-accent-ink hover:bg-hover ${starting ? "invisible" : ""}`}
      >
        {t("herdr-notice.start")}
      </button>
      {menu && !starting && failure && (
        <Menu anchor={menu.anchor ?? null} point={menu.point} onClose={() => onCloseMenu?.()} items={[{ key: "copy", label: t("herdr-notice.copy_detail"), icon: "copy", onSelect: () => onCopyDetail(failure.detail) }]} />
      )}
    </div>
  );
}

/** Pure presentational view for the stopped-herdr notice list. */
export function HerdrNoticesView({ rows, openMenu = null, onStart, onCopyDetail, onOpenMenu, onCloseMenu }: HerdrNoticesViewProps) {
  if (!rows.length) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-0.5">
      {rows.map((row) => (
        <HerdrNoticeRowView
          key={row.machine.id}
          machine={row.machine}
          starting={row.starting}
          failure={row.failure}
          menu={openMenu && openMenu.machineId === row.machine.id ? openMenu.at : null}
          onStart={() => onStart(row.machine.id)}
          onCopyDetail={(detail) => onCopyDetail(detail, row.machine.id)}
          onOpenMenu={(at) => onOpenMenu(row.machine.id, at)}
          onCloseMenu={onCloseMenu}
        />
      ))}
    </div>
  );
}

function DefaultMachinesBridge({ render }: { render: (machines: readonly Machine[]) => ReactNode }) {
  const machines = useStore((s) => s.machines);
  return <>{render(machines)}</>;
}

function DefaultWatchBridge({ render }: { render: (watch: HerdrWatch) => ReactNode }) {
  const [watch] = useState(() => new HerdrWatch());
  return <>{render(watch)}</>;
}

interface PendingOp {
  seq: number;
  controller: AbortController;
}

interface HerdrNoticesBodyProps {
  machines: readonly Machine[];
  activeWatch: HerdrWatch | null;
  controlledSnapshot: HerdrSnapshot | undefined;
  controlledVisibility: DocumentVisibilityState | undefined;
  outerScopeToken: string;
  readOuterScopeToken: () => string;
  deps?: HerdrNoticesDeps;
}

function HerdrNoticesBody({
  machines,
  activeWatch,
  controlledSnapshot,
  controlledVisibility,
  outerScopeToken,
  readOuterScopeToken,
  deps,
}: HerdrNoticesBodyProps) {
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: outerScopeToken, epoch: 1 }));
  const effectiveEpoch = scope.key === outerScopeToken ? scope.epoch : scope.epoch + 1;
  if (scope.key !== outerScopeToken) {
    setScope({ key: outerScopeToken, epoch: effectiveEpoch });
  }

  const hasControlledSnapshot = deps?.snapshot !== undefined || deps?.subscribeSnapshot !== undefined;
  const watchSnapSub = !hasControlledSnapshot && activeWatch ? activeWatch.subscribe : noopSubscribe;
  const watchSnap = useSyncExternalStore(
    watchSnapSub,
    () => (!hasControlledSnapshot && activeWatch ? activeWatch.snapshot() : EMPTY_SNAPSHOT),
    () => (!hasControlledSnapshot && activeWatch ? activeWatch.snapshot() : EMPTY_SNAPSHOT),
  );
  const snap = hasControlledSnapshot ? (controlledSnapshot ?? EMPTY_SNAPSHOT) : watchSnap;

  const key = watchKey(machines);
  const watched = useMemo(() => machines.filter(herdrWatched), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling depends on ids and engines; labels must follow a rename even when that polling set stays the same.
  const rows = useMemo<HerdrNoticeRowItem[]>(
    () => machines
      .filter((m) => herdrWatched(m) && snap.stopped.has(m.id))
      .map((machine) => ({
        machine,
        starting: snap.starting.has(machine.id),
        failure: snap.failures.get(machine.id),
      })),
    [machines, snap],
  );

  const [menuState, setMenuState] = useState<{ epoch: number; machineId: string; at: MenuAt } | null>(null);
  const liveMenu = menuState
    && menuState.epoch === effectiveEpoch
    && rows.some((r) => r.machine.id === menuState.machineId && !r.starting && Boolean(r.failure))
    ? { machineId: menuState.machineId, at: menuState.at }
    : null;

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pollOpRef = useRef<PendingOp | null>(null);
  const startOpsRef = useRef<Map<string, PendingOp>>(new Map());
  const copyOpRef = useRef<PendingOp | null>(null);
  const triggerPollRef = useRef<(() => void) | null>(null);
  const depsRef = useRef(deps);
  const activeWatchRef = useRef(activeWatch);
  const watchedRef = useRef(watched);
  const readScopeTokenRef = useRef(readOuterScopeToken);
  const readVisibilityRef = useRef<() => DocumentVisibilityState>(() => "visible");

  useLayoutEffect(() => {
    depsRef.current = deps;
    activeWatchRef.current = activeWatch;
    watchedRef.current = watched;
    readScopeTokenRef.current = readOuterScopeToken;
    readVisibilityRef.current = () => {
      const vis = deps?.documentVisibility;
      if (typeof vis === "function") return vis();
      if (vis !== undefined) return vis;
      return typeof document === "undefined" ? "visible" : document.visibilityState;
    };
  });

  // Clear stale menu state when its row or failure vanishes so a later reappearance (ABA) does not reopen it.
  useLayoutEffect(() => {
    if (menuState && (menuState.epoch !== effectiveEpoch || !liveMenu)) {
      setMenuState(null);
    }
  }, [menuState, effectiveEpoch, liveMenu]);

  // Abort in-flight start calls for machines that leave the watched set.
  useLayoutEffect(() => {
    const ids = new Set(watched.map((m) => m.id));
    startOpsRef.current.forEach((op, id) => {
      if (!ids.has(id)) {
        op.controller.abort();
        startOpsRef.current.delete(id);
      }
    });
  }, [key, watched]);

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pollOpRef.current?.controller.abort();
      pollOpRef.current = null;
      startOpsRef.current.forEach((op) => op.controller.abort());
      startOpsRef.current.clear();
      copyOpRef.current?.controller.abort();
      copyOpRef.current = null;
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = outerScopeToken;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  const reportError = (err: unknown) => {
    try {
      depsRef.current?.onError?.(err);
    } catch {
      // Error observer failures stay non-blocking.
    }
  };

  const hasRefresh = deps?.refresh !== undefined;
  const pollIntervalMs = deps?.pollIntervalMs ?? HERDR_POLL_MS;
  const customSetInterval = deps?.setInterval;
  const customClearInterval = deps?.clearInterval;
  const customSubVis = deps?.subscribeVisibility;
  const hasControlledVisibility = deps?.documentVisibility !== undefined || customSubVis !== undefined;

  useEffect(() => {
    if (!hasRefresh && !activeWatch) return;
    let dead = false;
    let busy = false;
    const read = () => {
      if (dead || busy || !isScopeLive() || readVisibilityRef.current() !== "visible") return;
      const runRefresh = depsRef.current?.refresh;
      const w = activeWatchRef.current;
      if (!runRefresh && !w) return;
      const controller = new AbortController();
      const runSeq = ++opSeqRef.current;
      pollOpRef.current?.controller.abort();
      pollOpRef.current = { seq: runSeq, controller };
      const isRunCurrent = () =>
        !dead
        && !controller.signal.aborted
        && isScopeLive()
        && pollOpRef.current?.seq === runSeq;

      busy = true;
      let result: unknown;
      try {
        result = runRefresh ? runRefresh(watchedRef.current, controller.signal) : w!.refresh(watchedRef.current);
      } catch (err) {
        if (isRunCurrent()) reportError(err);
        if (pollOpRef.current?.seq === runSeq) pollOpRef.current = null;
        busy = false;
        return;
      }
      if (!isThenable(result)) {
        if (pollOpRef.current?.seq === runSeq) pollOpRef.current = null;
        busy = false;
        return;
      }
      void (async () => {
        try {
          await result;
        } catch (err) {
          if (isRunCurrent()) reportError(err);
        } finally {
          if (pollOpRef.current?.seq === runSeq) pollOpRef.current = null;
          busy = false;
        }
      })();
    };

    triggerPollRef.current = read;
    read();
    const timer = customSetInterval ? customSetInterval(read, pollIntervalMs) : setInterval(read, pollIntervalMs);
    let offVis: (() => void) | undefined;
    if (customSubVis) {
      offVis = customSubVis(read);
    } else if (!hasControlledVisibility && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", read);
      offVis = () => document.removeEventListener("visibilitychange", read);
    }
    return () => {
      dead = true;
      if (triggerPollRef.current === read) triggerPollRef.current = null;
      pollOpRef.current?.controller.abort();
      pollOpRef.current = null;
      if (customClearInterval) customClearInterval(timer);
      else clearInterval(timer as ReturnType<typeof setInterval>);
      offVis?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveEpoch, key, activeWatch, hasRefresh, pollIntervalMs, customSetInterval, customClearInterval, customSubVis, hasControlledVisibility]);

  // Trigger an immediate poll when a direct `documentVisibility` prop transitions to "visible".
  const prevControlledVisRef = useRef<DocumentVisibilityState | undefined>(controlledVisibility);
  useEffect(() => {
    const prev = prevControlledVisRef.current;
    prevControlledVisRef.current = controlledVisibility;
    if (deps?.documentVisibility !== undefined && !customSubVis && prev !== "visible" && controlledVisibility === "visible") {
      triggerPollRef.current?.();
    }
  }, [controlledVisibility, deps?.documentVisibility, customSubVis]);

  const handleStart = (machineId: string) => {
    if (!isScopeLive() || startOpsRef.current.has(machineId)) return;
    const customStart = depsRef.current?.start;
    const w = activeWatchRef.current;
    if (!customStart && !w) return;
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    startOpsRef.current.set(machineId, { seq: runSeq, controller });
    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && startOpsRef.current.get(machineId)?.seq === runSeq;

    let result: unknown;
    try {
      result = customStart ? customStart(machineId, controller.signal) : w!.start(machineId);
    } catch (err) {
      if (isRunCurrent()) reportError(err);
      if (startOpsRef.current.get(machineId)?.seq === runSeq) startOpsRef.current.delete(machineId);
      return;
    }
    if (!isThenable(result)) {
      if (startOpsRef.current.get(machineId)?.seq === runSeq) startOpsRef.current.delete(machineId);
      return;
    }
    void (async () => {
      try {
        await result;
      } catch (err) {
        if (isRunCurrent()) reportError(err);
      } finally {
        if (startOpsRef.current.get(machineId)?.seq === runSeq) startOpsRef.current.delete(machineId);
      }
    })();
  };

  const handleCopyDetail = (detail: string, _machineId: string) => {
    if (!isScopeLive()) return;
    copyOpRef.current?.controller.abort();
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    copyOpRef.current = { seq: runSeq, controller };
    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && copyOpRef.current?.seq === runSeq;

    const customCopy = depsRef.current?.copyText;
    let result: unknown;
    try {
      result = customCopy ? customCopy(detail, controller.signal) : copyText(detail);
    } catch (err) {
      if (isRunCurrent()) reportError(err);
      if (copyOpRef.current?.seq === runSeq) copyOpRef.current = null;
      return;
    }
    if (!isThenable(result)) {
      if (copyOpRef.current?.seq === runSeq) copyOpRef.current = null;
      return;
    }
    void (async () => {
      try {
        await result;
      } catch (err) {
        if (isRunCurrent()) reportError(err);
      } finally {
        if (copyOpRef.current?.seq === runSeq) copyOpRef.current = null;
      }
    })();
  };

  const handleOpenMenu = (machineId: string, at: MenuAt) => {
    if (!isScopeLive()) return;
    setMenuState({ epoch: capturedEpoch, machineId, at });
  };

  const handleCloseMenu = () => {
    if (!isScopeLive()) return;
    setMenuState(null);
  };

  const viewProps: HerdrNoticesViewProps = {
    rows,
    openMenu: liveMenu,
    onStart: handleStart,
    onCopyDetail: handleCopyDetail,
    onOpenMenu: handleOpenMenu,
    onCloseMenu: handleCloseMenu,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <HerdrNoticesView {...viewProps} />;
}

export function HerdrNotices({ watch: given, deps }: HerdrNoticesProps = {}) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const controlledMachines = useCachedExternalValue(deps?.machines, deps?.subscribeMachines);
  const controlledSnapshot = useCachedExternalValue(deps?.snapshot, deps?.subscribeSnapshot);
  const controlledVisibility = useCachedExternalValue(deps?.documentVisibility, deps?.subscribeVisibility);

  const explicitWatch = deps?.watch ?? given ?? null;
  const needDefaultMachines = deps?.machines === undefined;
  const needDefaultWatch =
    explicitWatch === null
    && deps?.snapshot === undefined
    && deps?.subscribeSnapshot === undefined
    && deps?.refresh === undefined
    && deps?.start === undefined;

  const renderBody = (machines: readonly Machine[], activeWatch: HerdrWatch | null) => (
    <HerdrNoticesBody
      machines={machines}
      activeWatch={activeWatch}
      controlledSnapshot={controlledSnapshot}
      controlledVisibility={controlledVisibility}
      outerScopeToken={trackedScope.token}
      readOuterScopeToken={trackedScope.readToken}
      deps={deps}
    />
  );

  const renderWithWatch = (machines: readonly Machine[]) => (
    needDefaultWatch
      ? <DefaultWatchBridge render={(watch) => renderBody(machines, watch)} />
      : renderBody(machines, explicitWatch)
  );

  if (needDefaultMachines) {
    return <DefaultMachinesBridge render={renderWithWatch} />;
  }
  return renderWithWatch(controlledMachines ?? EMPTY_MACHINES);
}
