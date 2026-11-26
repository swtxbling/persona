import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../i18n";
import { api, enc, errorText } from "../../lib/api";
import type { MachineTerminalTarget } from "../../lib/machine-terminal";
import { navigate, type Route } from "../../lib/router";
import type { Listing } from "../../lib/terminal-panes";
import { terminalId } from "../../lib/terminals";
import type { Machine } from "../../lib/types";
import { sameDirectory } from "../../lib/workspace-directory";
import { Button, Loading } from "../../ui/atoms";

export type MachineTerminalOpenRequest =
  | { kind: string; workspace_id: string }
  | { kind: string; cwd: string }
  | { kind: string; cwd: string; new_space: true };

export type MachineTerminalEntryStatus = "offline" | "error" | "loading" | "ready" | "unavailable";

export interface MachineTerminalEntryViewProps {
  machineLabel: string;
  cwd?: string;
  status: MachineTerminalEntryStatus;
  listingError?: string;
  pending: boolean;
  error: string;
  onBack: () => void;
  onRetry: () => void;
  onStart: () => void;
}

export interface MachineTerminalEntryDeps {
  /** Optional scope partition (value or getter); switching it aborts in-flight creation, resets error/pending, and fences stale navigation. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Create a terminal pane on `mid` (defaults to `POST /machines/{mid}/panes`). */
  openTerminal?: (mid: string, at: MachineTerminalOpenRequest, signal: AbortSignal) => Promise<{ terminal: string }> | { terminal: string };
  /** Route navigation override (defaults to `router.navigate`). */
  navigate?: (route: Route, replace?: boolean, state?: Record<string, unknown> | null) => void;
  /** Format thrown creation errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when creation or navigation throws or rejects in the active scope/target. */
  onError?: (message: string, error: unknown) => void;
  /** Optional custom view renderer (defaults to `<MachineTerminalEntryView>`). */
  renderView?: (props: MachineTerminalEntryViewProps) => ReactNode;
}

export interface MachineTerminalEntryProps {
  target: MachineTerminalTarget;
  machine?: Machine;
  listing?: Listing;
  canCreateSpace: boolean;
  canOpenFolder: boolean;
  retry: () => void;
  deps?: MachineTerminalEntryDeps;
}

const noopSubscribe = () => () => {};

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

/** Pure presentational entry screen for resuming or creating a machine terminal. */
export function MachineTerminalEntryView({
  machineLabel,
  cwd,
  status,
  listingError,
  pending,
  error,
  onBack,
  onRetry,
  onStart,
}: MachineTerminalEntryViewProps) {
  return (
    <section className="mx-auto w-full max-w-xl space-y-3 p-4">
      <Button icon="arrowLeft" tone="quiet" onClick={onBack}>{t("terminal-terminalpage.back_terminals")}</Button>
      <div className="space-y-3 rounded-card bg-surface p-4 shadow-card">
        <h1 className="text-base font-semibold">{t("terminal-terminalpage.terminals")}</h1>
        <p className="font-medium text-ink">{machineLabel}</p>
        {cwd && <p className="break-all text-sm text-ink-2">{cwd}</p>}
        {status === "offline" ? <p>{t("terminal-terminalpage.offline")}</p>
          : status === "error" ? <div role="alert">{listingError} <Button onClick={onRetry}>{t("terminal-terminalpage.retry")}</Button></div>
          : status === "loading" ? <Loading />
          : status === "ready" ? <Button tone="primary" icon="plus" busy={pending} onClick={onStart}>{t("terminal-terminalpage.new_terminal")}</Button>
          : <p>{t("work-entry.terminal_unavailable")}</p>}
        {error && <p role="alert" className="text-sm text-red">{error}</p>}
      </div>
    </section>
  );
}

export function MachineTerminalEntry({ target, machine, listing, canCreateSpace, canOpenFolder, retry, deps }: MachineTerminalEntryProps) {
  const { mid, cwd, workspaceId, host } = target;
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const targetKey = JSON.stringify([mid, cwd ?? null, workspaceId ?? null, host ?? null]);
  const entryScope = JSON.stringify([trackedScope.token, targetKey]);

  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: entryScope, epoch: 1 }));
  const effectiveEpoch = scope.key === entryScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== entryScope) {
    setScope({ key: entryScope, epoch: effectiveEpoch });
  }

  const [pendingState, setPendingState] = useState<{ epoch: number; pending: boolean }>({ epoch: 0, pending: false });
  const [errorState, setErrorState] = useState<{ epoch: number; message: string }>({ epoch: 0, message: "" });
  const pending = pendingState.epoch === effectiveEpoch && pendingState.pending;
  const error = errorState.epoch === effectiveEpoch ? errorState.message : "";

  const activeEpochRef = useRef(0);
  const committedTargetRef = useRef(targetKey);
  const reqGenRef = useRef(0);
  const pendingRef = useRef<{ epoch: number; gen: number; controller: AbortController } | null>(null);
  const depsRef = useRef(deps);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    committedTargetRef.current = targetKey;
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
  const capturedTargetKey = targetKey;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && committedTargetRef.current === capturedTargetKey
    && readScopeTokenRef.current() === capturedScopeToken;

  const hosts = listing?.data?.hosts ?? [];
  const boundHost = hosts.find((h) => h.kind === host);
  // Runtime workspaces can live outside the terminal host. Their folder is the terminal destination.
  const scoped = boundHost ? [boundHost] : hosts;
  const matches = (id: string, path?: string) => boundHost && workspaceId ? id === workspaceId : !cwd || sameDirectory(path || "", cwd);
  const workspaces = scoped.flatMap((h) => (h.workspaces ?? []).filter((w) => matches(w.id, w.cwd)).map((w) => ({ h, w })));
  const workspace = workspaces.find(({ h }) => h.new_tab);
  // Match the Terminals inventory: a live Agent owns its pane; a standalone shell can be resumed here.
  const existing = scoped.filter((h) => h.stream).flatMap((h) => (h.panes ?? []).filter((p) =>
    !p.session_id && !p.agent && (matches(p.workspace_id, p.cwd) ||
      workspaces.some(({ h: owner, w }) => owner === h && w.id === p.workspace_id)))).at(0);
  const id = existing && terminalId(existing);
  const ready = Boolean(machine?.online && !listing?.error);

  useEffect(() => {
    if (!ready || !id || pending || pendingRef.current !== null) return;
    if (
      activeEpochRef.current !== capturedEpoch
      || committedTargetRef.current !== capturedTargetKey
      || readScopeTokenRef.current() !== capturedScopeToken
    ) return;
    try {
      const nav = depsRef.current?.navigate ?? navigate;
      nav({ name: "terminal", mid, id, view: "terminals" }, true, {});
    } catch (e) {
      if (
        activeEpochRef.current !== capturedEpoch
        || committedTargetRef.current !== capturedTargetKey
        || readScopeTokenRef.current() !== capturedScopeToken
      ) return;
      const msg = t("terminal-terminalpage.new_failed", { error: safeFormatError(depsRef.current?.formatError, e) });
      setErrorState({ epoch: capturedEpoch, message: msg });
      safeReportError(depsRef.current?.onError, msg, e);
    }
  }, [ready, id, mid, pending, capturedEpoch, capturedScopeToken, capturedTargetKey]);

  const kind = (scoped.find((h) => h.new_tab) ?? hosts.find((h) => h.new_tab))?.kind;
  const at: MachineTerminalOpenRequest | undefined = workspace
    ? { kind: workspace.h.kind, workspace_id: workspace.w.id }
    : canOpenFolder && cwd && kind
      ? { kind, cwd }
      : canCreateSpace && kind
        ? { kind, cwd: cwd || "~", new_space: true }
        : undefined;

  const handleBack = () => {
    if (!isScopeLive()) return;
    try {
      const nav = depsRef.current?.navigate ?? navigate;
      nav({ name: "terminal", view: "terminals" }, true, {});
    } catch (e) {
      if (!isScopeLive()) return;
      const msg = t("terminal-terminalpage.new_failed", { error: safeFormatError(depsRef.current?.formatError, e) });
      setErrorState({ epoch: capturedEpoch, message: msg });
      safeReportError(depsRef.current?.onError, msg, e);
    }
  };

  const start = async () => {
    if (!at || !ready || !isScopeLive() || pendingRef.current !== null) return;
    const controller = new AbortController();
    const runGen = ++reqGenRef.current;
    pendingRef.current = { epoch: capturedEpoch, gen: runGen, controller };
    setPendingState({ epoch: capturedEpoch, pending: true });
    setErrorState({ epoch: capturedEpoch, message: "" });
    const isRunCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && committedTargetRef.current === capturedTargetKey
      && reqGenRef.current === runGen
      && readScopeTokenRef.current() === capturedScopeToken;
    try {
      const openFn = depsRef.current?.openTerminal;
      const result = openFn
        ? await openFn(mid, at, controller.signal)
        : await api<{ terminal: string }>(`/machines/${enc(mid)}/panes`, { method: "POST", json: at, signal: controller.signal });
      if (!isRunCurrent()) return;
      const nav = depsRef.current?.navigate ?? navigate;
      nav({ name: "terminal", mid, id: result.terminal, view: "terminals" }, true, {});
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

  const status: MachineTerminalEntryStatus = !machine?.online
    ? "offline"
    : listing?.error
      ? "error"
      : !listing?.data || id
        ? "loading"
        : at
          ? "ready"
          : "unavailable";

  const viewProps: MachineTerminalEntryViewProps = {
    machineLabel: machine?.name ?? mid,
    cwd,
    status,
    listingError: listing?.error,
    pending,
    error,
    onBack: handleBack,
    onRetry: retry,
    onStart: () => void start(),
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <MachineTerminalEntryView {...viewProps} />;
}
