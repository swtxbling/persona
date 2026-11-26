// On-demand lazy wrappers for heavy click- and command-triggered sidebar/overview dialogs and context menus:
// MarkSeenDialog, AgentRowMenu, SpaceMenu, NodeMenu, and NodePrompt. None of them load on the first screen or at idle.
// Each wrapper isolates chunk failures via OverlayBoundary, resets open state cleanly for retry, cancels pending loads
// on Escape/outside-pointer dismissal, and fences stale callbacks against close-before-resolve and target-switch races.
import { memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { lazyPage } from "../lib/lazy-page";
import { answerAsk, getAsk, subscribeAsk } from "../lib/node-ask";
import type { Session } from "../lib/types";
import type { AgentRowMenuProps, MarkSeenDialogProps } from "./AgentMenus";
import type { NodeMenuProps } from "./NodeMenu";
import type { SpaceMenuProps } from "./SpaceMenu";
import { OverlayBoundary } from "./LazyOverlay";
import { preloadSessionDialogs } from "./chat/SessionDialogs";

const sessionListKey = (list: readonly Session[] | null | undefined) =>
  list ? list.map((s) => `${s.machine_id}/${s.session_id}`).join(",") : "";

/** Factory for LazyMarkSeenDialog so unit tests can inject deterministic deferred/failing chunk loaders. */
export function createLazyMarkSeenDialog(load: () => Promise<ComponentType<MarkSeenDialogProps>>, listed = false) {
  const LoadedDialog = lazyPage(load, { listed });

  return memo(function LazyMarkSeenDialog(props: MarkSeenDialogProps) {
    const open = Boolean(props.list);
    const targetKey = open ? `${sessionListKey(props.list)}::${sessionListKey(props.release ?? props.list)}` : "";
    const [openState, setOpenState] = useState<{ open: boolean; targetKey: string; gen: number }>(() => ({
      open,
      targetKey,
      gen: open ? 1 : 0,
    }));
    let gen = openState.gen;
    if (open !== openState.open || targetKey !== openState.targetKey) {
      gen = openState.gen + 1;
      setOpenState({ open, targetKey, gen });
    }
    const activeGenRef = useRef(gen);
    const activeOpenRef = useRef(open);
    const callbacksRef = useRef({ onClose: props.onClose, onDone: props.onDone, onNotice: props.onNotice });
    useLayoutEffect(() => {
      activeGenRef.current = gen;
      activeOpenRef.current = open;
      callbacksRef.current = { onClose: props.onClose, onDone: props.onDone, onNotice: props.onNotice };
    });

    // Only mount the lazy chunk while open (or after this instance has opened and loaded so exit animation can play).
    // If closed before the chunk resolves, unmounting prevents stale effects or late openings.
    const [openedAndLoaded, setOpenedAndLoaded] = useState(() => open && LoadedDialog.ready());
    if (open && LoadedDialog.ready() && !openedAndLoaded) setOpenedAndLoaded(true);
    const mounted = open || openedAndLoaded;
    useEffect(() => {
      if (!open || openedAndLoaded) return;
      let live = true;
      void LoadedDialog.preload().then(() => {
        if (live) setOpenedAndLoaded(true);
      }, () => {});
      return () => { live = false; };
    }, [open, openedAndLoaded]);

    const capturedGen = gen;
    const isCurrent = () => activeGenRef.current === capturedGen && activeOpenRef.current;
    const fencedClose = useCallback(() => {
      if (isCurrent()) callbacksRef.current.onClose();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- capturedGen is the fence for this open generation
    }, [capturedGen]);
    const fencedDone = useCallback(() => {
      if (isCurrent()) callbacksRef.current.onDone?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- capturedGen is the fence for this open generation
    }, [capturedGen]);
    const fencedNotice = useCallback((message: string, tone: "ok" | "error" | "info") => {
      if (isCurrent()) callbacksRef.current.onNotice?.(message, tone);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- capturedGen is the fence for this open generation
    }, [capturedGen]);

    // While the dialog chunk is still loading, Escape cancels the pending open immediately.
    useEffect(() => {
      if (!open || openedAndLoaded) return;
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        fencedClose();
      };
      addEventListener("keydown", onKeyDown, true);
      return () => removeEventListener("keydown", onKeyDown, true);
    }, [open, openedAndLoaded, fencedClose]);

    const [boundaryKey, setBoundaryKey] = useState(0);
    const [lastOpenTarget, setLastOpenTarget] = useState(targetKey);
    let activeBoundaryKey = boundaryKey;
    if (open && targetKey !== lastOpenTarget) {
      if (lastOpenTarget !== "") {
        activeBoundaryKey = boundaryKey + 1;
        setBoundaryKey(activeBoundaryKey);
      }
      setLastOpenTarget(targetKey);
    }

    // Boundary error cleanup runs during React's commit phase before ancestor layout effects publish the new
    // generation. Because OverlayBoundary is keyed by activeBoundaryKey (so stale boundaries unmount before the new
    // target commits), guarding on `open` lets current-target crashes close cleanly while LoadedDialog keeps the
    // generation-fenced callbacks against stale async interactions.
    const onBoundaryError = () => {
      if (open) props.onClose();
    };

    if (!mounted) return null;
    return (
      <OverlayBoundary key={activeBoundaryKey} open={open} onClose={onBoundaryError}>
        <Suspense fallback={null}>
          <LoadedDialog
            {...props}
            onClose={fencedClose}
            onDone={props.onDone ? fencedDone : undefined}
            onNotice={props.onNotice ? fencedNotice : undefined}
          />
        </Suspense>
      </OverlayBoundary>
    );
  });
}

/** Factory for a conditionally-mounted lazy overlay menu with error-boundary recovery, pending dismissal, and ABA fencing. */
export function createLazyMenuOverlay<P extends { onClose: () => void; anchor?: HTMLElement | null }>(
  load: () => Promise<ComponentType<P>>,
  targetKeyOf: (props: P) => string,
  onOpenEffect?: (props: P) => void,
  listed = false,
) {
  const LoadedMenu = lazyPage(load, { listed });

  return function LazyMenuOverlay(props: P) {
    const targetKey = targetKeyOf(props);
    const [epochState, setEpochState] = useState<{ key: string; gen: number }>(() => ({ key: targetKey, gen: 1 }));
    let gen = epochState.gen;
    if (epochState.key !== targetKey) {
      gen = epochState.gen + 1;
      setEpochState({ key: targetKey, gen });
    }
    const activeGenRef = useRef(gen);
    const onCloseRef = useRef(props.onClose);
    useLayoutEffect(() => {
      onCloseRef.current = props.onClose;
    });
    useLayoutEffect(() => {
      activeGenRef.current = gen;
      return () => {
        if (activeGenRef.current === gen) activeGenRef.current = 0;
      };
    }, [gen]);

    const [loaded, setLoaded] = useState(() => LoadedMenu.ready());
    if (!loaded && LoadedMenu.ready()) setLoaded(true);
    useEffect(() => {
      if (loaded) return;
      let live = true;
      void LoadedMenu.preload().then(() => {
        if (live) setLoaded(true);
      }, () => {});
      return () => { live = false; };
    }, [loaded]);

    useEffect(() => {
      onOpenEffect?.(props);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- run on mount/target change
    }, [targetKey]);

    const capturedGen = gen;
    const fencedClose = useCallback(() => {
      if (activeGenRef.current === capturedGen) onCloseRef.current();
    }, [capturedGen]);

    // While the menu chunk is still in flight, Menu has not mounted its dismissal listeners yet. Listen for Escape and
    // outside pointerdown (ignoring the anchor, matching Menu in ui/atoms.tsx) until the chunk resolves so user
    // dismissal cancels the pending open immediately instead of popping up late.
    const anchor = props.anchor;
    useEffect(() => {
      if (loaded) return;
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        fencedClose();
      };
      const onPointerDown = (e: Event) => {
        const target = e.target;
        if (target instanceof Node && anchor?.contains(target)) return;
        fencedClose();
      };
      addEventListener("keydown", onKeyDown, true);
      addEventListener("pointerdown", onPointerDown);
      return () => {
        removeEventListener("keydown", onKeyDown, true);
        removeEventListener("pointerdown", onPointerDown);
      };
    }, [loaded, anchor, fencedClose]);

    // OverlayBoundary is keyed by capturedGen, so an older target's boundary unmounts before the new target commits.
    // Pass props.onClose directly so a synchronous render crash during a target switch closes cleanly even though
    // componentDidCatch runs before the ancestor layout effect publishes activeGenRef.current = gen.
    return (
      <OverlayBoundary key={capturedGen} open onClose={props.onClose}>
        <Suspense fallback={null}>
          <LoadedMenu {...props} onClose={fencedClose} />
        </Suspense>
      </OverlayBoundary>
    );
  };
}

/** Factory for LazyNodePrompt so unit tests can inject deterministic chunk loaders. */
export function createLazyNodePrompt(load: () => Promise<ComponentType<Record<string, never>>>, listed = false) {
  const LoadedPrompt = lazyPage(load, { listed });

  return memo(function LazyNodePrompt() {
    const ask = useSyncExternalStore(subscribeAsk, getAsk, getAsk);
    const [askGen, setAskGen] = useState<{ ask: typeof ask; gen: number }>(() => ({ ask, gen: ask ? 1 : 0 }));
    let gen = askGen.gen;
    if (askGen.ask !== ask) {
      gen = askGen.gen + 1;
      setAskGen({ ask, gen });
    }
    if (!ask) return null;
    const capturedAsk = ask;
    const cancelOnChunkError = () => {
      if (getAsk() !== capturedAsk) return;
      answerAsk();
      if (capturedAsk.kind === "text") capturedAsk.resolve(null);
      else capturedAsk.resolve(false);
    };
    return (
      <OverlayBoundary key={gen} open onClose={cancelOnChunkError}>
        <Suspense fallback={null}>
          <LoadedPrompt />
        </Suspense>
      </OverlayBoundary>
    );
  });
}

export const LazyMarkSeenDialog = createLazyMarkSeenDialog(() => import("./AgentMenus").then((m) => m.MarkSeenDialog), true);

export const LazyAgentRowMenu = createLazyMenuOverlay<AgentRowMenuProps>(
  () => import("./AgentMenus").then((m) => m.AgentRowMenu),
  (p) => `${p.s.machine_id}/${p.s.session_id}`,
  undefined,
  true,
);

export const LazySpaceMenu = createLazyMenuOverlay<SpaceMenuProps & { preloadDialogs?: boolean }>(
  () => import("./SpaceMenu").then((m) => m.SpaceMenu),
  (p) => p.sp.key,
  (p) => { if (p.preloadDialogs !== false) preloadSessionDialogs(); },
  true,
);

export const LazyNodeMenu = createLazyMenuOverlay<NodeMenuProps>(
  () => import("./NodeMenu").then((m) => m.NodeMenu),
  (p) => `${p.node.kind}:${p.node.mid}:${p.node.workspaceId ?? ""}:${p.node.tabId ?? ""}:${p.node.paneId ?? ""}:${p.node.sessionId ?? ""}`,
  undefined,
  true,
);

export const LazyNodePrompt = createLazyNodePrompt(() => import("./NodePrompt").then((m) => m.NodePrompt), true);
