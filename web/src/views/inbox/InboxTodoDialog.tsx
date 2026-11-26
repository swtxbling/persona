// "Add to to-dos" (#6480): the due time asked once for the rows (1 hour later · today, all day · pick a date and time · no due
// date), then one to-do per row. Opened from a row's menu, the item's page and the selecting bar; the Inbox page's
// TodoDialogHost draws it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { addTodos, fromLocalMoment, pickerStart, type DueChoice } from "../../lib/inbox-actions";
import type { InboxItem } from "../../lib/inbox";
import { sameValue } from "../../lib/stable-lines";
import { t } from "../../i18n";
import { Button, cx, Dialog } from "../../ui/atoms";

export type TodoDialogOpening = { items: InboxItem[]; done?: () => void };
export type TodoDuePick = "hour" | "today" | "at" | "none";

export interface TodoDialogViewProps {
  count: number;
  pick: TodoDuePick;
  at: string;
  busy: boolean;
  canSubmit: boolean;
  onPickChange: (pick: TodoDuePick) => void;
  onAtChange: (at: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export interface TodoDialogDeps {
  /** Optional scope partition (value or getter); switching it resets draft state, aborts in-flight adds, and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Add to-dos for the items (defaults to `lib/inbox-actions.addTodos`). */
  addTodos?: (items: InboxItem[], due: DueChoice, signal: AbortSignal) => number | Promise<number>;
  /** Initial `datetime-local` value or factory for the picker (bypasses wall-clock `pickerStart()`). */
  pickerStart?: string | (() => string);
  /** Controlled epoch timestamp in ms (value or getter) used to compute `pickerStart(new Date(now))` when `pickerStart` is omitted. */
  now?: number | (() => number);
  /** Parse a `datetime-local` string into a `Date` (defaults to `lib/inbox-actions.fromLocalMoment`). */
  fromLocalMoment?: (value: string) => Date | null;
  /** Error observer invoked when `addTodos` throws or rejects in the active scope. */
  onError?: (error: unknown) => void;
  /** Optional custom view renderer (defaults to `<TodoDialogView>`). */
  renderView?: (props: TodoDialogViewProps) => ReactNode;
}

export interface TodoDialogProps {
  items: InboxItem[];
  onDone?: () => void;
  onClose: () => void;
  deps?: TodoDialogDeps;
}

export interface TodoDialogHostViewProps {
  opening: TodoDialogOpening | null;
  dialogKey?: string;
  onClose: () => void;
  dialogDeps?: TodoDialogDeps;
}

export interface TodoDialogHostDeps {
  /** Optional scope partition (value or getter); switching it remounts the hosted dialog and fences stale close callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled opening payload or getter (`null` for closed; bypasses module-global `opening` when supplied). */
  opening?: TodoDialogOpening | null | (() => TodoDialogOpening | null | undefined);
  /** Subscribe to opening updates when `opening` is a getter. */
  subscribeOpening?: (listener: () => void) => () => void;
  /** Controlled close handler (bypasses module-global `closeTodoDialog` when supplied). */
  close?: () => void;
  /** Controlled deps forwarded into `<TodoDialog>` (or a factory per opening). */
  dialogDeps?: TodoDialogDeps | ((opening: TodoDialogOpening) => TodoDialogDeps);
  /** Optional custom host view renderer (defaults to `<TodoDialogHostView>`). */
  renderView?: (props: TodoDialogHostViewProps) => ReactNode;
}

export interface TodoDialogHostProps {
  deps?: TodoDialogHostDeps;
}

const noopSubscribe = () => () => {};
const useCommitEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

let opening: TodoDialogOpening | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const subscribeDefaultOpening = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const readDefaultOpening = () => opening;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<unknown>).then === "function";
}

function itemsIdentityOf(items: readonly InboxItem[]): string {
  return JSON.stringify(items.map((it) => [it.id, it.manager ?? ""]));
}

function resolvePickerStart(deps: TodoDialogDeps | undefined): string {
  if (deps?.pickerStart !== undefined) {
    return typeof deps.pickerStart === "function" ? deps.pickerStart() : deps.pickerStart;
  }
  if (deps?.now !== undefined) {
    const ms = typeof deps.now === "function" ? deps.now() : deps.now;
    return pickerStart(new Date(ms));
  }
  return pickerStart();
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
  useCommitEffect(() => {
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
  const isGetter = typeof source === "function";
  const cache = useRef<{ has: boolean; value: T | undefined }>({ has: false, value: undefined });
  const getSnapshot = useCallback((): T | undefined => {
    const next = typeof source === "function" ? (source as () => T)() : source;
    if (cache.current.has && sameValue(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { has: true, value: next };
    return next;
  }, [source]);
  const sub = useCallback(
    (listener: () => void) => (subscribe && isGetter ? subscribe(listener) : noopSubscribe()),
    [subscribe, isGetter],
  );
  return useSyncExternalStore(sub, getSnapshot, getSnapshot);
}

/** Opens "Add to to-dos" for rows; `done` runs once they are added (the selecting bar ends selecting). */
export function openTodoDialog(items: InboxItem[], done?: () => void) {
  if (!items.length) return;
  opening = { items, done };
  emit();
}

function closeTodoDialog() {
  opening = null;
  emit();
}

/** Pure presentational host view for the Inbox "Add to to-dos" dialog. */
export function TodoDialogHostView({ opening: current, dialogKey, onClose, dialogDeps }: TodoDialogHostViewProps) {
  if (!current) return null;
  const key = dialogKey ?? current.items.map((it) => it.id).join();
  return <TodoDialog key={key} items={current.items} onDone={current.done} onClose={onClose} deps={dialogDeps} />;
}

/** Mounted once on the Inbox page. */
export function TodoDialogHost({ deps }: TodoDialogHostProps = {}) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const hostScope = trackedScope.token;
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: hostScope, epoch: 1 }));
  const effectiveEpoch = scope.key === hostScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== hostScope) {
    setScope({ key: hostScope, epoch: effectiveEpoch });
  }

  const controlledOpeningMode = deps?.opening !== undefined;
  const openingSnapshot = useCachedExternalValue<TodoDialogOpening | null | undefined>(
    controlledOpeningMode ? deps.opening : readDefaultOpening,
    controlledOpeningMode ? deps.subscribeOpening : subscribeDefaultOpening,
  );
  const currentOpening = openingSnapshot ?? null;
  const openingIdentity = currentOpening ? itemsIdentityOf(currentOpening.items) : "";

  const activeEpochRef = useRef(0);
  const activeOpeningKeyRef = useRef("");
  const depsRef = useRef(deps);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useCommitEffect(() => {
    depsRef.current = deps;
    activeOpeningKeyRef.current = openingIdentity;
    readScopeTokenRef.current = trackedScope.readToken;
  });

  useCommitEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
    };
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;
  const capturedOpeningKey = openingIdentity;
  const handleClose = () => {
    if (
      !capturedOpeningKey
      || activeEpochRef.current !== capturedEpoch
      || activeOpeningKeyRef.current !== capturedOpeningKey
      || readScopeTokenRef.current() !== capturedScopeToken
    ) return;
    const curDeps = depsRef.current;
    if (curDeps?.opening !== undefined) {
      const live = typeof curDeps.opening === "function" ? curDeps.opening() : curDeps.opening;
      const liveKey = live ? itemsIdentityOf(live.items) : "";
      if (liveKey !== capturedOpeningKey) return;
    }
    if (curDeps?.close) {
      curDeps.close();
      return;
    }
    if (curDeps?.opening === undefined) {
      closeTodoDialog();
    }
  };

  const dialogKey = currentOpening
    ? (deps?.scopeKey !== undefined ? `${effectiveEpoch}:${openingIdentity}` : currentOpening.items.map((it) => it.id).join())
    : undefined;
  const resolvedDialogDeps = currentOpening && deps?.dialogDeps
    ? (typeof deps.dialogDeps === "function" ? deps.dialogDeps(currentOpening) : deps.dialogDeps)
    : undefined;
  const viewProps: TodoDialogHostViewProps = {
    opening: currentOpening,
    dialogKey,
    onClose: handleClose,
    dialogDeps: resolvedDialogDeps,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <TodoDialogHostView {...viewProps} />;
}

/** Pure presentational view for the Inbox "Add to to-dos" dialog. */
export function TodoDialogView({
  count,
  pick,
  at,
  busy,
  canSubmit,
  onPickChange,
  onAtChange,
  onSubmit,
  onClose,
}: TodoDialogViewProps) {
  const options: { key: TodoDuePick; label: string }[] = [
    { key: "hour", label: t("inbox-inboxlist.todo_hour") },
    { key: "today", label: t("inbox-inboxlist.todo_today") },
    { key: "at", label: t("inbox-inboxlist.todo_pick") },
    { key: "none", label: t("inbox-inboxlist.todo_none") },
  ];
  return (
    <Dialog open onClose={onClose} title={t("inbox-inboxlist.todo_title", { count })} width={380}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>{t("common.cancel")}</Button>
          <Button tone="primary" icon="check" busy={busy} disabled={!canSubmit} onClick={onSubmit}>{t("inbox-inboxlist.todo_add")}</Button>
        </>
      }>
      <div role="radiogroup" aria-label={t("inbox-inboxlist.todo_due")} className="flex flex-col gap-1" data-todo-due>
        {options.map((o) => (
          <button key={o.key} type="button" role="radio" aria-checked={pick === o.key} onClick={() => onPickChange(o.key)}
            className={cx("flex h-9 items-center gap-2.5 rounded-control px-2.5 text-left text-meta whitespace-nowrap transition-colors", pick === o.key ? "bg-accent-tint font-medium text-ink" : "text-ink-2 hover:bg-hover")}>
            <span aria-hidden className={cx("size-3.5 shrink-0 rounded-full", pick === o.key ? "bg-accent shadow-[inset_0_0_0_3px_var(--accent-tint)]" : "shadow-[inset_0_0_0_1.5px_var(--line)]")} />
            {o.label}
          </button>
        ))}
      </div>
      {pick === "at" && (
        <input type="datetime-local" value={at} onChange={(e) => onAtChange(e.target.value)} aria-label={t("inbox-inboxlist.todo_pick")} data-todo-at
          className="mt-2 h-9 w-full rounded-control bg-field px-2.5 text-meta text-ink outline-none focus:shadow-[inset_0_0_0_1px_var(--accent)]" />
      )}
    </Dialog>
  );
}

export function TodoDialog({ items, onDone, onClose, deps }: TodoDialogProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const itemsIdentity = itemsIdentityOf(items);
  const dialogTarget = JSON.stringify([trackedScope.token, itemsIdentity]);

  const [targetEpoch, setTargetEpoch] = useState<{ key: string; epoch: number }>(() => ({ key: dialogTarget, epoch: 1 }));
  const effectiveEpoch = targetEpoch.key === dialogTarget ? targetEpoch.epoch : targetEpoch.epoch + 1;
  if (targetEpoch.key !== dialogTarget) {
    setTargetEpoch({ key: dialogTarget, epoch: effectiveEpoch });
  }

  const [draftState, setDraftState] = useState<{ epoch: number; pick: TodoDuePick; at: string }>(() => ({
    epoch: effectiveEpoch,
    pick: "today",
    at: resolvePickerStart(deps),
  }));
  const needsDraftReset = draftState.epoch !== effectiveEpoch;
  const nextAt = needsDraftReset ? resolvePickerStart(deps) : draftState.at;
  if (needsDraftReset) {
    setDraftState({ epoch: effectiveEpoch, pick: "today", at: nextAt });
  }
  const pick: TodoDuePick = needsDraftReset ? "today" : draftState.pick;
  const at: string = nextAt;

  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });
  const busy = busyState.epoch === effectiveEpoch && busyState.busy;

  const parseMoment = deps?.fromLocalMoment ?? fromLocalMoment;
  const moment = parseMoment(at);
  const due: DueChoice | null = pick === "at" ? (moment ? { kind: "at", at: moment } : null) : { kind: pick };

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingRef = useRef<{ epoch: number; seq: number; controller: AbortController } | null>(null);
  const itemsRef = useRef(items);
  const onDoneRef = useRef(onDone);
  const onCloseRef = useRef(onClose);
  const depsRef = useRef(deps);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useCommitEffect(() => {
    itemsRef.current = items;
    onDoneRef.current = onDone;
    onCloseRef.current = onClose;
    depsRef.current = deps;
    readScopeTokenRef.current = trackedScope.readToken;
  });

  useCommitEffect(() => {
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

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken;

  const handlePickChange = (next: TodoDuePick) => {
    if (!isScopeLive()) return;
    setDraftState((prev) => (prev.epoch === capturedEpoch ? { ...prev, pick: next } : prev));
  };

  const handleAtChange = (next: string) => {
    if (!isScopeLive()) return;
    setDraftState((prev) => (prev.epoch === capturedEpoch ? { ...prev, at: next } : prev));
  };

  const handleClose = () => {
    if (!isScopeLive()) return;
    pendingRef.current?.controller.abort();
    pendingRef.current = null;
    opSeqRef.current += 1;
    setBusyState({ epoch: capturedEpoch, busy: false });
    onCloseRef.current();
  };

  const handleSubmit = () => {
    if (!due || !isScopeLive() || pendingRef.current !== null) return;
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;
    const runEpoch = capturedEpoch;
    const runScopeToken = capturedScopeToken;
    const runItems = itemsRef.current;
    const runDue = due;

    const isRunCurrent = () =>
      !controller.signal.aborted
      && activeEpochRef.current === runEpoch
      && opSeqRef.current === runSeq
      && readScopeTokenRef.current() === runScopeToken;

    const reportError = (err: unknown) => {
      if (!isRunCurrent()) return;
      try {
        depsRef.current?.onError?.(err);
      } catch {
        // Error observer failures stay non-blocking so recovery never leaves busy stuck.
      }
    };

    const finishSuccess = (addedCount: number) => {
      if (!isRunCurrent()) return;
      if (addedCount) onDoneRef.current?.();
      if (!isRunCurrent()) return;
      onCloseRef.current();
    };

    let result: number | Promise<number>;
    try {
      result = depsRef.current?.addTodos
        ? depsRef.current.addTodos(runItems, runDue, controller.signal)
        : addTodos(runItems, runDue);
    } catch (err) {
      reportError(err);
      return;
    }

    if (!isThenable(result)) {
      finishSuccess(result);
      return;
    }

    pendingRef.current = { epoch: runEpoch, seq: runSeq, controller };
    setBusyState({ epoch: runEpoch, busy: true });
    void (async () => {
      let addedCount: number;
      try {
        addedCount = await result;
      } catch (err) {
        reportError(err);
        return;
      } finally {
        if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
        if (activeEpochRef.current === runEpoch && opSeqRef.current === runSeq) {
          setBusyState({ epoch: runEpoch, busy: false });
        }
      }
      finishSuccess(addedCount);
    })();
  };

  const viewProps: TodoDialogViewProps = {
    count: items.length,
    pick,
    at,
    busy,
    canSubmit: Boolean(due),
    onPickChange: handlePickChange,
    onAtChange: handleAtChange,
    onSubmit: handleSubmit,
    onClose: handleClose,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <TodoDialogView {...viewProps} />;
}
