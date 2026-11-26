import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../i18n";
import { api, errorText } from "../../lib/api";
import { fromShownManager, onManagerChoice } from "../../lib/manager-choice";
import { sameValue } from "../../lib/stable-lines";
import { onHubEvent } from "../../lib/store";
import { documentPage, visiblePoll } from "../../lib/visible-poll";
import { Button, Loading } from "../../ui/atoms";

export interface ResourceJob {
  ticket: string; run?: string; slot?: number; project: string; commit: string; groups: string[]; position?: number;
  started_at?: string; enqueued_at?: string; duplicate_of?: string;
}
export interface ResourceDefinition {
  id: string; capacity: number;
  mirror: { machine: string; target: string; port?: number; identity?: string };
  repositories?: Record<string, string>;
}
export interface ResourceStatus extends ResourceDefinition {
  mirror_state: { unknown: boolean; observed_at: string; raw?: string; queue?: { slots: number; running: ResourceJob[]; waiting: ResourceJob[] } };
  leases: { id: string; state: string; holder: { label?: string; machine: string }; joiners?: string[] }[];
}

export interface ResourcesPanelViewProps {
  resources: readonly ResourceStatus[] | null;
  now: number;
  error?: string;
  editing: boolean;
  draft: string;
  saving: boolean;
  onConfigure: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
}

export interface ResourcesPanelDeps {
  /** Optional scope partition (value or getter); switching it aborts in-flight load/save, resets editor/error/saving, and fences stale responses. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled resources list or getter (bypasses default `GET /resources`, `onManagerChoice`, `onHubEvent`, and `visiblePoll` when supplied). */
  resources?: readonly ResourceStatus[] | null | (() => readonly ResourceStatus[] | null);
  /** Subscribe to external resource updates when `resources` is a getter. */
  subscribeResources?: (listener: () => void) => () => void;
  /** Fetch the resources registry (defaults to `GET /resources`). */
  readResources?: (signal: AbortSignal) => Promise<{ resources: ResourceStatus[] } | ResourceStatus[]> | { resources: ResourceStatus[] } | ResourceStatus[];
  /** Persist resource definitions (defaults to `PUT /resources`). */
  saveResources?: (definitions: ResourceDefinition[], signal: AbortSignal) => Promise<unknown> | unknown;
  /** Subscribe to manager-choice switches (bypasses `lib/manager-choice.onManagerChoice` when supplied). */
  onManagerChoice?: (listener: () => void) => () => void;
  /** Subscribe to live resource push events (bypasses `lib/store.onHubEvent("resources")` + `fromShownManager` when supplied). */
  onResourcesEvent?: (listener: (resources: ResourceStatus[]) => void) => () => void;
  /** Controlled polling scheduler (bypasses `lib/visible-poll.visiblePoll` when supplied). */
  poll?: (refresh: () => void, intervalMs: number) => () => void;
  /** Polling interval in milliseconds (defaults to `15_000`). */
  pollIntervalMs?: number;
  /** Fixed timestamp or clock reader in milliseconds (bypasses `Date.now()` whenever supplied). */
  now?: number | (() => number);
  /** Subscribe to external clock updates when `now` is a getter. */
  subscribeNow?: (listener: () => void) => () => void;
  /** Format thrown load/save errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when load or save fails in the active scope. */
  onError?: (message: string, error: unknown) => void;
  /** Optional custom view renderer (defaults to `<ResourcesPanelView>`). */
  renderView?: (props: ResourcesPanelViewProps) => ReactNode;
}

export interface ResourcesPanelProps {
  deps?: ResourcesPanelDeps;
}

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const noopSubscribe = () => () => {};

function safeFormatError(fmt: ((error: unknown) => string) | undefined, error: unknown): string {
  if (!fmt) return errorText(error);
  try {
    return fmt(error);
  } catch {
    return errorText(error);
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

export function ageSeconds(at: string | undefined, now = Date.now()) {
  const parsed = at ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(0, Math.floor((now - parsed) / 1000)) : null;
}

export function jobAgeSeconds(job: ResourceJob, now: number) {
  return ageSeconds(job.enqueued_at, now) ?? ageSeconds(job.started_at, now);
}

/** Pure presentational view for the shared resources registry and editor panel. */
export function ResourcesPanelView({
  resources,
  now,
  error = "",
  editing,
  draft,
  saving,
  onConfigure,
  onDraftChange,
  onSave,
  onCancelEdit,
}: ResourcesPanelViewProps) {
  return (
    <section className="space-y-4" aria-label={t("resources.title")}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold text-ink">{t("resources.title")}</h2>
        <Button onClick={onConfigure}>{t("resources.configure")}</Button>
      </div>
      {error && <p role="alert" className="text-red">{error}</p>}
      {resources === null && !error && <Loading />}
      {resources?.length === 0 && <p className="text-ink-2">{t("resources.empty")}</p>}
      {editing && (
        <div className="space-y-3 rounded-control border border-line bg-surface p-4">
          <label className="block space-y-2">
            <span>{t("resources.registry")}</span>
            <textarea
              className="w-full rounded-control border border-line bg-field p-3 font-mono text-ink"
              rows={12}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
            />
          </label>
          <p className="text-ink-2">{t("resources.registry_help")}</p>
          <div className="flex gap-2">
            <Button onClick={onSave} disabled={saving}>{t("resources.save")}</Button>
            <Button onClick={onCancelEdit}>{t("resources.cancel")}</Button>
          </div>
        </div>
      )}
      {resources?.map((resource) => <ResourceCard key={resource.id} resource={resource} now={now} />)}
    </section>
  );
}

interface PendingLoad {
  epoch: number;
  gen: number;
  controller: AbortController;
}

interface PendingSave {
  epoch: number;
  seq: number;
  controller: AbortController;
}

export function ResourcesPanel({ deps }: ResourcesPanelProps = {}) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);

  const hasControlledResources = deps?.resources !== undefined || deps?.subscribeResources !== undefined;
  const resourcesDep = deps?.resources;
  const readControlledResources = useCallback((): readonly ResourceStatus[] | null => {
    if (resourcesDep === undefined) return null;
    return typeof resourcesDep === "function" ? resourcesDep() : resourcesDep;
  }, [resourcesDep]);
  const controlledResources = useCachedSnapshot(
    readControlledResources,
    typeof resourcesDep === "function" ? deps?.subscribeResources : undefined,
  );

  const hasControlledNow = deps?.now !== undefined;
  const nowDep = deps?.now;
  const readControlledNow = useCallback((): number => {
    if (nowDep === undefined) return 0;
    return typeof nowDep === "function" ? nowDep() : nowDep;
  }, [nowDep]);
  const controlledNow = useCachedSnapshot(
    readControlledNow,
    typeof nowDep === "function" ? deps?.subscribeNow : undefined,
  );
  const [uncontrolledNow, setUncontrolledNow] = useState<number>(() => (deps?.now !== undefined ? 0 : Date.now()));
  const now = hasControlledNow ? controlledNow : (uncontrolledNow || Date.now());

  const [managerSeq, setManagerSeq] = useState(0);
  const panelScope = JSON.stringify([trackedScope.token, managerSeq]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: panelScope, epoch: 1 }));
  const effectiveEpoch = scope.key === panelScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== panelScope) {
    setScope({ key: panelScope, epoch: effectiveEpoch });
  }

  const [loadedState, setLoadedState] = useState<{ epoch: number; value: ResourceStatus[] | null }>({ epoch: 0, value: null });
  const [errorState, setErrorState] = useState<{ epoch: number; message: string }>({ epoch: 0, message: "" });
  const [editorState, setEditorState] = useState<{ epoch: number; editing: boolean; draft: string }>({ epoch: 0, editing: false, draft: "" });
  const [savingState, setSavingState] = useState<{ epoch: number; seq: number; saving: boolean }>({ epoch: 0, seq: 0, saving: false });

  const resources = hasControlledResources
    ? controlledResources
    : (loadedState.epoch === effectiveEpoch ? loadedState.value : null);
  const error = errorState.epoch === effectiveEpoch ? errorState.message : "";
  const editing = editorState.epoch === effectiveEpoch && editorState.editing;
  const draft = editorState.epoch === effectiveEpoch ? editorState.draft : "";
  const saving = savingState.epoch === effectiveEpoch && savingState.saving;

  const activeEpochRef = useRef(0);
  const activeScopeTokenRef = useRef("");
  const lastLoadedEpochRef = useRef(0);
  const loadGenRef = useRef(0);
  const saveSeqRef = useRef(0);
  const pendingLoadRef = useRef<PendingLoad | null>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const depsRef = useRef(deps);
  const readScopeTokenRef = useRef(trackedScope.readToken);
  const hasControlledResourcesRef = useRef(hasControlledResources);

  useLayoutEffect(() => {
    depsRef.current = deps;
    readScopeTokenRef.current = trackedScope.readToken;
    hasControlledResourcesRef.current = hasControlledResources;
  });

  const abortAllPending = useCallback(() => {
    pendingLoadRef.current?.controller.abort();
    pendingLoadRef.current = null;
    pendingSaveRef.current?.controller.abort();
    pendingSaveRef.current = null;
    loadGenRef.current += 1;
    saveSeqRef.current += 1;
  }, []);

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    activeScopeTokenRef.current = trackedScope.token;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      abortAllPending();
    };
  }, [effectiveEpoch, trackedScope.token, abortAllPending]);

  const reportError = useCallback((msg: string, err: unknown) => {
    try {
      depsRef.current?.onError?.(msg, err);
    } catch {
      // Error observer failures stay non-blocking so recovery never leaves saving stuck.
    }
  }, []);

  const runLoad = useCallback(() => {
    const runEpoch = activeEpochRef.current;
    const runScopeToken = activeScopeTokenRef.current;
    if (runEpoch === 0 || readScopeTokenRef.current() !== runScopeToken) return;
    if (hasControlledResourcesRef.current) return;

    pendingLoadRef.current?.controller.abort();
    const controller = new AbortController();
    const gen = ++loadGenRef.current;
    pendingLoadRef.current = { epoch: runEpoch, gen, controller };

    const isLoadCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === runEpoch
      && activeScopeTokenRef.current === runScopeToken
      && readScopeTokenRef.current() === runScopeToken
      && loadGenRef.current === gen
      && !hasControlledResourcesRef.current;

    if (depsRef.current?.now === undefined) {
      setUncontrolledNow(Date.now());
    }

    void (async () => {
      try {
        const raw = depsRef.current?.readResources
          ? await depsRef.current.readResources(controller.signal)
          : await api<{ resources: ResourceStatus[] }>("/resources", { signal: controller.signal });
        if (!isLoadCurrent()) return;
        const list = Array.isArray(raw) ? raw : raw.resources;
        setLoadedState({ epoch: runEpoch, value: list });
        setErrorState({ epoch: runEpoch, message: "" });
        if (depsRef.current?.now === undefined) {
          setUncontrolledNow(Date.now());
        }
      } catch (err) {
        if (!isLoadCurrent()) return;
        const msg = safeFormatError(depsRef.current?.formatError, err);
        setErrorState({ epoch: runEpoch, message: msg });
        reportError(msg, err);
      } finally {
        if (pendingLoadRef.current?.gen === gen) pendingLoadRef.current = null;
      }
    })();
  }, [reportError]);

  const onManagerChoiceDep = deps?.onManagerChoice;
  const onResourcesEventDep = deps?.onResourcesEvent;
  const pollDep = deps?.poll;
  const pollIntervalMs = deps?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const handleManagerSwitch = () => {
      abortAllPending();
      setManagerSeq((seq) => seq + 1);
    };

    if (hasControlledResources) {
      if (onManagerChoiceDep) {
        cleanups.push(onManagerChoiceDep(handleManagerSwitch));
      }
      return () => {
        cleanups.forEach((off) => off());
      };
    }

    const applyPush = (nextResources: ResourceStatus[]) => {
      const runEpoch = activeEpochRef.current;
      const runScopeToken = activeScopeTokenRef.current;
      if (runEpoch === 0 || readScopeTokenRef.current() !== runScopeToken || hasControlledResourcesRef.current) return;
      pendingLoadRef.current?.controller.abort();
      pendingLoadRef.current = null;
      loadGenRef.current += 1;
      setErrorState({ epoch: runEpoch, message: "" });
      setLoadedState({ epoch: runEpoch, value: nextResources });
      if (depsRef.current?.now === undefined) {
        setUncontrolledNow(Date.now());
      }
    };

    cleanups.push((onManagerChoiceDep ?? onManagerChoice)(handleManagerSwitch));
    cleanups.push(
      pollDep
        ? pollDep(() => runLoad(), pollIntervalMs)
        : visiblePoll(() => runLoad(), pollIntervalMs, documentPage),
    );
    cleanups.push(
      onResourcesEventDep
        ? onResourcesEventDep(applyPush)
        : onHubEvent("resources", (event) => {
          if (fromShownManager(event) && Array.isArray(event.resources)) {
            applyPush(event.resources as ResourceStatus[]);
          }
        }),
    );

    return () => {
      lastLoadedEpochRef.current = 0;
      cleanups.forEach((off) => off());
    };
  }, [hasControlledResources, onManagerChoiceDep, onResourcesEventDep, pollDep, pollIntervalMs, abortAllPending, runLoad]);

  useEffect(() => {
    if (hasControlledResources) {
      lastLoadedEpochRef.current = 0;
      return;
    }
    if (lastLoadedEpochRef.current === 0) {
      lastLoadedEpochRef.current = effectiveEpoch;
      return;
    }
    if (lastLoadedEpochRef.current !== effectiveEpoch) {
      lastLoadedEpochRef.current = effectiveEpoch;
      runLoad();
    }
  }, [effectiveEpoch, hasControlledResources, runLoad]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && activeScopeTokenRef.current === capturedScopeToken
    && readScopeTokenRef.current() === capturedScopeToken;

  const configure = () => {
    if (!isScopeLive()) return;
    const nextDraft = JSON.stringify(
      (resources ?? []).map(({ id, capacity, mirror, repositories }) => ({ id, capacity, mirror, repositories })),
      null,
      2,
    );
    setEditorState({ epoch: capturedEpoch, editing: true, draft: nextDraft });
  };

  const handleDraftChange = (value: string) => {
    if (!isScopeLive()) return;
    setEditorState((prev) => (prev.epoch === capturedEpoch && prev.editing ? { ...prev, draft: value } : prev));
  };

  const cancelEdit = () => {
    if (!isScopeLive()) return;
    pendingSaveRef.current?.controller.abort();
    pendingSaveRef.current = null;
    saveSeqRef.current += 1;
    setSavingState({ epoch: capturedEpoch, seq: saveSeqRef.current, saving: false });
    setEditorState({ epoch: capturedEpoch, editing: false, draft: "" });
  };

  const save = () => {
    if (!isScopeLive() || !editing || pendingSaveRef.current !== null) return;
    const draftSnapshot = draft;
    let definitions: ResourceDefinition[];
    try {
      const parsed = JSON.parse(draftSnapshot) as unknown;
      if (!Array.isArray(parsed)) throw new Error(t("resources.invalid"));
      definitions = parsed as ResourceDefinition[];
    } catch (err) {
      const msg = safeFormatError(depsRef.current?.formatError, err);
      setErrorState({ epoch: capturedEpoch, message: msg });
      reportError(msg, err);
      return;
    }

    pendingLoadRef.current?.controller.abort();
    pendingLoadRef.current = null;
    loadGenRef.current += 1;

    const controller = new AbortController();
    const runSeq = ++saveSeqRef.current;
    pendingSaveRef.current = { epoch: capturedEpoch, seq: runSeq, controller };

    const isSaveCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && pendingSaveRef.current?.seq === runSeq;

    setSavingState({ epoch: capturedEpoch, seq: runSeq, saving: true });

    void (async () => {
      try {
        if (depsRef.current?.saveResources) {
          await depsRef.current.saveResources(definitions, controller.signal);
        } else {
          await api("/resources", { method: "PUT", json: { resources: definitions }, signal: controller.signal });
        }
        if (!isSaveCurrent()) return;

        if (!hasControlledResourcesRef.current) {
          pendingLoadRef.current?.controller.abort();
          pendingLoadRef.current = null;
          loadGenRef.current += 1;
          const raw = depsRef.current?.readResources
            ? await depsRef.current.readResources(controller.signal)
            : await api<{ resources: ResourceStatus[] }>("/resources", { signal: controller.signal });
          if (!isSaveCurrent()) return;
          const nextList = Array.isArray(raw) ? raw : raw.resources;
          loadGenRef.current += 1;
          setLoadedState({ epoch: capturedEpoch, value: nextList });
          if (depsRef.current?.now === undefined) {
            setUncontrolledNow(Date.now());
          }
        }

        setEditorState({ epoch: capturedEpoch, editing: false, draft: "" });
        setErrorState({ epoch: capturedEpoch, message: "" });
      } catch (err) {
        if (!isSaveCurrent()) return;
        const msg = safeFormatError(depsRef.current?.formatError, err);
        setErrorState({ epoch: capturedEpoch, message: msg });
        reportError(msg, err);
      } finally {
        if (pendingSaveRef.current?.seq === runSeq) pendingSaveRef.current = null;
        if (activeEpochRef.current === capturedEpoch) {
          setSavingState((prev) => (prev.epoch === capturedEpoch && prev.seq === runSeq ? { epoch: capturedEpoch, seq: runSeq, saving: false } : prev));
        }
      }
    })();
  };

  const viewProps: ResourcesPanelViewProps = {
    resources,
    now,
    error,
    editing,
    draft,
    saving,
    onConfigure: configure,
    onDraftChange: handleDraftChange,
    onSave: save,
    onCancelEdit: cancelEdit,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <ResourcesPanelView {...viewProps} />;
}

export function ResourceCard({ resource, now }: { resource: ResourceStatus; now: number }) {
  const mirror = resource.mirror_state;
  const age = ageSeconds(mirror.observed_at, now);
  const stale = mirror.unknown || age === null || age > 30;
  const queue = mirror.queue;
  const jobs = [...(queue?.running ?? []), ...(queue?.waiting ?? [])];
  return <article className="space-y-3 rounded-control border border-line bg-surface p-4">
    <h3 className="font-semibold text-ink">{resource.id}</h3>
    <p className="text-ink-2">{t("resources.capacity", { used: queue?.running.length ?? t("resources.unknown"), capacity: queue?.slots ?? resource.capacity })}</p>
    <p role={stale ? "status" : undefined} className={stale ? "text-attention" : "text-ink-2"}>
      {age === null ? t("resources.never") : t(stale ? "resources.stale" : "resources.fresh", { seconds: age })}
    </p>
    {jobs.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left">
      <caption className="sr-only">{t("resources.queue")}</caption>
      <thead className="text-ink-2"><tr>{["ticket", "project", "commit", "groups", "waiting", "start"].map((key) => <th key={key} className="p-2 font-medium">{t(`resources.${key}`)}</th>)}</tr></thead>
      <tbody>{jobs.map((job, index) => <tr key={job.ticket || job.run || `${job.slot ?? "q"}-${job.position ?? index}`} className="border-t border-line">
        <td className="p-2">{job.ticket || job.run || t("resources.unknown")}{job.duplicate_of && <span className="block text-attention">{t("resources.duplicate", { ticket: job.duplicate_of })}</span>}</td>
        <td className="p-2">{job.project}</td><td className="p-2 font-mono">{job.commit || t("resources.unknown")}</td>
        <td className="p-2">{job.groups.join(", ")}</td>
        <td className="p-2">{jobAgeSeconds(job, now) === null ? t("resources.unknown") : t("resources.seconds", { seconds: jobAgeSeconds(job, now)! })}</td>
        <td className="p-2">{job.position ? t("resources.position", { position: job.position }) : t("resources.running")}</td>
      </tr>)}</tbody>
    </table></div>}
    {!queue && <p className="text-ink-2">{t("resources.unknown")}</p>}
    {resource.leases.filter((lease) => lease.state === "queued" || lease.state === "granted").map((lease) => <p key={lease.id} className="text-ink-2">
      {lease.holder.label || lease.holder.machine} · {t(`resources.${lease.state}`)}
      {!!lease.joiners?.length && <> · {t("resources.joined", { count: lease.joiners.length })}</>}
    </p>)}
    {mirror.raw && <details><summary>{t("resources.raw")}</summary><pre className="overflow-x-auto whitespace-pre-wrap text-ink-2">{mirror.raw}</pre></details>}
  </article>;
}
