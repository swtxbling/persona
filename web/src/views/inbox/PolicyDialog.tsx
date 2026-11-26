// Inbox policies (docs/assistant/inbox.md "Policies", #5764): "Rule for this chat / sender / repository…" from an item's menu opens
// PolicyDialog (the tier its items get, what the AI twin does with them); "Rules" in the Inbox's ⋯ menu lists them
// (RulesDialog) with Edit and Remove. The hub decides in code; this only sets and lists.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { saveInboxPolicy, type InboxItem, type InboxMuteOption, type InboxPolicy, type PolicyTier, type PolicyTwin } from "../../lib/inbox";
import { listInboxPolicies, muteLine, muteShortName, policySummary, policyTierName, policyTwinName, removeInboxPolicy } from "../../lib/inbox-page";
import { errorText } from "../../lib/api";
import { otherManager } from "../../lib/manager-choice";
import { type Manager } from "../../lib/managers";
import { sameValue } from "../../lib/stable-lines";
import { t } from "../../i18n";
import { Button, Dialog, Loading, toast } from "../../ui/atoms";
import { Icon } from "../../ui/icons";
import { Segmented } from "../assistant/parts";
import { useScope } from "../../lib/current-assistant";

/** What the dialog is about: a new rule from an item's option, or an existing one. Each manager keeps its own rules:
 *  the rule is the item's (or the rule's) manager's. */
export type PolicyTarget = { item?: InboxItem; option: InboxMuteOption; source: string; policy?: InboxPolicy };

export type PolicyNoticeTone = "ok" | "error" | "info";

export type PolicySaveRequest = {
  item?: InboxItem;
  option: InboxMuteOption;
  source: string;
  id?: string;
  manager?: string;
  stamped?: boolean;
};

export interface PolicyDialogViewProps {
  open?: boolean;
  target: PolicyTarget;
  policy?: InboxPolicy;
  loaded: boolean;
  tier: PolicyTier;
  twin: PolicyTwin;
  busy: boolean;
  error?: string;
  onTierChange: (tier: PolicyTier) => void;
  onTwinChange: (twin: PolicyTwin) => void;
  onSave: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export interface PolicyDialogDeps {
  /** Optional scope partition (value or getter); switching it resets state and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled policy target (value or getter; bypasses module-level target store when supplied). */
  target?: PolicyTarget | null | (() => PolicyTarget | null);
  /** Subscribe to target changes when `target` is a getter. */
  subscribeTarget?: (listener: () => void) => () => void;
  /** Controlled target closer (overrides `onClose` / module-level `closePolicyDialog` when supplied). */
  closeTarget?: () => void;
  /** Load existing policies when `target.policy` is omitted (defaults to `lib/inbox-page.listInboxPolicies`). */
  listPolicies?: (manager: string | undefined, signal: AbortSignal) => InboxPolicy[] | Promise<InboxPolicy[]>;
  /** Save or update a policy (defaults to `lib/inbox.saveInboxPolicy`). */
  savePolicy?: (
    request: PolicySaveRequest,
    tier: PolicyTier,
    twin: PolicyTwin,
    signal: AbortSignal,
  ) => InboxPolicy | null | void | Promise<InboxPolicy | null | void>;
  /** Remove a policy (defaults to `savePolicy` / `lib/inbox.saveInboxPolicy` with empty tier and twin). */
  removePolicy?: (
    request: PolicySaveRequest,
    signal: AbortSignal,
  ) => InboxPolicy | null | boolean | void | Promise<InboxPolicy | null | boolean | void>;
  /** Show notifications for controlled save/remove mutations (defaults to no extra toast over `saveInboxPolicy`). */
  notify?: (message: string, tone?: PolicyNoticeTone) => void;
  /** Format thrown/rejected mutation errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when saving or removing fails in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<PolicyDialogView>`). */
  renderView?: (props: PolicyDialogViewProps) => ReactNode;
}

export interface PolicyDialogProps {
  target?: PolicyTarget | null;
  onClose?: () => void;
  deps?: PolicyDialogDeps;
}

export interface PolicyDialogHostProps {
  deps?: PolicyDialogDeps;
}

/** One manager's rules in the "Rules" dialog (several managers: each keeps its own, read with its name). */
export type RuleGroup = { manager: Manager; rules: InboxPolicy[] | null; error: string };

export interface RulesDialogViewProps {
  open?: boolean;
  managersMode: boolean;
  list: readonly InboxPolicy[] | null;
  groups: readonly RuleGroup[] | null;
  failed: string;
  busyKey: string | null;
  onRetry: () => void;
  onEdit: (policy: InboxPolicy) => void;
  onRemove: (policy: InboxPolicy) => void;
  onClose: () => void;
}

export interface RulesDialogDeps {
  /** Optional scope partition (value or getter); switching it resets state and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled current assistant manager (value or getter; `null` = single-assistant mode; bypasses `useScope` when supplied). */
  manager?: Manager | null | (() => Manager | null);
  /** Subscribe to manager changes when `manager` is a getter. */
  subscribeManager?: (listener: () => void) => () => void;
  /** Controlled active policy editor state (value or getter; bypasses module-level `usePolicyTarget` when supplied). */
  editing?: PolicyTarget | null | boolean | (() => PolicyTarget | null | boolean);
  /** Subscribe to editing changes when `editing` is a getter. */
  subscribeEditing?: (listener: () => void) => () => void;
  /** Load policies for the default assistant (`manager === undefined`) or a named manager (defaults to `lib/inbox-page.listInboxPolicies`). */
  listPolicies?: (manager: string | undefined, signal: AbortSignal) => InboxPolicy[] | Promise<InboxPolicy[]>;
  /** Remove a policy (defaults to `lib/inbox-page.removeInboxPolicy`). */
  removePolicy?: (policy: InboxPolicy, signal: AbortSignal) => void | Promise<unknown>;
  /** Open the single-rule editor dialog (defaults to module-level `openPolicyDialog`). */
  openPolicyDialog?: (target: PolicyTarget) => void;
  /** Show toast notifications (defaults to `atoms.toast`). */
  notify?: (message: string, tone?: PolicyNoticeTone) => void;
  /** Format thrown/rejected errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when loading or removing fails in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<RulesDialogView>`). */
  renderView?: (props: RulesDialogViewProps) => ReactNode;
}

export interface RulesDialogProps {
  onClose: () => void;
  deps?: RulesDialogDeps;
}

/** Whose rules a target's are: its rule's, else its item's manager (none: the default's). */
const ownerOf = (target: PolicyTarget) => target.policy?.manager ?? target.item?.manager;

let current: PolicyTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Open the rule dialog (from a row's menu or an item's page); the Inbox page's PolicyDialogHost draws it. */
export function openPolicyDialog(target: PolicyTarget) {
  current = target;
  emit();
}

function closePolicyDialog() {
  current = null;
  emit();
}

function usePolicyTarget(): PolicyTarget | null {
  return useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => current);
}

const noopSubscribe = () => () => {};

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

function safeNotify(notify: ((message: string, tone?: PolicyNoticeTone) => void) | undefined, message: string, tone?: PolicyNoticeTone, fallbackToToast = true) {
  try {
    if (notify) notify(message, tone);
    else if (fallbackToToast) toast(message, tone);
  } catch {
    // Notification failures stay non-blocking so recovery never leaves busy stuck.
  }
}

function safeReportError(onError: ((message: string) => void) | undefined, message: string) {
  if (!onError) return;
  try {
    onError(message);
  } catch {
    // Error observer failures stay non-blocking.
  }
}

function safeCall(fn: (() => void) | undefined) {
  if (!fn) return;
  try {
    fn();
  } catch {
    // Callback failures stay non-blocking so finally always releases locks and busy state.
  }
}

function hasControlledTarget(deps?: PolicyDialogDeps): boolean {
  return Boolean(deps && (deps.target !== undefined || deps.subscribeTarget !== undefined || Object.prototype.hasOwnProperty.call(deps, "target")));
}

function hasControlledManager(deps?: RulesDialogDeps): boolean {
  return Boolean(deps && (deps.manager !== undefined || deps.subscribeManager !== undefined || Object.prototype.hasOwnProperty.call(deps, "manager")));
}

function hasControlledEditing(deps?: RulesDialogDeps): boolean {
  return Boolean(deps && (deps.editing !== undefined || deps.subscribeEditing !== undefined || Object.prototype.hasOwnProperty.call(deps, "editing")));
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

function useTrackedValue<T>(
  source: T | (() => T),
  subscribe: ((listener: () => void) => () => void) | undefined,
) {
  const isGetter = typeof source === "function";
  const read = useCallback(() => (typeof source === "function" ? (source as () => T)() : source), [source]);
  const readRef = useRef(read);
  const committedRef = useRef<{ value: T; version: number } | null>(null);
  const snapRef = useRef<{ value: T; version: number } | null>(null);
  const sub = useCallback((listener: () => void) => {
    if (!subscribe || !isGetter) return noopSubscribe();
    return subscribe(() => {
      const next = readRef.current();
      const cur = committedRef.current;
      if (!cur || !sameValue(next, cur.value)) {
        committedRef.current = { value: next, version: (cur?.version ?? 0) + 1 };
      }
      listener();
    });
  }, [subscribe, isGetter]);
  const getSnapshot = useCallback(() => {
    const next = read();
    const cur = committedRef.current;
    if (cur && sameValue(next, cur.value)) return cur;
    const nextVersion = cur ? cur.version + 1 : 0;
    if (snapRef.current && snapRef.current.version === nextVersion && sameValue(snapRef.current.value, next)) {
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
  const isCurrent = useCallback((expectedVersion: number, expectedValue: T) => {
    const cur = readRef.current();
    const committed = committedRef.current;
    return Boolean(committed && committed.version === expectedVersion && sameValue(committed.value, cur) && sameValue(expectedValue, cur));
  }, []);
  return { value: snap.value, version: snap.version, isCurrent };
}

/** Mounted once on the Inbox page: the rule dialog when one is open. */
export function PolicyDialogHost({ deps }: PolicyDialogHostProps = {}) {
  if (hasControlledTarget(deps)) {
    return <PolicyDialog deps={deps} />;
  }
  return <DefaultPolicyDialogHost deps={deps} />;
}

function DefaultPolicyDialogHost({ deps }: PolicyDialogHostProps) {
  const target = usePolicyTarget();
  return target
    ? <PolicyDialog key={`${ownerOf(target) ?? ""}:${target.source}:${target.option.tag}:${target.option.value}`} target={target} onClose={deps?.closeTarget ?? closePolicyDialog} deps={deps} />
    : null;
}

const TIERS: PolicyTier[] = ["", "action", "fyi", "noise"];
const TWINS: PolicyTwin[] = ["", "first", "never"];

/** Pure presentational dialog view for editing or creating a single inbox policy rule. */
export function PolicyDialogView({
  open = true,
  target,
  policy,
  loaded,
  tier,
  twin,
  busy,
  error,
  onTierChange,
  onTwinChange,
  onSave,
  onRemove,
  onClose,
}: PolicyDialogViewProps) {
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={t("inbox-policydialog.title", { name: muteShortName(target.option) })}
      width={440}
      footer={
        <>
          {policy && <Button tone="quiet" disabled={busy} onClick={onRemove}>{t("inbox-policydialog.remove")}</Button>}
          <span className="flex-1" />
          <Button tone="secondary" disabled={busy} onClick={onClose}>{t("inbox-policydialog.cancel")}</Button>
          <Button tone="primary" busy={busy} disabled={!loaded || busy || (!policy && !tier && !twin)} onClick={onSave}>{t("inbox-policydialog.save")}</Button>
        </>
      }
    >
      {!loaded ? (
        <div className="py-2"><Loading /></div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-[12.5px] leading-relaxed text-ink-3">{t("inbox-policydialog.intro", { what: muteLine({ ...target.option, id: "", source: target.source, source_name: target.item?.account_name || policy?.source_name }) })}</p>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">{t("inbox-policydialog.tier")}</span>
            <Segmented label={t("inbox-policydialog.tier")} value={tier} onChange={onTierChange} options={TIERS.map((v) => ({ v, label: policyTierName(v) }))} compact />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">{t("inbox-policydialog.twin")}</span>
            <Segmented label={t("inbox-policydialog.twin")} value={twin} onChange={onTwinChange} options={TWINS.map((v) => ({ v, label: policyTwinName(v) }))} compact />
            <p className="text-[11.5px] leading-relaxed text-ink-3">{t("inbox-policydialog.twin_note")}</p>
          </div>
          {error ? <p role="alert" className="text-submeta text-red">{error}</p> : null}
        </div>
      )}
    </Dialog>
  );
}

interface PendingOp {
  epoch: number;
  seq: number;
  controller: AbortController;
}

function targetIdentity(target: PolicyTarget | null): string {
  if (!target) return "";
  return JSON.stringify([
    ownerOf(target) ?? "",
    target.source,
    target.option.tag,
    target.option.value,
    target.policy?.id ?? "",
  ]);
}

/** The rule of one chat / sender / repository: its tier and what the AI twin does; prefilled from the rule it has. */
export function PolicyDialog({ target, onClose, deps }: PolicyDialogProps) {
  const controlledTarget = hasControlledTarget(deps);
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const targetSource: PolicyTarget | null | (() => PolicyTarget | null) = controlledTarget
    ? (deps?.target ?? null)
    : (target ?? null);
  const trackedTarget = useTrackedValue<PolicyTarget | null>(
    targetSource,
    controlledTarget ? deps?.subscribeTarget : undefined,
  );
  const activeTarget = trackedTarget.value;

  const dialogScope = JSON.stringify([trackedScope.token, trackedTarget.version, targetIdentity(activeTarget)]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: dialogScope, epoch: 1 }));
  const effectiveEpoch = scope.key === dialogScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== dialogScope) {
    setScope({ key: dialogScope, epoch: effectiveEpoch });
  }

  const [formState, setFormState] = useState<{
    epoch: number;
    policy: InboxPolicy | undefined;
    loaded: boolean;
    tier: PolicyTier;
    twin: PolicyTwin;
  }>(() => ({
    epoch: 1,
    policy: activeTarget?.policy,
    loaded: Boolean(activeTarget?.policy),
    tier: activeTarget?.policy?.tier ?? "",
    twin: activeTarget?.policy?.twin ?? "",
  }));
  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });
  const [errorState, setErrorState] = useState<{ epoch: number; message: string }>({ epoch: 0, message: "" });

  const policy = formState.epoch === effectiveEpoch ? formState.policy : activeTarget?.policy;
  const loaded = formState.epoch === effectiveEpoch ? formState.loaded : Boolean(activeTarget?.policy);
  const tier = formState.epoch === effectiveEpoch ? formState.tier : (activeTarget?.policy?.tier ?? "");
  const twin = formState.epoch === effectiveEpoch ? formState.twin : (activeTarget?.policy?.twin ?? "");
  const busy = busyState.epoch === effectiveEpoch && busyState.busy;
  const error = errorState.epoch === effectiveEpoch ? errorState.message : "";

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingLoadRef = useRef<PendingOp | null>(null);
  const pendingMutateRef = useRef<PendingOp | null>(null);
  const depsRef = useRef(deps);
  const onCloseRef = useRef(onClose);
  const readScopeTokenRef = useRef(trackedScope.readToken);
  const isTargetCurrentRef = useRef(trackedTarget.isCurrent);

  useLayoutEffect(() => {
    depsRef.current = deps;
    onCloseRef.current = onClose;
    readScopeTokenRef.current = trackedScope.readToken;
    isTargetCurrentRef.current = trackedTarget.isCurrent;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pendingLoadRef.current?.controller.abort();
      pendingLoadRef.current = null;
      pendingMutateRef.current?.controller.abort();
      pendingMutateRef.current = null;
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;
  const capturedTargetVersion = trackedTarget.version;
  const capturedTarget = activeTarget;

  const isScopeLive = useCallback(
    () =>
      activeEpochRef.current === capturedEpoch
      && readScopeTokenRef.current() === capturedScopeToken
      && isTargetCurrentRef.current(capturedTargetVersion, capturedTarget),
    [capturedEpoch, capturedScopeToken, capturedTargetVersion, capturedTarget],
  );

  useEffect(() => {
    if (!capturedTarget || capturedTarget.policy) return;
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    pendingLoadRef.current?.controller.abort();
    pendingLoadRef.current = { epoch: capturedEpoch, seq: runSeq, controller };

    const isLoadCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && pendingLoadRef.current?.seq === runSeq;

    const applyList = (list: InboxPolicy[]) => {
      if (!isLoadCurrent()) return;
      const same = list.find((p) => p.source === capturedTarget.source && p.tag === capturedTarget.option.tag && p.value === capturedTarget.option.value);
      setFormState({
        epoch: capturedEpoch,
        policy: same,
        loaded: true,
        tier: same?.tier ?? "",
        twin: same?.twin ?? "",
      });
    };

    const applyFallback = () => {
      if (!isLoadCurrent()) return;
      setFormState({
        epoch: capturedEpoch,
        policy: undefined,
        loaded: true,
        tier: "",
        twin: "",
      });
    };

    let res: InboxPolicy[] | Promise<InboxPolicy[]>;
    try {
      // the item's manager's rules: a rule of the same chat under another manager is not this one
      res = depsRef.current?.listPolicies
        ? depsRef.current.listPolicies(ownerOf(capturedTarget), controller.signal)
        : listInboxPolicies(otherManager(ownerOf(capturedTarget)));
    } catch {
      applyFallback();
      if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
      return;
    }

    if (!isThenable(res)) {
      applyList(res);
      if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
      return;
    }

    void (async () => {
      try {
        const list = await res;
        applyList(list);
      } catch {
        applyFallback(); // no list (an older hub): start from nothing
      } finally {
        if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
      }
    })();

    return () => {
      controller.abort();
      if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
    };
  }, [capturedEpoch, capturedTarget, isScopeLive]);

  if (!activeTarget) return null;

  const closeActive = () => safeCall(depsRef.current?.closeTarget ?? onCloseRef.current);

  const handleDismiss = () => {
    if (!isScopeLive() || pendingMutateRef.current !== null || busy) return;
    closeActive();
  };

  const handleTierChange = (nextTier: PolicyTier) => {
    if (!isScopeLive() || pendingMutateRef.current !== null) return;
    setFormState({ epoch: capturedEpoch, policy, loaded, tier: nextTier, twin });
    setErrorState({ epoch: capturedEpoch, message: "" });
  };

  const handleTwinChange = (nextTwin: PolicyTwin) => {
    if (!isScopeLive() || pendingMutateRef.current !== null) return;
    setFormState({ epoch: capturedEpoch, policy, loaded, tier, twin: nextTwin });
    setErrorState({ epoch: capturedEpoch, message: "" });
  };

  const mutate = (nextTier: PolicyTier, nextTwin: PolicyTwin) => {
    if (!isScopeLive() || pendingMutateRef.current !== null) return;
    const isRemoval = !nextTier && !nextTwin;
    // removing a rule opened from the Rules list names the manager the list read it from, even when that is the default now
    const stamped = !activeTarget.item && isRemoval;
    const request: PolicySaveRequest = {
      item: activeTarget.item,
      option: activeTarget.option,
      source: activeTarget.source,
      id: policy?.id,
      manager: ownerOf(activeTarget),
      stamped,
    };
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && (pendingMutateRef.current === null || pendingMutateRef.current.seq === runSeq);

    const controlledMutation = Boolean(isRemoval ? (depsRef.current?.removePolicy || depsRef.current?.savePolicy) : depsRef.current?.savePolicy);

    const finishSuccess = (result: InboxPolicy | null | boolean | void) => {
      if (!isRunCurrent()) return;
      if (result === null || result === false) return;
      if (controlledMutation && depsRef.current?.notify) {
        safeNotify(
          depsRef.current.notify,
          isRemoval
            ? t("lib-inbox.policy_removed", { name: activeTarget.option.name })
            : t("lib-inbox.policy_saved", { name: activeTarget.option.name }),
          "ok",
          false,
        );
      }
      closeActive();
    };

    const finishError = (err: unknown) => {
      if (!isRunCurrent()) return;
      const msg = safeFormatError(depsRef.current?.formatError, err);
      setErrorState({ epoch: capturedEpoch, message: msg });
      safeNotify(depsRef.current?.notify, t("lib-inbox.policy_failed", { error: msg }), "error", !controlledMutation);
      safeReportError(depsRef.current?.onError, msg);
    };

    setErrorState({ epoch: capturedEpoch, message: "" });
    let res: InboxPolicy | null | boolean | void | Promise<InboxPolicy | null | boolean | void>;
    try {
      if (isRemoval && depsRef.current?.removePolicy) {
        res = depsRef.current.removePolicy(request, controller.signal);
      } else if (depsRef.current?.savePolicy) {
        res = depsRef.current.savePolicy(request, nextTier, nextTwin, controller.signal);
      } else {
        res = saveInboxPolicy(request, nextTier, nextTwin);
      }
    } catch (err) {
      finishError(err);
      return;
    }

    if (!isThenable(res)) {
      finishSuccess(res);
      return;
    }

    pendingMutateRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setBusyState({ epoch: capturedEpoch, busy: true });
    void (async () => {
      try {
        const result = await res;
        finishSuccess(result);
      } catch (err) {
        finishError(err);
      } finally {
        if (pendingMutateRef.current?.seq === runSeq) pendingMutateRef.current = null;
        if (activeEpochRef.current === capturedEpoch) {
          setBusyState({ epoch: capturedEpoch, busy: false });
        }
      }
    })();
  };

  const viewProps: PolicyDialogViewProps = {
    open: true,
    target: activeTarget,
    policy,
    loaded,
    tier,
    twin,
    busy,
    error,
    onTierChange: handleTierChange,
    onTwinChange: handleTwinChange,
    onSave: () => mutate(tier, twin),
    onRemove: () => mutate("", ""),
    onClose: handleDismiss,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <PolicyDialogView {...viewProps} />;
}

/** Pure presentational dialog view for listing and managing inbox policy rules. */
export function RulesDialogView({
  open = true,
  managersMode,
  list,
  groups,
  failed,
  busyKey,
  onRetry,
  onEdit,
  onRemove,
  onClose,
}: RulesDialogViewProps) {
  const row = (p: InboxPolicy) => {
    const key = `${p.manager ?? ""}:${p.id}`;
    return (
      <li key={key} data-policy={p.id} className="flex items-center gap-3 rounded-control px-1 py-2 hover:bg-hover">
        <Icon name="target" size={14} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink" title={p.name}>{p.name}</span>
          <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">{[muteLine(p), policySummary(p)].filter(Boolean).join(" · ")}</span>
        </span>
        <Button tone="quiet" disabled={busyKey !== null} onClick={() => onEdit(p)}>{t("inbox-policydialog.edit")}</Button>
        <Button tone="quiet" busy={busyKey === key} disabled={busyKey !== null && busyKey !== key} onClick={() => onRemove(p)}>{t("inbox-policydialog.remove")}</Button>
      </li>
    );
  };
  const shownGroups = groups?.filter((g) => g.error || g.rules?.length) ?? null;
  const empty = managersMode ? shownGroups?.length === 0 : list?.length === 0;
  return (
    <Dialog open={open} onClose={onClose} title={t("inbox-policydialog.rules")} width={440} footer={<Button tone="primary" onClick={onClose}>{t("inbox-policydialog.close")}</Button>}>
      {failed ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-[12.5px] break-words text-red">{t("inbox-policydialog.load_failed", { error: failed })}</p>
          <Button tone="secondary" icon="retry" onClick={onRetry}>{t("inbox-policydialog.retry")}</Button>
        </div>
      ) : (managersMode ? !groups : !list) ? (
        <div className="py-2"><Loading /></div>
      ) : empty ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-field text-ink-3">
            <Icon name="target" size={17} />
          </span>
          <p className="text-[13.5px] font-medium text-ink">{t("inbox-policydialog.empty_title")}</p>
          <p className="max-w-[300px] text-[12.5px] leading-relaxed text-ink-3">{t("inbox-policydialog.empty_hint")}</p>
        </div>
      ) : shownGroups ? (
        shownGroups.map((g) => (
          <section key={g.manager.id} data-rules-manager={g.manager.id} className="mb-2">
            {g.error ? (
              <p className="px-1 py-1.5 text-[12px] break-words text-ink-3">{g.manager.online ? t("inbox-policydialog.load_failed", { error: g.error }) : t("inbox-policydialog.rules_offline")}</p>
            ) : (
              <ul className="-mx-1 flex flex-col">{g.rules!.map(row)}</ul>
            )}
          </section>
        ))
      ) : (
        <ul className="-mx-1 flex flex-col">{list!.map(row)}</ul>
      )}
    </Dialog>
  );
}

/** "Rules" (the Inbox's ⋯ menu): every source's rules, newest first, each with Edit and Remove. With several assistants,
 *  the current one's. */
export function RulesDialog(props: RulesDialogProps) {
  if (hasControlledEditing(props.deps)) {
    if (hasControlledManager(props.deps)) {
      return <RulesDialogBody {...props} fallbackManager={null} fallbackEditing={null} />;
    }
    return <RulesDialogScopeBridge {...props} fallbackEditing={null} />;
  }
  return <RulesDialogEditingBridge {...props} />;
}

function RulesDialogEditingBridge(props: RulesDialogProps) {
  const editing = usePolicyTarget();
  if (hasControlledManager(props.deps)) {
    return <RulesDialogBody {...props} fallbackManager={null} fallbackEditing={editing} />;
  }
  return <RulesDialogScopeBridge {...props} fallbackEditing={editing} />;
}

function RulesDialogScopeBridge(props: RulesDialogProps & { fallbackEditing: PolicyTarget | null }) {
  // several assistants: the current one's rules, asked of it by name
  const mine = useScope().manager;
  return <RulesDialogBody {...props} fallbackManager={mine} />;
}

function RulesDialogBody({
  onClose,
  deps,
  fallbackManager,
  fallbackEditing,
}: RulesDialogProps & { fallbackManager: Manager | null; fallbackEditing: PolicyTarget | null }) {
  const controlledManager = hasControlledManager(deps);
  const controlledEditing = hasControlledEditing(deps);
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);

  const managerSource: Manager | null | (() => Manager | null) = controlledManager
    ? (deps?.manager ?? null)
    : fallbackManager;
  const trackedManager = useTrackedValue<Manager | null>(
    managerSource,
    controlledManager ? deps?.subscribeManager : undefined,
  );

  const editingSource: PolicyTarget | null | boolean | (() => PolicyTarget | null | boolean) = controlledEditing
    ? (deps?.editing ?? null)
    : fallbackEditing;
  const trackedEditing = useTrackedValue<PolicyTarget | null | boolean>(
    editingSource,
    controlledEditing ? deps?.subscribeEditing : undefined,
  );

  const mine = trackedManager.value;
  const editing = trackedEditing.value;
  const isEditing = Boolean(editing);

  const rulesScope = JSON.stringify([trackedScope.token, trackedManager.version, mine?.id ?? "", mine?.online ?? null, trackedEditing.version, isEditing]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: rulesScope, epoch: 1 }));
  const effectiveEpoch = scope.key === rulesScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== rulesScope) {
    setScope({ key: rulesScope, epoch: effectiveEpoch });
  }

  const [listState, setListState] = useState<{ epoch: number; list: InboxPolicy[] | null }>({ epoch: 0, list: null });
  const [groupsState, setGroupsState] = useState<{ epoch: number; groups: RuleGroup[] | null }>({ epoch: 0, groups: null });
  const [failedState, setFailedState] = useState<{ epoch: number; message: string }>({ epoch: 0, message: "" });
  const [busyState, setBusyState] = useState<{ epoch: number; key: string | null }>({ epoch: 0, key: null });

  const list = listState.epoch === effectiveEpoch ? listState.list : null;
  const groups = groupsState.epoch === effectiveEpoch ? groupsState.groups : null;
  const failed = failedState.epoch === effectiveEpoch ? failedState.message : "";
  const busy = busyState.epoch === effectiveEpoch ? busyState.key : null;

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingLoadRef = useRef<PendingOp | null>(null);
  const pendingRemoveRef = useRef<PendingOp | null>(null);
  const depsRef = useRef(deps);
  const onCloseRef = useRef(onClose);
  const readScopeTokenRef = useRef(trackedScope.readToken);
  const isManagerCurrentRef = useRef(trackedManager.isCurrent);
  const isEditingCurrentRef = useRef(trackedEditing.isCurrent);

  useLayoutEffect(() => {
    depsRef.current = deps;
    onCloseRef.current = onClose;
    readScopeTokenRef.current = trackedScope.readToken;
    isManagerCurrentRef.current = trackedManager.isCurrent;
    isEditingCurrentRef.current = trackedEditing.isCurrent;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pendingLoadRef.current?.controller.abort();
      pendingLoadRef.current = null;
      pendingRemoveRef.current?.controller.abort();
      pendingRemoveRef.current = null;
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;
  const capturedManagerVersion = trackedManager.version;
  const capturedManager = mine;
  const capturedEditingVersion = trackedEditing.version;
  const capturedEditing = editing;

  const isScopeLive = useCallback(
    () =>
      activeEpochRef.current === capturedEpoch
      && readScopeTokenRef.current() === capturedScopeToken
      && isManagerCurrentRef.current(capturedManagerVersion, capturedManager)
      && isEditingCurrentRef.current(capturedEditingVersion, capturedEditing),
    [capturedEpoch, capturedScopeToken, capturedManagerVersion, capturedManager, capturedEditingVersion, capturedEditing],
  );

  const runLoad = useCallback(() => {
    if (!isScopeLive() || Boolean(capturedEditing)) return;
    pendingLoadRef.current?.controller.abort();
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    pendingLoadRef.current = { epoch: capturedEpoch, seq: runSeq, controller };

    const isLoadCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && pendingLoadRef.current?.seq === runSeq;

    setFailedState({ epoch: capturedEpoch, message: "" });

    if (capturedManager) {
      setGroupsState({ epoch: capturedEpoch, groups: null });
      const applyGroupSuccess = (rules: InboxPolicy[]) => {
        if (!isLoadCurrent()) return;
        setGroupsState({ epoch: capturedEpoch, groups: [{ manager: capturedManager, rules, error: "" }] });
      };
      const applyGroupError = (err: unknown) => {
        if (!isLoadCurrent()) return;
        const msg = safeFormatError(depsRef.current?.formatError, err);
        setGroupsState({ epoch: capturedEpoch, groups: [{ manager: capturedManager, rules: null, error: msg }] });
        safeReportError(depsRef.current?.onError, msg);
      };

      let res: InboxPolicy[] | Promise<InboxPolicy[]>;
      try {
        res = depsRef.current?.listPolicies
          ? depsRef.current.listPolicies(capturedManager.id, controller.signal)
          : listInboxPolicies(capturedManager.id);
      } catch (err) {
        applyGroupError(err);
        if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
        return;
      }

      if (!isThenable(res)) {
        applyGroupSuccess(res);
        if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
        return;
      }

      void (async () => {
        try {
          const rules = await res;
          applyGroupSuccess(rules);
        } catch (err) {
          applyGroupError(err);
        } finally {
          if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
        }
      })();
      return;
    }

    setListState({ epoch: capturedEpoch, list: null });
    const applyListSuccess = (items: InboxPolicy[]) => {
      if (!isLoadCurrent()) return;
      setListState({ epoch: capturedEpoch, list: items });
    };
    const applyListError = (err: unknown) => {
      if (!isLoadCurrent()) return;
      const msg = safeFormatError(depsRef.current?.formatError, err);
      setFailedState({ epoch: capturedEpoch, message: msg });
      safeReportError(depsRef.current?.onError, msg);
    };

    let res: InboxPolicy[] | Promise<InboxPolicy[]>;
    try {
      res = depsRef.current?.listPolicies
        ? depsRef.current.listPolicies(undefined, controller.signal)
        : listInboxPolicies();
    } catch (err) {
      applyListError(err);
      if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
      return;
    }

    if (!isThenable(res)) {
      applyListSuccess(res);
      if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
      return;
    }

    void (async () => {
      try {
        const items = await res;
        applyListSuccess(items);
      } catch (err) {
        applyListError(err);
      } finally {
        if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
      }
    })();
  }, [capturedEpoch, capturedManager, capturedEditing, isScopeLive]);

  useEffect(() => {
    if (isEditing) return;
    runLoad(); // again after an edit closes
    return () => {
      pendingLoadRef.current?.controller.abort();
      pendingLoadRef.current = null;
    };
  }, [effectiveEpoch, isEditing, runLoad]);

  if (isEditing) return null; // the rule's own dialog is open over the list's place

  const remove = (p: InboxPolicy) => {
    if (!isScopeLive() || pendingRemoveRef.current !== null) return;
    const key = `${p.manager ?? ""}:${p.id}`;
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;

    const isRemoveCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && (pendingRemoveRef.current === null || pendingRemoveRef.current.seq === runSeq);

    const customRemove = depsRef.current?.removePolicy;
    const isDefaultRemove = !customRemove;
    const notifyOnRemove = depsRef.current?.notify;
    const formatErrorOnRemove = depsRef.current?.formatError;

    const finishSuccess = () => {
      if (!isRemoveCurrent()) {
        // Default removeInboxPolicy ignores AbortSignal, so the removal still lands on the hub even if
        // RulesDialog closes mid-request; preserve the base confirmation toast without touching state.
        if (isDefaultRemove) safeNotify(notifyOnRemove, t("inbox-policydialog.removed", { name: p.name }), "ok");
        return;
      }
      setListState((prev) => (prev.epoch === capturedEpoch ? { epoch: capturedEpoch, list: (prev.list ?? []).filter((x) => x.id !== p.id) } : prev));
      setGroupsState((prev) => (prev.epoch === capturedEpoch
        ? {
            epoch: capturedEpoch,
            groups: prev.groups?.map((g) => (g.manager.id === (p.manager ?? capturedManager?.id) ? { ...g, rules: g.rules?.filter((x) => x.id !== p.id) ?? null } : g)) ?? prev.groups,
          }
        : prev));
      safeNotify(depsRef.current?.notify, t("inbox-policydialog.removed", { name: p.name }), "ok");
    };

    const finishError = (err: unknown) => {
      if (!isRemoveCurrent()) {
        if (isDefaultRemove) {
          const msg = safeFormatError(formatErrorOnRemove, err);
          safeNotify(notifyOnRemove, t("inbox-policydialog.remove_failed", { error: msg }), "error");
        }
        return;
      }
      const msg = safeFormatError(depsRef.current?.formatError, err);
      safeNotify(depsRef.current?.notify, t("inbox-policydialog.remove_failed", { error: msg }), "error");
      safeReportError(depsRef.current?.onError, msg);
    };

    let res: void | Promise<unknown>;
    try {
      res = customRemove
        ? customRemove(p, controller.signal)
        : removeInboxPolicy(p);
    } catch (err) {
      finishError(err);
      return;
    }

    if (!isThenable(res)) {
      finishSuccess();
      return;
    }

    pendingRemoveRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setBusyState({ epoch: capturedEpoch, key });
    void (async () => {
      try {
        await res;
        finishSuccess();
      } catch (err) {
        finishError(err);
      } finally {
        if (pendingRemoveRef.current?.seq === runSeq) pendingRemoveRef.current = null;
        if (activeEpochRef.current === capturedEpoch) {
          setBusyState({ epoch: capturedEpoch, key: null });
        }
      }
    })();
  };

  const handleEdit = (p: InboxPolicy) => {
    if (!isScopeLive() || pendingRemoveRef.current !== null) return;
    const nextTarget: PolicyTarget = { option: p, source: p.source, policy: p };
    if (depsRef.current?.openPolicyDialog) depsRef.current.openPolicyDialog(nextTarget);
    else openPolicyDialog(nextTarget);
  };

  const handleClose = () => {
    if (!isScopeLive()) return;
    safeCall(onCloseRef.current);
  };

  const viewProps: RulesDialogViewProps = {
    open: true,
    managersMode: Boolean(mine),
    list,
    groups,
    failed,
    busyKey: busy,
    onRetry: runLoad,
    onEdit: handleEdit,
    onRemove: remove,
    onClose: handleClose,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <RulesDialogView {...viewProps} />;
}
