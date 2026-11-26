import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, enc, errorText } from "../../lib/api";
import { machineDeployment } from "../../lib/machine-deploy";
import type { Manager } from "../../lib/managers";
import { getState, refresh } from "../../lib/store";
import type { Machine } from "../../lib/types";
import { Button, cx, toast } from "../../ui/atoms";
import { formatList, t } from "../../i18n";

export type MachineDeployNoticeTone = "ok" | "error" | "info";
export type MachineDeployment = ReturnType<typeof machineDeployment>;

export interface MachineDeployViewProps {
  deployment: MachineDeployment;
  pending: boolean;
  coLocatedNames?: string;
  className?: string;
  onDetails?: () => void;
  onDeploy: () => void;
}

export interface MachineDeployDeps {
  /** Optional scope partition (value or getter); switching it aborts in-flight deploy/refresh, resets state, and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled in-flight admission set (bypasses module-global `deployRequests` when supplied). */
  inFlightSet?: Set<string>;
  /** Controlled admission check (bypasses `inFlightSet` and module-global `deployRequests` when supplied). */
  isInFlight?: (machineId: string) => boolean;
  /** Controlled admission acquire hook (return `false` to refuse admission). */
  beginInFlight?: (machineId: string) => boolean | void;
  /** Controlled admission release hook (always invoked in `finally` / cleanup when admitted). */
  endInFlight?: (machineId: string) => void;
  /** Look up the latest machine record before admitting a deploy (bypasses `store.getState()` when supplied). */
  getMachine?: (machineId: string) => Machine | undefined;
  /** Request deployment for `machineId` (defaults to `POST /machines/{id}/deploy`). */
  requestDeploy?: (machineId: string, signal: AbortSignal) => Promise<unknown> | unknown;
  /** Refresh machines after an accepted deploy (defaults to `store.refresh()`). */
  refreshMachines?: (signal: AbortSignal) => Promise<unknown> | unknown;
  /** Show toast notifications (defaults to `atoms.toast`). */
  notify?: (message: string, tone?: MachineDeployNoticeTone) => void;
  /** Format thrown deploy errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when a deploy request fails in the active scope. */
  onError?: (message: string, error: unknown) => void;
  /** Optional custom view renderer for `MachineDeploy` (defaults to `<MachineDeployView>`). */
  renderView?: (props: MachineDeployViewProps) => ReactNode;
}

export interface MachineDeployProps {
  machine: Machine;
  className?: string;
  onDetails?: () => void;
  hostedManagers?: readonly Manager[];
  deps?: MachineDeployDeps;
}

// The card, detail and alert sheet share admission while a request is out, before the hub's phase is published.
const deployRequests = new Set<string>();

const noopSubscribe = () => () => {};

function safeFormatError(fmt: ((error: unknown) => string) | undefined, error: unknown): string {
  if (!fmt) return errorText(error);
  try {
    return fmt(error);
  } catch {
    return errorText(error);
  }
}

function safeNotify(notify: ((message: string, tone?: MachineDeployNoticeTone) => void) | undefined, message: string, tone?: MachineDeployNoticeTone) {
  try {
    if (notify) notify(message, tone);
    else toast(message, tone);
  } catch {
    // Notification failures stay non-blocking so recovery never leaves pending stuck.
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

interface PendingDeploy {
  epoch: number;
  seq: number;
  controller: AbortController;
  releaseAdmission: () => void;
}

/** The update action both the deployment strip and the node self-check use: the same request, the same capability checks. */
export function useDeploy(machine: Machine, deps?: MachineDeployDeps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const targetScope = JSON.stringify([trackedScope.token, machine.id]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: targetScope, epoch: 1 }));
  const effectiveEpoch = scope.key === targetScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== targetScope) {
    setScope({ key: targetScope, epoch: effectiveEpoch });
  }

  const [pendingState, setPendingState] = useState<{ epoch: number; seq: number; pending: boolean }>({ epoch: 0, seq: 0, pending: false });
  // why the last request was refused (the alert sheet's stepper says it in place); "" when it went or none was made
  const [errorState, setErrorState] = useState<{ epoch: number; message: string }>({ epoch: 0, message: "" });
  const pending = pendingState.epoch === effectiveEpoch && pendingState.pending;
  const error = errorState.epoch === effectiveEpoch ? errorState.message : "";
  const deployment = machineDeployment(machine);

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingRef = useRef<PendingDeploy | null>(null);
  const localInFlightRef = useRef<Set<string>>(new Set());
  const depsRef = useRef(deps);
  const machineRef = useRef(machine);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    machineRef.current = machine;
    readScopeTokenRef.current = trackedScope.readToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      const inFlight = pendingRef.current;
      if (inFlight) {
        pendingRef.current = null;
        inFlight.controller.abort();
        inFlight.releaseAdmission();
      }
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;
  const capturedMachineId = machine.id;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken
    && machineRef.current.id === capturedMachineId;

  const deploy = async () => {
    if (!isScopeLive() || pendingRef.current !== null) return false;
    const curDeps = depsRef.current;
    const targetMachine = machineRef.current;
    const targetId = targetMachine.id;

    const current = curDeps?.getMachine
      ? (curDeps.getMachine(targetId) ?? targetMachine)
      : (getState().machines.find((m) => m.id === targetId) ?? targetMachine);
    if (!machineDeployment(current).canDeploy) return false;

    const hasCustomHooks = curDeps?.isInFlight !== undefined || curDeps?.beginInFlight !== undefined || curDeps?.endInFlight !== undefined;
    const hasScopedIsolation = curDeps?.scopeKey !== undefined;
    const backingSet = curDeps?.inFlightSet ?? (hasCustomHooks || hasScopedIsolation ? localInFlightRef.current : deployRequests);

    let releaseFn: () => void;
    if (hasCustomHooks) {
      if (curDeps?.isInFlight?.(targetId)) return false;
      if (!curDeps?.beginInFlight && backingSet.has(targetId)) return false;
      if (curDeps?.beginInFlight) {
        if (curDeps.beginInFlight(targetId) === false) return false;
      } else {
        backingSet.add(targetId);
      }
      const endHook = curDeps?.endInFlight;
      const usedBackingSet = !curDeps?.beginInFlight;
      releaseFn = () => {
        if (usedBackingSet) backingSet.delete(targetId);
        endHook?.(targetId);
      };
    } else {
      if (backingSet.has(targetId)) return false;
      backingSet.add(targetId);
      releaseFn = () => {
        backingSet.delete(targetId);
      };
    }

    let released = false;
    const releaseAdmission = () => {
      if (released) return;
      released = true;
      try {
        releaseFn();
      } catch {
        // Admission release failures stay non-blocking so pending state never sticks.
      }
    };

    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    pendingRef.current = { epoch: capturedEpoch, seq: runSeq, controller, releaseAdmission };

    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && pendingRef.current?.seq === runSeq;

    setPendingState({ epoch: capturedEpoch, seq: runSeq, pending: true });
    setErrorState({ epoch: capturedEpoch, message: "" });
    try {
      if (curDeps?.requestDeploy) {
        await curDeps.requestDeploy(targetId, controller.signal);
      } else {
        await api(`/machines/${enc(targetId)}/deploy`, { method: "POST", signal: controller.signal });
      }
      if (!isRunCurrent()) return false;
      try {
        if (curDeps?.refreshMachines) {
          await curDeps.refreshMachines(controller.signal);
        } else {
          await refresh();
        }
      } catch {
        // Post-deploy refresh failures stay non-blocking, matching default refresh().catch(() => {}).
      }
      return isRunCurrent();
    } catch (e) {
      if (!isRunCurrent()) return false;
      const msg = safeFormatError(depsRef.current?.formatError, e);
      setErrorState({ epoch: capturedEpoch, message: msg });
      safeNotify(depsRef.current?.notify, t("machines-machinedeploy.failed", { error: msg }), "error");
      try {
        depsRef.current?.onError?.(msg, e);
      } catch {
        // Error observer failures stay non-blocking so recovery never leaves pending stuck.
      }
      return false;
    } finally {
      releaseAdmission();
      if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
      if (activeEpochRef.current === capturedEpoch) {
        setPendingState((prev) => (prev.epoch === capturedEpoch && prev.seq === runSeq ? { epoch: capturedEpoch, seq: runSeq, pending: false } : prev));
      }
    }
  };
  return { deployment, pending, deploy, error };
}

/** Pure presentational view for the deployment status and action strip. */
export function MachineDeployView({
  deployment,
  pending,
  coLocatedNames = "",
  className,
  onDetails,
  onDeploy,
}: MachineDeployViewProps) {
  if (!deployment.visible) return null;

  return (
    <div className={cx("mx-4 flex items-center gap-2 rounded-[8px] bg-orange-tint py-1.5 pl-2.5 pr-1.5 text-[12px] text-orange", deployment.busy && "flex-wrap", className)}>
      <div className={cx("min-w-0 flex-1 break-words", deployment.busy && "basis-48")} role="status">
        {deployment.message && <p>{deployment.message}</p>}
        {coLocatedNames && (
          <p className="mt-0.5 text-submeta text-ink-2" data-testid="deploy-co-located-note">
            {t("machines-machinedeploy.co_located_note", { names: coLocatedNames })}
          </p>
        )}
        {deployment.error && <p>{deployment.error}</p>}
        {deployment.reason && !deployment.busy && <p>{deployment.reason}</p>}
      </div>
      {(onDetails || deployment.supported || deployment.busy) && (
        <div className="ml-auto flex items-center gap-2">
          {onDetails && (
            <Button tone="quiet" size="sm" onClick={onDetails} testId="deploy-details">
              {t("machines-machinedeploy.details")}
            </Button>
          )}
          {(deployment.supported || deployment.busy) && (
            <Button tone="secondary" icon="retry" busy={deployment.busy || pending} disabled={!deployment.canDeploy || pending} title={deployment.reason || undefined} onClick={onDeploy}>
              {pending && !deployment.busy ? t("machines-machinedeploy.requesting") : deployment.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The list and detail keep the same capability checks, stages and confirmation wording. */
/** `onDetails`: the Machines card's "Details", which opens the computer's alert sheet on the deployment. */
export function MachineDeploy({ machine, className, onDetails, hostedManagers, deps }: MachineDeployProps) {
  const { deployment, pending, deploy } = useDeploy(machine, deps);
  const coLocatedNames = hostedManagers?.length && (deployment.supported || deployment.busy)
    ? formatList(hostedManagers.map((m) => m.name))
    : "";

  const viewProps: MachineDeployViewProps = {
    deployment,
    pending,
    coLocatedNames,
    className,
    onDetails,
    onDeploy: () => void deploy(),
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <MachineDeployView {...viewProps} />;
}
