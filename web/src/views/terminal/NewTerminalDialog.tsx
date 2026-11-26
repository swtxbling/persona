import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../i18n";
import { api, enc, errorText } from "../../lib/api";
import { useScopedMachines } from "../../lib/current-assistant";
import { navigate, type Route } from "../../lib/router";
import { sameValue } from "../../lib/stable-lines";
import { useStore } from "../../lib/store";
import { usePanes, type Listing } from "../../lib/terminal-panes";
import { buildTerminalTree, homeShellHost, type TermSpace } from "../../lib/terminals";
import type { Machine } from "../../lib/types";
import { Button, Dialog } from "../../ui/atoms";

export type NewTerminalTarget =
  | { kind: string; workspace_id: string }
  | { kind: string; cwd: "~"; new_space: true };

export interface NewTerminalDialogPanes {
  listing: Record<string, Listing>;
  busy: boolean;
  refresh?: () => void | Promise<unknown>;
}

export interface NewTerminalDialogChoice {
  machine: Machine;
  spaces: readonly TermSpace[];
  home: string | undefined;
  listing?: Listing;
}

export interface NewTerminalDialogViewProps {
  open: boolean;
  busy: boolean;
  pending: boolean;
  error: string;
  choices: readonly NewTerminalDialogChoice[];
  onClose: () => void;
  onRetry: () => void;
  onStart: (mid: string, at: NewTerminalTarget) => void;
}

export interface NewTerminalDialogDeps {
  /** Optional scope partition (value or getter); switching it aborts in-flight creation, resets error/pending, and fences stale responses. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled machine list or getter (bypasses `useScopedMachines` when supplied). */
  machines?: readonly Machine[] | (() => readonly Machine[]);
  /** Subscribe to machine updates when `machines` is a getter. */
  subscribeMachines?: (listener: () => void) => () => void;
  /** Controlled terminal panes state or getter (bypasses `usePanes` when supplied). */
  panes?: NewTerminalDialogPanes | (() => NewTerminalDialogPanes);
  /** Subscribe to panes updates when `panes` is a getter. */
  subscribePanes?: (listener: () => void) => () => void;
  /** Controlled `pane_new_space` capability or getter (bypasses `useStore` when supplied). */
  canNewSpace?: boolean | (() => boolean);
  /** Subscribe to capability updates when `canNewSpace` is a getter. */
  subscribeCanNewSpace?: (listener: () => void) => () => void;
  /** Open a terminal pane on `mid` (defaults to `POST /machines/{mid}/panes`). */
  openTerminal?: (mid: string, at: NewTerminalTarget, signal: AbortSignal) => Promise<{ terminal: string }> | { terminal: string };
  /** Route navigation override (defaults to `router.navigate`). */
  navigate?: (route: Route, replace?: boolean, state?: Record<string, unknown> | null) => void;
  /** Format thrown creation errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when creation throws or rejects in the active scope. */
  onError?: (message: string, error: unknown) => void;
  /** Optional custom dialog renderer (defaults to `<NewTerminalDialogView>`). */
  renderView?: (props: NewTerminalDialogViewProps) => ReactNode;
}

export interface NewTerminalDialogProps {
  open: boolean;
  onClose: () => void;
  onOpened?: () => void;
  deps?: NewTerminalDialogDeps;
}

interface PanesData {
  listing: Record<string, Listing>;
  busy: boolean;
}

const noopSubscribe = () => () => {};
const EMPTY_MACHINES: readonly Machine[] = [];
const EMPTY_PANES_DATA: PanesData = { listing: {}, busy: false };

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

function safeReportError(onError: ((message: string, error: unknown) => void) | undefined, message: string, error: unknown) {
  try {
    onError?.(message, error);
  } catch {
    // Error observer failures stay non-blocking so recovery never leaves pending stuck.
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

function useCachedExternal<T>(
  source: T | (() => T) | undefined,
  subscribe: ((listener: () => void) => () => void) | undefined,
  fallback: T,
): T {
  const isGetter = typeof source === "function";
  const sub = useMemo(
    () => (isGetter && subscribe ? subscribe : noopSubscribe),
    [isGetter, subscribe],
  );
  const cache = useRef<{ has: boolean; value: T }>({ has: false, value: fallback });
  const getSnapshot = useCallback((): T => {
    const next = source === undefined ? fallback : isGetter ? (source as () => T)() : source;
    if (cache.current.has && sameValue(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { has: true, value: next };
    return next;
  }, [source, isGetter, fallback]);
  return useSyncExternalStore(sub, getSnapshot, getSnapshot);
}

function useCachedPanesData(
  source: NewTerminalDialogPanes | (() => NewTerminalDialogPanes) | undefined,
  subscribe: ((listener: () => void) => () => void) | undefined,
): PanesData {
  const isGetter = typeof source === "function";
  const sub = useMemo(
    () => (isGetter && subscribe ? subscribe : noopSubscribe),
    [isGetter, subscribe],
  );
  const cache = useRef<{ has: boolean; value: PanesData }>({ has: false, value: EMPTY_PANES_DATA });
  const getSnapshot = useCallback((): PanesData => {
    if (source === undefined) return EMPTY_PANES_DATA;
    const raw = isGetter ? (source as () => NewTerminalDialogPanes)() : source;
    const next: PanesData = { listing: raw.listing, busy: raw.busy };
    if (cache.current.has && sameValue(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { has: true, value: next };
    return next;
  }, [source, isGetter]);
  return useSyncExternalStore(sub, getSnapshot, getSnapshot);
}

function DefaultMachinesBridge({ render }: { render: (machines: readonly Machine[]) => ReactNode }) {
  const machines = useScopedMachines();
  return <>{render(machines)}</>;
}

function DefaultPanesBridge({
  machines,
  open,
  render,
}: {
  machines: readonly Machine[];
  open: boolean;
  render: (panes: NewTerminalDialogPanes) => ReactNode;
}) {
  const panes = usePanes(machines as Machine[], open);
  return <>{render(panes)}</>;
}

function DefaultCanNewSpaceBridge({ render }: { render: (canNewSpace: boolean) => ReactNode }) {
  const canNewSpace = useStore((s) => s.features.includes("pane_new_space"));
  return <>{render(canNewSpace)}</>;
}

/** Pure presentational dialog view for opening a plain terminal in a workspace or home space. */
export function NewTerminalDialogView({
  open,
  busy,
  pending,
  error,
  choices,
  onClose,
  onRetry,
  onStart,
}: NewTerminalDialogViewProps) {
  return (
    <Dialog open={open} onClose={onClose} title={t("terminal-terminalpage.new_terminal")}>
      <div className="space-y-3">
        {busy && <p role="status" className="text-xs text-ink-3">{t("terminal-terminalpage.loading")}</p>}
        {!choices.length && <p className="text-sm text-ink-2">{t("terminal-terminalpage.none_online")}</p>}
        {choices.map(({ machine, spaces, home, listing }) => (
          <section key={machine.id} className="space-y-2">
            <h2 className="text-sm font-medium text-ink">{machine.name}</h2>
            {listing?.error ? (
              <div role="alert" className="text-xs text-red">
                {listing.error} <Button tone="quiet" onClick={onRetry}>{t("sidebar.retry")}</Button>
              </div>
            ) : (
              <div className="flex flex-col items-stretch gap-2">
                {spaces.map((space) => (
                  <Button
                    key={`${space.host}/${space.id}`}
                    disabled={pending}
                    onClick={() => onStart(machine.id, { kind: space.host, workspace_id: space.id })}
                  >
                    {t("terminal-terminalpage.new_in_space", { name: space.label })}
                  </Button>
                ))}
                {!spaces.length && home && (
                  <Button disabled={pending} onClick={() => onStart(machine.id, { kind: home, cwd: "~", new_space: true })}>
                    {t("terminal-terminalpage.new_terminal")}
                  </Button>
                )}
                {!busy && listing?.data && !spaces.length && !home && (
                  <p className="text-xs text-ink-3">{t("terminal-terminalpage.no_panes_agent")}</p>
                )}
              </div>
            )}
          </section>
        ))}
        {error && <p role="alert" className="text-xs text-red">{error}</p>}
        {pending && <p role="status" className="text-xs text-ink-3">{t("terminal-terminalpage.loading")}</p>}
      </div>
    </Dialog>
  );
}

interface NewTerminalDialogControllerProps extends NewTerminalDialogProps {
  machines: readonly Machine[];
  defaultPanes?: NewTerminalDialogPanes;
  defaultCanNewSpace?: boolean;
}

function NewTerminalDialogController({
  open,
  onClose,
  onOpened,
  deps,
  machines,
  defaultPanes,
  defaultCanNewSpace,
}: NewTerminalDialogControllerProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const controlledPanes = useCachedPanesData(deps?.panes, deps?.subscribePanes);
  const controlledCanNewSpace = useCachedExternal(deps?.canNewSpace, deps?.subscribeCanNewSpace, false);

  const listing = deps?.panes !== undefined ? controlledPanes.listing : (defaultPanes?.listing ?? EMPTY_PANES_DATA.listing);
  const busy = deps?.panes !== undefined ? controlledPanes.busy : (defaultPanes?.busy ?? false);
  const newSpace = deps?.canNewSpace !== undefined ? controlledCanNewSpace : Boolean(defaultCanNewSpace);

  const dialogScope = JSON.stringify([trackedScope.token, open]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: dialogScope, epoch: 1 }));
  const effectiveEpoch = scope.key === dialogScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== dialogScope) {
    setScope({ key: dialogScope, epoch: effectiveEpoch });
  }

  const [pendingState, setPendingState] = useState<{ epoch: number; pending: boolean }>({ epoch: 0, pending: false });
  const [errorState, setErrorState] = useState<{ epoch: number; message: string }>({ epoch: 0, message: "" });
  const pending = pendingState.epoch === effectiveEpoch && pendingState.pending;
  const error = errorState.epoch === effectiveEpoch ? errorState.message : "";

  const activeEpochRef = useRef(0);
  const reqGenRef = useRef(0);
  const pendingRef = useRef<{ epoch: number; gen: number; controller: AbortController } | null>(null);
  const depsRef = useRef(deps);
  const openRef = useRef(open);
  const onCloseRef = useRef(onClose);
  const onOpenedRef = useRef(onOpened);
  const defaultPanesRef = useRef(defaultPanes);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    openRef.current = open;
    onCloseRef.current = onClose;
    onOpenedRef.current = onOpened;
    defaultPanesRef.current = defaultPanes;
    readScopeTokenRef.current = trackedScope.readToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      reqGenRef.current += 1;
      pendingRef.current?.controller.abort();
      pendingRef.current = null;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  const choices = useMemo<NewTerminalDialogChoice[]>(
    () =>
      machines
        .filter((m) => m.online)
        .map((machine) => ({
          machine,
          spaces: buildTerminalTree(listing[machine.id]?.data, []).filter((s) => s.canOpen),
          home: newSpace ? homeShellHost(listing[machine.id]?.data) : undefined,
          listing: listing[machine.id],
        })),
    [machines, listing, newSpace],
  );

  const handleRetry = () => {
    if (!isScopeLive()) return;
    try {
      const panesDep = depsRef.current?.panes;
      const refreshFn = panesDep !== undefined
        ? (typeof panesDep === "function" ? panesDep() : panesDep)?.refresh
        : defaultPanesRef.current?.refresh;
      const res = refreshFn?.();
      if (isThenable(res)) void Promise.resolve(res).catch(() => {});
    } catch {
      // Refresh errors stay non-blocking.
    }
  };

  const start = async (mid: string, at: NewTerminalTarget) => {
    if (!isScopeLive() || !openRef.current || pendingRef.current !== null) return;
    const controller = new AbortController();
    const runGen = ++reqGenRef.current;
    pendingRef.current = { epoch: capturedEpoch, gen: runGen, controller };
    setPendingState({ epoch: capturedEpoch, pending: true });
    setErrorState({ epoch: capturedEpoch, message: "" });
    const isRunCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && reqGenRef.current === runGen
      && openRef.current
      && readScopeTokenRef.current() === capturedScopeToken;
    try {
      const openFn = depsRef.current?.openTerminal;
      const result = openFn
        ? await openFn(mid, at, controller.signal)
        : await api<{ terminal: string }>(`/machines/${enc(mid)}/panes`, { method: "POST", json: at });
      if (!isRunCurrent()) return;
      const nav = depsRef.current?.navigate ?? navigate;
      nav({ name: "terminal", mid, id: result.terminal, view: "terminals" });
      onCloseRef.current();
      onOpenedRef.current?.();
    } catch (e) {
      if (!isRunCurrent()) return;
      const msg = t("terminal-terminalpage.new_failed", { error: safeFormatError(depsRef.current?.formatError, e) });
      setErrorState({ epoch: capturedEpoch, message: msg });
      safeReportError(depsRef.current?.onError, msg, e);
    } finally {
      if (pendingRef.current?.gen === runGen) pendingRef.current = null;
      if (activeEpochRef.current === capturedEpoch && reqGenRef.current === runGen) {
        setPendingState((cur) => (cur.epoch === capturedEpoch ? { epoch: capturedEpoch, pending: false } : cur));
      }
    }
  };

  const viewProps: NewTerminalDialogViewProps = {
    open,
    busy,
    pending,
    error,
    choices,
    onClose,
    onRetry: handleRetry,
    onStart: (mid, at) => void start(mid, at),
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <NewTerminalDialogView {...viewProps} />;
}

function NewTerminalDialogWithPanes({
  open,
  onClose,
  onOpened,
  deps,
  machines,
  defaultPanes,
}: NewTerminalDialogProps & { machines: readonly Machine[]; defaultPanes?: NewTerminalDialogPanes }) {
  if (deps?.canNewSpace === undefined) {
    return (
      <DefaultCanNewSpaceBridge
        render={(canNewSpace) => (
          <NewTerminalDialogController
            open={open}
            onClose={onClose}
            onOpened={onOpened}
            deps={deps}
            machines={machines}
            defaultPanes={defaultPanes}
            defaultCanNewSpace={canNewSpace}
          />
        )}
      />
    );
  }
  return (
    <NewTerminalDialogController
      open={open}
      onClose={onClose}
      onOpened={onOpened}
      deps={deps}
      machines={machines}
      defaultPanes={defaultPanes}
    />
  );
}

function NewTerminalDialogWithMachines({
  open,
  onClose,
  onOpened,
  deps,
  defaultMachines,
}: NewTerminalDialogProps & { defaultMachines?: readonly Machine[] }) {
  const controlledMachines = useCachedExternal(deps?.machines, deps?.subscribeMachines, EMPTY_MACHINES);
  const machines = deps?.machines !== undefined ? controlledMachines : (defaultMachines ?? EMPTY_MACHINES);

  if (deps?.panes === undefined) {
    return (
      <DefaultPanesBridge
        machines={machines}
        open={open}
        render={(panes) => (
          <NewTerminalDialogWithPanes
            open={open}
            onClose={onClose}
            onOpened={onOpened}
            deps={deps}
            machines={machines}
            defaultPanes={panes}
          />
        )}
      />
    );
  }
  return (
    <NewTerminalDialogWithPanes
      open={open}
      onClose={onClose}
      onOpened={onOpened}
      deps={deps}
      machines={machines}
    />
  );
}

/** Same node protocol and workspace/host selection as the terminal inventory's New terminal. */
export function NewTerminalDialog({ open, onClose, onOpened, deps }: NewTerminalDialogProps) {
  if (deps?.machines === undefined) {
    return (
      <DefaultMachinesBridge
        render={(machines) => (
          <NewTerminalDialogWithMachines
            open={open}
            onClose={onClose}
            onOpened={onOpened}
            deps={deps}
            defaultMachines={machines}
          />
        )}
      />
    );
  }
  return (
    <NewTerminalDialogWithMachines
      open={open}
      onClose={onClose}
      onOpened={onOpened}
      deps={deps}
    />
  );
}
