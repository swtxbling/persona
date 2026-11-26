// The alert sheet's section for a computer whose Persona is not the hub's build, or whose last update failed (#8037):
// both builds side by side and how far apart they are, why it matters, how many Agents are working (an update waits
// for them); Redeploy behind a confirmation, then a stepper the machine's pushed `deploy_phase` drives (waiting for
// idle → transferring → restarting → confirming → done) ending in the build the node reports, or the error and Try
// again. Where the hub cannot update it (`can_deploy` false), the hub's reason instead.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatDate, formatList, t } from "../../i18n";
import { errorText, isAbort } from "../../lib/api";
import { stateOf } from "../../lib/format";
import { buildGap, buildTime, gapText } from "../../lib/machine-alerts";
import { machineDeployment } from "../../lib/machine-deploy";
import { hostedManagersForMachine, useRoster, type Manager, type ManagerList } from "../../lib/managers";
import { sameValue } from "../../lib/stable-lines";
import { useStore } from "../../lib/store";
import type { Machine, Session } from "../../lib/types";
import { Button, Dialog } from "../../ui/atoms";
import { Steps } from "../../ui/Steps";
import { HostedManagersList } from "./HostedManagersList";
import { useDeploy } from "./MachineDeploy";
import { SheetPart } from "./AlertParts";

const STEPS = ["waiting_idle", "transferring", "restarting", "confirming", "done"] as const;
type Step = (typeof STEPS)[number];
const noopSubscribe = () => () => {};

const stepLabel = (s: Step): string => {
  switch (s) {
    case "waiting_idle":
      return t("lib-machine-deploy.waiting_idle");
    case "transferring":
      return t("lib-machine-deploy.transferring");
    case "restarting":
      return t("lib-machine-deploy.restarting");
    case "confirming":
      return t("lib-machine-deploy.confirming");
    default:
      return t("machines-alerts.step_done");
  }
};

/** Where an update stands: the step under way (or reached), and how it ended. */
export interface DeployProgress {
  step: number;
  outcome: "running" | "done" | "failed" | "idle";
}

export type DeployNoticeTone = "ok" | "error" | "info";
export type MachineDeploymentInfo = ReturnType<typeof machineDeployment>;

export interface DeploySectionViewProps {
  machine: Machine;
  hubVersion: string;
  hostedManagers: readonly Manager[];
  workingCount: number;
  deployment: MachineDeploymentInfo;
  progress: DeployProgress;
  pending: boolean;
  error: string;
  asking: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  onConfirmRedeploy: () => void;
  renderHostedManagers?: (props: { managers: readonly Manager[]; nodeVersion?: string }) => ReactNode;
}

export interface DeploySectionDeps {
  /** Optional scope partition (value or getter); switching it resets dialog, progress, pending, and error state, aborts in-flight deploy, and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled hub build version (value or getter; bypasses `useStore((s) => s.version)` when supplied). */
  hubVersion?: string | (() => string);
  /** Subscribe to hub version updates when `hubVersion` is a getter. */
  subscribeHubVersion?: (listener: () => void) => () => void;
  /** Controlled manager roster (value or getter; bypasses `useRoster` when supplied). */
  roster?: ManagerList | null | (() => ManagerList | null);
  /** Subscribe to roster updates when `roster` is a getter. */
  subscribeRoster?: (listener: () => void) => () => void;
  /** Controlled co-located managers list (value or getter; bypasses `useRoster` and `hostedManagersForMachine` when supplied). */
  hostedManagers?: readonly Manager[] | (() => readonly Manager[]);
  /** Subscribe to hosted managers updates when `hostedManagers` is a getter. */
  subscribeHostedManagers?: (listener: () => void) => () => void;
  /** Shared fallback subscription for any getter dep without a dedicated subscriber. */
  subscribe?: (listener: () => void) => () => void;
  /** Controlled deployment capability calculator (defaults to `lib/machine-deploy.machineDeployment`). */
  machineDeployment?: (machine: Machine) => MachineDeploymentInfo;
  /** Controlled deploy action (bypasses `useDeploy`, `api`, `store`, and `toast` when supplied). */
  deploy?: (machine: Machine, signal: AbortSignal) => boolean | void | Promise<boolean | void>;
  /** Optional post-deploy refresh hook invoked after a controlled `deploy` resolves without returning `false`. */
  refresh?: (signal: AbortSignal) => void | Promise<unknown>;
  /** Optional notification callback invoked when a controlled `deploy` fails. */
  notify?: (message: string, tone?: DeployNoticeTone) => void;
  /** Format thrown deploy errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when a controlled `deploy` throws or rejects in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom hosted managers renderer inside the view (defaults to `<HostedManagersList>`). */
  renderHostedManagers?: (props: { managers: readonly Manager[]; nodeVersion?: string }) => ReactNode;
  /** Optional custom view renderer (defaults to `<DeploySectionView>`). */
  renderView?: (props: DeploySectionViewProps) => ReactNode;
}

export interface DeploySectionProps {
  machine: Machine;
  agents: readonly Session[];
  deps?: DeploySectionDeps;
}

interface PendingOp {
  epoch: number;
  seq: number;
  controller: AbortController;
}

interface DeployTrackState {
  epoch: number;
  started: boolean;
  sawBusy: boolean;
  furthest: number;
  asking: boolean;
}

const INITIAL_TRACK: DeployTrackState = { epoch: 0, started: false, sawBusy: false, furthest: 0, asking: false };

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

function safeNotify(notify: ((message: string, tone?: DeployNoticeTone) => void) | undefined, message: string, tone?: DeployNoticeTone) {
  if (!notify) return;
  try {
    notify(message, tone);
  } catch {
    // Notification failures stay non-blocking so recovery never leaves pending stuck.
  }
}

function safeOnError(onError: ((message: string) => void) | undefined, message: string) {
  if (!onError) return;
  try {
    onError(message);
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

/** The stepper's state from what the page saw: `started` (Redeploy was pressed here), `sawBusy` (the hub has said it is
 *  updating since), the furthest step seen, and the machine as pushed now. */
export function deployProgress(m: Machine, started: boolean, sawBusy: boolean, furthest: number, requesting: boolean, refused: string): DeployProgress {
  const busy = !!(m.deploying || m.deploy_phase);
  if (busy) return { step: m.deploy_phase ? STEPS.indexOf(m.deploy_phase) : Math.max(0, furthest), outcome: "running" };
  if (!started) return { step: 0, outcome: "idle" };
  if (requesting) return { step: 0, outcome: "running" };
  if (refused) return { step: Math.max(0, furthest), outcome: "failed" };
  if (sawBusy && m.deploy_error) return { step: Math.max(0, furthest), outcome: "failed" };
  if (!m.node_mismatch && !m.deploy_error && m.online) return { step: STEPS.length - 1, outcome: "done" };
  if (sawBusy && m.node_mismatch) return { step: Math.max(0, furthest), outcome: "failed" };
  return { step: 0, outcome: "running" };
}

/** Pure presentational view for the alert sheet's build mismatch and redeploy section. */
export function DeploySectionView({
  machine,
  hubVersion,
  hostedManagers,
  workingCount,
  deployment,
  progress,
  pending,
  error,
  asking,
  onOpenConfirm,
  onCloseConfirm,
  onConfirmRedeploy,
  renderHostedManagers,
}: DeploySectionViewProps) {
  const hostedNames = hostedManagers.length ? formatList(hostedManagers.map((m) => m.name)) : "";
  const pendingRestartNames = formatList(hostedManagers.filter((m) => m.pending_restart).map((m) => m.name));
  const nodeVersion = machine.node_version;
  const gap = buildGap(hubVersion, nodeVersion);
  const { busy } = deployment;

  return (
    <>
      <SheetPart part="what">
        <div className="grid grid-cols-2 gap-3" data-testid="builds">
          <Build label={t("machines-alerts.build_hub")} version={hubVersion} />
          <Build label={t("machines-alerts.build_node", { machine: machine.name })} version={nodeVersion} />
        </div>
        <p className="mt-2 text-meta text-ink-2" data-testid="build-gap">
          {!hubVersion ? t("machines-alerts.build_hub_unknown")
            : gap === undefined ? t("machines-alerts.build_gap_unknown")
            : gap > 0 ? t("machines-alerts.build_older", { gap: gapText(gap) })
            : gap < 0 ? t("machines-alerts.build_newer", { gap: gapText(gap) })
            : t("machines-alerts.build_same_time")}
        </p>
        {machine.deploy_error && progress.outcome !== "running" && <p className="mt-1 break-words text-meta text-red" data-testid="deploy-error">{t("lib-machine-deploy.last_failed", { error: machine.deploy_error })}</p>}
        {renderHostedManagers ? renderHostedManagers({ managers: hostedManagers, nodeVersion }) : (
          <HostedManagersList
            managers={hostedManagers}
            nodeVersion={nodeVersion}
            compact
            className="mt-3 rounded-control bg-field p-2.5"
            testId="deploy-hosted-managers"
          />
        )}
      </SheetPart>
      <SheetPart part="why">
        {progress.outcome === "done" ? (
          <>
            <p className="text-meta leading-relaxed text-ink-2">{t("machines-alerts.mismatch_resolved")}</p>
            {pendingRestartNames && (
              <p className="mt-1 text-meta leading-relaxed text-orange" data-testid="deploy-done-pending-restart">
                {t("machines-alerts.deploy_done_pending_restart", { names: pendingRestartNames })}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-meta leading-relaxed text-ink-2">{t("machines-alerts.mismatch_why")}</p>
            {hostedNames && (
              <p className="mt-1 text-meta leading-relaxed text-ink-2" data-testid="deploy-hosted-why">
                {t("machines-alerts.mismatch_hosted_managers", { names: hostedNames })}
              </p>
            )}
            <p className="mt-1 text-meta text-ink-2" data-testid="working-count">{workingCount ? t("machines-alerts.mismatch_working", { count: workingCount }) : t("machines-alerts.mismatch_none_working")}</p>
          </>
        )}
      </SheetPart>
      <SheetPart part="do">
        {progress.outcome !== "idle" && <Steps steps={STEPS.map((s) => ({ key: s, label: stepLabel(s) }))} step={progress.step} outcome={progress.outcome} label={t("machines-alerts.stepper_label")} testId="deploy-stepper" />}
        {progress.outcome === "done" && <p className="mt-2 text-meta text-green" role="status" data-testid="deploy-done">{t("machines-alerts.deploy_done", { build: nodeVersion || "—" })}</p>}
        {progress.outcome === "failed" && (
          <p className="mt-2 break-words text-meta text-red" role="alert" data-testid="deploy-failed">
            {t("machines-alerts.deploy_failed_why", { error: error || machine.deploy_error || t("machines-alerts.deploy_still_mismatch") })}
          </p>
        )}
        {!deployment.supported ? (
          <p className="text-meta leading-relaxed text-ink-2" data-testid="deploy-reason">{deployment.reason}</p>
        ) : progress.outcome !== "running" && progress.outcome !== "done" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button tone="primary" icon="retry" disabled={!deployment.canDeploy} title={deployment.reason || undefined} onClick={onOpenConfirm} testId="redeploy">
              {progress.outcome === "failed" ? t("machines-alerts.try_again") : t("lib-machine-deploy.redeploy")}
            </Button>
            {deployment.reason && <span className="text-submeta text-ink-3">{deployment.reason}</span>}
          </div>
        ) : null}
      </SheetPart>
      <Dialog
        open={asking && !busy}
        onClose={onCloseConfirm}
        title={t("machines-alerts.redeploy_confirm_title", { machine: machine.name })}
        footer={
          <>
            <Button tone="quiet" onClick={onCloseConfirm}>
              {t("common.cancel")}
            </Button>
            <Button tone="primary" disabled={!deployment.canDeploy || pending} onClick={onConfirmRedeploy} testId="redeploy-confirm">
              {t("lib-machine-deploy.redeploy")}
            </Button>
          </>
        }
      >
        <p className="text-meta leading-relaxed text-ink-2">{t("machines-alerts.redeploy_confirm_body", { machine: machine.name })}</p>
        {hostedNames && (
          <p className="mt-2 text-meta leading-relaxed text-ink-2" data-testid="redeploy-confirm-managers">
            {t("machines-alerts.redeploy_confirm_managers", { names: hostedNames })}
          </p>
        )}
        <p className="mt-2 text-meta leading-relaxed text-ink-2">{workingCount ? t("machines-alerts.redeploy_confirm_working", { count: workingCount }) : t("machines-alerts.redeploy_confirm_idle")}</p>
      </Dialog>
    </>
  );
}

function DefaultHubVersionBridge({ render }: { render: (hubVersion: string) => ReactNode }) {
  const hubVersion = useStore((s) => s.version);
  return <>{render(hubVersion)}</>;
}

function DefaultRosterBridge({ render }: { render: (roster: ManagerList | null) => ReactNode }) {
  const roster = useRoster();
  return <>{render(roster)}</>;
}

interface DefaultDeployState {
  deployment: MachineDeploymentInfo;
  pending: boolean;
  error: string;
  deploy: () => Promise<boolean>;
}

function DefaultDeployBridge({ machine, render }: { machine: Machine; render: (state: DefaultDeployState) => ReactNode }) {
  const state = useDeploy(machine);
  return <>{render(state)}</>;
}

interface DeploySectionBodyProps {
  machine: Machine;
  agents: readonly Session[];
  hubVersion: string;
  hostedManagers: readonly Manager[];
  defaultDeploy?: DefaultDeployState;
  outerScopeToken: string;
  readOuterScopeToken: () => string;
  deps?: DeploySectionDeps;
}

function DeploySectionBody({
  machine,
  agents,
  hubVersion,
  hostedManagers,
  defaultDeploy,
  outerScopeToken,
  readOuterScopeToken,
  deps,
}: DeploySectionBodyProps) {
  const sectionScope = JSON.stringify([outerScopeToken, machine.id]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: sectionScope, epoch: 1 }));
  const effectiveEpoch = scope.key === sectionScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== sectionScope) {
    setScope({ key: sectionScope, epoch: effectiveEpoch });
  }

  const [trackState, setTrackState] = useState<DeployTrackState>(INITIAL_TRACK);
  const [controlledPendingState, setControlledPendingState] = useState<{ epoch: number; pending: boolean }>({ epoch: 0, pending: false });
  const [controlledErrorState, setControlledErrorState] = useState<{ epoch: number; error: string }>({ epoch: 0, error: "" });

  const deployment = useMemo(
    () => (deps?.machineDeployment ? deps.machineDeployment(machine) : defaultDeploy ? defaultDeploy.deployment : machineDeployment(machine)),
    [deps, defaultDeploy, machine],
  );
  const { busy } = deployment;
  const phaseIndex = machine.deploy_phase ? STEPS.indexOf(machine.deploy_phase) : -1;

  const isControlledDeploy = deps?.deploy !== undefined;
  const pending = isControlledDeploy
    ? (controlledPendingState.epoch === effectiveEpoch && controlledPendingState.pending)
    : (defaultDeploy?.pending ?? false);
  const error = isControlledDeploy
    ? (controlledErrorState.epoch === effectiveEpoch ? controlledErrorState.error : "")
    : (defaultDeploy?.error ?? "");

  const curTrack = trackState.epoch === effectiveEpoch ? trackState : INITIAL_TRACK;
  const started = curTrack.started || busy;
  const sawBusy = curTrack.sawBusy || busy;
  const furthest = Math.max(curTrack.furthest, phaseIndex);
  const asking = curTrack.asking && !busy;

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingOpRef = useRef<PendingOp | null>(null);
  const depsRef = useRef(deps);
  const machineRef = useRef(machine);
  const deploymentRef = useRef(deployment);
  const defaultDeployRef = useRef(defaultDeploy);
  const readScopeTokenRef = useRef(readOuterScopeToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    machineRef.current = machine;
    deploymentRef.current = deployment;
    defaultDeployRef.current = defaultDeploy;
    readScopeTokenRef.current = readOuterScopeToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pendingOpRef.current?.controller.abort();
      pendingOpRef.current = null;
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  // Commit observed deploy busy/phase progress only after render commits, keeping concurrent renders pure.
  useLayoutEffect(() => {
    if (!busy && phaseIndex < 0) return;
    setTrackState((prev) => {
      const base = prev.epoch === effectiveEpoch ? prev : { epoch: effectiveEpoch, started: false, sawBusy: false, furthest: 0, asking: false };
      const nextStarted = base.started || busy;
      const nextSawBusy = base.sawBusy || busy;
      const nextFurthest = Math.max(base.furthest, phaseIndex);
      const nextAsking = busy ? false : base.asking;
      if (
        prev.epoch === effectiveEpoch
        && base.started === nextStarted
        && base.sawBusy === nextSawBusy
        && base.furthest === nextFurthest
        && base.asking === nextAsking
      ) {
        return prev;
      }
      return {
        epoch: effectiveEpoch,
        started: nextStarted,
        sawBusy: nextSawBusy,
        furthest: nextFurthest,
        asking: nextAsking,
      };
    });
  }, [effectiveEpoch, busy, phaseIndex]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = outerScopeToken;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  const handleOpenConfirm = () => {
    if (!isScopeLive() || !deploymentRef.current.canDeploy || deploymentRef.current.busy || pendingOpRef.current !== null) return;
    setTrackState((prev) => {
      const base = prev.epoch === capturedEpoch ? prev : { epoch: capturedEpoch, started: false, sawBusy: false, furthest: 0, asking: false };
      return { ...base, epoch: capturedEpoch, asking: true };
    });
  };

  const handleCloseConfirm = () => {
    if (!isScopeLive()) return;
    setTrackState((prev) => {
      if (prev.epoch !== capturedEpoch || !prev.asking) return prev;
      return { ...prev, asking: false };
    });
  };

  const handleConfirmRedeploy = () => {
    if (!isScopeLive() || !deploymentRef.current.canDeploy || pendingOpRef.current !== null) return;
    setTrackState({ epoch: capturedEpoch, started: true, sawBusy: false, furthest: 0, asking: false });

    const controlledDeploy = depsRef.current?.deploy;
    if (!controlledDeploy) {
      void defaultDeployRef.current?.deploy();
      return;
    }

    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    pendingOpRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setControlledPendingState({ epoch: capturedEpoch, pending: true });
    setControlledErrorState({ epoch: capturedEpoch, error: "" });

    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && pendingOpRef.current?.seq === runSeq;

    void (async () => {
      try {
        const res = await controlledDeploy(machineRef.current, controller.signal);
        if (!isRunCurrent()) return;
        if (res !== false && depsRef.current?.refresh) {
          try {
            const refreshRes = depsRef.current.refresh(controller.signal);
            if (isThenable(refreshRes)) await refreshRes;
          } catch {
            // Post-deploy refresh failures stay non-blocking, matching default useDeploy behavior.
          }
        }
      } catch (err) {
        if (isRunCurrent() && !isAbort(err)) {
          const msg = safeFormatError(depsRef.current?.formatError, err);
          setControlledErrorState({ epoch: capturedEpoch, error: msg });
          safeNotify(depsRef.current?.notify, t("machines-machinedeploy.failed", { error: msg }), "error");
          safeOnError(depsRef.current?.onError, msg);
        }
      } finally {
        if (pendingOpRef.current?.seq === runSeq) pendingOpRef.current = null;
        if (activeEpochRef.current === capturedEpoch && opSeqRef.current === runSeq) {
          setControlledPendingState({ epoch: capturedEpoch, pending: false });
        }
      }
    })();
  };

  const progress = deployProgress(machine, started, sawBusy, furthest, pending, error);
  const workingCount = agents.filter((s) => stateOf(s) === "working").length;

  const viewProps: DeploySectionViewProps = {
    machine,
    hubVersion,
    hostedManagers,
    workingCount,
    deployment,
    progress,
    pending,
    error,
    asking,
    onOpenConfirm: handleOpenConfirm,
    onCloseConfirm: handleCloseConfirm,
    onConfirmRedeploy: handleConfirmRedeploy,
    renderHostedManagers: deps?.renderHostedManagers,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <DeploySectionView {...viewProps} />;
}

export function DeploySection({ machine, agents, deps }: DeploySectionProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey ?? deps?.subscribe);

  // Keep controlled inputs and scope tracking in the identity-stable outer component so direct <-> getter+subscribe switches never remount.
  const controlledHubVersion = useCachedExternalValue(deps?.hubVersion, deps?.subscribeHubVersion ?? deps?.subscribe);
  const controlledRoster = useCachedExternalValue(deps?.roster, deps?.subscribeRoster ?? deps?.subscribe);
  const controlledHostedManagers = useCachedExternalValue(deps?.hostedManagers, deps?.subscribeHostedManagers ?? deps?.subscribe);

  const needDefaultHubVersion = deps?.hubVersion === undefined;
  const needDefaultRoster = deps?.roster === undefined && deps?.hostedManagers === undefined;
  const needDefaultDeploy = deps?.deploy === undefined;

  const renderBody = (hubVersion: string, roster: ManagerList | null, defaultDeploy?: DefaultDeployState) => {
    const hostedManagers = deps?.hostedManagers !== undefined
      ? (controlledHostedManagers ?? [])
      : hostedManagersForMachine(roster, machine);
    return (
      <DeploySectionBody
        machine={machine}
        agents={agents}
        hubVersion={hubVersion}
        hostedManagers={hostedManagers}
        defaultDeploy={defaultDeploy}
        outerScopeToken={trackedScope.token}
        readOuterScopeToken={trackedScope.readToken}
        deps={deps}
      />
    );
  };

  const renderWithDeploy = (hubVersion: string, roster: ManagerList | null) => (
    needDefaultDeploy
      ? <DefaultDeployBridge key={`${trackedScope.token}:${machine.id}`} machine={machine} render={(state) => renderBody(hubVersion, roster, state)} />
      : renderBody(hubVersion, roster)
  );

  const renderWithRoster = (hubVersion: string) => (
    needDefaultRoster
      ? <DefaultRosterBridge render={(roster) => renderWithDeploy(hubVersion, roster)} />
      : renderWithDeploy(hubVersion, controlledRoster ?? null)
  );

  if (needDefaultHubVersion) {
    return <DefaultHubVersionBridge render={renderWithRoster} />;
  }
  return renderWithRoster(controlledHubVersion ?? "");
}

function Build({ label, version }: { label: string; version?: string }) {
  const at = buildTime(version);
  return (
    <div className="min-w-0 rounded-control bg-field px-3 py-2">
      <div className="truncate text-submeta text-ink-3">{label}</div>
      <div className="truncate font-mono text-meta text-ink" title={version || undefined}>{version || "—"}</div>
      {at !== undefined && <div className="text-submeta text-ink-3 tabular-nums">{formatDate(at, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>}
    </div>
  );
}
