// The alert sheet's section for launchers that fail on a computer (#8037, docs/server/launcher-health.md): each failing
// or blocked one (what kind of failure, its error line, when it was checked, how many starts failed, a usage limit's
// reset), the ones that work there as alternatives, and Test again (the hub's own check of that launcher on that
// computer; the new record shows in place). The hub has no per-computer default launcher to switch, so the way to use
// another one is Settings › Models, which this links to.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatDate, t } from "../../i18n";
import { api, enc, errorText, isAbort } from "../../lib/api";
import { blockReason } from "../../lib/launcher-health";
import { launcherBlockedReason, launcherErrorText, launcherFailing, type LauncherHealthRecord } from "../../lib/machine-alerts";
import { providerTitle } from "../../lib/provider-names";
import { relativeTime } from "../../lib/relative-time";
import { navigate } from "../../lib/router";
import { sameValue } from "../../lib/stable-lines";
import type { Launcher, Machine } from "../../lib/types";
import { Button, cx } from "../../ui/atoms";
import { Icon } from "../../ui/icons";
import { settingsHref } from "../settings/nav";
import { DiagnosisLoading, SheetPart } from "./AlertParts";

const noopSubscribe = () => () => {};
const EMPTY_CHECKED: Readonly<Record<string, string>> = {};

interface PendingOp {
  epoch: number;
  seq: number;
  controller: AbortController;
}

export interface LauncherSectionViewProps {
  online: boolean;
  failing: readonly LauncherHealthRecord[];
  list: readonly Launcher[] | null | undefined;
  healthy?: readonly Launcher[];
  checking: string;
  checked: Readonly<Record<string, string>>;
  now?: number;
  onTestAgain: (launcher: string) => void;
  onOpenSettings: () => void;
}

export interface LauncherSectionDeps {
  /** Optional scope partition (value or getter); switching it resets list/checking/checked state, aborts in-flight calls, and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled launcher list loader (bypasses default `/machines/:id/launchers` API when supplied). */
  loadLaunchers?: (machineId: string, signal: AbortSignal) => Promise<readonly Launcher[] | { launchers?: Launcher[] }> | readonly Launcher[] | { launchers?: Launcher[] };
  /** Controlled launcher health check action (bypasses default `/launchers/health/check` POST when supplied). */
  checkLauncher?: (machineId: string, launcher: string, signal: AbortSignal) => Promise<readonly LauncherHealthRecord[] | { records?: LauncherHealthRecord[] }> | readonly LauncherHealthRecord[] | { records?: LauncherHealthRecord[] };
  /** Controlled navigation callback (bypasses `lib/router.navigate` when supplied). */
  navigate?: (to: string, signal?: AbortSignal) => void | Promise<unknown>;
  /** Controlled settings destination (string or builder; bypasses `settingsHref` when supplied). */
  settingsHref?: string | (() => string);
  /** Controlled clock timestamp in ms (value or getter; passed to `relativeTime`). */
  now?: number | (() => number);
  /** Subscribe to clock updates when `now` is a getter. */
  subscribeNow?: (listener: () => void) => () => void;
  /** Format thrown action errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when loading, checking, or navigating throws or rejects in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<LauncherSectionView>`). */
  renderView?: (props: LauncherSectionViewProps) => ReactNode;
}

export interface LauncherSectionProps {
  machine: Machine;
  records: readonly LauncherHealthRecord[];
  onRecords: (records: LauncherHealthRecord[]) => void;
  onReload?: () => void;
  deps?: LauncherSectionDeps;
}

function isReadonlyArray<T>(value: unknown): value is readonly T[] {
  return Array.isArray(value);
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

/** What kind of failure a record is, in a line (lib/launcher-health.ts's words where they fit). */
export function failureKind(kind: string | undefined): string {
  if (kind === "usage_limit") return t("machines-alerts.launcher_usage_limit");
  if (kind === "onboarding") return t("machines-alerts.launcher_onboarding");
  return blockReason(kind ?? "");
}

/** Pure presentational view for the alert sheet's launcher health section. */
export function LauncherSectionView({
  online,
  failing,
  list,
  healthy: healthyProp,
  checking,
  checked,
  now,
  onTestAgain,
  onOpenSettings,
}: LauncherSectionViewProps) {
  const broken = new Set(failing.map((r) => r.launcher));
  const healthy = healthyProp ?? (list ?? []).filter((l) => !broken.has(l.name) && (!l.health || !launcherFailing(l.health)));
  const title = (name: string) => providerTitle(list?.find((l) => l.name === name) ?? { name });

  return (
    <>
      <SheetPart part="what">
        {!failing.length && <p className="text-meta text-ink-2">{t("machines-alerts.launcher_all_ok")}</p>}
        <ul className="space-y-2" data-testid="failing-launchers">
          {failing.map((r) => (
            <li key={r.launcher} className="rounded-control bg-field px-3 py-2" data-launcher={r.launcher} data-state={r.state}>
              <div className="flex items-center gap-2">
                <Icon name="terminal" size={13} className={r.state === "blocked" ? "text-red" : "text-orange"} />
                <span className="min-w-0 flex-1 truncate text-meta font-medium text-ink">{title(r.launcher)}</span>
                <span className="shrink-0 text-submeta text-ink-2">{r.state === "blocked" ? t("machines-alerts.launcher_blocked") : t("machines-alerts.launcher_failing")}</span>
              </div>
              <p className="mt-0.5 text-meta text-ink-2">{failureKind(r.kind)}</p>
              {launcherErrorText(r) && <p className="mt-0.5 line-clamp-3 break-words font-mono text-submeta text-ink-3" title={launcherErrorText(r)}>{launcherErrorText(r)}</p>}
              <p className="mt-1 text-submeta text-ink-3 tabular-nums">
                {[
                  r.checked_at && t("machines-alerts.launcher_checked", { time: relativeTime(r.checked_at, now) }),
                  (r.fails ?? 0) > 0 && t("machines-alerts.launcher_fails", { count: r.fails ?? 0 }),
                  r.resets_at && t("machines-alerts.launcher_resets", { time: formatDate(Date.parse(r.resets_at), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) }),
                ].filter(Boolean).join(" · ")}
              </p>
              {launcherBlockedReason(r) && <p className="mt-0.5 text-submeta text-ink-3">{launcherBlockedReason(r)}</p>}
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Button size="sm" icon="retry" busy={checking === r.launcher} disabled={!!checking || !online} onClick={() => onTestAgain(r.launcher)} testId="test-again">
                  {t("machines-alerts.test_again")}
                </Button>
                {checked[r.launcher] && <span className="text-submeta text-ink-2" role="status">{checked[r.launcher]}</span>}
              </div>
            </li>
          ))}
        </ul>
      </SheetPart>
      <SheetPart part="why">
        <p className="text-meta leading-relaxed text-ink-2">{t("machines-alerts.launcher_why")}</p>
      </SheetPart>
      <SheetPart part="do">
        <h4 className="mb-1 text-meta font-medium text-ink">{t("machines-alerts.launcher_alternatives")}</h4>
        {list === undefined && <DiagnosisLoading label={t("machines-alerts.launcher_loading")} />}
        {list === null && <p className="text-meta text-ink-3">{t("machines-alerts.launcher_list_failed")}</p>}
        {list && (healthy.length ? (
          <ul className="flex flex-wrap gap-1.5" data-testid="healthy-launchers">
            {healthy.map((l) => (
              <li key={l.name} className={cx("inline-flex h-6 items-center gap-1 rounded-full bg-field px-2 text-label text-ink")}>
                <Icon name="check" size={11} className="text-green" />
                {providerTitle(l)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-meta text-ink-3">{t("machines-alerts.launcher_no_alternative")}</p>
        ))}
        <p className="mt-2 text-submeta text-ink-3">{t("machines-alerts.launcher_switch_note")}</p>
        <div className="mt-1.5">
          <Button size="sm" tone="quiet" icon="sliders" onClick={onOpenSettings}>
            {t("machines-alerts.launcher_settings")}
          </Button>
        </div>
      </SheetPart>
    </>
  );
}

export function LauncherSection({ machine, records, onRecords, onReload, deps }: LauncherSectionProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const controlledNow = useCachedExternalValue(deps?.now, deps?.subscribeNow);

  const sectionScope = JSON.stringify([trackedScope.token, machine.id]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: sectionScope, epoch: 1 }));
  const effectiveEpoch = scope.key === sectionScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== sectionScope) {
    setScope({ key: sectionScope, epoch: effectiveEpoch });
  }

  const [listState, setListState] = useState<{ epoch: number; value: readonly Launcher[] | null | undefined }>({ epoch: 0, value: undefined });
  const [checkingState, setCheckingState] = useState<{ epoch: number; launcher: string }>({ epoch: 0, launcher: "" });
  const [checkedState, setCheckedState] = useState<{ epoch: number; map: Record<string, string> }>({ epoch: 0, map: {} });

  const list = listState.epoch === effectiveEpoch ? listState.value : undefined;
  const checking = checkingState.epoch === effectiveEpoch ? checkingState.launcher : "";
  const checked = checkedState.epoch === effectiveEpoch ? checkedState.map : EMPTY_CHECKED;

  const activeEpochRef = useRef(0);
  const loadSeqRef = useRef(0);
  const checkSeqRef = useRef(0);
  const navSeqRef = useRef(0);
  const pendingLoadRef = useRef<PendingOp | null>(null);
  const pendingCheckRef = useRef<PendingOp | null>(null);
  const pendingNavRef = useRef<PendingOp | null>(null);
  const depsRef = useRef(deps);
  const onRecordsRef = useRef(onRecords);
  const onReloadRef = useRef(onReload);
  const onlineRef = useRef(machine.online);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    onRecordsRef.current = onRecords;
    onReloadRef.current = onReload;
    onlineRef.current = machine.online;
    readScopeTokenRef.current = trackedScope.readToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pendingLoadRef.current?.controller.abort();
      pendingLoadRef.current = null;
      pendingCheckRef.current?.controller.abort();
      pendingCheckRef.current = null;
      pendingNavRef.current?.controller.abort();
      pendingNavRef.current = null;
      loadSeqRef.current += 1;
      checkSeqRef.current += 1;
      navSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;
  const capturedMachineId = machine.id;
  const hasControlledLoader = deps?.loadLaunchers !== undefined;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  useEffect(() => {
    if (activeEpochRef.current !== capturedEpoch || readScopeTokenRef.current() !== capturedScopeToken) return;
    const controller = new AbortController();
    const runSeq = ++loadSeqRef.current;
    pendingLoadRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setListState({ epoch: capturedEpoch, value: undefined });
    const isLoadCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && loadSeqRef.current === runSeq
      && readScopeTokenRef.current() === capturedScopeToken;

    void (async () => {
      try {
        const loader = depsRef.current?.loadLaunchers;
        const res = await (loader
          ? loader(capturedMachineId, controller.signal)
          : api<{ launchers?: Launcher[] }>(`/machines/${enc(capturedMachineId)}/launchers`, { signal: controller.signal }));
        if (!isLoadCurrent()) return;
        const nextList: readonly Launcher[] = isReadonlyArray<Launcher>(res) ? res : (res?.launchers ?? []);
        setListState({ epoch: capturedEpoch, value: nextList });
      } catch (err) {
        if (isLoadCurrent() && !isAbort(err)) {
          setListState({ epoch: capturedEpoch, value: null });
          safeOnError(depsRef.current?.onError, safeFormatError(depsRef.current?.formatError, err));
        }
      } finally {
        if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
      }
    })();

    return () => {
      controller.abort();
      if (pendingLoadRef.current?.seq === runSeq) pendingLoadRef.current = null;
      loadSeqRef.current += 1;
    };
  }, [capturedEpoch, capturedScopeToken, capturedMachineId, hasControlledLoader]);

  const testAgain = (launcher: string) => {
    if (!isScopeLive() || !onlineRef.current || pendingCheckRef.current !== null) return;
    const controller = new AbortController();
    const runSeq = ++checkSeqRef.current;
    pendingCheckRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setCheckingState({ epoch: capturedEpoch, launcher });

    const isCheckCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && pendingCheckRef.current?.seq === runSeq;

    void (async () => {
      try {
        const checker = depsRef.current?.checkLauncher;
        const res = await (checker
          ? checker(capturedMachineId, launcher, controller.signal)
          : api<{ records?: LauncherHealthRecord[] }>(
              `/launchers/health/check?machine=${enc(capturedMachineId)}&launcher=${enc(launcher)}`,
              { method: "POST", timeout: 180_000, signal: controller.signal },
            ));
        if (!isCheckCurrent()) return;
        const allRecords: readonly LauncherHealthRecord[] = isReadonlyArray<LauncherHealthRecord>(res) ? res : (res?.records ?? []);
        const got = allRecords.filter((x) => x.launcher === launcher);
        onRecordsRef.current(got);
        // No record for it (#14534): the one shown may be gone or newer on the hub, so the sheet shows what it holds now.
        if (!got.length && isCheckCurrent()) onReloadRef.current?.();
        if (!isCheckCurrent()) return;
        const nowRecord = got[0];
        const statusText = !nowRecord
          ? t("machines-alerts.launcher_no_result")
          : launcherFailing(nowRecord)
            ? t("machines-alerts.launcher_still_failing")
            : t("machines-alerts.launcher_works");
        setCheckedState((prev) => ({
          epoch: capturedEpoch,
          map: { ...(prev.epoch === capturedEpoch ? prev.map : {}), [launcher]: statusText },
        }));
      } catch (err) {
        if (isCheckCurrent() && !isAbort(err)) {
          const msg = safeFormatError(depsRef.current?.formatError, err);
          setCheckedState((prev) => ({
            epoch: capturedEpoch,
            map: {
              ...(prev.epoch === capturedEpoch ? prev.map : {}),
              [launcher]: t("machines-alerts.launcher_check_failed", { error: msg }),
            },
          }));
          safeOnError(depsRef.current?.onError, msg);
        }
      } finally {
        if (pendingCheckRef.current?.seq === runSeq) pendingCheckRef.current = null;
        if (activeEpochRef.current === capturedEpoch && checkSeqRef.current === runSeq) {
          setCheckingState((prev) => (prev.epoch === capturedEpoch && prev.launcher === launcher ? { epoch: capturedEpoch, launcher: "" } : prev));
        }
      }
    })();
  };

  const handleOpenSettings = () => {
    if (!isScopeLive() || pendingNavRef.current !== null) return;
    const controller = new AbortController();
    const runSeq = ++navSeqRef.current;
    const isNavCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && navSeqRef.current === runSeq;

    let res: unknown;
    try {
      const target = depsRef.current?.settingsHref !== undefined
        ? (typeof depsRef.current.settingsHref === "function" ? depsRef.current.settingsHref() : depsRef.current.settingsHref)
        : settingsHref("models", null, false, null, "providers");
      const customNav = depsRef.current?.navigate;
      res = customNav ? customNav(target, controller.signal) : navigate(target);
    } catch (err) {
      if (isNavCurrent() && !isAbort(err)) {
        safeOnError(depsRef.current?.onError, safeFormatError(depsRef.current?.formatError, err));
      }
      return;
    }

    if (!isThenable(res)) return;
    pendingNavRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    void (async () => {
      try {
        await res;
      } catch (err) {
        if (isNavCurrent() && !isAbort(err)) {
          safeOnError(depsRef.current?.onError, safeFormatError(depsRef.current?.formatError, err));
        }
      } finally {
        if (pendingNavRef.current?.seq === runSeq) pendingNavRef.current = null;
      }
    })();
  };

  const mine = records.filter((r) => r.machine === machine.id);
  const failing = mine.filter(launcherFailing);
  const broken = new Set(failing.map((r) => r.launcher));
  const healthy = (list ?? []).filter((l) => !broken.has(l.name) && (!l.health || !launcherFailing(l.health)));

  const viewProps: LauncherSectionViewProps = {
    online: machine.online,
    failing,
    list,
    healthy,
    checking,
    checked,
    now: controlledNow,
    onTestAgain: testAgain,
    onOpenSettings: handleOpenSettings,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <LauncherSectionView {...viewProps} />;
}
