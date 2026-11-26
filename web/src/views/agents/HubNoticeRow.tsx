// The one quiet line about the hub at the top of the Agents list (#2897, docs/operations/hub-update.md "In the app", the app's
// HubNoticeRow): an update under way, one that went back, auto-update turned on (once), a newer version or Docker image.
// Clicking the line opens Settings › hub; its buttons each do their own thing. Follows the hub's `hub_update` pushes and
// reads again on a fresh hello (a hub that just restarted into a new version).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { errorText } from "../../lib/api";
import {
  dismissedHubNotices, dismissHubNotice, hubNotice, hubNoticeKey, hubNoticeText, hubUpdate, setHubUpdateSettings, startHubUpdate,
  type HubNotice, type HubUpdateStatus,
} from "../../lib/hub-update";
import { isResumed } from "../../lib/reconnect";
import { navigate } from "../../lib/router";
import { sameValue } from "../../lib/stable-lines";
import { onHubEvent } from "../../lib/store";
import { Spinner, toast } from "../../ui/atoms";
import { Icon } from "../../ui/icons";
import { t } from "../../i18n";

export type HubNoticeSettings = Parameters<typeof setHubUpdateSettings>[0];

export interface HubNoticeViewProps {
  notice: HubNotice;
  busy?: boolean;
  onOpen: () => void;
  onAutoOff: () => void;
  onSeen: () => void;
  onUpdate: () => void;
  onDismiss: (key: string) => void;
}

export interface HubNoticeLineDeps {
  /** Optional scope partition (value or getter); switching it resets status/busy state and aborts/fences stale requests and pushes. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled status reader (bypasses `hubUpdate` when supplied). */
  readStatus?: (signal: AbortSignal) => Promise<HubUpdateStatus | null> | HubUpdateStatus | null;
  /** Controlled hub event subscription (bypasses `onHubEvent` when supplied). */
  subscribeHubEvent?: (type: string, listener: (msg: Record<string, unknown>) => void) => () => void;
  /** Controlled dismissed notice keys or getter (bypasses `localStorage` reads when supplied). */
  dismissed?: readonly string[] | (() => readonly string[]);
  /** Subscribe to dismissed keys updates when `dismissed` is a getter. */
  subscribeDismissed?: (listener: () => void) => () => void;
  /** Controlled dismiss handler (sync or async; bypasses `dismissHubNotice` when supplied). */
  dismissNotice?: (key: string, signal: AbortSignal) => readonly string[] | void | Promise<readonly string[] | void>;
  /** Controlled update trigger (sync or async; bypasses `startHubUpdate` when supplied). */
  startUpdate?: (now: boolean, signal: AbortSignal) => Promise<HubUpdateStatus> | HubUpdateStatus;
  /** Controlled update settings writer (sync or async; bypasses `setHubUpdateSettings` when supplied). */
  setUpdateSettings?: (settings: HubNoticeSettings, signal: AbortSignal) => Promise<HubUpdateStatus> | HubUpdateStatus;
  /** Controlled router navigation (bypasses `router.navigate` when supplied). */
  navigate?: (to: string) => void;
  /** Controlled toast notifier (bypasses `atoms.toast` when supplied). */
  notify?: (message: string, tone?: "ok" | "error" | "info") => void;
  /** Custom error formatter (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when an action or read fails in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<HubNoticeView>`). */
  renderView?: (props: HubNoticeViewProps) => ReactNode;
}

export interface HubNoticeLineProps {
  deps?: HubNoticeLineDeps;
}

const noopSub = () => () => {};
const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as PromiseLike<unknown>).then === "function";

function fmtErr(fmt: ((e: unknown) => string) | undefined, e: unknown): string {
  if (!fmt) return errorText(e);
  try { return fmt(e); } catch { return errorText(e); }
}

function useTrackedScope(source: string | (() => string) | undefined, subscribe: ((l: () => void) => () => void) | undefined) {
  const isGetter = typeof source === "function";
  const read = useCallback(() => (typeof source === "function" ? source() : (source ?? "")), [source]);
  const readRef = useRef(read);
  const committedRef = useRef<{ value: string; version: number } | null>(null);
  const snapRef = useRef<{ value: string; version: number } | null>(null);
  const sub = useCallback((listener: () => void) => {
    if (!subscribe || !isGetter) return noopSub();
    return subscribe(() => {
      const next = readRef.current();
      const cur = committedRef.current;
      if (!cur || next !== cur.value) committedRef.current = { value: next, version: (cur?.version ?? 0) + 1 };
      listener();
    });
  }, [subscribe, isGetter]);
  const getSnapshot = useCallback(() => {
    const next = read();
    const cur = committedRef.current;
    if (cur && next === cur.value) return cur;
    const v = cur ? cur.version + 1 : 0;
    if (snapRef.current && snapRef.current.value === next && snapRef.current.version === v) return snapRef.current;
    return (snapRef.current = { value: next, version: v });
  }, [read]);
  const snap = useSyncExternalStore(sub, getSnapshot, getSnapshot);
  useLayoutEffect(() => {
    readRef.current = read;
    committedRef.current = snap;
  }, [read, snap]);
  const readToken = useCallback(() => {
    const cur = readRef.current();
    const c = committedRef.current;
    return c && c.value === cur ? `${c.version}:${cur}` : `drift:${cur}`;
  }, []);
  return { token: `${snap.version}:${snap.value}`, readToken };
}

function useCached<T>(source: T | (() => T) | undefined, subscribe: ((l: () => void) => () => void) | undefined): T | undefined {
  const cache = useRef<{ has: boolean; value: T | undefined }>({ has: false, value: undefined });
  const get = useCallback((): T | undefined => {
    const next = typeof source === "function" ? (source as () => T)() : source;
    if (cache.current.has && sameValue(cache.current.value, next)) return cache.current.value;
    cache.current = { has: true, value: next };
    return next;
  }, [source]);
  return useSyncExternalStore(subscribe && typeof source === "function" ? subscribe : noopSub, get, get);
}

export function HubNoticeLine({ deps }: HubNoticeLineProps = {}) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const controlledDismissed = useCached(deps?.dismissed, deps?.subscribeDismissed);

  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: trackedScope.token, epoch: 1 }));
  const effectiveEpoch = scope.key === trackedScope.token ? scope.epoch : scope.epoch + 1;
  if (scope.key !== trackedScope.token) setScope({ key: trackedScope.token, epoch: effectiveEpoch });

  const [statusState, setStatusState] = useState<{ epoch: number; status: HubUpdateStatus | null }>({ epoch: 0, status: null });
  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });
  const [localDismissed, setLocalDismissed] = useState<{ epoch: number; keys: readonly string[] }>(() => ({
    epoch: 1,
    keys: deps?.dismissed === undefined && deps?.dismissNotice === undefined ? dismissedHubNotices() : [],
  }));

  const status = statusState.epoch === effectiveEpoch ? statusState.status : null;
  const busy = busyState.epoch === effectiveEpoch && busyState.busy;
  const dismissed = deps?.dismissed !== undefined
    ? (controlledDismissed ?? [])
    : (localDismissed.epoch === effectiveEpoch ? localDismissed.keys : []);

  const activeEpochRef = useRef(0);
  const seqRef = useRef(0);
  const opSeqRef = useRef(0);
  const readOpRef = useRef<{ seq: number; c: AbortController } | null>(null);
  const actOpRef = useRef<{ seq: number; c: AbortController } | null>(null);
  const disOpRef = useRef<{ seq: number; c: AbortController } | null>(null);
  const depsRef = useRef(deps);
  const readTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    readTokenRef.current = trackedScope.readToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      readOpRef.current?.c.abort();
      readOpRef.current = null;
      actOpRef.current?.c.abort();
      actOpRef.current = null;
      disOpRef.current?.c.abort();
      disOpRef.current = null;
      seqRef.current += 1;
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedToken = trackedScope.token;
  const isLive = () => activeEpochRef.current === capturedEpoch && readTokenRef.current() === capturedToken;

  const fail = (err: unknown, showToast: boolean) => {
    const msg = fmtErr(depsRef.current?.formatError, err);
    if (showToast) {
      try { (depsRef.current?.notify ?? toast)(msg, "error"); } catch { /* non-blocking */ }
    }
    try { depsRef.current?.onError?.(msg); } catch { /* non-blocking */ }
  };

  const subHubEvent = deps?.subscribeHubEvent;
  useEffect(() => {
    let dead = false;
    // Only the newest read may land, and a hub_update push outdates every read still on its way: a GET that left
    // before the push would otherwise put the older status back (an "Update" button in the middle of an update).
    const read = () => {
      if (dead || !isLive()) return;
      readOpRef.current?.c.abort();
      const c = new AbortController();
      const mine = ++seqRef.current;
      readOpRef.current = { seq: mine, c };
      const current = () => !dead && !c.signal.aborted && isLive() && mine === seqRef.current;
      const custom = depsRef.current?.readStatus;
      let res: Promise<HubUpdateStatus | null> | HubUpdateStatus | null;
      try {
        res = custom ? custom(c.signal) : hubUpdate();
      } catch (e) {
        if (readOpRef.current?.seq === mine) readOpRef.current = null;
        if (current()) fail(e, false);
        return;
      }
      if (!isThenable(res)) {
        if (readOpRef.current?.seq === mine) readOpRef.current = null;
        if (current()) setStatusState({ epoch: capturedEpoch, status: res });
        return;
      }
      // an older hub without /hub/update, or one that can't be read now: no line
      void (async () => {
        try {
          const s = await res;
          if (current()) setStatusState({ epoch: capturedEpoch, status: s });
        } catch (e) {
          if (current()) fail(e, false);
        } finally {
          if (readOpRef.current?.seq === mine) readOpRef.current = null;
        }
      })();
    };
    read();
    const listen = subHubEvent ?? onHubEvent;
    const offUpdate = listen("hub_update", (m) => {
      if (dead || !isLive() || !m.update) return;
      seqRef.current += 1;
      readOpRef.current?.c.abort();
      readOpRef.current = null;
      setStatusState({ epoch: capturedEpoch, status: m.update as HubUpdateStatus });
    });
    // A resumed hello does not read: the hub replays the hub_update pushes it missed, which carry the update state. The
    // auto-update settings behind the auto_on and available lines are not pushed, so a change another device made while
    // the socket was down shows with the next push or fresh hello (Settings › hub works the same way).
    const offHello = listen("hello", (m) => {
      if (!dead && isLive() && !isResumed(m)) read();
    });
    return () => {
      dead = true;
      readOpRef.current?.c.abort();
      readOpRef.current = null;
      offUpdate();
      offHello();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveEpoch, subHubEvent]);

  const runAction = (call: (signal: AbortSignal) => Promise<HubUpdateStatus> | HubUpdateStatus) => {
    if (!isLive() || actOpRef.current !== null) return;
    const c = new AbortController();
    const runSeq = ++opSeqRef.current;
    const current = () => !c.signal.aborted && isLive() && actOpRef.current?.seq === runSeq;
    const apply = (s: HubUpdateStatus) => {
      seqRef.current += 1;
      readOpRef.current?.c.abort();
      readOpRef.current = null;
      setStatusState({ epoch: capturedEpoch, status: s });
    };
    let res: Promise<HubUpdateStatus> | HubUpdateStatus;
    try {
      res = call(c.signal);
    } catch (e) {
      if (isLive()) fail(e, true);
      return;
    }
    if (!isThenable(res)) {
      if (isLive()) apply(res);
      return;
    }
    actOpRef.current = { seq: runSeq, c };
    setBusyState({ epoch: capturedEpoch, busy: true });
    void (async () => {
      try {
        const s = await res;
        if (current()) apply(s);
      } catch (e) {
        if (current()) fail(e, true);
      } finally {
        if (actOpRef.current?.seq === runSeq) actOpRef.current = null;
        if (activeEpochRef.current === capturedEpoch) setBusyState({ epoch: capturedEpoch, busy: false });
      }
    })();
  };

  const handleDismiss = (key: string) => {
    if (!isLive() || disOpRef.current !== null) return;
    if (depsRef.current?.dismissed !== undefined && !depsRef.current?.dismissNotice) return;
    const c = new AbortController();
    const runSeq = ++opSeqRef.current;
    const current = () => !c.signal.aborted && isLive() && disOpRef.current?.seq === runSeq;
    const apply = (out: readonly string[] | void) => {
      if (depsRef.current?.dismissed !== undefined) return;
      setLocalDismissed((prev) => ({
        epoch: capturedEpoch,
        keys: Array.isArray(out) ? out : [...(prev.epoch === capturedEpoch ? prev.keys : []).filter((k) => k !== key), key],
      }));
    };
    let res: readonly string[] | void | Promise<readonly string[] | void>;
    try {
      res = depsRef.current?.dismissNotice ? depsRef.current.dismissNotice(key, c.signal) : dismissHubNotice(key);
    } catch (e) {
      if (isLive()) fail(e, true);
      return;
    }
    if (!isThenable(res)) {
      if (isLive()) apply(res);
      return;
    }
    disOpRef.current = { seq: runSeq, c };
    void (async () => {
      try {
        const out = await res;
        if (current()) apply(out);
      } catch (e) {
        if (current()) fail(e, true);
      } finally {
        if (disOpRef.current?.seq === runSeq) disOpRef.current = null;
      }
    })();
  };

  const handleOpen = () => {
    if (!isLive()) return;
    try {
      (depsRef.current?.navigate ?? navigate)("/settings?tab=hub");
    } catch (e) {
      fail(e, true);
    }
  };

  const notice = hubNotice(status, dismissed);
  if (!notice) return null;
  const viewProps: HubNoticeViewProps = {
    notice,
    busy,
    onOpen: handleOpen,
    onAutoOff: () => runAction((sig) => (depsRef.current?.setUpdateSettings ? depsRef.current.setUpdateSettings({ auto: false }, sig) : setHubUpdateSettings({ auto: false }))),
    onSeen: () => runAction((sig) => (depsRef.current?.setUpdateSettings ? depsRef.current.setUpdateSettings({ auto_notice_seen: true }, sig) : setHubUpdateSettings({ auto_notice_seen: true }))),
    onUpdate: () => runAction((sig) => (depsRef.current?.startUpdate ? depsRef.current.startUpdate(false, sig) : startHubUpdate(false))),
    onDismiss: handleDismiss,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <HubNoticeView {...viewProps} />;
}

export function HubNoticeView({ notice, busy = false, onOpen, onAutoOff, onSeen, onUpdate, onDismiss }: HubNoticeViewProps) {
  const warn = notice.kind === "rolled_back";
  const key = hubNoticeKey(notice);
  const action = "touch-hit shrink-0 whitespace-nowrap rounded-control px-2 py-0.5 text-[12px] font-medium text-accent-ink hover:bg-hover";
  return (
    <div data-testid="hub-notice" data-kind={notice.kind} className="relative z-10 mt-1.5 flex items-start gap-1 rounded-[7px] px-2 py-1.5 hover:bg-hover [@media(pointer:coarse)]:min-h-11">
      <button type="button" onClick={onOpen} title={t("lib-hub-update.notice_open")} className="flex min-w-0 flex-1 items-start gap-2 text-left" aria-live="polite">
        <span className={`mt-[3px] flex size-3.5 shrink-0 items-center justify-center ${warn ? "text-orange" : "text-accent-ink"}`}>
          {notice.kind === "updating" ? <Spinner size={11} /> : <Icon name={warn ? "warning" : "retry"} size={13} stroke={2.2} />}
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-[1.45] text-ink-2">{hubNoticeText(notice)}</span>
      </button>
      {notice.kind === "auto_on" && (
        <>
          <button type="button" data-testid="hub-notice-auto-off" disabled={busy || undefined} aria-busy={busy || undefined} onClick={onAutoOff} className={action}>{t("lib-hub-update.notice_turn_off")}</button>
          <button type="button" data-testid="hub-notice-seen" disabled={busy || undefined} aria-busy={busy || undefined} onClick={onSeen} className={action}>{t("lib-hub-update.notice_got_it")}</button>
        </>
      )}
      {notice.kind === "available" && (
        <button type="button" data-testid="hub-notice-update" disabled={busy || undefined} aria-busy={busy || undefined} onClick={onUpdate} className={action}>{t("lib-hub-update.notice_update")}</button>
      )}
      {key && (
        <button type="button" data-testid="hub-notice-dismiss" aria-label={t("lib-hub-update.notice_dismiss")} title={t("lib-hub-update.notice_dismiss")} onClick={() => onDismiss(key)} className="touch-hit -mt-0.5 shrink-0 rounded-control p-1 text-ink-3 hover:bg-hover hover:text-ink-2">
          <Icon name="x" size={12} stroke={2} />
        </button>
      )}
    </div>
  );
}

export const HubNoticeLineView = HubNoticeView;
