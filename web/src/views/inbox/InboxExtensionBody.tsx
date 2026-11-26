// An inbox item's body drawn by the extension whose connector brought it in (docs/extensions/extensions.md "Inbox items", placement
// inbox_item): its View in place of the item's own body, under the detail's own header (title, "Done", the summary,
// "AI draft reply" / "Hand to AI"), which stays the web's. The hub is told which item (context.item) and looks it up itself;
// the extension draws it again when the item changes. When it cannot draw it — a device that may only read, the item
// gone, the connector not the extension's now (403 / 404) — the item's own body is drawn as if there were no extension; when
// the extension fails, the own body too, with a line saying so and a retry. A press that opens the item's source
// (persona://inbox/<item>/source, "View in chat") shows the own body — the chat at the item's first message — with a way
// back to the extension's page, which stays as it was. That source page has a same-address history entry too, so browser
// Back and the page's back button both return to the extension.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useCloseOnBack } from "../../lib/back-close";
import { ExtensionOwnerScope } from "../../lib/extension-owner";
import { ApiError, errorText } from "../../lib/api";
import type { InboxItem } from "../../lib/inbox";
import type { UIPlace } from "../../lib/extension-ui";
import { t } from "../../i18n";
import { Button, cx } from "../../ui/atoms";
import { Icon } from "../../ui/icons";
import { ExtensionUI } from "../settings/ExtensionView";

/** What became of the extension's draw: "" drawn (or drawing); quiet: the own body, said nothing; else why it failed. */
export type InboxExtensionFallback = "" | { quiet: true } | { error: string };

export interface InboxExtensionRenderProps {
  /** Monotonic partition + retry key so retries and target/scope switches remount cleanly. */
  retryKey: string;
  /** Retry counter within the active scope/item/place partition (starts at 0). */
  retryCount: number;
  extension: string;
  ui: string;
  context: { item: string };
  manager?: string;
  bare: true;
  title: string;
  revision?: string;
  onWide: (wide: boolean) => void;
  onUnsupported: () => void;
  onMissing: () => void;
  onFailed: (error: unknown) => void;
  onOpenSource: () => void;
}

export interface InboxExtensionBodyViewProps {
  place: UIPlace;
  fallback: InboxExtensionFallback;
  source: boolean;
  wide: boolean;
  own: () => ReactNode;
  extensionContent?: ReactNode;
  onRetry: () => void;
  onCloseSource: () => void;
}

export interface InboxExtensionBodyDeps {
  /** Optional scope partition (value or getter); switching it resets fallback/source/wide/retry state and fences stale callbacks. */
  scopeKey?: string | (() => string);
  /** Subscribe to scope changes when `scopeKey` is a getter. */
  subscribeScopeKey?: (listener: () => void) => () => void;
  /** Custom back-close hook (replaces `lib/back-close.useCloseOnBack` when supplied). */
  useCloseOnBack?: (open: boolean, onClose: () => void) => void;
  /** Imperative back-overlay registration returning an unsubscribe cleanup (replaces `lib/back-close.useCloseOnBack` when supplied). */
  onBackCloseRegister?: (onClose: () => void) => (() => void) | void;
  /** Custom extension renderer (bypasses `ExtensionUI` when supplied). */
  renderExtension?: (props: InboxExtensionRenderProps) => ReactNode;
  /** Format failed extension draw errors (bypasses `lib/api.errorText` when supplied). */
  formatError?: (error: unknown) => string;
  /** Optional custom outer view renderer (defaults to `<InboxExtensionBodyView>`). */
  renderView?: (props: InboxExtensionBodyViewProps) => ReactNode;
}

export interface InboxExtensionBodyProps {
  item: InboxItem;
  place: UIPlace;
  own: () => ReactNode;
  onOwn?: (shown: boolean) => void;
  deps?: InboxExtensionBodyDeps;
}

const noopSubscribe = () => () => {};
const useCommitEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

function safeFormatError(fmt: ((error: unknown) => string) | undefined, error: unknown): string {
  if (!fmt) return errorText(error);
  try {
    return fmt(error);
  } catch {
    return "";
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

/** How a failed first draw falls back: refused or nothing to draw (403 / 404) quietly, anything else (the extension failed) with why. */
export function fallbackOf(e: unknown, formatError?: (error: unknown) => string): Exclude<InboxExtensionFallback, ""> {
  if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return { quiet: true };
  return { error: safeFormatError(formatError, e) || t("inbox-inboxextensionbody.error") };
}

function DefaultBackCloseBridge({ open, onClose, step }: { open: boolean; onClose: () => void; step: number }) {
  useCloseOnBack(open, onClose, open, step);
  return null;
}

function CustomBackCloseBridge({
  hook,
  open,
  onClose,
}: {
  hook: (open: boolean, onClose: () => void) => void;
  open: boolean;
  onClose: () => void;
}) {
  hook(open, onClose);
  return null;
}

/** Pure presentational view for an extension-rendered inbox item body and its fallback / source states. */
export function InboxExtensionBodyView({
  place,
  fallback,
  source,
  wide,
  own,
  extensionContent,
  onRetry,
  onCloseSource,
}: InboxExtensionBodyViewProps) {
  if (fallback && "quiet" in fallback) return <>{own()}</>;
  if (fallback) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-line bg-inset px-4 py-1.5 sm:px-6">
          <Icon name="extension" size={12} className="shrink-0 text-ink-3" />
          <p className="min-w-0 flex-1 truncate text-[12px] text-ink-3" title={fallback.error}>
            {t("inbox-inboxextensionbody.draw_failed", { name: place.extension_name || place.title, error: fallback.error })}
          </p>
          <Button tone="quiet" icon="retry" onClick={onRetry}>
            {t("inbox-inboxextensionbody.retry")}
          </Button>
        </div>
        {own()}
      </div>
    );
  }
  return (
    <>
      {source && (
        <div className="flex min-h-0 flex-1 flex-col" data-inbox-source>
          <div className="flex shrink-0 items-center border-b border-line bg-inset px-2 py-1 sm:px-4">
            <Button tone="quiet" icon="chevronLeft" onClick={onCloseSource}>
              {t("inbox-inboxextensionbody.back_to", { title: place.title })}
            </Button>
          </div>
          {own()}
        </div>
      )}
      <ExtensionPage hidden={source} place={place} wide={wide}>
        {/* the extension's own id scopes what a graph's `key` keeps (lib/extension-owner.tsx), so this page's
            graphs never share their pan, zoom and folds with another surface's */}
        <ExtensionOwnerScope owner={place.extension}>
          {extensionContent}
        </ExtensionOwnerScope>
      </ExtensionPage>
    </>
  );
}

/** `onOwn`: whether the item's own body is drawn now (the header's Pin button works on the chat it draws). */
export function InboxExtensionBody({ item, place, own, onOwn, deps }: InboxExtensionBodyProps) {
  const trackedScope = useTrackedScope(deps?.scopeKey, deps?.subscribeScopeKey);
  const targetKey = JSON.stringify([trackedScope.token, item.id, place.extension, place.id]);

  const [targetPartition, setTargetPartition] = useState<{ key: string; epoch: number }>(() => ({ key: targetKey, epoch: 1 }));
  const effectiveEpoch = targetPartition.key === targetKey ? targetPartition.epoch : targetPartition.epoch + 1;
  if (targetPartition.key !== targetKey) {
    setTargetPartition({ key: targetKey, epoch: effectiveEpoch });
  }

  const [fallbackState, setFallbackState] = useState<{ epoch: number; value: InboxExtensionFallback }>({ epoch: 0, value: "" });
  const [sourceState, setSourceState] = useState<{ epoch: number; value: boolean }>({ epoch: 0, value: false });
  const [retryState, setRetryState] = useState<{ epoch: number; value: number }>({ epoch: 0, value: 0 });
  const [wideState, setWideState] = useState<{ epoch: number; value: boolean }>({ epoch: 0, value: false });

  const fallback: InboxExtensionFallback = fallbackState.epoch === effectiveEpoch ? fallbackState.value : "";
  const source = sourceState.epoch === effectiveEpoch ? sourceState.value : false;
  const n = retryState.epoch === effectiveEpoch ? retryState.value : 0;
  const wide = wideState.epoch === effectiveEpoch ? wideState.value : false;

  const activeEpochRef = useRef(0);
  const depsRef = useRef(deps);
  const readScopeTokenRef = useRef(trackedScope.readToken);

  useCommitEffect(() => {
    depsRef.current = deps;
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

  const isLive = useCallback(
    () => activeEpochRef.current === capturedEpoch && readScopeTokenRef.current() === capturedScopeToken,
    [capturedEpoch, capturedScopeToken],
  );

  const handleWide = useCallback((next: boolean) => {
    if (!isLive()) return;
    setWideState({ epoch: capturedEpoch, value: next });
  }, [capturedEpoch, isLive]);

  const handleQuietFallback = useCallback(() => {
    if (!isLive()) return;
    setFallbackState({ epoch: capturedEpoch, value: { quiet: true } });
  }, [capturedEpoch, isLive]);

  const handleFailed = useCallback((e: unknown) => {
    if (!isLive()) return;
    setFallbackState({ epoch: capturedEpoch, value: fallbackOf(e, depsRef.current?.formatError) });
  }, [capturedEpoch, isLive]);

  const handleOpenSource = useCallback(() => {
    if (!isLive()) return;
    setSourceState({ epoch: capturedEpoch, value: true });
  }, [capturedEpoch, isLive]);

  const handleCloseSource = useCallback(() => {
    if (!isLive()) return;
    setSourceState({ epoch: capturedEpoch, value: false });
  }, [capturedEpoch, isLive]);

  const handleRetry = useCallback(() => {
    if (!isLive()) return;
    setFallbackState({ epoch: capturedEpoch, value: "" });
    setRetryState((prev) => ({ epoch: capturedEpoch, value: prev.epoch === capturedEpoch ? prev.value + 1 : 1 }));
  }, [capturedEpoch, isLive]);

  const handleCloseSourceRef = useRef(handleCloseSource);
  useCommitEffect(() => {
    handleCloseSourceRef.current = handleCloseSource;
  });

  const customBackHook = deps?.useCloseOnBack;
  const customBackRegister = customBackHook ? undefined : deps?.onBackCloseRegister;

  useEffect(() => {
    if (!source || !customBackRegister) return;
    const runEpoch = capturedEpoch;
    const runScopeToken = capturedScopeToken;
    let active = true;
    const cleanup = customBackRegister(() => {
      if (!active || activeEpochRef.current !== runEpoch || readScopeTokenRef.current() !== runScopeToken) return;
      handleCloseSourceRef.current();
    });
    return () => {
      active = false;
      cleanup?.();
    };
  }, [source, customBackRegister, capturedEpoch, capturedScopeToken]);

  const context = useMemo(() => ({ item: item.id }), [item.id]);
  const ownShown = !!fallback || source;
  useEffect(() => onOwn?.(ownShown), [ownShown, onOwn]);

  const retryKey = `${effectiveEpoch}:${n}`;
  let extensionContent: ReactNode;
  if (!fallback) {
    const extProps: InboxExtensionRenderProps = {
      retryKey,
      retryCount: n,
      extension: place.extension,
      ui: place.id,
      context,
      manager: item.manager,
      bare: true,
      title: place.title,
      revision: item.version,
      onWide: handleWide,
      onUnsupported: handleQuietFallback,
      onMissing: handleQuietFallback,
      onFailed: handleFailed,
      onOpenSource: handleOpenSource,
    };
    extensionContent = deps?.renderExtension ? (
      deps.renderExtension(extProps)
    ) : (
      <ExtensionUI
        key={retryKey}
        extension={place.extension}
        ui={place.id}
        context={context}
        manager={item.manager}
        bare
        title={place.title}
        revision={item.version}
        onWide={handleWide}
        onUnsupported={handleQuietFallback}
        onMissing={handleQuietFallback}
        onFailed={handleFailed}
        onOpenSource={handleOpenSource}
      />
    );
  }

  const backCloseBridge = customBackHook ? (
    <CustomBackCloseBridge hook={customBackHook} open={source} onClose={handleCloseSource} />
  ) : customBackRegister ? null : (
    <DefaultBackCloseBridge open={source} onClose={handleCloseSource} step={effectiveEpoch} />
  );

  const viewProps: InboxExtensionBodyViewProps = {
    place,
    fallback,
    source,
    wide,
    own,
    extensionContent,
    onRetry: handleRetry,
    onCloseSource: handleCloseSource,
  };
  const body = deps?.renderView ? <>{deps.renderView(viewProps)}</> : <InboxExtensionBodyView {...viewProps} />;
  return (
    <>
      {backCloseBridge}
      {body}
    </>
  );
}

/** The extension's page in its own scroller; kept (hidden) while the item's source is open, to come back to as it was. */
function ExtensionPage({ hidden, place, wide, children }: { hidden: boolean; place: UIPlace; wide: boolean; children: ReactNode }) {
  return (
    <div className={cx("min-h-0 flex-1 overflow-y-auto", hidden && "hidden")} data-extension-inbox={`${place.extension}/${place.id}`}>
      <div data-extension-inbox-container className={cx("mx-auto px-4 py-5 sm:px-6", wide ? "max-w-[1680px]" : "max-w-[760px]")}>{children}</div>
    </div>
  );
}
