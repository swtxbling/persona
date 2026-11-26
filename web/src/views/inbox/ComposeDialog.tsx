// "New email" (the app's ComposeView): from one of the hub's mail accounts, to / cc / bcc, subject and plain text; a reply comes
// with Re:, the thread ids and the start of the mail quoted (replyDraft). Sent by the hub (POST /mail/send).
// "Cancel" drops the mail; closing it any other way (Esc, a click outside, the page under it going away) keeps it for the
// next "New email" in this page.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { errorText } from "../../lib/api";
import type { MailAccount } from "../../lib/inbox";
import { badAddresses, parseAddresses, sendMail, type ComposeDraft } from "../../lib/mail";
import { defaultManager, useItemManager } from "../../lib/manager-choice";
import { sameValue } from "../../lib/stable-lines";
import { t } from "../../i18n";
import { Button, Dialog, toast } from "../../ui/atoms";
import { composing } from "../../lib/send-history";

export type ComposeNoticeTone = "ok" | "error" | "info";

export interface ComposeDraftStore {
  get: (key: string) => ComposeDraft | undefined;
  set: (key: string, draft: ComposeDraft) => void;
  delete: (key: string) => void;
}

export interface ComposeDialogViewProps {
  open?: boolean;
  title: string;
  draft: ComposeDraft;
  accounts: readonly MailAccount[];
  sending: boolean;
  canSend: boolean;
  error: string;
  toRef?: RefObject<HTMLInputElement | null>;
  bodyRef?: RefObject<HTMLTextAreaElement | null>;
  onChange: (patch: Partial<ComposeDraft>) => void;
  onSend: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}

export interface ComposeDialogDeps {
  /** Optional scope partition (value or getter); switching it resets state and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled item manager (value or getter; bypasses `useItemManager` when supplied, including explicit `undefined`). */
  manager?: string | undefined | (() => string | undefined);
  /** Subscribe to manager changes when `manager` is a getter. */
  subscribeManager?: (listener: () => void) => () => void;
  /** Controlled default manager id (value or getter; bypasses `lib/manager-choice.defaultManager` when supplied). */
  defaultManager?: string | (() => string);
  /** Controlled draft store (bypasses module-level `kept` and `pendingRestores` maps when supplied). */
  draftStore?: ComposeDraftStore;
  /** Controlled send action (defaults to `lib/mail.sendMail`). */
  sendMail?: (draft: ComposeDraft, manager: string | undefined, signal: AbortSignal) => void | Promise<unknown>;
  /** Show toast notifications (defaults to `atoms.toast`). */
  notify?: (message: string, tone?: ComposeNoticeTone) => void;
  /** Format thrown/rejected send errors (defaults to `api.errorText`). */
  formatError?: (error: unknown) => string;
  /** Error observer invoked when sending fails in the active scope. */
  onError?: (message: string) => void;
  /** Optional custom view renderer (defaults to `<ComposeDialogView>`). */
  renderView?: (props: ComposeDialogViewProps) => ReactNode;
}

export interface ComposeDialogProps {
  draftKey: string;
  initial: ComposeDraft;
  accounts: MailAccount[];
  onClose: () => void;
  deps?: ComposeDialogDeps;
}

const kept = new Map<string, ComposeDraft>();
// A later opening owns this key's edits and Cancel, even if an older send has not answered yet.
const pendingRestores = new Map<string, object>();
// Isolated per-store pending-restore ownership when a controlled `draftStore` is supplied.
const controlledPendingRestores = new WeakMap<ComposeDraftStore, Map<string, object>>();

function resolveDraftStore(store: ComposeDraftStore | undefined): { store: ComposeDraftStore; restores: Map<string, object> } {
  if (!store) return { store: kept, restores: pendingRestores };
  let restores = controlledPendingRestores.get(store);
  if (!restores) {
    restores = new Map<string, object>();
    controlledPendingRestores.set(store, restores);
  }
  return { store, restores };
}

/** The mail left open under `key` ("new", or a reply's), else `fresh`. */
function keptDraft(store: ComposeDraftStore, key: string, fresh: ComposeDraft): ComposeDraft {
  return store.get(key) ?? fresh;
}

function isDirty(draft: ComposeDraft, initial: ComposeDraft): boolean {
  return draft.to !== initial.to
    || draft.cc !== initial.cc
    || draft.bcc !== initial.bcc
    || draft.subject !== initial.subject
    || draft.body !== initial.body
    || draft.accountID !== initial.accountID;
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

function safeNotify(notify: ((message: string, tone?: ComposeNoticeTone) => void) | undefined, message: string, tone?: ComposeNoticeTone) {
  try {
    if (notify) notify(message, tone);
    else toast(message, tone);
  } catch {
    // Notification failures stay non-blocking so recovery never leaves locks or busy state stuck.
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

function safeClose(onClose: () => void) {
  try {
    onClose();
  } catch {
    // Close callback failures stay non-blocking so finally always cleans up busy/restore state.
  }
}

function hasControlledManager(deps?: ComposeDialogDeps): boolean {
  return Boolean(deps && (deps.manager !== undefined || deps.subscribeManager !== undefined || Object.prototype.hasOwnProperty.call(deps, "manager")));
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

function useTrackedOwner(
  readManager: () => string | undefined,
  readDefaultManager: () => string,
  isGetter: boolean,
  subscribe: ((listener: () => void) => () => void) | undefined,
) {
  const read = useCallback(() => {
    const manager = readManager();
    const owner = manager || readDefaultManager();
    return { manager, owner };
  }, [readManager, readDefaultManager]);
  const readRef = useRef(read);
  const committedRef = useRef<{ value: { manager: string | undefined; owner: string }; version: number } | null>(null);
  const snapRef = useRef<{ value: { manager: string | undefined; owner: string }; version: number } | null>(null);
  const sub = useCallback((listener: () => void) => {
    if (!subscribe || !isGetter) return noopSubscribe();
    return subscribe(() => {
      const next = readRef.current();
      const cur = committedRef.current;
      if (!cur || next.owner !== cur.value.owner) {
        committedRef.current = { value: next, version: (cur?.version ?? 0) + 1 };
      } else if (!sameValue(next, cur.value)) {
        // Explicit default stamp keeps the same owner without bumping the epoch version.
        committedRef.current = { value: next, version: cur.version };
      }
      listener();
    });
  }, [subscribe, isGetter]);
  const getSnapshot = useCallback(() => {
    const next = read();
    const cur = committedRef.current;
    if (cur && sameValue(next, cur.value)) return cur;
    const nextVersion = cur ? (next.owner === cur.value.owner ? cur.version : cur.version + 1) : 0;
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
  const readOwnerToken = useCallback(() => {
    const cur = readRef.current();
    const committed = committedRef.current;
    return committed && committed.value.owner === cur.owner ? `${committed.version}:${cur.owner}` : `drift:${cur.owner}`;
  }, []);
  const readLiveManager = useCallback(() => readRef.current().manager, []);
  return {
    manager: snap.value.manager,
    owner: snap.value.owner,
    token: `${snap.version}:${snap.value.owner}`,
    readToken: readOwnerToken,
    readManager: readLiveManager,
  };
}

const fieldClass = "h-8 min-w-0 flex-1 rounded-control bg-field px-2.5 text-[12.5px] text-ink shadow-inset-field outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--accent)]";

/** Pure presentational dialog view for composing or replying to an email. */
export function ComposeDialogView({
  open = true,
  title,
  draft,
  accounts,
  sending,
  canSend,
  error,
  toRef,
  bodyRef,
  onChange,
  onSend,
  onCancel,
  onDismiss,
}: ComposeDialogViewProps) {
  return (
    <Dialog
      open={open}
      onClose={onDismiss}
      title={title}
      width={620}
      footer={
        <>
          <Button tone="quiet" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button tone="accent" icon="send" busy={sending} disabled={!canSend} onClick={onSend}>{t("inbox-composedialog.send")}</Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
        onKeyDown={(e) => {
          // ⌘↩ / Ctrl+↩ sends, as in a mail app.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !composing(e.nativeEvent)) {
            e.preventDefault();
            onSend();
          }
        }}
      >
        <Field label={t("inbox-composedialog.from")}>
          <select value={draft.accountID} onChange={(e) => onChange({ accountID: e.target.value })} className={fieldClass} aria-label={t("inbox-composedialog.from")}>
            {!accounts.some((a) => a.id === draft.accountID) && <option value={draft.accountID}>{draft.accountID || t("inbox-composedialog.no_account")}</option>}
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name && a.name !== a.email ? `${a.name} · ${a.email}` : a.email}</option>)}
          </select>
        </Field>
        <Field label={t("inbox-composedialog.to")}>
          <input ref={toRef} value={draft.to} onChange={(e) => onChange({ to: e.target.value })} placeholder={t("inbox-composedialog.to_placeholder")} aria-label={t("inbox-composedialog.to")} type="text" inputMode="email" autoComplete="off" spellCheck={false} className={fieldClass} />
        </Field>
        <Field label={t("inbox-composedialog.cc")}>
          <input value={draft.cc} onChange={(e) => onChange({ cc: e.target.value })} aria-label={t("inbox-composedialog.cc")} type="text" inputMode="email" autoComplete="off" spellCheck={false} className={fieldClass} />
        </Field>
        <Field label={t("inbox-composedialog.bcc")}>
          <input value={draft.bcc} onChange={(e) => onChange({ bcc: e.target.value })} aria-label={t("inbox-composedialog.bcc")} type="text" inputMode="email" autoComplete="off" spellCheck={false} className={fieldClass} />
        </Field>
        <Field label={t("inbox-composedialog.subject")}>
          <input value={draft.subject} onChange={(e) => onChange({ subject: e.target.value })} aria-label={t("inbox-composedialog.subject")} className={fieldClass} />
        </Field>
        <textarea
          ref={bodyRef}
          value={draft.body}
          onChange={(e) => onChange({ body: e.target.value })}
          rows={12}
          aria-label={t("inbox-composedialog.body")}
          placeholder={t("inbox-composedialog.body")}
          className="mt-1 block w-full resize-y rounded-control bg-field px-3 py-2.5 text-[13.5px] leading-relaxed text-ink shadow-inset-field outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--accent)]"
        />
        {error && <p role="alert" className="text-[12px] text-red">{error}</p>}
      </form>
    </Dialog>
  );
}

export function ComposeDialog(props: ComposeDialogProps) {
  if (hasControlledManager(props.deps)) {
    return <OwnedComposeDialog {...props} fallbackManager={undefined} />;
  }
  return <DefaultManagerComposeDialog {...props} />;
}

function DefaultManagerComposeDialog(props: ComposeDialogProps) {
  // Both retained drafts and live form state belong to the owner, including an explicitly stamped default manager.
  // Keep the item context unchanged for sends; resolve the default only for draft identity.
  const manager = useItemManager();
  return <OwnedComposeDialog {...props} fallbackManager={manager} />;
}

interface PendingSend {
  epoch: number;
  seq: number;
  controller: AbortController;
  isDefaultSend: boolean;
}

interface LiveDraftRecord {
  d: ComposeDraft;
  dirty: boolean;
  done: boolean;
  mounted: boolean;
  storeKey: string;
  store: ComposeDraftStore;
  restores: Map<string, object>;
}

function OwnedComposeDialog({
  draftKey,
  initial,
  accounts,
  onClose,
  deps,
  fallbackManager,
}: ComposeDialogProps & { fallbackManager: string | undefined }) {
  const controlledManager = hasControlledManager(deps);
  const managerDep = deps?.manager;
  const defaultManagerDep = deps?.defaultManager;
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);

  const readManager = useCallback(
    () => (controlledManager ? (typeof managerDep === "function" ? managerDep() : managerDep) : fallbackManager),
    [controlledManager, managerDep, fallbackManager],
  );
  const readDefaultManager = useCallback(
    () => (defaultManagerDep !== undefined ? (typeof defaultManagerDep === "function" ? defaultManagerDep() : defaultManagerDep) : defaultManager()),
    [defaultManagerDep],
  );
  const trackedOwner = useTrackedOwner(
    readManager,
    readDefaultManager,
    controlledManager && typeof managerDep === "function",
    controlledManager ? deps?.subscribeManager : undefined,
  );

  const { store, restores } = resolveDraftStore(deps?.draftStore);
  const storeKey = trackedScope.value
    ? JSON.stringify([trackedScope.value, trackedOwner.owner, draftKey])
    : JSON.stringify([trackedOwner.owner, draftKey]);
  const composeScope = JSON.stringify([trackedScope.token, trackedOwner.token, draftKey]);

  const [scope, setScope] = useState<{ key: string; epoch: number }>(() => ({ key: composeScope, epoch: 1 }));
  const effectiveEpoch = scope.key === composeScope ? scope.epoch : scope.epoch + 1;
  if (scope.key !== composeScope) {
    setScope({ key: composeScope, epoch: effectiveEpoch });
  }

  const [draftState, setDraftState] = useState<{ epoch: number; draft: ComposeDraft }>(() => ({
    epoch: 1,
    draft: keptDraft(store, storeKey, initial),
  }));
  const [sendingState, setSendingState] = useState<{ epoch: number; sending: boolean }>({ epoch: 0, sending: false });
  const [errorState, setErrorState] = useState<{ epoch: number; message: string }>({ epoch: 0, message: "" });

  const d = draftState.epoch === effectiveEpoch ? draftState.draft : keptDraft(store, storeKey, initial);
  const sending = sendingState.epoch === effectiveEpoch && sendingState.sending;
  const error = errorState.epoch === effectiveEpoch ? errorState.message : "";

  const body = useRef<HTMLTextAreaElement>(null);
  const to = useRef<HTMLInputElement>(null);
  const recipients = [d.to, d.cc, d.bcc];
  const hasRecipients = recipients.some((field) => parseAddresses(field).length > 0);
  const dirty = isDirty(d, initial);

  const activeEpochRef = useRef(0);
  const sendLockRef = useRef(false);
  const sendSeqRef = useRef(0);
  const pendingSendRef = useRef<PendingSend | null>(null);
  const nowRef = useRef<LiveDraftRecord | null>(null);
  const depsRef = useRef(deps);
  const onCloseRef = useRef(onClose);
  const initialRef = useRef(initial);
  const storeRef = useRef(store);
  const restoresRef = useRef(restores);
  const readScopeTokenRef = useRef(trackedScope.readToken);
  const readOwnerTokenRef = useRef(trackedOwner.readToken);
  const readManagerRef = useRef(trackedOwner.readManager);

  // Render-pure commit-phase ref updates: abandoned concurrent renders never mutate live refs or abort sends.
  useLayoutEffect(() => {
    depsRef.current = deps;
    onCloseRef.current = onClose;
    initialRef.current = initial;
    storeRef.current = store;
    restoresRef.current = restores;
    readScopeTokenRef.current = trackedScope.readToken;
    readOwnerTokenRef.current = trackedOwner.readToken;
    readManagerRef.current = trackedOwner.readManager;
    if (nowRef.current && activeEpochRef.current === effectiveEpoch) {
      nowRef.current.d = d;
      nowRef.current.dirty = dirty;
      nowRef.current.storeKey = storeKey;
      nowRef.current.store = store;
      nowRef.current.restores = restores;
    }
  });

  // Taken down without being closed (the item, owner, scope, or page left under it): kept as a close keeps it.
  // "Cancel", a close and a send mark it done (a send that fails puts it back only if no newer opening took ownership).
  useLayoutEffect(() => {
    activeEpochRef.current = effectiveEpoch;
    sendLockRef.current = false;
    const record: LiveDraftRecord = {
      d: keptDraft(storeRef.current, storeKey, initialRef.current),
      dirty: isDirty(keptDraft(storeRef.current, storeKey, initialRef.current), initialRef.current),
      done: false,
      mounted: true,
      storeKey,
      store: storeRef.current,
      restores: restoresRef.current,
    };
    nowRef.current = record;
    record.restores.delete(storeKey);
    setDraftState((prev) => (prev.epoch === effectiveEpoch ? prev : { epoch: effectiveEpoch, draft: record.d }));
    return () => {
      if (activeEpochRef.current === effectiveEpoch) activeEpochRef.current = 0;
      record.mounted = false;
      pendingSendRef.current?.controller.abort();
      pendingSendRef.current = null;
      sendLockRef.current = false;
      sendSeqRef.current += 1;
      if (record.done) return;
      if (record.dirty) record.store.set(record.storeKey, record.d);
      else record.store.delete(record.storeKey);
    };
  }, [effectiveEpoch, storeKey]);

  // A reply starts in its body, above the quote; a new mail at its recipients.
  useEffect(() => {
    if (initialRef.current.to && body.current) {
      body.current.focus();
      body.current.setSelectionRange(0, 0);
    } else to.current?.focus();
  }, [effectiveEpoch]);

  const capturedEpoch = effectiveEpoch;
  const capturedScopeToken = trackedScope.token;
  const capturedOwnerToken = trackedOwner.token;

  const isScopeLive = () =>
    activeEpochRef.current === capturedEpoch
    && readScopeTokenRef.current() === capturedScopeToken
    && readOwnerTokenRef.current() === capturedOwnerToken;

  const set = (patch: Partial<ComposeDraft>) => {
    if (!isScopeLive()) return;
    setDraftState((prev) => {
      const base = prev.epoch === capturedEpoch ? prev.draft : d;
      return { epoch: capturedEpoch, draft: { ...base, ...patch } };
    });
    setErrorState({ epoch: capturedEpoch, message: "" });
  };

  const keepOrDrop = () => {
    if (!isScopeLive()) return;
    const at = nowRef.current;
    if (at && pendingSendRef.current === null) {
      at.done = true;
      if (at.dirty) at.store.set(at.storeKey, at.d);
      else at.store.delete(at.storeKey);
    }
    safeClose(onCloseRef.current);
  };

  const cancel = () => {
    if (!isScopeLive()) return;
    const at = nowRef.current;
    const pending = pendingSendRef.current;
    const defaultInFlight = Boolean(pending?.isDefaultSend);
    pending?.controller.abort();
    pendingSendRef.current = null;
    sendSeqRef.current += 1;
    if (at) {
      at.done = true;
      // Preserve pending restore ownership when a non-abortable default send is still in flight so a later
      // failure still restores the unsent draft (matching base ComposeDialog) unless a newer dialog opens.
      if (!defaultInFlight) at.restores.delete(at.storeKey);
      at.store.delete(at.storeKey);
    }
    safeClose(onCloseRef.current);
  };

  const send = () => {
    if (!isScopeLive() || sendLockRef.current) return;
    const at = nowRef.current;
    if (!at) return;
    const sentDraft = d;
    const sentRecipients = [sentDraft.to, sentDraft.cc, sentDraft.bcc];
    const sentHasRecipients = sentRecipients.some((field) => parseAddresses(field).length > 0);
    const bad = sentRecipients.flatMap(badAddresses);
    if (!sentHasRecipients) {
      setErrorState({ epoch: capturedEpoch, message: t("inbox-composedialog.need_recipient") });
      return;
    }
    if (bad.length) {
      setErrorState({
        epoch: capturedEpoch,
        message: t("inbox-composedialog.bad_addresses", { addresses: bad.join(t("inbox-composedialog.list_sep")) }),
      });
      return;
    }
    // All entry points share this lock before the busy button rerenders; only failure allows a retry.
    sendLockRef.current = true;
    const controller = new AbortController();
    const runSeq = ++sendSeqRef.current;
    const attempt = {};
    const runStore = at.store;
    const runRestores = at.restores;
    const runStoreKey = at.storeKey;
    const currentManager = readManagerRef.current();

    const isRunCurrent = () =>
      !controller.signal.aborted
      && isScopeLive()
      && at.mounted
      && (pendingSendRef.current === null || pendingSendRef.current.seq === runSeq);

    // On its way: not kept (a box opened for this key meanwhile starts fresh, nothing to send twice).
    runRestores.set(runStoreKey, attempt);
    at.done = true;
    runStore.delete(runStoreKey);
    setErrorState({ epoch: capturedEpoch, message: "" });

    const customSendMail = depsRef.current?.sendMail;
    const isDefaultSend = !customSendMail;
    const notifyOnSend = depsRef.current?.notify;

    const finishSuccess = () => {
      if (runRestores.get(runStoreKey) === attempt) runRestores.delete(runStoreKey);
      if (!isRunCurrent()) {
        // Default sendMail ignores AbortSignal, so the mail still goes out if the dialog closes mid-send
        // (via Cancel, Esc, or unmount); preserve the base "Sent" confirmation toast without touching state.
        if (isDefaultSend) safeNotify(notifyOnSend, t("inbox-composedialog.sent"), "ok");
        return;
      }
      safeNotify(depsRef.current?.notify, t("inbox-composedialog.sent"), "ok");
      safeClose(onCloseRef.current);
    };

    const finishFailure = (err: unknown) => {
      // Still open in the active scope: keep in the dialog to retry; gone: restore only if no newer opening took ownership.
      if (isRunCurrent()) {
        sendLockRef.current = false;
        at.done = false;
        const msg = safeFormatError(depsRef.current?.formatError, err);
        const display = t("inbox-composedialog.send_failed", { error: msg });
        setErrorState({ epoch: capturedEpoch, message: display });
        safeReportError(depsRef.current?.onError, display);
      } else if ((!at.mounted || isDefaultSend) && runRestores.get(runStoreKey) === attempt) {
        runStore.set(runStoreKey, sentDraft);
      }
    };

    let res: void | Promise<unknown>;
    try {
      res = customSendMail
        ? customSendMail(sentDraft, currentManager, controller.signal)
        : sendMail(sentDraft, currentManager);
    } catch (err) {
      try {
        finishFailure(err);
      } finally {
        if (runRestores.get(runStoreKey) === attempt) runRestores.delete(runStoreKey);
      }
      return;
    }

    if (!isThenable(res)) {
      try {
        finishSuccess();
      } finally {
        if (runRestores.get(runStoreKey) === attempt) runRestores.delete(runStoreKey);
      }
      return;
    }

    pendingSendRef.current = { epoch: capturedEpoch, seq: runSeq, controller, isDefaultSend };
    setSendingState({ epoch: capturedEpoch, sending: true });
    void (async () => {
      try {
        await res;
        finishSuccess();
      } catch (err) {
        finishFailure(err);
      } finally {
        if (pendingSendRef.current?.seq === runSeq) pendingSendRef.current = null;
        if (runRestores.get(runStoreKey) === attempt) runRestores.delete(runStoreKey);
        if (activeEpochRef.current === capturedEpoch) {
          setSendingState({ epoch: capturedEpoch, sending: false });
        }
      }
    })();
  };

  const title = initial.inReplyTo || /^re:/i.test(initial.subject)
    ? t("inbox-composedialog.title_reply")
    : t("inbox-composedialog.title_new");
  const viewProps: ComposeDialogViewProps = {
    open: true,
    title,
    draft: d,
    accounts,
    sending,
    canSend: hasRecipients && Boolean(d.accountID),
    error,
    toRef: to,
    bodyRef: body,
    onChange: set,
    onSend: send,
    onCancel: cancel,
    onDismiss: keepOrDrop,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <ComposeDialogView {...viewProps} />;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-12 shrink-0 text-[12px] whitespace-nowrap text-ink-3">{label}</span>
      {children}
    </label>
  );
}
