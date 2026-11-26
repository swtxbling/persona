// "Archived agents" (`/agents/archived`, docs/web/web.md "Archived agents"; Android's AgentArchivesScreen): every agent
// archived from the Agents list, newest activity first, searchable on its title, folder, computer, agent and last
// words. A row opens its chat (read from its transcript); "Restore" puts it back in the Agents list. What the hub
// lists is what is archived: a session with new activity comes back by itself and leaves this list.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { appArchiveDeps, AGENT_ARCHIVES_FEATURE, listArchived, noteArchivedList, restoreAgent } from "../../lib/agent-archives";
import { agentName, sessionAgent } from "../../lib/agent-kind";
import { errorText } from "../../lib/api";
import { ago, baseName, sessionTitle } from "../../lib/format";
import { machineWithHub } from "../../lib/mesh";
import { href as defaultHref, navigate as defaultNavigate, onLinkClick as defaultOnLinkClick, type Route } from "../../lib/router";
import { sameValue } from "../../lib/stable-lines";
import { useStore } from "../../lib/store";
import type { Machine, Session } from "../../lib/types";
import { SessionMark } from "../../ui/AgentMark";
import { Button, IconButton, Loading, useNow } from "../../ui/atoms";
import { Icon } from "../../ui/icons";
import { Empty } from "../assistant/parts";
import { t } from "../../i18n";

export type AgentArchivesNoticeTone = "ok" | "error" | "info";

export interface ArchivedRowViewProps {
  s: Session;
  now: number;
  machine: string;
  busy: boolean;
  href?: string;
  onLinkClick?: (e: MouseEvent<HTMLAnchorElement>, route: Route) => void;
  onRestore: () => void;
}

export interface AgentArchivesViewProps {
  supported: boolean;
  featuresKnown: boolean;
  rows: readonly Session[] | null;
  hits: readonly Session[];
  machines: readonly Machine[];
  query: string;
  error: string;
  loading: boolean;
  restoringKeys: ReadonlySet<string>;
  now: number;
  href: (route: Route) => string;
  onLinkClick: (e: MouseEvent<HTMLAnchorElement>, route: Route) => void;
  onToggleSidebar: () => void;
  onBack: () => void;
  onRefresh: () => void;
  onQueryChange: (value: string) => void;
  onRestore: (session: Session) => void;
}

export interface AgentArchivesDeps {
  /** Optional scope partition (value or getter); switching it resets query, rows, error, loading, and restoring states and aborts/fences stale requests. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled archives feature support flag or getter (bypasses `useStore` when supplied). */
  supported?: boolean | (() => boolean);
  /** Subscribe to `supported` updates when `supported` is a getter. */
  subscribeSupported?: (listener: () => void) => () => void;
  /** Controlled features-known flag or getter (bypasses `useStore` when supplied). */
  featuresKnown?: boolean | (() => boolean);
  /** Subscribe to `featuresKnown` updates when `featuresKnown` is a getter. */
  subscribeFeaturesKnown?: (listener: () => void) => () => void;
  /** Controlled machines list or getter (bypasses `useStore` when supplied). */
  machines?: readonly Machine[] | (() => readonly Machine[]);
  /** Subscribe to machines updates when `machines` is a getter. */
  subscribeMachines?: (listener: () => void) => () => void;
  /** Controlled archived sessions loader (sync or async; bypasses `listArchived` and `noteArchivedList` when supplied). */
  listArchived?: (signal: AbortSignal) => Promise<Session[]> | Session[];
  /** Controlled session restore handler (sync or async; bypasses `restoreAgent` and `appArchiveDeps` when supplied). */
  restoreArchived?: (session: Session, signal: AbortSignal) => Promise<boolean | void> | boolean | void;
  /** Controlled clock timestamp in ms or getter (bypasses `useNow(60_000)` when supplied). */
  now?: number | (() => number);
  /** Subscribe to clock updates when `now` is a getter. */
  subscribeNow?: (listener: () => void) => () => void;
  /** Controlled route href builder (bypasses `router.href` when supplied). */
  href?: (route: Route) => string;
  /** Controlled link click handler (bypasses `router.onLinkClick` when supplied). */
  onLinkClick?: (e: MouseEvent<HTMLAnchorElement>, route: Route) => void;
  /** Controlled router navigation (bypasses `router.navigate` when supplied). */
  navigate?: (to: Route | string) => void;
  /** Controlled toast notifier (bypasses `atoms.toast` when supplied). */
  notify?: (message: string, tone?: AgentArchivesNoticeTone) => void;
  /** Custom error formatter (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when loading or restoring fails in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<AgentArchivesView>`). */
  renderView?: (props: AgentArchivesViewProps) => ReactNode;
}

export interface AgentArchivesProps {
  onToggleSidebar: () => void;
  deps?: AgentArchivesDeps;
}

const EMPTY_MACHINES: readonly Machine[] = [];
const noopSubscribe = () => () => {};
const keyOf = (s: Pick<Session, "machine_id" | "session_id">) => `${s.machine_id}/${s.session_id}`;

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

function safeNotify(notify: ((message: string, tone?: AgentArchivesNoticeTone) => void) | undefined, message: string, tone?: AgentArchivesNoticeTone) {
  if (!notify) return;
  try {
    notify(message, tone);
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

/** The rows whose title, folder, computer, agent or last words hold `query` (case-insensitive). */
export function filterArchived(rows: readonly Session[], query: string, machines: readonly Machine[]): Session[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows as Session[];
  return rows.filter((s) =>
    [sessionTitle(s), s.cwd, machineWithHub(s.machine_id, machines as Machine[]), agentName(sessionAgent(s).agent, s.agent_label), s.last_text ?? ""]
      .some((x) => x.toLowerCase().includes(needle)),
  );
}

/** Pure presentational row for a single archived agent session. */
export function ArchivedRowView({ s, now, machine, busy, href: linkHref, onLinkClick, onRestore }: ArchivedRowViewProps) {
  const route: Route = { name: "session", mid: s.machine_id, sid: s.session_id };
  const title = sessionTitle(s);
  const where = [machine, baseName(s.cwd), agentName(sessionAgent(s).agent, s.agent_label)].filter(Boolean).join(" · ");
  const resolvedHref = linkHref ?? defaultHref(route);
  const handleLink = onLinkClick ?? defaultOnLinkClick;
  return (
    <div className="group relative flex items-center gap-2 pr-3 transition-colors hover:bg-hover">
      <a href={resolvedHref} onClick={(e) => handleLink(e, route)} title={[title, s.cwd].filter(Boolean).join("\n")} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 focus-visible:outline-none">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-field">
          <SessionMark s={s} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{title}</span>
            <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">{ago(s.updated_at, now)}</span>
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-ink-3">{where}</span>
          {s.last_text && <span className="mt-0.5 block truncate text-[12px] text-ink-2">{s.last_text}</span>}
        </span>
      </a>
      <Button tone="secondary" icon="undo" busy={busy} onClick={onRestore} title={t("agents-archives.restore_label", { title })}>
        {t("agents-archives.restore")}
      </Button>
    </div>
  );
}

/** Pure presentational view for the Archived agents page. */
export function AgentArchivesView({
  supported,
  featuresKnown,
  rows,
  hits,
  machines,
  query,
  error,
  loading,
  restoringKeys,
  now,
  href: buildHref,
  onLinkClick,
  onToggleSidebar,
  onBack,
  onRefresh,
  onQueryChange,
  onRestore,
}: AgentArchivesViewProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
        <IconButton icon="sidebar" label={t("assistant-history.sidebar")} onClick={onToggleSidebar} className="lg:hidden" />
        {/* a page under the Agents list: back to it, as a request's page and the settings' pages go back to theirs; the
            list keeps its grouping and filter (stored in this browser) */}
        <IconButton icon="chevronLeft" label={t("agents-archives.back")} onClick={onBack} />
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">
          {t("agents-archives.title")}
          {rows && rows.length > 0 && <span className="ml-2 text-[12px] font-normal text-ink-3 tabular-nums">{rows.length}</span>}
        </h1>
        {supported && <IconButton icon="retry" label={t("agents-archives.refresh")} onClick={onRefresh} disabled={loading} />}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-4 py-5 sm:px-8 sm:py-6">
          {!supported && featuresKnown ? (
            <Empty icon="archive" title={t("agents-archives.unsupported_title")}>
              {t("agents-archives.unsupported_body")}
            </Empty>
          ) : (
            <>
              <label className="mb-2 flex h-9 items-center gap-2 rounded-control bg-surface px-3 shadow-btn focus-within:shadow-[inset_0_0_0_1px_var(--accent)]">
                <Icon name="search" size={13} stroke={2} className="text-ink-3" />
                <input
                  value={query}
                  onChange={(e) => onQueryChange(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && onQueryChange("")}
                  placeholder={t("agents-archives.search_placeholder")}
                  aria-label={t("agents-archives.search_placeholder")}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
                />
                {query && <IconButton icon="x" label={t("agents-archives.clear_search")} size={22} iconSize={12} onClick={() => onQueryChange("")} />}
              </label>
              <p className="mb-5 px-1 text-[11.5px] leading-relaxed text-ink-3">{t("agents-archives.description")}</p>

              {rows === null && !error && (
                <div className="flex justify-center py-16">
                  <Loading />
                </div>
              )}
              {error && (
                <Empty icon="info" title={t("agents-archives.load_failed")} action={<Button tone="secondary" icon="retry" busy={loading} onClick={onRefresh}>{t("agents-archives.retry")}</Button>}>
                  {error}
                </Empty>
              )}
              {rows !== null && !error && rows.length === 0 && (
                <Empty icon="archive" title={t("agents-archives.empty_title")}>
                  {t("agents-archives.empty_body")}
                </Empty>
              )}
              {rows !== null && rows.length > 0 && hits.length === 0 && <Empty icon="search" title={t("agents-archives.no_results", { query: query.trim() })} />}
              {hits.length > 0 && (
                <div data-agent-archives className="divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card">
                  {hits.map((s) => {
                    const route: Route = { name: "session", mid: s.machine_id, sid: s.session_id };
                    const key = keyOf(s);
                    return (
                      <ArchivedRowView
                        key={key}
                        s={s}
                        now={now}
                        machine={machineWithHub(s.machine_id, machines as Machine[])}
                        busy={restoringKeys.has(key)}
                        href={buildHref(route)}
                        onLinkClick={onLinkClick}
                        onRestore={() => onRestore(s)}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DefaultSupportedBridge({ render }: { render: (supported: boolean) => ReactNode }) {
  const supported = useStore((s) => s.features.includes(AGENT_ARCHIVES_FEATURE));
  return <>{render(supported)}</>;
}

function DefaultFeaturesKnownBridge({ render }: { render: (featuresKnown: boolean) => ReactNode }) {
  const featuresKnown = useStore((s) => s.features.length > 0);
  return <>{render(featuresKnown)}</>;
}

function DefaultMachinesBridge({ render }: { render: (machines: readonly Machine[]) => ReactNode }) {
  const machines = useStore((s) => s.machines);
  return <>{render(machines)}</>;
}

function DefaultNowBridge({ render }: { render: (now: number) => ReactNode }) {
  const now = useNow(60_000);
  return <>{render(now)}</>;
}

interface PendingOp {
  seq: number;
  controller: AbortController;
}

interface AgentArchivesBodyProps {
  onToggleSidebar: () => void;
  supported: boolean;
  featuresKnown: boolean;
  machines: readonly Machine[];
  now: number;
  outerScopeToken: string;
  readOuterScopeToken: () => string;
  deps?: AgentArchivesDeps;
}

function AgentArchivesBody({
  onToggleSidebar,
  supported,
  featuresKnown,
  machines,
  now,
  outerScopeToken,
  readOuterScopeToken,
  deps,
}: AgentArchivesBodyProps) {
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: outerScopeToken, epoch: 1 }));
  const effectiveEpoch = scope.key === outerScopeToken ? scope.epoch : scope.epoch + 1;
  if (scope.key !== outerScopeToken) {
    setScope({ key: outerScopeToken, epoch: effectiveEpoch });
  }

  const [rowsState, setRowsState] = useState<{ epoch: number; rows: Session[] | null }>({ epoch: 0, rows: null });
  const [errorState, setErrorState] = useState<{ epoch: number; error: string }>({ epoch: 0, error: "" });
  const [loadingState, setLoadingState] = useState<{ epoch: number; loading: boolean }>({ epoch: 0, loading: false });
  const [queryState, setQueryState] = useState<{ epoch: number; query: string }>({ epoch: 0, query: "" });
  const [restoringState, setRestoringState] = useState<{ epoch: number; keys: readonly string[] }>({ epoch: 0, keys: [] });

  const rows = rowsState.epoch === effectiveEpoch ? rowsState.rows : null;
  const error = errorState.epoch === effectiveEpoch ? errorState.error : "";
  const loading = loadingState.epoch === effectiveEpoch && loadingState.loading;
  const query = queryState.epoch === effectiveEpoch ? queryState.query : "";
  const restoringKeys = useMemo(
    () => new Set(restoringState.epoch === effectiveEpoch ? restoringState.keys : []),
    [restoringState, effectiveEpoch],
  );

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const loadOpRef = useRef<PendingOp | null>(null);
  const restoreOpsRef = useRef<Map<string, PendingOp>>(new Map());
  const depsRef = useRef(deps);
  const readScopeTokenRef = useRef(readOuterScopeToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    readScopeTokenRef.current = readOuterScopeToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      loadOpRef.current?.controller.abort();
      loadOpRef.current = null;
      restoreOpsRef.current.forEach((op) => op.controller.abort());
      restoreOpsRef.current.clear();
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = outerScopeToken;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  const reportError = (msg: string) => {
    try {
      depsRef.current?.onError?.(msg);
    } catch {
      // Error observer failures stay non-blocking.
    }
  };

  const runLoad = (): Promise<void> => {
    if (!isScopeLive()) return Promise.resolve();
    loadOpRef.current?.controller.abort();
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    loadOpRef.current = { seq: runSeq, controller };
    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && loadOpRef.current?.seq === runSeq;

    const finishSuccess = (list: Session[]) => {
      if (!isRunCurrent()) return;
      setRowsState({ epoch: capturedEpoch, rows: list });
      if (!depsRef.current?.listArchived) noteArchivedList(list);
      setErrorState({ epoch: capturedEpoch, error: "" });
    };

    const finishError = (err: unknown) => {
      if (!isRunCurrent()) return;
      const msg = safeFormatError(depsRef.current?.formatError, err);
      setErrorState({ epoch: capturedEpoch, error: msg });
      reportError(msg);
    };

    setLoadingState({ epoch: capturedEpoch, loading: true });
    let result: Promise<Session[]> | Session[];
    try {
      result = depsRef.current?.listArchived ? depsRef.current.listArchived(controller.signal) : listArchived(controller.signal);
    } catch (err) {
      finishError(err);
      if (loadOpRef.current?.seq === runSeq) {
        loadOpRef.current = null;
        if (activeEpochRef.current === capturedEpoch) setLoadingState({ epoch: capturedEpoch, loading: false });
      }
      return Promise.resolve();
    }

    if (!isThenable(result)) {
      finishSuccess(result);
      if (loadOpRef.current?.seq === runSeq) {
        loadOpRef.current = null;
        if (activeEpochRef.current === capturedEpoch) setLoadingState({ epoch: capturedEpoch, loading: false });
      }
      return Promise.resolve();
    }

    return (async () => {
      try {
        const list = await result;
        finishSuccess(list);
      } catch (err) {
        finishError(err);
      } finally {
        if (loadOpRef.current?.seq === runSeq) {
          loadOpRef.current = null;
          if (activeEpochRef.current === capturedEpoch) setLoadingState({ epoch: capturedEpoch, loading: false });
        }
      }
    })();
  };

  useEffect(() => {
    if (!supported) {
      loadOpRef.current?.controller.abort();
      loadOpRef.current = null;
      setLoadingState((prev) => (prev.epoch === capturedEpoch && prev.loading ? { epoch: capturedEpoch, loading: false } : prev));
      return;
    }
    void runLoad();
    return () => {
      loadOpRef.current?.controller.abort();
      loadOpRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveEpoch, supported]);

  const hits = useMemo(() => filterArchived(rows ?? [], query, machines), [rows, query, machines]);

  const handleRestore = (s: Session) => {
    const key = keyOf(s);
    if (!isScopeLive() || restoreOpsRef.current.has(key)) return;
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    restoreOpsRef.current.set(key, { seq: runSeq, controller });
    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && restoreOpsRef.current.get(key)?.seq === runSeq;

    const removeRow = () => {
      setRowsState((prev) => (prev.epoch === capturedEpoch ? { epoch: capturedEpoch, rows: (prev.rows ?? []).filter((x) => keyOf(x) !== key) } : prev));
    };

    const failRestore = (err: unknown) => {
      const msg = safeFormatError(depsRef.current?.formatError, err);
      safeNotify(depsRef.current?.notify, t("lib-agent-archives.restore_failed", { error: msg }), "error");
      reportError(msg);
    };

    const releaseKey = () => {
      if (restoreOpsRef.current.get(key)?.seq === runSeq) {
        restoreOpsRef.current.delete(key);
      }
      if (activeEpochRef.current === capturedEpoch) {
        setRestoringState((prev) => (prev.epoch === capturedEpoch ? { epoch: capturedEpoch, keys: prev.keys.filter((k) => k !== key) } : prev));
      }
    };

    setRestoringState((prev) => ({
      epoch: capturedEpoch,
      keys: prev.epoch === capturedEpoch ? (prev.keys.includes(key) ? prev.keys : [...prev.keys, key]) : [key],
    }));

    let result: Promise<boolean | void> | boolean | void;
    try {
      if (depsRef.current?.restoreArchived) {
        result = depsRef.current.restoreArchived(s, controller.signal);
      } else {
        result = restoreAgent(s, {
          ...appArchiveDeps,
          notify: depsRef.current?.notify ?? appArchiveDeps.notify,
          refresh: () => Promise.all([appArchiveDeps.refresh(), isScopeLive() ? runLoad() : Promise.resolve()]),
        });
      }
    } catch (err) {
      if (isRunCurrent()) failRestore(err);
      releaseKey();
      return;
    }

    if (!isThenable(result)) {
      if (isRunCurrent() && result !== false) removeRow();
      releaseKey();
      return;
    }

    void (async () => {
      try {
        const ok = await result;
        if (isRunCurrent() && ok !== false) removeRow();
      } catch (err) {
        if (isRunCurrent()) failRestore(err);
      } finally {
        releaseKey();
      }
    })();
  };

  const handleQueryChange = (value: string) => {
    if (!isScopeLive()) return;
    setQueryState({ epoch: capturedEpoch, query: value });
  };

  const handleBack = () => {
    if (!isScopeLive()) return;
    try {
      (depsRef.current?.navigate ?? defaultNavigate)({ name: "agent-list" });
    } catch (err) {
      const msg = safeFormatError(depsRef.current?.formatError, err);
      safeNotify(depsRef.current?.notify, msg, "error");
      reportError(msg);
    }
  };

  const handleLinkClick = (e: MouseEvent<HTMLAnchorElement>, route: Route) => {
    if (!isScopeLive()) {
      e.preventDefault();
      return;
    }
    try {
      if (depsRef.current?.onLinkClick) {
        depsRef.current.onLinkClick(e, route);
        return;
      }
      if (depsRef.current?.navigate) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        depsRef.current.navigate(route);
        return;
      }
      defaultOnLinkClick(e, route);
    } catch (err) {
      const msg = safeFormatError(depsRef.current?.formatError, err);
      safeNotify(depsRef.current?.notify, msg, "error");
      reportError(msg);
    }
  };

  const viewProps: AgentArchivesViewProps = {
    supported,
    featuresKnown,
    rows,
    hits,
    machines,
    query,
    error,
    loading,
    restoringKeys,
    now,
    href: deps?.href ?? defaultHref,
    onLinkClick: handleLinkClick,
    onToggleSidebar,
    onBack: handleBack,
    onRefresh: () => void runLoad(),
    onQueryChange: handleQueryChange,
    onRestore: handleRestore,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <AgentArchivesView {...viewProps} />;
}

export function AgentArchives({ onToggleSidebar, deps }: AgentArchivesProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const controlledSupported = useCachedExternalValue(deps?.supported, deps?.subscribeSupported);
  const controlledFeaturesKnown = useCachedExternalValue(deps?.featuresKnown, deps?.subscribeFeaturesKnown);
  const controlledMachines = useCachedExternalValue(deps?.machines, deps?.subscribeMachines);
  const controlledNow = useCachedExternalValue(deps?.now, deps?.subscribeNow);

  const needDefaultSupported = deps?.supported === undefined;
  const needDefaultFeaturesKnown = deps?.featuresKnown === undefined;
  const needDefaultMachines = deps?.machines === undefined;
  const needDefaultNow = deps?.now === undefined;

  const renderBody = (supported: boolean, featuresKnown: boolean, machines: readonly Machine[], now: number) => (
    <AgentArchivesBody
      onToggleSidebar={onToggleSidebar}
      supported={supported}
      featuresKnown={featuresKnown}
      machines={machines}
      now={now}
      outerScopeToken={trackedScope.token}
      readOuterScopeToken={trackedScope.readToken}
      deps={deps}
    />
  );

  const renderWithNow = (supported: boolean, featuresKnown: boolean, machines: readonly Machine[]) => (
    needDefaultNow
      ? <DefaultNowBridge render={(now) => renderBody(supported, featuresKnown, machines, now)} />
      : renderBody(supported, featuresKnown, machines, controlledNow ?? 0)
  );

  const renderWithMachines = (supported: boolean, featuresKnown: boolean) => (
    needDefaultMachines
      ? <DefaultMachinesBridge render={(machines) => renderWithNow(supported, featuresKnown, machines)} />
      : renderWithNow(supported, featuresKnown, controlledMachines ?? EMPTY_MACHINES)
  );

  const renderWithFeaturesKnown = (supported: boolean) => (
    needDefaultFeaturesKnown
      ? <DefaultFeaturesKnownBridge render={(featuresKnown) => renderWithMachines(supported, featuresKnown)} />
      : renderWithMachines(supported, Boolean(controlledFeaturesKnown))
  );

  if (needDefaultSupported) {
    return <DefaultSupportedBridge render={renderWithFeaturesKnown} />;
  }
  return renderWithFeaturesKnown(Boolean(controlledSupported));
}
