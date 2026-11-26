import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../i18n";
import { errorText } from "../../lib/api";
import { decisionLaterKey } from "../../lib/assistant-entries";
import { acceptBrief, later } from "../../lib/feed";
import { openTask } from "../../lib/handoff";
import { refreshTodos } from "../../lib/store";
import type { Todo, TodoAsk } from "../../lib/todos";
import type { Interaction } from "../../lib/types";
import { Button, toast } from "../../ui/atoms";
import { QuestionCard } from "../chat/Interactions";

export type ExpiredQuestionAcceptResult = "accepted" | "recorded" | "handled";

export interface ExpiredQuestionViewProps {
  rowKey?: string;
  ix: Interaction;
  questionKey?: string;
  recorded: boolean;
  busy: boolean;
  onAnswer: (answers: Record<string, string>) => Promise<boolean>;
  onLater: () => void;
  onOpenTask: () => void;
}

export interface ExpiredQuestionDeps {
  /** Optional scope partition (value or getter); switching it resets recorded/busy state, aborts in-flight actions, and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Shared fallback subscription for getter deps without a dedicated subscriber. */
  subscribe?: (listener: () => void) => () => void;
  /** Controlled answer submission (bypasses `feed.acceptBrief` when supplied). */
  acceptBrief?: (
    todoId: string,
    askedAt: string,
    answer: { answers: Record<string, string> },
    signal: AbortSignal,
  ) => ExpiredQuestionAcceptResult | Promise<ExpiredQuestionAcceptResult>;
  /** Controlled todo refresh invoked after a current answer succeeds (bypasses `store.refreshTodos` when supplied). */
  refreshTodos?: (signal: AbortSignal) => void | Promise<unknown>;
  /** Controlled defer action (bypasses `feed.later` when supplied). */
  later?: (itemId: string, signal: AbortSignal) => void | Promise<unknown>;
  /** Controlled open-task action (bypasses `handoff.openTask` when supplied). */
  openTask?: (todoId: string, signal: AbortSignal) => void | Promise<unknown>;
  /** Controlled toast/notification sink (bypasses `ui/atoms.toast` when supplied). */
  notify?: (message: string, tone?: "ok" | "error") => void;
  /** Format thrown action errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when an action throws or rejects in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<ExpiredQuestionView>`). */
  renderView?: (props: ExpiredQuestionViewProps) => ReactNode;
}

export interface ExpiredQuestionProps {
  todo: Todo;
  ask: TodoAsk;
  rowKey?: string;
  deps?: ExpiredQuestionDeps;
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

/** Pure presentational view for an expired question answered via the late-decision path. */
export function ExpiredQuestionView({
  rowKey,
  ix,
  questionKey,
  recorded,
  busy,
  onAnswer,
  onLater,
  onOpenTask,
}: ExpiredQuestionViewProps) {
  return (
    <div data-needs-row={rowKey} data-expired-question className="flex min-w-0 flex-col gap-2">
      {recorded
        ? <p className="text-sm text-ink-2">{t("assistant-decisionrow.answer_recorded")}</p>
        : <QuestionCard key={questionKey ?? ix.id} ix={ix} canApprove onAnswer={onAnswer} />}
      <div className="flex items-center gap-2">
        <Button disabled={busy} onClick={onLater}>{t("assistant-task-actions.later")}</Button>
        <Button disabled={busy} onClick={onOpenTask}>{t("assistant-decisionrow.another")}</Button>
      </div>
    </div>
  );
}

/** Reuse the original question form, but return answers through the to-do's late-decision path. */
export function ExpiredQuestion({ todo, ask, rowKey, deps }: ExpiredQuestionProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey ?? deps?.subscribe);

  const targetScope = JSON.stringify([trackedScope.token, todo.id, ask.asked_at]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: targetScope, epoch: 1 }));
  const effectiveEpoch = scope.key === targetScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== targetScope) {
    setScope({ key: targetScope, epoch: effectiveEpoch });
  }

  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });
  const [recordedState, setRecordedState] = useState<{ epoch: number; recorded: boolean }>({ epoch: 0, recorded: false });
  const busy = busyState.epoch === effectiveEpoch && busyState.busy;
  const recorded = recordedState.epoch === effectiveEpoch && recordedState.recorded;

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingRef = useRef<{ epoch: number; seq: number; controller: AbortController } | null>(null);
  const depsRef = useRef(deps);
  const todoRef = useRef(todo);
  const askRef = useRef(ask);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useLayoutEffect(() => {
    depsRef.current = deps;
    todoRef.current = todo;
    askRef.current = ask;
    readScopeTokenRef.current = trackedScope.readToken;
  });

  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      pendingRef.current?.controller.abort();
      pendingRef.current = null;
      opSeqRef.current += 1;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;

  const safeNotify = (message: string, tone?: "ok" | "error") => {
    try {
      const customNotify = depsRef.current?.notify;
      if (customNotify) {
        if (tone === undefined) customNotify(message);
        else customNotify(message, tone);
      } else if (tone === undefined) {
        toast(message);
      } else {
        toast(message, tone);
      }
    } catch {
      // Notification sink failures stay non-blocking so recovery never leaves busy stuck.
    }
  };

  const surfaceError = (err: unknown) => {
    const msg = safeFormatError(depsRef.current?.formatError, err);
    safeNotify(t("assistant-decisionrow.failed", { error: msg }), "error");
    try {
      depsRef.current?.onError?.(msg);
    } catch {
      // Error observer failures stay non-blocking so recovery never leaves busy stuck.
    }
  };

  const reportObserverError = (err: unknown) => {
    const msg = safeFormatError(depsRef.current?.formatError, err);
    try {
      depsRef.current?.onError?.(msg);
    } catch {
      // Error observer failures stay non-blocking.
    }
  };

  const answer = async (answers: Record<string, string>): Promise<boolean> => {
    if (activeEpochRef.current !== capturedEpoch || readScopeTokenRef.current() !== capturedScopeToken) return false;
    if (pendingRef.current !== null) return false;

    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    const isRunCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && opSeqRef.current === runSeq
      && readScopeTokenRef.current() === capturedScopeToken;

    pendingRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setBusyState({ epoch: capturedEpoch, busy: true });

    const todoId = todoRef.current.id;
    const askedAt = askRef.current.asked_at;

    try {
      const customAccept = depsRef.current?.acceptBrief;
      const result = await (customAccept
        ? customAccept(todoId, askedAt, { answers }, controller.signal)
        : acceptBrief(todoId, askedAt, { answers }));
      if (!isRunCurrent()) return false;

      try {
        const customRefresh = depsRef.current?.refreshTodos;
        const refreshed = customRefresh ? customRefresh(controller.signal) : refreshTodos();
        if (isThenable(refreshed)) {
          void Promise.resolve(refreshed).catch((err) => {
            if (isRunCurrent()) reportObserverError(err);
          });
        }
      } catch (err) {
        if (isRunCurrent()) reportObserverError(err);
      }

      if (result === "handled") {
        safeNotify(t("assistant-brief.handled"));
        return false;
      }
      setRecordedState({ epoch: capturedEpoch, recorded: true });
      return true;
    } catch (error) {
      if (isRunCurrent()) surfaceError(error);
      return false;
    } finally {
      if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
      if (activeEpochRef.current === capturedEpoch && opSeqRef.current === runSeq) {
        setBusyState({ epoch: capturedEpoch, busy: false });
      }
    }
  };

  const runAction = (task: (signal: AbortSignal) => void | Promise<unknown>) => {
    if (activeEpochRef.current !== capturedEpoch || readScopeTokenRef.current() !== capturedScopeToken) return;
    if (pendingRef.current !== null) return;

    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    const isRunCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && opSeqRef.current === runSeq
      && readScopeTokenRef.current() === capturedScopeToken;

    pendingRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    let result: unknown;
    try {
      result = task(controller.signal);
    } catch (err) {
      if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
      if (isRunCurrent()) surfaceError(err);
      return;
    }

    if (!isThenable(result)) {
      if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
      return;
    }

    setBusyState({ epoch: capturedEpoch, busy: true });
    void (async () => {
      try {
        await result;
      } catch (err) {
        if (isRunCurrent()) surfaceError(err);
      } finally {
        if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
        if (activeEpochRef.current === capturedEpoch && opSeqRef.current === runSeq) {
          setBusyState({ epoch: capturedEpoch, busy: false });
        }
      }
    })();
  };

  const handleLater = () => {
    runAction((signal) => {
      const key = decisionLaterKey(todoRef.current);
      const customLater = depsRef.current?.later;
      return customLater ? customLater(key, signal) : later(key);
    });
  };

  const handleOpenTask = () => {
    runAction((signal) => {
      const id = todoRef.current.id;
      const customOpen = depsRef.current?.openTask;
      return customOpen ? customOpen(id, signal) : openTask(id);
    });
  };

  const ix: Interaction = {
    id: `${todo.id}:${ask.asked_at}`, manager: todo.manager, machine_id: "", session_id: "",
    kind: "question", tool_name: "ask_user", questions: ask.questions,
    created_at: ask.asked_at,
  };

  const viewProps: ExpiredQuestionViewProps = {
    rowKey,
    ix,
    questionKey: `${effectiveEpoch}:${ix.id}`,
    recorded,
    busy,
    onAnswer: answer,
    onLater: handleLater,
    onOpenTask: handleOpenTask,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <ExpiredQuestionView {...viewProps} />;
}
