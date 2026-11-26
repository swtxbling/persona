// Overlays a first screen does not draw (the command palette, New agent, dialogs and popovers opened by a click): their chunks load in
// the idle preload (lib/lazy-page.ts) or on the first open, and each mounts then and stays mounted for its exit.
import { Component, Fragment, Suspense, type ComponentType, type ErrorInfo, type ReactNode, useState } from "react";
import { t } from "../i18n";
import { reportBoundary } from "../lib/error-reports";
import { lazyPage } from "../lib/lazy-page";
import { isChunkError } from "./PageBoundary";

/** True from the first render where `open` is, and kept so afterwards: a closed overlay stays mounted for its exit. */
export function useOpened(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

/**
 * Keeps a lazy overlay's failure (its chunk would not load: offline, or the hub was redeployed) from taking the shell
 * down, since it sits outside PageBoundary: with a `fallback`, that local UI stays available; otherwise the overlay
 * shows nothing and is closed, so the next open from any entry (shortcut, sidebar button) is a fresh open that tries
 * again (lazyPage does not keep a failed load).
 */
export class OverlayBoundary extends Component<{ open: boolean; onClose: () => void; children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // a chunk that would not load is a warning (a redeploy), anything else a render crash (docs/web/web.md "Error reports")
    reportBoundary(error, "overlay_boundary", isChunkError(error), info.componentStack);
    // left open, an open request would not change the state, and the entry points would do nothing until a reload
    if (!this.props.fallback) this.props.onClose();
  }

  componentDidUpdate(prev: { open: boolean }) {
    if (this.state.failed && this.props.open && !prev.open) this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/**
 * Error boundary for always-open lazy inline content (filter controls, chat-list rows, delegated cards).
 * Unlike OverlayBoundary (which only resets on a false -> true `open` transition), this surfaces an accessible
 * retry action so transient chunk failures recover cleanly on click or when `resetKey` changes.
 */
export class RecoverableLazyBoundary extends Component<
  {
    resetKey?: string | number;
    children: ReactNode;
    fallback?: (retry: () => void) => ReactNode;
    compact?: boolean;
  },
  { failed: boolean; attempt: number }
> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportBoundary(error, "overlay_boundary", isChunkError(error), info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string | number }) {
    if (this.state.failed && this.props.resetKey !== prev.resetKey) {
      this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }));
    }
  }

  retry = () => {
    this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }));
  };

  render() {
    if (!this.state.failed) {
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
    if (this.props.fallback) return this.props.fallback(this.retry);
    const label = t("app.retry");
    return (
      <button
        type="button"
        data-lazy-retry=""
        aria-label={label}
        title={label}
        onClick={this.retry}
        className={
          this.props.compact
            ? "inline-flex h-5 min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-control px-1.5 text-submeta font-medium text-ink-3 hover:bg-hover hover:text-ink [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11"
            : "inline-flex items-center gap-1.5 whitespace-nowrap rounded-control border border-line bg-surface px-2.5 py-1 text-label font-medium text-ink-2 hover:bg-hover hover:text-ink [@media(pointer:coarse)]:min-h-11"
        }
      >
        {label}
      </button>
    );
  }
}

/** A lazy overlay, with its chunk's load on hand for a caller that knows before the click that it may be next (a menu
 *  offering it opened): loaded by then, the click draws it at once. */
export type LazyOverlayComponent<P> = ComponentType<P> & { preload: () => Promise<unknown> };

/** An overlay from its own chunk, mounted while it is shown (a popover): behind OverlayBoundary and an empty Suspense. */
export function lazyOverlay<P extends { onClose: () => void }>(load: () => Promise<ComponentType<P>>): LazyOverlayComponent<P & { open?: boolean }> {
  const Overlay = lazyPage(load);
  function LazyOverlay(props: P & { open?: boolean }) {
    return (
      <OverlayBoundary open={props.open ?? true} onClose={props.onClose}>
        <Suspense fallback={null}>
          <Overlay {...props} />
        </Suspense>
      </OverlayBoundary>
    );
  }
  return Object.assign(LazyOverlay, { preload: Overlay.preload });
}

/**
 * A dialog from its own chunk: nothing until its first open, then the dialog itself (as lazyOverlay), kept mounted so it
 * closes with its exit as before. The chunk loads on the first open, or ahead of it through `preload`.
 */
export function lazyDialog<P extends { open: boolean; onClose: () => void }>(load: () => Promise<ComponentType<P>>): LazyOverlayComponent<P> {
  const Overlay = lazyOverlay(load);
  function LazyDialog(props: P) {
    return useOpened(props.open) ? <Overlay {...props} /> : null;
  }
  return Object.assign(LazyDialog, { preload: Overlay.preload });
}
