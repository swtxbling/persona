// A mail on a hub with mail off (#15995): the text the hub kept with the Inbox item, and one line saying why the
// whole message is not here. No mail route is asked: they are gone with the module. The item's own page
// (GET /api/v1/inbox/{id}) and the translation the hub kept (POST /api/v1/translate/mail answers from it) are Core's.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, isAbort } from "../../lib/api";
import { clock } from "../../lib/format";
import { itemPath, itemRequest, type InboxItem } from "../../lib/inbox";
import { addressText, storedMailClipping, type StoredMailClipping } from "../../lib/mail";
import { storedMailText } from "../../lib/mail-stored";
import { sameValue } from "../../lib/stable-lines";
import { hubTranslation, languageName, translateMail, useTranslatePrefs, type MailTranslation, type TranslatePrefs } from "../../lib/translate";
import { t } from "../../i18n";
import { Button, Loading } from "../../ui/atoms";
import { Icon } from "../../ui/icons";

/** What is drawn where the mail would be: nothing yet, or the hub's stored words. */
export type StoredBody = { kind: "loading" } | { kind: "stored"; text: string; clipping: StoredMailClipping };

export interface StoredMailBodyViewProps {
  body: StoredBody;
  from: string;
  dateText: string;
  translation: MailTranslation | null;
  targetLanguage: string;
  showOriginal: boolean;
  onToggleOriginal: () => void;
  onLatest?: () => void;
}

export interface StoredMailBodyDeps {
  /** Optional scope partition (value or getter); switching it resets body/translation state, aborts in-flight fetches, and fences stale responses. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Controlled translation preferences or getter (bypasses `useTranslatePrefs` when supplied). */
  translatePrefs?: TranslatePrefs | (() => TranslatePrefs);
  /** Subscribe to translation preference updates when `translatePrefs` is a getter. */
  subscribeTranslatePrefs?: (listener: () => void) => () => void;
  /** Read the full inbox item with stored mail context (defaults to `api(itemPath(item.id), ...)`). */
  readItem?: (item: InboxItem, signal: AbortSignal) => InboxItem | Promise<InboxItem>;
  /** Read the hub's kept mail translation (defaults to `lib/translate.translateMail`). */
  translateMail?: (
    accountId: string,
    uid: number,
    mailbox: string,
    target: string,
    manager: string | undefined,
    signal: AbortSignal,
  ) => MailTranslation | Promise<MailTranslation>;
  /** Format the mail's timestamp (defaults to `lib/format.clock`). */
  formatClock?: (iso: string) => string;
  /** Error observer invoked when item read or translation fetch throws or rejects (non-abort) in the active scope. */
  onError?: (error: unknown, phase: "item" | "translation") => void;
  /** Optional custom view renderer (defaults to `<StoredMailBodyView>`). */
  renderView?: (props: StoredMailBodyViewProps) => ReactNode;
}

export interface StoredMailBodyProps {
  item: InboxItem;
  onLatest?: () => void;
  deps?: StoredMailBodyDeps;
}

const noopSubscribe = () => () => {};
const useCommitEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

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

function mailPrefsSignature(p: TranslatePrefs | undefined): string {
  return p ? `${p.enabled ? 1 : 0}:${p.mail ? 1 : 0}:${p.target}` : "";
}

function useTrackedPrefsValue(
  source: TranslatePrefs | (() => TranslatePrefs) | undefined,
  subscribe: ((listener: () => void) => () => void) | undefined,
): { value: TranslatePrefs | undefined; mailVersion: number } {
  const isGetter = typeof source === "function";
  const read = useCallback((): TranslatePrefs | undefined => (typeof source === "function" ? source() : source), [source]);
  const readRef = useRef(read);
  const committedRef = useRef<{ has: boolean; value: TranslatePrefs | undefined; sig: string; mailVersion: number }>({
    has: false,
    value: undefined,
    sig: "",
    mailVersion: 0,
  });
  const snapRef = useRef<{ has: boolean; value: TranslatePrefs | undefined; sig: string; mailVersion: number }>({
    has: false,
    value: undefined,
    sig: "",
    mailVersion: 0,
  });
  const sub = useCallback((listener: () => void) => {
    if (!subscribe || !isGetter) return noopSubscribe();
    return subscribe(() => {
      const next = readRef.current();
      const cur = committedRef.current;
      const nextSig = mailPrefsSignature(next);
      const sigChanged = cur.has && cur.sig !== nextSig;
      if (!cur.has || sigChanged || !sameValue(cur.value, next)) {
        committedRef.current = {
          has: true,
          value: next,
          sig: nextSig,
          mailVersion: sigChanged ? cur.mailVersion + 1 : cur.mailVersion,
        };
      }
      listener();
    });
  }, [subscribe, isGetter]);
  const getSnapshot = useCallback(() => {
    const next = read();
    const cur = committedRef.current;
    const nextSig = mailPrefsSignature(next);
    if (cur.has && cur.sig === nextSig && sameValue(cur.value, next)) return cur;
    const nextVersion = cur.has && cur.sig !== nextSig ? cur.mailVersion + 1 : cur.mailVersion;
    if (snapRef.current.has && snapRef.current.sig === nextSig && snapRef.current.mailVersion === nextVersion && sameValue(snapRef.current.value, next)) {
      return snapRef.current;
    }
    snapRef.current = { has: true, value: next, sig: nextSig, mailVersion: nextVersion };
    return snapRef.current;
  }, [read]);
  const snap = useSyncExternalStore(sub, getSnapshot, getSnapshot);
  useCommitEffect(() => {
    readRef.current = read;
    committedRef.current = snap;
  }, [read, snap]);
  return { value: snap.value, mailVersion: snap.mailVersion };
}

/** The line after the text: why the rest is not here, and what the hub said about the text being cut short. */
function notice(clipping: StoredMailClipping): string {
  switch (clipping) {
    case "clipped": return t("inbox-inboxbodies.mail_off_stored_clipped");
    case "whole": return t("inbox-inboxbodies.mail_off_stored_whole");
    case "unknown": return t("inbox-inboxbodies.mail_off_stored");
  }
}

/** Pure presentational view for a mail item's stored text when the mail module is off. */
export function StoredMailBodyView({
  body,
  from,
  dateText,
  translation,
  targetLanguage,
  showOriginal,
  onToggleOriginal,
  onLatest,
}: StoredMailBodyViewProps) {
  if (body.kind === "loading") return <div className="p-5"><Loading label={t("inbox-inboxbodies.reading_mail")} /></div>;
  const shown = showOriginal ? null : translation;
  return (
    <div className="mx-auto max-w-[760px] px-4 py-4 sm:px-6" data-mail-body="stored">
      {onLatest && (
        <div className="mb-3 flex justify-center">
          <Button tone="quiet" icon="chevronDown" onClick={onLatest}>{t("inbox-inboxbodies.latest")}</Button>
        </div>
      )}
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label">
        {from && (<><dt className="text-ink-3">{t("inbox-inboxbodies.from")}</dt><dd className="min-w-0 truncate text-ink">{from}</dd></>)}
        {dateText && (<><dt className="text-ink-3">{t("inbox-inboxbodies.date")}</dt><dd className="text-ink-2">{dateText}</dd></>)}
      </dl>
      {translation && (
        <div className="mt-3 flex min-h-8 items-center gap-2 rounded-control bg-inset px-3 py-1.5 text-label text-ink-3 shadow-hairline">
          <Icon name="translate" size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{showOriginal ? t("inbox-inboxbodies.original") : t("inbox-inboxbodies.translated_to", { language: languageName(targetLanguage) })}</span>
          <button type="button" onClick={onToggleOriginal} className="shrink-0 rounded-chip px-1.5 py-0.5 font-medium whitespace-nowrap text-accent-ink hover:bg-hover">
            {showOriginal ? t("inbox-inboxbodies.show_translation") : t("inbox-inboxbodies.show_original")}
          </button>
        </div>
      )}
      <div className="mt-4 text-meta leading-relaxed break-words whitespace-pre-wrap text-ink select-text" data-mail-stored-text>
        {(shown ? shown.text : body.text) || t("inbox-inboxbodies.no_body")}
      </div>
      <p className="mt-4 flex items-start gap-2 rounded-control bg-inset px-3 py-2 text-label leading-relaxed text-ink-2 shadow-hairline" role="note" data-mail-off-notice data-mail-stored-clipping={body.clipping}>
        <Icon name="info" size={13} className="mt-0.5 shrink-0 text-ink-3" />
        <span className="min-w-0">{notice(body.clipping)}</span>
      </p>
    </div>
  );
}

function DefaultTranslatePrefsBridge({ render }: { render: (prefs: TranslatePrefs) => ReactNode }) {
  const prefs = useTranslatePrefs();
  return <>{render(prefs)}</>;
}

interface StoredMailBodyContentProps {
  item: InboxItem;
  onLatest?: () => void;
  prefs: TranslatePrefs;
  prefsMailVersion: number;
  outerScopeToken: string;
  readOuterScopeToken: () => string;
  deps?: StoredMailBodyDeps;
}

function StoredMailBodyContent({
  item,
  onLatest,
  prefs,
  prefsMailVersion,
  outerScopeToken,
  readOuterScopeToken,
  deps,
}: StoredMailBodyContentProps) {
  const m = item.mail!;
  const uid = m.uids[m.uids.length - 1];
  const mailbox = m.mailbox || "INBOX";
  const manager = item.manager;

  const itemFetchKey = JSON.stringify([outerScopeToken, item.id, manager ?? "", item.version ?? ""]);
  const [itemPartition, setItemPartition] = useState<{ key: string; epoch: number }>(() => ({ key: itemFetchKey, epoch: 1 }));
  const itemEpoch = itemPartition.key === itemFetchKey ? itemPartition.epoch : itemPartition.epoch + 1;
  if (itemPartition.key !== itemFetchKey) {
    setItemPartition({ key: itemFetchKey, epoch: itemEpoch });
  }

  // Only a translation the hub already kept (the item lists it): a new one would need the mail server.
  const kept = Boolean(hubTranslation(item, prefs));
  const transFetchKey = JSON.stringify([outerScopeToken, prefsMailVersion, item.id, kept, prefs.target, m.account_id, uid, mailbox, manager ?? ""]);
  const [transPartition, setTransPartition] = useState<{ key: string; epoch: number }>(() => ({ key: transFetchKey, epoch: 1 }));
  const transEpoch = transPartition.key === transFetchKey ? transPartition.epoch : transPartition.epoch + 1;
  if (transPartition.key !== transFetchKey) {
    setTransPartition({ key: transFetchKey, epoch: transEpoch });
  }

  const [bodyState, setBodyState] = useState<{ epoch: number; body: StoredBody }>({ epoch: 0, body: { kind: "loading" } });
  const [translationState, setTranslationState] = useState<{ epoch: number; value: MailTranslation | null }>({ epoch: 0, value: null });
  const [showOriginalState, setShowOriginalState] = useState<{ epoch: number; value: boolean }>({ epoch: 0, value: false });

  const body: StoredBody = bodyState.epoch === itemEpoch ? bodyState.body : { kind: "loading" };
  const translation = translationState.epoch === transEpoch ? translationState.value : null;
  const showOriginal = showOriginalState.epoch === transEpoch ? showOriginalState.value : false;

  const activeItemEpochRef = useRef(0);
  const itemGenRef = useRef(0);
  const itemAbortRef = useRef<AbortController | null>(null);

  const activeTransEpochRef = useRef(0);
  const transGenRef = useRef(0);
  const transAbortRef = useRef<AbortController | null>(null);

  const itemRef = useRef(item);
  const onLatestRef = useRef(onLatest);
  const depsRef = useRef(deps);
  const readScopeTokenRef = useRef(readOuterScopeToken);

  useCommitEffect(() => {
    itemRef.current = item;
    onLatestRef.current = onLatest;
    depsRef.current = deps;
    readScopeTokenRef.current = readOuterScopeToken;
  });

  useCommitEffect(() => {
    activeItemEpochRef.current = itemEpoch;
    return () => {
      if (activeItemEpochRef.current === itemEpoch) activeItemEpochRef.current = 0;
      itemGenRef.current += 1;
      itemAbortRef.current?.abort();
      itemAbortRef.current = null;
    };
  }, [itemEpoch]);

  useCommitEffect(() => {
    activeTransEpochRef.current = transEpoch;
    return () => {
      if (activeTransEpochRef.current === transEpoch) activeTransEpochRef.current = 0;
      transGenRef.current += 1;
      transAbortRef.current?.abort();
      transAbortRef.current = null;
    };
  }, [transEpoch]);

  useEffect(() => {
    const runEpoch = itemEpoch;
    const runScopeToken = outerScopeToken;
    const runItem = itemRef.current;
    const gen = ++itemGenRef.current;
    const abort = new AbortController();
    itemAbortRef.current = abort;

    const isCurrent = () =>
      !abort.signal.aborted
      && activeItemEpochRef.current === runEpoch
      && itemGenRef.current === gen
      && readScopeTokenRef.current() === runScopeToken;

    const reportItemError = (e: unknown) => {
      try {
        depsRef.current?.onError?.(e, "item");
      } catch {
        // Error observer failures stay non-blocking so fallback rendering completes.
      }
    };

    const applyLoaded = (r: InboxItem) => {
      if (!isCurrent()) return;
      setBodyState({
        epoch: runEpoch,
        body: { kind: "stored", text: storedMailText(r.context, r.preview || runItem.preview), clipping: storedMailClipping(r) },
      });
    };

    // the item could not be read again: the list's own words of it are stored text too, and nothing says how much
    const applyFallback = (e: unknown) => {
      if (!isCurrent() || isAbort(e)) return;
      reportItemError(e);
      if (!isCurrent()) return;
      setBodyState({
        epoch: runEpoch,
        body: { kind: "stored", text: storedMailText(runItem.context, runItem.preview), clipping: "unknown" },
      });
    };

    let req: InboxItem | Promise<InboxItem>;
    try {
      req = depsRef.current?.readItem
        ? depsRef.current.readItem(runItem, abort.signal)
        : api<InboxItem>(itemPath(runItem.id), { headers: itemRequest(runItem), signal: abort.signal });
    } catch (e) {
      applyFallback(e);
      return () => {
        abort.abort();
        if (itemAbortRef.current === abort) itemAbortRef.current = null;
      };
    }

    if (!isThenable(req)) {
      applyLoaded(req);
      return () => {
        abort.abort();
        if (itemAbortRef.current === abort) itemAbortRef.current = null;
      };
    }

    void (async () => {
      try {
        const r = await req;
        applyLoaded(r);
      } catch (e) {
        applyFallback(e);
      } finally {
        if (itemAbortRef.current === abort) itemAbortRef.current = null;
      }
    })();

    return () => {
      abort.abort();
      if (itemAbortRef.current === abort) itemAbortRef.current = null;
    };
  }, [itemEpoch, outerScopeToken]);

  useEffect(() => {
    if (!kept) return;
    const runEpoch = transEpoch;
    const runScopeToken = outerScopeToken;
    const gen = ++transGenRef.current;
    const abort = new AbortController();
    transAbortRef.current = abort;

    const isCurrent = () =>
      !abort.signal.aborted
      && activeTransEpochRef.current === runEpoch
      && transGenRef.current === gen
      && readScopeTokenRef.current() === runScopeToken;

    const reportTranslationError = (e: unknown) => {
      if (!isCurrent() || isAbort(e)) return;
      try {
        depsRef.current?.onError?.(e, "translation");
      } catch {
        // Error observer failures stay non-blocking; the stored text stays readable.
      }
    };

    const applyTranslation = (tr: MailTranslation) => {
      if (!isCurrent()) return;
      setTranslationState({ epoch: runEpoch, value: tr });
    };

    let req: MailTranslation | Promise<MailTranslation>;
    try {
      req = depsRef.current?.translateMail
        ? depsRef.current.translateMail(m.account_id, uid, mailbox, prefs.target, manager, abort.signal)
        : translateMail(m.account_id, uid, mailbox, prefs.target, manager);
    } catch (e) {
      reportTranslationError(e);
      return () => {
        abort.abort();
        if (transAbortRef.current === abort) transAbortRef.current = null;
      };
    }

    if (!isThenable(req)) {
      applyTranslation(req);
      return () => {
        abort.abort();
        if (transAbortRef.current === abort) transAbortRef.current = null;
      };
    }

    void (async () => {
      try {
        const tr = await req;
        applyTranslation(tr);
      } catch (e) {
        // it was made by another model since, or is gone: the stored text stays
        reportTranslationError(e);
      } finally {
        if (transAbortRef.current === abort) transAbortRef.current = null;
      }
    })();

    return () => {
      abort.abort();
      if (transAbortRef.current === abort) transAbortRef.current = null;
    };
  }, [transEpoch, outerScopeToken, kept, m.account_id, uid, mailbox, prefs.target, manager]);

  const capturedItemEpoch = itemEpoch;
  const capturedTransEpoch = transEpoch;
  const capturedScopeToken = outerScopeToken;

  const handleToggleOriginal = () => {
    if (activeTransEpochRef.current !== capturedTransEpoch || readScopeTokenRef.current() !== capturedScopeToken) return;
    setShowOriginalState((prev) => ({
      epoch: capturedTransEpoch,
      value: prev.epoch === capturedTransEpoch ? !prev.value : true,
    }));
  };

  const handleLatest = onLatest
    ? () => {
        if (activeItemEpochRef.current !== capturedItemEpoch || readScopeTokenRef.current() !== capturedScopeToken) return;
        onLatestRef.current?.();
      }
    : undefined;

  const from = addressText(m.from) || item.sender || "";
  const formatTime = deps?.formatClock ?? clock;
  const dateText = item.updated_at ? formatTime(item.updated_at) : "";

  const viewProps: StoredMailBodyViewProps = {
    body,
    from,
    dateText,
    translation,
    targetLanguage: prefs.target,
    showOriginal,
    onToggleOriginal: handleToggleOriginal,
    onLatest: handleLatest,
  };
  if (deps?.renderView) return <>{deps.renderView(viewProps)}</>;
  return <StoredMailBodyView {...viewProps} />;
}

/** `onLatest`: an older message from the handling chain was asked for; the hub keeps only the newest mail's text. */
export function StoredMailBody({ item, onLatest, deps }: StoredMailBodyProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const controlledPrefs = useTrackedPrefsValue(deps?.translatePrefs, deps?.subscribeTranslatePrefs);
  const renderContent = (prefs: TranslatePrefs, prefsMailVersion: number) => (
    <StoredMailBodyContent
      item={item}
      onLatest={onLatest}
      prefs={prefs}
      prefsMailVersion={prefsMailVersion}
      outerScopeToken={trackedScope.token}
      readOuterScopeToken={trackedScope.readToken}
      deps={deps}
    />
  );
  if (deps?.translatePrefs === undefined) {
    return <DefaultTranslatePrefsBridge render={(prefs) => renderContent(prefs, 0)} />;
  }
  return renderContent(controlledPrefs.value!, controlledPrefs.mailVersion);
}
