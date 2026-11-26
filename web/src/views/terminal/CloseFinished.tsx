// "Close finished terminals" (#4754, docs/integrations/engines.md "Agents run in a terminal"): the terminals stopped
// Agents left stay until the user closes them. Per computer: what it would close now (a preview that closes nothing),
// a confirmation listing them (the destructive rung of DESIGN_SYSTEM.md 4.4: the verb again in red, and Cancel), then
// exactly the confirmed panes, a toast with how many went, and the list read again.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../i18n";
import { api, errorText } from "../../lib/api";
import { sessionTitle } from "../../lib/format";
import { getSession } from "../../lib/store";
import { closeFinished, previewFinished, type CloseFinishedResult } from "../../lib/terminal-list";
import type { TermSpace } from "../../lib/terminals";
import type { Session } from "../../lib/types";
import { Button, Dialog, toast } from "../../ui/atoms";
import { Icon } from "../../ui/icons";

export type CloseFinishedNoticeTone = "ok" | "error" | "info";

export interface CloseFinishedRow {
  key: string;
  label: string;
}

export interface CloseFinishedDialogViewProps {
  open: boolean;
  rows: readonly CloseFinishedRow[];
  kept: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export interface CloseFinishedDeps {
  /** Optional scope partition (value or getter); switching it aborts in-flight work, closes the dialog, and fences stale responses. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Preview finished panes on `mid` without closing them (defaults to `terminal-list.previewFinished`). */
  previewFinished?: (mid: string, signal: AbortSignal) => Promise<CloseFinishedResult> | CloseFinishedResult;
  /** Close confirmed panes on `mid` (defaults to `terminal-list.closeFinished`). */
  closeFinished?: (mid: string, panes: readonly string[], signal: AbortSignal) => Promise<CloseFinishedResult> | CloseFinishedResult;
  /** Session lookup for row labels (defaults to `store.getSession`). */
  getSession?: (mid: string, sid: string) => Session | undefined;
  /** Show toast notifications (defaults to `atoms.toast`). */
  notify?: (message: string, tone?: CloseFinishedNoticeTone) => void;
  /** Format thrown preview/close errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when preview or close throws or rejects in the active scope. */
  onError?: (message: string, error: unknown) => void;
  /** Optional custom dialog renderer (defaults to `<CloseFinishedDialogView>`). */
  renderView?: (props: CloseFinishedDialogViewProps) => ReactNode;
}

export interface UseCloseFinishedOptions {
  spacesOf: (mid: string) => readonly TermSpace[];
  reload: (mid: string) => void;
  deps?: CloseFinishedDeps;
}

type State = {
  epoch: number;
  mid: string;
  result?: CloseFinishedResult;
  busy: boolean;
};

const noopSubscribe = () => () => {};

function safeFormatError(fmt: ((error: unknown) => string) | undefined, error: unknown): string {
  if (!fmt) return errorText(error);
  try {
    return fmt(error);
  } catch {
    return errorText(error);
  }
}

function safeNotify(notify: ((message: string, tone?: CloseFinishedNoticeTone) => void) | undefined, message: string, tone?: CloseFinishedNoticeTone) {
  try {
    if (notify) notify(message, tone);
    else toast(message, tone);
  } catch {
    // Notification failures stay non-blocking so recovery never leaves busy stuck.
  }
}

function safeReportError(onError: ((message: string, error: unknown) => void) | undefined, message: string, error: unknown) {
  try {
    onError?.(message, error);
  } catch {
    // Error observer failures stay non-blocking so recovery never leaves busy stuck.
  }
}

function safeReload(reload: (mid: string) => void, mid: string) {
  try {
    reload(mid);
  } catch {
    // Reload observer failures stay non-blocking so recovery never leaves busy stuck.
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

/** Pure presentational confirmation dialog for "Close finished terminals". */
export function CloseFinishedDialogView({ open, rows, kept, busy, onCancel, onConfirm }: CloseFinishedDialogViewProps) {
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onCancel()}
      title={t("terminal-terminalpage.close_finished_title", { count: rows.length })}
      footer={
        <>
          <Button tone="quiet" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button tone="danger" busy={busy} onClick={onConfirm}>
            {t("terminal-terminalpage.close_finished_confirm")}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">{t("terminal-terminalpage.close_finished_detail")}</p>
      <ul className="mt-2 flex flex-col gap-0.5" data-finished-list>
        {rows.map((row) => (
          <li key={row.key} className="flex min-h-8 items-center gap-2 rounded-control bg-inset px-2.5 text-[12.5px] text-ink">
            <Icon name="terminal" size={13} className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
          </li>
        ))}
      </ul>
      {kept > 0 && <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{t("terminal-terminalpage.close_finished_kept", { count: kept })}</p>}
    </Dialog>
  );
}

/** `spacesOf`: a computer's tree as the page shows it (the rows' titles); `reload`: read that computer's panes again. */
export function useCloseFinished({ spacesOf, reload, deps }: UseCloseFinishedOptions) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const scopeToken = trackedScope.token;
  const [scope, setScope] = useState<{ token: string; epoch: number }>(() => ({ token: scopeToken, epoch: 1 }));
  const effectiveEpoch = scope.token === scopeToken ? scope.epoch : scope.epoch + 1;
  if (scope.token !== scopeToken) {
    setScope({ token: scopeToken, epoch: effectiveEpoch });
  }

  const [state, setState] = useState<State | null>(null);
  const activeState = state && state.epoch === effectiveEpoch ? state : null;

  const activeEpochRef = useRef(0);
  const reqGenRef = useRef(0);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const stateRef = useRef<State | null>(null);
  const depsRef = useRef(deps);
  const reloadRef = useRef(reload);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    reloadRef.current = reload;
    readScopeTokenRef.current = trackedScope.readToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      reqGenRef.current += 1;
      busyRef.current = false;
      stateRef.current = null;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = scopeToken;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  const cancel = () => {
    if (!isScopeLive()) return;
    reqGenRef.current += 1;
    busyRef.current = false;
    stateRef.current = null;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(null);
  };

  const start = async (mid: string) => {
    if (!isScopeLive() || busyRef.current || stateRef.current !== null) return;
    const controller = new AbortController();
    const runGen = ++reqGenRef.current;
    busyRef.current = true;
    controllerRef.current = controller;
    const nextPending: State = { epoch: capturedEpoch, mid, busy: true };
    stateRef.current = nextPending;
    setState(nextPending);
    const isRunCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && reqGenRef.current === runGen
      && readScopeTokenRef.current() === capturedScopeToken;
    try {
      const previewFn = depsRef.current?.previewFinished;
      const result = previewFn
        ? await previewFn(mid, controller.signal)
        : await previewFinished(mid, (path, init) => api(path, { ...init, signal: controller.signal }));
      if (!isRunCurrent()) return;
      if (!result.closed.length) {
        stateRef.current = null;
        setState(null);
        safeNotify(depsRef.current?.notify, t("terminal-terminalpage.finished_none"));
        safeReload(reloadRef.current, mid);
        return;
      }
      const readyState: State = { epoch: capturedEpoch, mid, result, busy: false };
      stateRef.current = readyState;
      setState(readyState);
    } catch (e) {
      if (!isRunCurrent()) return;
      stateRef.current = null;
      setState(null);
      const msg = t("terminal-terminalpage.close_finished_failed", { error: safeFormatError(depsRef.current?.formatError, e) });
      safeNotify(depsRef.current?.notify, msg, "error");
      safeReportError(depsRef.current?.onError, msg, e);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (reqGenRef.current === runGen) busyRef.current = false;
    }
  };

  const confirm = async () => {
    const cur = stateRef.current;
    if (
      !isScopeLive()
      || busyRef.current
      || !cur
      || cur.epoch !== capturedEpoch
      || !cur.result
      || cur.busy
    ) return;
    const { mid, result } = cur;
    const controller = new AbortController();
    const runGen = ++reqGenRef.current;
    busyRef.current = true;
    controllerRef.current = controller;
    const busyState: State = { epoch: capturedEpoch, mid, result, busy: true };
    stateRef.current = busyState;
    setState(busyState);
    const isRunCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && reqGenRef.current === runGen
      && readScopeTokenRef.current() === capturedScopeToken;
    try {
      const closeFn = depsRef.current?.closeFinished;
      const panes = result.closed.map((c) => c.pane);
      const done = closeFn
        ? await closeFn(mid, panes, controller.signal)
        : await closeFinished(mid, panes, (path, init) => api(path, { ...init, signal: controller.signal }));
      if (!isRunCurrent()) return;
      safeNotify(depsRef.current?.notify, t("terminal-terminalpage.closed_finished", { count: done.closed.length }), "ok");
    } catch (e) {
      if (!isRunCurrent()) return;
      const msg = t("terminal-terminalpage.close_finished_failed", { error: safeFormatError(depsRef.current?.formatError, e) });
      safeNotify(depsRef.current?.notify, msg, "error");
      safeReportError(depsRef.current?.onError, msg, e);
    } finally {
      const current = isRunCurrent();
      if (controllerRef.current === controller) controllerRef.current = null;
      if (reqGenRef.current === runGen) busyRef.current = false;
      if (current) {
        stateRef.current = null;
        setState(null);
        safeReload(reloadRef.current, mid);
      }
    }
  };

  const lookupSession = deps?.getSession ?? getSession;
  const rows: CloseFinishedRow[] = activeState?.result
    ? activeState.result.closed.map((c) => ({
        key: c.pane,
        label: finishedLabel(spacesOf(activeState.mid), c.pane, c.session_id, activeState.mid, lookupSession),
      }))
    : [];
  const kept = activeState?.result?.kept.length ?? 0;
  const viewProps: CloseFinishedDialogViewProps = {
    open: Boolean(activeState?.result),
    rows,
    kept,
    busy: Boolean(activeState?.busy),
    onCancel: cancel,
    onConfirm: () => void confirm(),
  };
  const dialog = deps?.renderView ? <>{deps.renderView(viewProps)}</> : <CloseFinishedDialogView {...viewProps} />;
  /** `previewing`: the computer whose preview is out (its button spins). */
  return { start, previewing: activeState && !activeState.result ? activeState.mid : undefined, dialog };
}

/** A finished terminal's line in the confirmation: its row's title in the tree ("Finished: <the Agent's title>"), else
 *  the Agent's title, else a short id. */
export function finishedLabel(
  spaces: readonly TermSpace[],
  pane: string,
  sessionId: string,
  mid: string,
  lookupSession: (mid: string, sid: string) => Session | undefined = getSession,
): string {
  for (const sp of spaces) for (const tab of sp.tabs) for (const p of tab.panes) if (p.pane === pane) return p.title;
  const s = sessionId ? lookupSession(mid, sessionId) : undefined;
  return t("lib-terminals.finished", { title: s ? sessionTitle(s) : sessionId.slice(0, 8) || pane });
}
