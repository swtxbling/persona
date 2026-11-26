// The two small dialogs the palette's node commands ask with (lib/node-palette.ts): a name for a rename, a yes for a
// close. Mounted once, with the sidebar.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { answerAsk, getAsk, subscribeAsk, type NodeAsk } from "../lib/node-ask";
import { sameValue } from "../lib/stable-lines";
import { Button, Dialog } from "../ui/atoms";
import { t } from "../i18n";

export type { NodeAsk };
export type TextNodeAsk = Extract<NodeAsk, { kind: "text" }>;
export type ConfirmNodeAsk = Extract<NodeAsk, { kind: "confirm" }>;
export type NodeAskAnswer = string | null | boolean;

export interface TextAskViewProps {
  ask: Pick<TextNodeAsk, "title" | "label" | "value">;
  text: string;
  busy?: boolean;
  onTextChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export interface ConfirmAskViewProps {
  ask: Pick<ConfirmNodeAsk, "title" | "body" | "label">;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface NodePromptViewProps {
  ask: NodeAsk | null;
  text: string;
  busy?: boolean;
  promptKey?: string | number;
  onTextChange: (value: string) => void;
  onSubmitText: (value: string) => void;
  onCancelText: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
}

export interface NodePromptDeps {
  /** Optional scope partition (value or getter); switching it resets draft/busy state and fences stale answers. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled active ask or getter (bypasses `node-ask.getAsk`, `subscribeAsk`, and default `answerAsk` when supplied). */
  ask?: NodeAsk | null | (() => NodeAsk | null);
  /** Subscribe to external ask updates when `ask` is a getter (bypasses `node-ask.subscribeAsk` when supplied). */
  subscribeAsk?: (listener: () => void) => () => void;
  /** Controlled answer/dismiss handler (sync or async; bypasses `node-ask.answerAsk` when supplied). */
  answerAsk?: (ask: NodeAsk, answer: NodeAskAnswer, signal: AbortSignal) => void | Promise<unknown>;
  /** Error observer invoked when `answerAsk` or `ask.resolve` throws or rejects in the active scope. */
  onError?: (error: unknown) => void;
  /** Optional custom view renderer (defaults to `<NodePromptView>`). */
  renderView?: (props: NodePromptViewProps) => ReactNode;
}

export interface NodePromptProps {
  deps?: NodePromptDeps;
}

const noopSubscribe = () => () => {};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<unknown>).then === "function";
}

function useTrackedExternalValue<T>(
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
      if (!cur || !sameValue(cur.value, next)) {
        committedRef.current = { value: next, version: (cur?.version ?? 0) + 1 };
      }
      listener();
    });
  }, [subscribe, isGetter]);

  const getSnapshot = useCallback(() => {
    const next = read();
    const cur = committedRef.current;
    if (cur && sameValue(cur.value, next)) return cur;
    const nextVersion = cur ? cur.version + 1 : 0;
    if (snapRef.current && sameValue(snapRef.current.value, next) && snapRef.current.version === nextVersion) {
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

  const readVersion = useCallback(() => {
    const cur = readRef.current();
    const committed = committedRef.current;
    return committed && sameValue(committed.value, cur) ? committed.version : -1;
  }, []);

  return { value: snap.value, version: snap.version, readVersion };
}

/** Pure presentational dialog view for a text node prompt. */
export function TextAskView({ ask, text, busy = false, onTextChange, onSubmit, onCancel }: TextAskViewProps) {
  const next = text.trim();
  const canSave = Boolean(next) && next !== ask.value.trim();
  return (
    <Dialog
      open
      onClose={() => !busy && onCancel()}
      title={ask.title}
      width={380}
      footer={
        <>
          <Button tone="quiet" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button tone="primary" busy={busy} disabled={!canSave} onClick={() => onSubmit(next)}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && canSave) onSubmit(next);
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">{ask.label}</span>
          <input
            value={text}
            autoFocus
            disabled={busy}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => onTextChange(e.target.value)}
            className="h-9 rounded-control bg-surface px-3 text-[13px] text-ink shadow-btn outline-none focus:shadow-[inset_0_0_0_1px_var(--accent)]"
          />
        </label>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Pure presentational dialog view for a confirmation node prompt. */
export function ConfirmAskView({ ask, busy = false, onConfirm, onCancel }: ConfirmAskViewProps) {
  return (
    <Dialog
      open
      onClose={() => !busy && onCancel()}
      title={ask.title}
      width={380}
      footer={
        <>
          <Button tone="quiet" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button tone="danger" busy={busy} onClick={onConfirm}>
            {ask.label}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-2">{ask.body}</p>
    </Dialog>
  );
}

/** Pure presentational view that renders the active text or confirmation node prompt. */
export function NodePromptView({
  ask,
  text,
  busy = false,
  promptKey,
  onTextChange,
  onSubmitText,
  onCancelText,
  onConfirm,
  onCancelConfirm,
}: NodePromptViewProps) {
  if (!ask) return null;
  // a new question starts over (its own text)
  return ask.kind === "text" ? (
    <TextAskView
      key={promptKey ?? ask.title + ask.value}
      ask={ask}
      text={text}
      busy={busy}
      onTextChange={onTextChange}
      onSubmit={onSubmitText}
      onCancel={onCancelText}
    />
  ) : (
    <ConfirmAskView
      ask={ask}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancelConfirm}
    />
  );
}

export function NodePrompt({ deps }: NodePromptProps = {}) {
  const scopeSource = deps?.scopeKey !== undefined ? deps.scopeKey : "";
  const scopeSubscribe = typeof deps?.scopeKey === "function" ? deps.subscribeScopeKey : undefined;
  const trackedScope = useTrackedExternalValue<string>(scopeSource, scopeSubscribe);

  const controlledAsk = deps?.ask !== undefined;
  const askSource: NodeAsk | null | (() => NodeAsk | null) = controlledAsk ? deps.ask! : getAsk;
  const askSubscribe = controlledAsk
    ? (typeof deps.ask === "function" ? deps.subscribeAsk : undefined)
    : (deps?.subscribeAsk ?? subscribeAsk);
  const trackedAsk = useTrackedExternalValue<NodeAsk | null>(askSource, askSubscribe);

  const ask = trackedAsk.value;
  const promptScope = JSON.stringify([trackedScope.version, trackedScope.value, trackedAsk.version]);
  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: promptScope, epoch: 1 }));
  const effectiveEpoch = scope.key === promptScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== promptScope) {
    setScope({ key: promptScope, epoch: effectiveEpoch });
  }

  const [draftState, setDraftState] = useState<{ epoch: number; text: string }>({ epoch: 0, text: "" });
  const [busyState, setBusyState] = useState<{ epoch: number; busy: boolean }>({ epoch: 0, busy: false });

  const text = ask?.kind === "text"
    ? (draftState.epoch === effectiveEpoch ? draftState.text : ask.value)
    : "";
  const busy = busyState.epoch === effectiveEpoch && busyState.busy;

  const activeEpochRef = useRef(0);
  const opSeqRef = useRef(0);
  const pendingRef = useRef<{ epoch: number; seq: number; controller: AbortController } | null>(null);
  const depsRef = useRef(deps);
  const askRef = useRef(ask);
  const readScopeVersionRef = useRef(trackedScope.readVersion);
  const readAskVersionRef = useRef(trackedAsk.readVersion);

  useLayoutEffect(() => {
    depsRef.current = deps;
    askRef.current = ask;
    readScopeVersionRef.current = trackedScope.readVersion;
    readAskVersionRef.current = trackedAsk.readVersion;
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
  const capturedScopeVersion = trackedScope.version;
  const capturedAskVersion = trackedAsk.version;

  const isPromptLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeVersionRef.current() === capturedScopeVersion
    && readAskVersionRef.current() === capturedAskVersion;

  const handleTextChange = (value: string) => {
    if (!isPromptLive() || pendingRef.current !== null) return;
    setDraftState({ epoch: capturedEpoch, text: value });
  };

  const runAnswer = (answer: NodeAskAnswer) => {
    if (!isPromptLive() || !askRef.current || pendingRef.current !== null) return;
    const currentAsk = askRef.current;
    const curDeps = depsRef.current;
    const controller = new AbortController();
    const runSeq = ++opSeqRef.current;

    const isScopeLive = () =>
      !controller.signal.aborted
      && activeEpochRef.current === capturedEpoch
      && opSeqRef.current === runSeq
      && readScopeVersionRef.current() === capturedScopeVersion;

    const isRunCurrent = () =>
      isScopeLive()
      && readAskVersionRef.current() === capturedAskVersion;

    const reportError = (err: unknown) => {
      try {
        depsRef.current?.onError?.(err);
      } catch {
        // Error observer failures stay non-blocking so recovery never leaves busy stuck.
      }
    };

    const invokeResolve = (): unknown => {
      if (currentAsk.kind === "text") return currentAsk.resolve(answer as string | null);
      return currentAsk.resolve(Boolean(answer));
    };

    let answerResult: unknown;
    try {
      if (curDeps?.answerAsk) {
        answerResult = curDeps.answerAsk(currentAsk, answer, controller.signal);
      } else if (curDeps?.ask === undefined) {
        answerAsk();
      }
    } catch (err) {
      if (isRunCurrent()) reportError(err);
      return;
    }

    if (!isThenable(answerResult)) {
      if (!isScopeLive()) return;
      const askChangedBySyncAnswer = readAskVersionRef.current() !== capturedAskVersion;
      let resolveResult: unknown;
      try {
        resolveResult = invokeResolve();
      } catch (err) {
        if (isScopeLive()) reportError(err);
        return;
      }
      if (!isThenable(resolveResult)) return;

      const askChangedBySyncResolve = readAskVersionRef.current() !== capturedAskVersion;
      const checkResolveCurrent = () => (askChangedBySyncAnswer || askChangedBySyncResolve ? isScopeLive() : isRunCurrent());
      pendingRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
      setBusyState({ epoch: capturedEpoch, busy: true });
      void (async () => {
        try {
          await resolveResult;
        } catch (err) {
          if (checkResolveCurrent()) reportError(err);
        } finally {
          if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
          if (activeEpochRef.current === capturedEpoch && opSeqRef.current === runSeq) {
            setBusyState({ epoch: capturedEpoch, busy: false });
          }
        }
      })();
      return;
    }

    pendingRef.current = { epoch: capturedEpoch, seq: runSeq, controller };
    setBusyState({ epoch: capturedEpoch, busy: true });
    void (async () => {
      let askChangedDuringResolve = false;
      try {
        await answerResult;
        if (!isRunCurrent()) return;
        const resolveResult = invokeResolve();
        askChangedDuringResolve = readAskVersionRef.current() !== capturedAskVersion;
        if (isThenable(resolveResult)) {
          await resolveResult;
        }
      } catch (err) {
        if (askChangedDuringResolve ? isScopeLive() : isRunCurrent()) reportError(err);
      } finally {
        if (pendingRef.current?.seq === runSeq) pendingRef.current = null;
        if (activeEpochRef.current === capturedEpoch && opSeqRef.current === runSeq) {
          setBusyState({ epoch: capturedEpoch, busy: false });
        }
      }
    })();
  };

  const viewProps: NodePromptViewProps = {
    ask,
    text,
    busy,
    promptKey: effectiveEpoch,
    onTextChange: handleTextChange,
    onSubmitText: (value) => runAnswer(value),
    onCancelText: () => runAnswer(null),
    onConfirm: () => runAnswer(true),
    onCancelConfirm: () => runAnswer(false),
  };

  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <NodePromptView {...viewProps} />;
}
