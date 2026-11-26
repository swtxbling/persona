import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../i18n";
import { ASSISTANT_MODEL_PICK_FEATURE, mainChatAgentMismatch } from "../../lib/assistant-models";
import { stateOf } from "../../lib/format";
import { launcherTitle } from "../../lib/provider-names";
import { assistantLaunchers, readAssistantLaunchers, useModelLists, useRevisionReread, type AssistantLaunchers } from "../../lib/session-models";
import { sameValue } from "../../lib/stable-lines";
import { hubHas, useStore } from "../../lib/store";
import type { AssistantInfo, Session } from "../../lib/types";
import { Button } from "../../ui/atoms";
import { Icon } from "../../ui/icons";

const noopSubscribe = () => () => {};

export type MainChatAgentNoticeAssistant = Pick<AssistantInfo, "launcher">;

export interface MainChatAgentNoticeViewProps {
  configuredLabel: string;
  actualLabel: string;
  onNewMain?: () => void;
  busy?: boolean;
}

export interface MainChatAgentNoticeDeps {
  /** Optional scope partition (value or getter); switching it resets busy state, aborts in-flight actions/reads, and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled assistant info (value or getter; bypasses `useStore(s => s.assistant)` when supplied). */
  assistant?: MainChatAgentNoticeAssistant | null | (() => MainChatAgentNoticeAssistant | null);
  /** Subscribe to assistant changes when `assistant` is a getter. */
  subscribeAssistant?: (listener: () => void) => () => void;
  /** Controlled `assistant_model_pick` feature flag (value or getter; bypasses `useStore(s => hubHas(...))` when supplied). */
  kept?: boolean | (() => boolean);
  /** Subscribe to `kept` changes when `kept` is a getter. */
  subscribeKept?: (listener: () => void) => () => void;
  /** Controlled assistant launchers catalog (value or getter; bypasses `useModelLists` and `assistantLaunchers` when supplied). */
  launchersInfo?: AssistantLaunchers | null | (() => AssistantLaunchers | null | undefined);
  /** Subscribe to launcher catalog changes when `launchersInfo` is a getter. */
  subscribeLaunchersInfo?: (listener: () => void) => () => void;
  /** Shared fallback subscription for getter deps without a dedicated subscriber. */
  subscribe?: (listener: () => void) => () => void;
  /** Controlled launcher refresh reader (bypasses `readAssistantLaunchers` and `useRevisionReread` when supplied). */
  readLaunchers?: (mid: string, opts: { again?: boolean; signal: AbortSignal }) => void | Promise<unknown>;
  /** Controlled "New main chat" handler (overrides prop `onNewMain` when supplied). */
  onNewMain?: (signal: AbortSignal) => void | Promise<unknown>;
  /** Error observer invoked when `readLaunchers` or `onNewMain` throws or rejects in the active scope. */
  onError?: (error: unknown) => void;
  /** Optional custom view renderer (defaults to `<MainChatAgentNoticeView>`). */
  renderView?: (props: MainChatAgentNoticeViewProps) => ReactNode;
}

export interface MainChatAgentNoticeProps {
  session: Session;
  isMain: boolean;
  onNewMain?: () => void;
  deps?: MainChatAgentNoticeDeps;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<unknown>).then === "function";
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

/** Pure presentational view for the main chat agent-kind mismatch banner. */
export function MainChatAgentNoticeView({
  configuredLabel,
  actualLabel,
  onNewMain,
  busy,
}: MainChatAgentNoticeViewProps) {
  return (
    <div data-main-chat-agent-notice role="status" className="flex min-h-9 items-center gap-2 rounded-[12px] bg-surface px-3 py-1.5 text-xs text-ink-2 shadow-card">
      <Icon name="info" size={13} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 break-words">
        {t("assistant-mainagentnotice.main_other_kind", { configured: configuredLabel, actual: actualLabel })}
      </span>
      {onNewMain && (
        <Button tone="quiet" className="touch-hit shrink-0" busy={busy} disabled={busy} onClick={onNewMain}>
          {t("assistant-assistantchat.new_main_ellipsis")}
        </Button>
      )}
    </div>
  );
}

function DefaultAssistantBridge({ render }: { render: (assistant: MainChatAgentNoticeAssistant | null) => ReactNode }) {
  const assistant = useStore((s) => s.assistant);
  return <>{render(assistant)}</>;
}

function DefaultKeptBridge({ render }: { render: (kept: boolean) => ReactNode }) {
  const kept = useStore((s) => hubHas(s.features, ASSISTANT_MODEL_PICK_FEATURE));
  return <>{render(kept)}</>;
}

function DefaultLaunchersBridge({
  mid,
  render,
}: {
  mid: string;
  render: (launchers: { info?: AssistantLaunchers; read?: Promise<void> }) => ReactNode;
}) {
  useModelLists();
  const { info, read } = assistantLaunchers(mid);
  return <>{render({ info, read })}</>;
}

function DefaultRevisionRereadBridge({
  session,
  enabled,
  onReread,
}: {
  session: Session;
  enabled: boolean;
  onReread: () => void | (() => void);
}) {
  useRevisionReread(session, enabled, onReread);
  return null;
}

interface MainChatAgentNoticeBodyProps {
  session: Session;
  isMain: boolean;
  propOnNewMain?: () => void;
  assistant: MainChatAgentNoticeAssistant | null;
  kept: boolean;
  info?: AssistantLaunchers;
  renderedRead?: Promise<void>;
  needDefaultLaunchers: boolean;
  hasCustomScope: boolean;
  outerScopeToken: string;
  readOuterScopeToken: () => string;
  deps?: MainChatAgentNoticeDeps;
}

function MainChatAgentNoticeBody({
  session,
  isMain,
  propOnNewMain,
  assistant,
  kept,
  info,
  renderedRead,
  needDefaultLaunchers,
  hasCustomScope,
  outerScopeToken,
  readOuterScopeToken,
  deps,
}: MainChatAgentNoticeBodyProps) {
  const mid = session.machine_id;
  const hasCustomRead = deps?.readLaunchers !== undefined;
  const useDefaultRevisionBridge = needDefaultLaunchers && !hasCustomRead;

  const targetScope = JSON.stringify([outerScopeToken, mid, session.session_id, isMain]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: targetScope, epoch: 1 }));
  const effectiveEpoch = scope.key === targetScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== targetScope) {
    setScope({ key: targetScope, epoch: effectiveEpoch });
  }

  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });
  const busy = busyState.epoch === effectiveEpoch && busyState.busy;

  const activeEpochRef = useRef(0);
  const readControllerRef = useRef<AbortController | null>(null);
  const inFlightControlledReadRef = useRef<{ epoch: number; promise: Promise<unknown> } | null>(null);
  const actionSeqRef = useRef(0);
  const actionPendingRef = useRef<{ epoch: number; seq: number; controller: AbortController } | null>(null);
  const depsRef = useRef(deps);
  const propOnNewMainRef = useRef(propOnNewMain);
  const renderedReadRef = useRef(renderedRead);
  const readScopeTokenRef = useRef(readOuterScopeToken);

  // Controlled revision reread tracker (mirrors useRevisionReread without touching session-models).
  const revSeenRef = useRef<{ key: string; rev: number | undefined }>({ key: `${effectiveEpoch}:${mid}/${session.session_id}`, rev: session.rev });
  const revOwedRef = useRef(false);
  const revCleanupRef = useRef<(() => void) | undefined>(undefined);

  useLayoutEffect(() => {
    depsRef.current = deps;
    propOnNewMainRef.current = propOnNewMain;
    renderedReadRef.current = renderedRead;
    readScopeTokenRef.current = readOuterScopeToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    const controller = new AbortController();
    readControllerRef.current = controller;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      controller.abort();
      if (readControllerRef.current === controller) readControllerRef.current = null;
      inFlightControlledReadRef.current = null;
      actionPendingRef.current?.controller.abort();
      actionPendingRef.current = null;
      actionSeqRef.current += 1;
      revCleanupRef.current?.();
      revCleanupRef.current = undefined;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = outerScopeToken;

  const reportError = (err: unknown) => {
    try {
      depsRef.current?.onError?.(err);
    } catch {
      // Error observer failures stay non-blocking so recovery never leaves busy stuck.
    }
  };

  const invokeControlledRead = (machineId: string): Promise<unknown> | undefined => {
    const customRead = depsRef.current?.readLaunchers;
    const controller = readControllerRef.current;
    if (!customRead || !controller) return undefined;
    const isReadCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && readScopeTokenRef.current() === capturedScopeToken;
    if (!isReadCurrent()) return undefined;

    let result: unknown;
    try {
      result = customRead(machineId, { again: true, signal: controller.signal });
    } catch (err) {
      if (isReadCurrent()) reportError(err);
      return undefined;
    }
    if (!isThenable(result)) return undefined;

    const promise = result as Promise<unknown>;
    if (inFlightControlledReadRef.current?.promise === promise) return promise;
    inFlightControlledReadRef.current = { epoch: capturedEpoch, promise };
    void Promise.resolve(promise).then(
      () => {
        if (inFlightControlledReadRef.current?.promise === promise) {
          inFlightControlledReadRef.current = null;
        }
      },
      (err) => {
        if (inFlightControlledReadRef.current?.promise === promise) {
          inFlightControlledReadRef.current = null;
        }
        if (isReadCurrent()) reportError(err);
      },
    );
    return promise;
  };

  // Initial / target-switch launcher read.
  useEffect(() => {
    if (!isMain || !mid) return;
    if (depsRef.current?.readLaunchers) {
      void invokeControlledRead(mid);
      return;
    }
    if (needDefaultLaunchers) {
      void readAssistantLaunchers(mid, { again: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveEpoch captures scope/session/isMain transitions; depsRef reads the latest controlled reader without re-triggering on inline closures
  }, [effectiveEpoch, isMain, mid, needDefaultLaunchers, hasCustomRead]);

  // Controlled revision reread (used only when deps.readLaunchers is supplied; bypasses session-models.useRevisionReread).
  const rev = session.rev;
  const working = Boolean(stateOf(session) === "working" && !session.background_working);
  const controlledRereadEnabled = hasCustomRead && Boolean(isMain && mid);
  const revWhoKey = `${effectiveEpoch}:${mid}/${session.session_id}`;
  useEffect(() => {
    if (!hasCustomRead) return;
    const done = () => {
      revCleanupRef.current?.();
      revCleanupRef.current = undefined;
    };
    if (revSeenRef.current.key !== revWhoKey) {
      revSeenRef.current = { key: revWhoKey, rev };
      revOwedRef.current = false;
      done();
      return;
    }
    if (rev !== undefined && rev !== revSeenRef.current.rev) {
      revSeenRef.current.rev = rev;
      revOwedRef.current = true;
    }
    if (!controlledRereadEnabled) done();
    if (!revOwedRef.current || working || !controlledRereadEnabled) return;
    revOwedRef.current = false;
    done();

    const priorPromise = inFlightControlledReadRef.current?.epoch === capturedEpoch
      ? inFlightControlledReadRef.current.promise
      : undefined;
    const nextPromise = invokeControlledRead(mid);
    if (!priorPromise || nextPromise !== priorPromise) return;
    let active = true;
    const controller = readControllerRef.current;
    void Promise.resolve(nextPromise).then(
      () => {
        if (
          active
          && controller
          && !controller.signal.aborted
          && activeEpochRef.current === capturedEpoch
          && readScopeTokenRef.current() === capturedScopeToken
        ) {
          void invokeControlledRead(mid);
        }
      },
      () => {
        // Error already reported by invokeControlledRead.
      },
    );
    revCleanupRef.current = () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matches useRevisionReread trigger inputs while reading latest reader from refs
  }, [hasCustomRead, revWhoKey, rev, working, controlledRereadEnabled, mid, capturedEpoch, capturedScopeToken]);

  // A hub-side default change can arrive while this page stays open. Follow the pill: a pushed session revision
  // re-reads the launchers once per turn (useRevisionReread), and useModelLists redraws this notice with the answer so
  // a stale mismatch cannot linger.
  const handleDefaultRevisionReread = () => {
    if (!isMain || !mid) return;
    if (activeEpochRef.current !== capturedEpoch || readScopeTokenRef.current() !== capturedScopeToken) return;
    const read = readAssistantLaunchers(mid, { again: true });
    // Only the exact request seen at render can have preceded this revision. If it already settled, this call returned
    // a new promise and needs no trailing read; a request another effect starts for this revision also needs none.
    const seenAtRender = renderedReadRef.current;
    if (!seenAtRender || read !== seenAtRender) return;
    let active = true;
    const controller = readControllerRef.current;
    void read.then(() => {
      if (
        active
        && (!controller || !controller.signal.aborted)
        && activeEpochRef.current === capturedEpoch
        && readScopeTokenRef.current() === capturedScopeToken
      ) {
        void readAssistantLaunchers(mid, { again: true });
      }
    });
    return () => { active = false; };
  };

  const rereadSession = hasCustomScope
    ? { ...session, session_id: `${outerScopeToken}\0${session.session_id}` }
    : session;

  const hasNewMain = Boolean(deps?.onNewMain || propOnNewMain);
  const handleNewMain = () => {
    if (activeEpochRef.current !== capturedEpoch || readScopeTokenRef.current() !== capturedScopeToken) return;
    if (actionPendingRef.current !== null) return;

    const controller = new AbortController();
    const runSeq = ++actionSeqRef.current;
    const isActionCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && actionSeqRef.current === runSeq
      && readScopeTokenRef.current() === capturedScopeToken;

    actionPendingRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    let result: unknown;
    try {
      const customNewMain = depsRef.current?.onNewMain;
      result = customNewMain ? customNewMain(controller.signal) : propOnNewMainRef.current?.();
    } catch (err) {
      if (actionPendingRef.current?.seq === runSeq) actionPendingRef.current = null;
      if (isActionCurrent()) {
        if (depsRef.current?.onError) reportError(err);
        else if (!depsRef.current?.onNewMain) throw err;
      }
      return;
    }

    if (!isThenable(result)) {
      if (actionPendingRef.current?.seq === runSeq) actionPendingRef.current = null;
      return;
    }

    setBusyState({ epoch: capturedEpoch, busy: true });
    void (async () => {
      try {
        await result;
      } catch (err) {
        if (isActionCurrent()) reportError(err);
      } finally {
        if (actionPendingRef.current?.seq === runSeq) actionPendingRef.current = null;
        if (activeEpochRef.current === capturedEpoch && actionSeqRef.current === runSeq) {
          setBusyState({ epoch: capturedEpoch, busy: false });
        }
      }
    })();
  };

  const mismatch = mainChatAgentMismatch({ session, isMain, kept, config: assistant?.launcher }, info);
  const named = (launcher: string) => launcherTitle(launcher, info?.launchers);
  const bridge = useDefaultRevisionBridge ? (
    <DefaultRevisionRereadBridge
      session={rereadSession}
      enabled={Boolean(isMain && mid)}
      onReread={handleDefaultRevisionReread}
    />
  ) : null;

  const content = mismatch
    ? (() => {
        const viewProps: MainChatAgentNoticeViewProps = {
          configuredLabel: named(mismatch.configuredLauncher),
          actualLabel: named(mismatch.actualLauncher),
          onNewMain: hasNewMain ? handleNewMain : undefined,
          busy,
        };
        return deps?.renderView ? deps.renderView(viewProps) : <MainChatAgentNoticeView {...viewProps} />;
      })()
    : null;

  if (!bridge) return <>{content}</>;
  return (
    <>
      {bridge}
      {content}
    </>
  );
}

/** The Main chat setting names another agent kind than this conversation runs: say what runs now and offer the existing
 *  fresh-start path. A same-kind default, an unknown list or a conversation's pick shows nothing. */
export function MainChatAgentNotice({ session, isMain, onNewMain, deps }: MainChatAgentNoticeProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey ?? deps?.subscribe);

  // Keep controlled inputs and scope tracking in the identity-stable outer component so direct <-> getter+subscribe switches never remount.
  const controlledAssistant = useCachedExternalValue(deps?.assistant, deps?.subscribeAssistant ?? deps?.subscribe);
  const controlledKept = useCachedExternalValue(deps?.kept, deps?.subscribeKept ?? deps?.subscribe);
  const controlledLaunchers = useCachedExternalValue(deps?.launchersInfo, deps?.subscribeLaunchersInfo ?? deps?.subscribe);

  const needDefaultAssistant = deps?.assistant === undefined;
  const needDefaultKept = deps?.kept === undefined;
  const needDefaultLaunchers = deps?.launchersInfo === undefined;
  const hasCustomScope = deps?.scopeKey !== undefined;

  const renderBody = (
    assistant: MainChatAgentNoticeAssistant | null,
    kept: boolean,
    launchers: { info?: AssistantLaunchers; read?: Promise<void> },
  ) => (
    <MainChatAgentNoticeBody
      session={session}
      isMain={isMain}
      propOnNewMain={onNewMain}
      assistant={assistant}
      kept={kept}
      info={launchers.info}
      renderedRead={launchers.read}
      needDefaultLaunchers={needDefaultLaunchers}
      hasCustomScope={hasCustomScope}
      outerScopeToken={trackedScope.token}
      readOuterScopeToken={trackedScope.readToken}
      deps={deps}
    />
  );

  const renderWithLaunchers = (assistant: MainChatAgentNoticeAssistant | null, kept: boolean) => (
    needDefaultLaunchers
      ? <DefaultLaunchersBridge mid={session.machine_id} render={(launchers) => renderBody(assistant, kept, launchers)} />
      : renderBody(assistant, kept, { info: controlledLaunchers ?? undefined })
  );

  const renderWithKept = (assistant: MainChatAgentNoticeAssistant | null) => (
    needDefaultKept
      ? <DefaultKeptBridge render={(kept) => renderWithLaunchers(assistant, kept)} />
      : renderWithLaunchers(assistant, Boolean(controlledKept))
  );

  if (needDefaultAssistant) {
    return <DefaultAssistantBridge render={renderWithKept} />;
  }
  return renderWithKept(controlledAssistant ?? null);
}
