// The alert sheet's memory, CPU and load section (#8037): the numbers; the largest process groups the node names (by
// memory, or by CPU for CPU and load) and the Agents on this computer by what they are doing; then Stop idle Agents
// (after a confirmation that lists each one; working and needs-you Agents are never in it) and Hand work to another
// computer. Without the node's diagnosis the Agents and both actions still work.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../i18n";
import { errorText, isAbort } from "../../lib/api";
import { sessionTitle, stateOf } from "../../lib/format";
import { stateName } from "../../lib/state-labels";
import { bytesBin, load as loadText, percent, uptime, usedOfTotal } from "../../lib/machine-detail";
import { loadDefinition, perCoreLabel, readings, type AlertKind } from "../../lib/machine-alerts";
import { stopAgents, stoppableAgents, type StopOutcome } from "../../lib/machine-handoff";
import { diagnosisFailure, type Diagnosis, type DiagnosisFailure, type DiagnosisSection, type ProcessGroup } from "../../lib/machine-diagnosis";
import { sameValue } from "../../lib/stable-lines";
import { refresh } from "../../lib/store";
import type { Machine, MachineMetrics, Session } from "../../lib/types";
import { Button, cx, Dialog, StatePill, useNow } from "../../ui/atoms";
import { DiagnosisLoading, DiagnosisNote, Figure, SheetPart, ShareBar, useDiagnosis, type DiagnosisRead } from "./AlertParts";

const SHOWN = 5;
const SECTIONS = ["processes"] as const;
const noopSubscribe = () => () => {};

interface PendingOp {
  epoch: number;
  seq: number;
  controller: AbortController;
}

export interface AgentGroupsViewProps {
  agents: readonly Session[];
  known: "yes" | "loading" | "failed";
  now: number;
}

export interface AgentGroupsDeps {
  /** Controlled clock timestamp in ms (value or getter; bypasses `useNow` timer when supplied). */
  now?: number | (() => number);
  /** Subscribe to clock updates when `now` is a getter. */
  subscribeNow?: (listener: () => void) => () => void;
  /** Optional custom view renderer (defaults to `<AgentGroupsView>`). */
  renderView?: (props: AgentGroupsViewProps) => ReactNode;
}

export interface AgentGroupsProps {
  agents: readonly Session[];
  known: "yes" | "loading" | "failed";
  deps?: AgentGroupsDeps;
}

export interface PressureSectionViewProps {
  kind: Extract<AlertKind, "memory" | "cpu" | "load">;
  machine: Machine;
  metrics?: MachineMetrics;
  agents: readonly Session[];
  agentsKnown: "yes" | "loading" | "failed";
  redeploy?: ReactNode;
  diagnosis: DiagnosisRead;
  showAllProcesses: boolean;
  now: number;
  idleAgents: readonly Session[];
  asking: readonly Session[] | null;
  busy: boolean;
  outcome: readonly StopOutcome[] | null;
  stopError?: string;
  onRetryDiagnosis: () => void;
  onToggleShowAllProcesses: () => void;
  onOpenStopDialog: () => void;
  onCloseStopDialog: () => void;
  onConfirmStop: () => void;
  onHandoff: () => void;
}

export interface PressureSectionDeps {
  /** Optional scope partition (value or getter); switching it resets confirmation dialog, busy, outcome, error, and diagnosis load state while aborting in-flight calls and fencing stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled diagnosis state (value or getter; bypasses `useDiagnosis` when supplied). */
  diagnosis?: DiagnosisRead | (() => DiagnosisRead);
  /** Subscribe to diagnosis state updates when `diagnosis` is a getter. */
  subscribeDiagnosis?: (listener: () => void) => () => void;
  /** Controlled diagnosis loader (bypasses `useDiagnosis` and `fetchDiagnosis` when supplied). */
  loadDiagnosis?: (machineId: string, sections: readonly DiagnosisSection[], signal: AbortSignal) => Promise<Diagnosis> | Diagnosis;
  /** Controlled retry handler when `diagnosis` is directly provided without `loadDiagnosis`. */
  onReloadDiagnosis?: (signal: AbortSignal) => void | Promise<unknown>;
  /** Custom failure mapper for `loadDiagnosis` errors (defaults to `lib/machine-diagnosis.diagnosisFailure`). */
  diagnosisFailure?: (error: unknown) => DiagnosisFailure;
  /** Controlled stop-idle action (bypasses `lib/machine-handoff.stopAgents` when supplied). */
  stopAgents?: (list: readonly Session[], signal: AbortSignal) => Promise<StopOutcome[]> | StopOutcome[];
  /** Controlled post-stop refresh action (bypasses `lib/store.refresh` when supplied). */
  refresh?: (signal: AbortSignal) => void | Promise<unknown>;
  /** Controlled clock timestamp in ms (value or getter; bypasses `useNow` timer when supplied). */
  now?: number | (() => number);
  /** Subscribe to clock updates when `now` is a getter. */
  subscribeNow?: (listener: () => void) => () => void;
  /** Shared fallback subscription for any getter dep without a dedicated subscriber. */
  subscribe?: (listener: () => void) => () => void;
  /** Controlled handoff handler (overrides `onHandoff` prop when supplied). */
  onHandoff?: (signal: AbortSignal) => void | Promise<unknown>;
  /** Format thrown action errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when diagnosis loading, stopping, or handoff throws or rejects in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<PressureSectionView>`). */
  renderView?: (props: PressureSectionViewProps) => ReactNode;
}

export interface PressureSectionProps {
  kind: Extract<AlertKind, "memory" | "cpu" | "load">;
  machine: Machine;
  metrics?: MachineMetrics;
  agents: readonly Session[];
  agentsKnown: "yes" | "loading" | "failed";
  /** Redeploy for a computer whose Persona is too old to say what uses it (shown only when the hub can deploy). */
  redeploy?: ReactNode;
  onHandoff: () => void;
  deps?: PressureSectionDeps;
}

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

function safeDiagnosisFailure(mapper: ((error: unknown) => DiagnosisFailure) | undefined, fmt: ((error: unknown) => string) | undefined, error: unknown): DiagnosisFailure {
  if (mapper) {
    try {
      return mapper(error);
    } catch {
      // Fall back to default diagnosis failure formatting.
    }
  }
  try {
    return diagnosisFailure(error);
  } catch {
    return { kind: "error", text: safeFormatError(fmt, error) };
  }
}

function safeOnError(onError: ((message: string) => void) | undefined, message: string) {
  if (!onError) return;
  try {
    onError(message);
  } catch {
    // Error observer failures stay non-blocking so recovery never leaves busy stuck.
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

const KIND_LABEL: Record<string, () => string> = {
  agent: () => t("machines-alerts.kind_agent"),
  engine: () => t("machines-alerts.kind_engine"),
  persona: () => t("machines-alerts.kind_persona"),
};

function ProcessList({ data, byCpu, cores, all, onToggleAll }: { data: Diagnosis; byCpu: boolean; cores?: number; all: boolean; onToggleAll: () => void }) {
  const p = data.processes;
  const groups = useMemo(() => {
    const list = [...(p?.groups ?? [])];
    if (byCpu) list.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.rss - a.rss);
    return list;
  }, [p, byCpu]);
  if (!p || !groups.length) return <p className="py-1 text-meta text-ink-3">{t("machines-alerts.processes_none")}</p>;
  const shown = all ? groups : groups.slice(0, SHOWN);
  const share = (g: ProcessGroup) => (byCpu ? (g.cpu ?? 0) / (100 * (cores || 1)) : p.mem_total ? g.rss / p.mem_total : 0);
  return (
    <div data-testid="process-groups">
      <ul className="divide-y divide-line">
        {shown.map((g) => (
          <li key={g.name} className="py-1.5" data-process={g.name}>
            <div className="flex items-baseline gap-2 text-meta">
              <span className="min-w-0 truncate font-medium text-ink">{g.name}</span>
              <span className="shrink-0 rounded-chip bg-field px-1.5 text-submeta text-ink-2">{(KIND_LABEL[g.kind] ?? (() => t("machines-alerts.kind_misc")))()}</span>
              {g.count > 1 && <span className="shrink-0 text-submeta text-ink-3 tabular-nums">{t("machines-alerts.process_count", { count: g.count })}</span>}
              <span className="ml-auto shrink-0 text-ink-2 tabular-nums">
                {byCpu ? `${percent(g.cpu)} · ${bytesBin(g.rss)}` : `${bytesBin(g.rss)} · ${percent(share(g) * 100)}`}
              </span>
            </div>
            <div className="mt-1">
              <ShareBar share={share(g)} />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex items-center gap-2 text-submeta text-ink-3">
        <span className="flex-1">{t("machines-alerts.processes_seen", { count: p.count })}</span>
        {groups.length > SHOWN && (
          <Button size="sm" tone="quiet" onClick={onToggleAll} expanded={all}>
            {all ? t("machines-alerts.show_fewer") : t("machines-alerts.show_all", { count: groups.length })}
          </Button>
        )}
      </div>
    </div>
  );
}

type Group = "needs_you" | "working" | "idle";
const groupOf = (s: Session): Group => {
  const st = stateOf(s);
  return st === "needs_you" ? "needs_you" : st === "working" ? "working" : "idle";
};

function DefaultNowBridge({ render }: { render: (now: number) => ReactNode }) {
  const now = useNow(60_000);
  return <>{render(now)}</>;
}

/** Pure presentational view for the computer's Agents grouped by needs you, working, and idle. */
export function AgentGroupsView({ agents, known, now }: AgentGroupsViewProps) {
  if (known !== "yes") return <p className="mt-3 text-meta text-ink-3">{known === "loading" ? t("machines-alerts.agents_loading") : t("machines-alerts.agents_failed")}</p>;
  const groups: Record<Group, Session[]> = { needs_you: [], working: [], idle: [] };
  for (const s of agents) groups[groupOf(s)].push(s);
  const heading: Record<Group, string> = { needs_you: stateName("needs_you"), working: stateName("working"), idle: t("machines-alerts.agents_idle") };
  return (
    <div className="mt-3" data-testid="agent-groups">
      <h4 className="mb-1 text-meta font-medium text-ink">{t("machines-alerts.agents_title", { count: agents.length })}</h4>
      {!agents.length && <p className="text-meta text-ink-3">{t("machines-alerts.agents_none")}</p>}
      {(["needs_you", "working", "idle"] as Group[]).filter((g) => groups[g].length).map((g) => (
        <div key={g} className="mt-1.5" data-group={g}>
          <div className="text-submeta text-ink-3">{heading[g]} · {groups[g].length}</div>
          <ul>
            {groups[g].map((s) => {
              const since = Date.parse(s.state_since || s.updated_at || "");
              return (
                <li key={s.session_id} className="flex items-center gap-2 py-1 text-meta">
                  <span className="min-w-0 flex-1 truncate text-ink">{sessionTitle(s)}</span>
                  {g === "idle" && Number.isFinite(since) && <span className="shrink-0 text-submeta text-ink-3 tabular-nums">{t("machines-alerts.idle_for", { time: uptime(since / 1000, now / 1000) })}</span>}
                  <StatePill state={stateOf(s)} />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The computer's Agents: needs you, working, idle (with how long), as the native cards count them. */
export function AgentGroups({ agents, known, deps }: AgentGroupsProps) {
  const controlledNow = useCachedExternalValue(deps?.now, deps?.subscribeNow);
  const needDefaultNow = deps?.now === undefined;

  const renderView = (now: number) => {
    const viewProps: AgentGroupsViewProps = { agents, known, now };
    if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
    return <AgentGroupsView {...viewProps} />;
  };

  if (needDefaultNow) {
    return <DefaultNowBridge render={renderView} />;
  }
  return renderView(controlledNow ?? 0);
}

/** Pure presentational view for the alert sheet's memory, CPU, and load section. */
export function PressureSectionView({
  kind,
  machine,
  metrics,
  agents,
  agentsKnown,
  redeploy,
  diagnosis,
  showAllProcesses,
  now,
  idleAgents,
  asking,
  busy,
  outcome,
  stopError,
  onRetryDiagnosis,
  onToggleShowAllProcesses,
  onOpenStopDialog,
  onCloseStopDialog,
  onConfirmStop,
  onHandoff,
}: PressureSectionViewProps) {
  const r = readings(machine, metrics);
  const latest = metrics?.latest;
  const total = latest?.mem_total || metrics?.system?.memory || machine.system?.memory;
  const byCpu = kind !== "memory";
  const tone = (v: number | undefined, warn: number, crit: number) => (v === undefined ? undefined : v >= crit ? "critical" as const : v >= warn ? "warning" as const : undefined);
  const others = agents.length > 0;
  const failed = outcome?.filter((o) => !o.ok) ?? [];

  return (
    <>
      <SheetPart part="what">
        <div className="grid grid-cols-3 gap-3" data-testid="pressure-figures">
          <Figure label={t("machines-alerts.memory")} value={percent(r.memory)} detail={usedOfTotal(latest?.mem_used, total)} tone={tone(r.memory, 80, 90)} />
          <Figure label="CPU" value={percent(r.cpu)} detail={r.cores ? t("machines-alerts.cores", { count: r.cores }) : undefined} tone={tone(r.cpu, 75, 90)} />
          <Figure label={t("machines-alerts.load")} value={loadText(latest?.load)} detail={r.load !== undefined ? perCoreLabel(r.load) : undefined} tone={tone(r.load, 1, 2)} />
        </div>
        {/* the load alert says what it counts before anything else (#12519): high load with CPU to spare is queuing */}
        {kind === "load" && <p className="mt-2 text-meta leading-relaxed text-ink-2" data-testid="load-definition">{loadDefinition()}</p>}
      </SheetPart>
      <SheetPart part="why">
        <h4 className="mb-1 text-meta font-medium text-ink">{byCpu ? t("machines-alerts.processes_cpu") : t("machines-alerts.processes_memory")}</h4>
        {diagnosis.state === "loading" && <DiagnosisLoading label={t("machines-alerts.processes_loading")} />}
        {diagnosis.state === "failed" && <DiagnosisNote failure={diagnosis.failure} onRetry={onRetryDiagnosis} redeploy={redeploy} />}
        {diagnosis.state === "ok" && <ProcessList data={diagnosis.data} byCpu={byCpu} cores={r.cores} all={showAllProcesses} onToggleAll={onToggleShowAllProcesses} />}
        <AgentGroupsView agents={agents} known={agentsKnown} now={now} />
      </SheetPart>
      <SheetPart part="do">
        <div className="flex flex-wrap gap-2">
          <Button tone="secondary" icon="stop" disabled={agentsKnown !== "yes" || !idleAgents.length || !machine.online} onClick={onOpenStopDialog} testId="stop-idle">
            {idleAgents.length ? t("machines-alerts.stop_idle_count", { count: idleAgents.length }) : t("machines-alerts.stop_idle")}
          </Button>
          <Button tone="secondary" icon="forward" disabled={agentsKnown !== "yes" || !others} onClick={onHandoff} testId="handoff">
            {t("machines-alerts.handoff")}
          </Button>
        </div>
        <p className="mt-1.5 text-submeta text-ink-3">{agentsKnown === "yes" && !idleAgents.length ? t("machines-alerts.stop_idle_none") : t("machines-alerts.stop_idle_note")}</p>
        {stopError && (
          <p className="mt-2 break-words text-meta text-red" role="alert" data-testid="stop-error">
            {stopError}
          </p>
        )}
        {outcome && (
          <div className={cx("mt-2 rounded-control px-3 py-2 text-meta", failed.length ? "bg-red-tint" : "bg-green-tint")} role="status" data-testid="stop-outcome">
            <p className={failed.length ? "text-red" : "text-green"}>{t("machines-alerts.stopped", { count: outcome.length - failed.length, total: outcome.length })}</p>
            {failed.map((f) => (
              <p key={f.session.session_id} className="mt-0.5 break-words text-ink-2">{t("machines-alerts.stop_failed_item", { title: sessionTitle(f.session), error: f.error ?? "" })}</p>
            ))}
          </div>
        )}
        <Dialog
          open={!!asking}
          onClose={() => !busy && onCloseStopDialog()}
          title={t("machines-alerts.stop_confirm_title", { count: asking?.length ?? 0 })}
          footer={
            <>
              <Button tone="quiet" disabled={busy} onClick={onCloseStopDialog}>
                {t("common.cancel")}
              </Button>
              <Button tone="danger" busy={busy} disabled={busy} onClick={onConfirmStop} testId="stop-confirm">
                {t("machines-alerts.stop_confirm", { count: asking?.length ?? 0 })}
              </Button>
            </>
          }
        >
          <p className="text-meta leading-relaxed text-ink-2">{t("machines-alerts.stop_confirm_body", { machine: machine.name })}</p>
          <ul className="mt-2 space-y-1" data-testid="stop-list">
            {asking?.map((s) => (
              <li key={s.session_id} className="flex items-center gap-2 text-meta">
                <span className="min-w-0 flex-1 truncate text-ink">{sessionTitle(s)}</span>
                <StatePill state={stateOf(s)} />
              </li>
            ))}
          </ul>
        </Dialog>
      </SheetPart>
    </>
  );
}

interface DefaultDiagnosisState {
  read: DiagnosisRead;
  reload: () => void;
}

function DefaultDiagnosisBridge({ machineId, online, render }: { machineId: string; online: boolean; render: (state: DefaultDiagnosisState) => ReactNode }) {
  const state = useDiagnosis(machineId, SECTIONS, online);
  return <>{render(state)}</>;
}

interface PressureSectionBodyProps {
  kind: Extract<AlertKind, "memory" | "cpu" | "load">;
  machine: Machine;
  metrics?: MachineMetrics;
  agents: readonly Session[];
  agentsKnown: "yes" | "loading" | "failed";
  redeploy?: ReactNode;
  onHandoff: () => void;
  now: number;
  controlledDiagnosis?: DiagnosisRead;
  defaultDiagnosis?: DefaultDiagnosisState;
  outerScopeToken: string;
  readOuterScopeToken: () => string;
  deps?: PressureSectionDeps;
}

function PressureSectionBody({
  kind,
  machine,
  metrics,
  agents,
  agentsKnown,
  redeploy,
  onHandoff,
  now,
  controlledDiagnosis,
  defaultDiagnosis,
  outerScopeToken,
  readOuterScopeToken,
  deps,
}: PressureSectionBodyProps) {
  const sectionScope = JSON.stringify([outerScopeToken, machine.id]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: sectionScope, epoch: 1 }));
  const effectiveEpoch = scope.key === sectionScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== sectionScope) {
    setScope({ key: sectionScope, epoch: effectiveEpoch });
  }

  const idleAgents = useMemo(() => stoppableAgents(agents), [agents]);

  const [askingState, setAskingState] = useState<{ epoch: number; list: Session[] | null }>({ epoch: 0, list: null });
  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });
  const [outcomeState, setOutcomeState] = useState<{ epoch: number; outcome: StopOutcome[] | null }>({ epoch: 0, outcome: null });
  const [stopErrorState, setStopErrorState] = useState<{ epoch: number; message: string }>({ epoch: 0, message: "" });
  const [showAllState, setShowAllState] = useState<{ epoch: number; kind: string; all: boolean }>({ epoch: 0, kind: "", all: false });
  const [loadedDiagState, setLoadedDiagState] = useState<{ epoch: number; read: DiagnosisRead }>({ epoch: 0, read: { state: "loading" } });
  const [diagTick, setDiagTick] = useState(0);

  const asking = askingState.epoch === effectiveEpoch ? askingState.list : null;
  const busy = busyState.epoch === effectiveEpoch && busyState.busy;
  const outcome = outcomeState.epoch === effectiveEpoch ? outcomeState.outcome : null;
  const stopError = stopErrorState.epoch === effectiveEpoch ? stopErrorState.message : "";
  const showAllProcesses = showAllState.epoch === effectiveEpoch && showAllState.kind === kind && showAllState.all;

  const activeEpochRef = useRef(0);
  const diagSeqRef = useRef(0);
  const reloadSeqRef = useRef(0);
  const stopSeqRef = useRef(0);
  const handoffSeqRef = useRef(0);
  const pendingDiagRef = useRef<PendingOp | null>(null);
  const pendingReloadRef = useRef<PendingOp | null>(null);
  const pendingStopRef = useRef<PendingOp | null>(null);
  const pendingHandoffRef = useRef<PendingOp | null>(null);
  const depsRef = useRef(deps);
  const propOnHandoffRef = useRef(onHandoff);
  const defaultDiagnosisRef = useRef(defaultDiagnosis);
  const idleAgentsRef = useRef(idleAgents);
  const askingRef = useRef(asking);
  const readScopeTokenRef = useRef(readOuterScopeToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    propOnHandoffRef.current = onHandoff;
    defaultDiagnosisRef.current = defaultDiagnosis;
    idleAgentsRef.current = idleAgents;
    askingRef.current = asking;
    readScopeTokenRef.current = readOuterScopeToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pendingDiagRef.current?.controller.abort();
      pendingDiagRef.current = null;
      pendingReloadRef.current?.controller.abort();
      pendingReloadRef.current = null;
      pendingStopRef.current?.controller.abort();
      pendingStopRef.current = null;
      pendingHandoffRef.current?.controller.abort();
      pendingHandoffRef.current = null;
      diagSeqRef.current += 1;
      reloadSeqRef.current += 1;
      stopSeqRef.current += 1;
      handoffSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = outerScopeToken;
  const capturedMachineId = machine.id;
  const hasLoadDiagnosis = deps?.diagnosis === undefined && deps?.loadDiagnosis !== undefined;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  useEffect(() => {
    if (!hasLoadDiagnosis) return;
    if (!machine.online || !capturedMachineId) return;
    if (activeEpochRef.current !== capturedEpoch || readScopeTokenRef.current() !== capturedScopeToken) return;
    const loader = depsRef.current?.loadDiagnosis;
    if (!loader) return;

    const controller = new AbortController();
    const runSeq = ++diagSeqRef.current;
    pendingDiagRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setLoadedDiagState({ epoch: capturedEpoch, read: { state: "loading" } });

    const isDiagCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && diagSeqRef.current === runSeq
      && readScopeTokenRef.current() === capturedScopeToken;

    void (async () => {
      try {
        const data = await loader(capturedMachineId, SECTIONS, controller.signal);
        if (!isDiagCurrent()) return;
        setLoadedDiagState({ epoch: capturedEpoch, read: { state: "ok", data } });
      } catch (err) {
        if (isDiagCurrent() && !isAbort(err)) {
          const failure = safeDiagnosisFailure(depsRef.current?.diagnosisFailure, depsRef.current?.formatError, err);
          setLoadedDiagState({ epoch: capturedEpoch, read: { state: "failed", failure } });
          safeOnError(depsRef.current?.onError, failure.text);
        }
      } finally {
        if (pendingDiagRef.current?.seq === runSeq) pendingDiagRef.current = null;
      }
    })();

    return () => {
      controller.abort();
      if (pendingDiagRef.current?.seq === runSeq) pendingDiagRef.current = null;
      diagSeqRef.current += 1;
    };
  }, [hasLoadDiagnosis, capturedEpoch, capturedScopeToken, capturedMachineId, machine.online, diagTick]);

  const handleRetryDiagnosis = () => {
    if (!isScopeLive()) return;
    if (depsRef.current?.diagnosis !== undefined) {
      const customReload = depsRef.current.onReloadDiagnosis;
      if (!customReload || pendingReloadRef.current !== null) return;
      const controller = new AbortController();
      const runSeq = ++reloadSeqRef.current;
      const isReloadCurrent = () =>
        !controller.signal.aborted
        && isScopeLive()
        && reloadSeqRef.current === runSeq;
      let res: unknown;
      try {
        res = customReload(controller.signal);
      } catch (err) {
        if (isReloadCurrent() && !isAbort(err)) {
          safeOnError(depsRef.current?.onError, safeFormatError(depsRef.current?.formatError, err));
        }
        return;
      }
      if (!isThenable(res)) return;
      pendingReloadRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
      void (async () => {
        try {
          await res;
        } catch (err) {
          if (isReloadCurrent() && !isAbort(err)) {
            safeOnError(depsRef.current?.onError, safeFormatError(depsRef.current?.formatError, err));
          }
        } finally {
          if (pendingReloadRef.current?.seq === runSeq) pendingReloadRef.current = null;
        }
      })();
      return;
    }
    if (depsRef.current?.loadDiagnosis !== undefined) {
      setDiagTick((n) => n + 1);
      return;
    }
    defaultDiagnosisRef.current?.reload();
  };

  const handleToggleShowAllProcesses = () => {
    if (!isScopeLive()) return;
    setShowAllState((prev) => ({
      epoch: capturedEpoch,
      kind,
      all: prev.epoch === capturedEpoch && prev.kind === kind ? !prev.all : true,
    }));
  };

  const handleOpenStopDialog = () => {
    if (!isScopeLive() || pendingStopRef.current !== null) return;
    const list = idleAgentsRef.current;
    if (!list.length) return;
    setStopErrorState({ epoch: capturedEpoch, message: "" });
    setAskingState({ epoch: capturedEpoch, list: [...list] });
  };

  const handleCloseStopDialog = () => {
    if (!isScopeLive() || pendingStopRef.current !== null) return;
    setAskingState({ epoch: capturedEpoch, list: null });
  };

  const handleConfirmStop = () => {
    if (!isScopeLive() || pendingStopRef.current !== null) return;
    const list = askingRef.current ?? [];
    const controller = new AbortController();
    const runSeq = ++stopSeqRef.current;
    pendingStopRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setBusyState({ epoch: capturedEpoch, busy: true });
    setStopErrorState({ epoch: capturedEpoch, message: "" });

    const isStopCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && pendingStopRef.current?.seq === runSeq;

    void (async () => {
      try {
        const stopFn = depsRef.current?.stopAgents;
        const out = await (stopFn ? stopFn(list, controller.signal) : stopAgents(list));
        if (!isStopCurrent()) return;
        setOutcomeState({ epoch: capturedEpoch, outcome: out });
        setAskingState({ epoch: capturedEpoch, list: null });
        try {
          const refreshFn = depsRef.current?.refresh;
          const refreshRes = refreshFn ? refreshFn(controller.signal) : refresh();
          if (isThenable(refreshRes)) await refreshRes;
        } catch {
          // Refresh failures after stop stay non-blocking, matching default behavior.
        }
      } catch (err) {
        if (isStopCurrent() && !isAbort(err)) {
          const msg = safeFormatError(depsRef.current?.formatError, err);
          setStopErrorState({ epoch: capturedEpoch, message: msg });
          setAskingState({ epoch: capturedEpoch, list: null });
          safeOnError(depsRef.current?.onError, msg);
        }
      } finally {
        if (pendingStopRef.current?.seq === runSeq) pendingStopRef.current = null;
        if (activeEpochRef.current === capturedEpoch && stopSeqRef.current === runSeq) {
          setBusyState({ epoch: capturedEpoch, busy: false });
        }
      }
    })();
  };

  const handleHandoff = () => {
    if (!isScopeLive() || pendingHandoffRef.current !== null) return;
    const customHandoff = depsRef.current?.onHandoff;
    if (!customHandoff) {
      propOnHandoffRef.current();
      return;
    }
    const controller = new AbortController();
    const runSeq = ++handoffSeqRef.current;
    const isHandoffCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && handoffSeqRef.current === runSeq;
    let res: unknown;
    try {
      res = customHandoff(controller.signal);
    } catch (err) {
      if (isHandoffCurrent() && !isAbort(err)) {
        safeOnError(depsRef.current?.onError, safeFormatError(depsRef.current?.formatError, err));
      }
      return;
    }
    if (!isThenable(res)) return;
    pendingHandoffRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    void (async () => {
      try {
        await res;
      } catch (err) {
        if (isHandoffCurrent() && !isAbort(err)) {
          safeOnError(depsRef.current?.onError, safeFormatError(depsRef.current?.formatError, err));
        }
      } finally {
        if (pendingHandoffRef.current?.seq === runSeq) pendingHandoffRef.current = null;
      }
    })();
  };

  const diagnosis: DiagnosisRead = deps?.diagnosis !== undefined
    ? (controlledDiagnosis ?? { state: "loading" })
    : hasLoadDiagnosis
      ? (loadedDiagState.epoch === effectiveEpoch ? loadedDiagState.read : { state: "loading" })
      : (defaultDiagnosis?.read ?? { state: "loading" });

  const viewProps: PressureSectionViewProps = {
    kind,
    machine,
    metrics,
    agents,
    agentsKnown,
    redeploy,
    diagnosis,
    showAllProcesses,
    now,
    idleAgents,
    asking,
    busy,
    outcome,
    stopError,
    onRetryDiagnosis: handleRetryDiagnosis,
    onToggleShowAllProcesses: handleToggleShowAllProcesses,
    onOpenStopDialog: handleOpenStopDialog,
    onCloseStopDialog: handleCloseStopDialog,
    onConfirmStop: handleConfirmStop,
    onHandoff: handleHandoff,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <PressureSectionView {...viewProps} />;
}

export function PressureSection({ kind, machine, metrics, agents, agentsKnown, redeploy, onHandoff, deps }: PressureSectionProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey ?? deps?.subscribe);

  // Keep controlled inputs and scope tracking in the identity-stable outer component so direct <-> getter+subscribe switches never remount.
  const controlledDiagnosis = useCachedExternalValue(deps?.diagnosis, deps?.subscribeDiagnosis ?? deps?.subscribe);
  const controlledNow = useCachedExternalValue(deps?.now, deps?.subscribeNow ?? deps?.subscribe);

  const needDefaultDiagnosis = deps?.diagnosis === undefined && deps?.loadDiagnosis === undefined;
  const needDefaultNow = deps?.now === undefined;

  const renderBody = (now: number, defaultDiagnosis?: DefaultDiagnosisState) => (
    <PressureSectionBody
      kind={kind}
      machine={machine}
      metrics={metrics}
      agents={agents}
      agentsKnown={agentsKnown}
      redeploy={redeploy}
      onHandoff={onHandoff}
      now={now}
      controlledDiagnosis={controlledDiagnosis}
      defaultDiagnosis={defaultDiagnosis}
      outerScopeToken={trackedScope.token}
      readOuterScopeToken={trackedScope.readToken}
      deps={deps}
    />
  );

  const renderWithDiagnosis = (now: number) => (
    needDefaultDiagnosis
      ? <DefaultDiagnosisBridge key={trackedScope.token} machineId={machine.id} online={machine.online} render={(state) => renderBody(now, state)} />
      : renderBody(now)
  );

  if (needDefaultNow) {
    return <DefaultNowBridge render={renderWithDiagnosis} />;
  }
  return renderWithDiagnosis(controlledNow ?? 0);
}
