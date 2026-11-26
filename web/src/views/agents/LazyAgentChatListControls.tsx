// On-demand lazy wrappers for the opt-in Agents filter button, filter chips, and chat-list rows (Settings › Agents ›
// Filter, off by default): keeps AgentChatListControls.tsx (~23 KB) off cold first screens while recovering safely on
// chunk load failures.
import { Suspense, type ComponentProps } from "react";
import { lazyPage } from "../../lib/lazy-page";
import { OverlayBoundary } from "../LazyOverlay";
import type { AgentChatListRow, AgentFilterButton, AgentFilterChips } from "./AgentChatListControls";

const loadControls = () => import("./AgentChatListControls");
const LoadedFilterButton = lazyPage(() => loadControls().then((m) => m.AgentFilterButton));
const LoadedFilterChips = lazyPage(() => loadControls().then((m) => m.AgentFilterChips));
const LoadedChatListRow = lazyPage(() => loadControls().then((m) => m.AgentChatListRow));

/** Preloads the opt-in filter controls chunk (used by tests that assert synchronous first paint). */
export const preloadAgentChatListControls = () =>
  Promise.all([LoadedFilterButton.preload(), LoadedFilterChips.preload(), LoadedChatListRow.preload()]);

const noop = () => {};

export function LazyAgentFilterButton(props: ComponentProps<typeof AgentFilterButton>) {
  return (
    <OverlayBoundary open onClose={noop} fallback={null}>
      <Suspense fallback={null}>
        <LoadedFilterButton {...props} />
      </Suspense>
    </OverlayBoundary>
  );
}

export function LazyAgentFilterChips(props: ComponentProps<typeof AgentFilterChips>) {
  return (
    <OverlayBoundary open onClose={noop} fallback={null}>
      <Suspense fallback={null}>
        <LoadedFilterChips {...props} />
      </Suspense>
    </OverlayBoundary>
  );
}

export function LazyAgentChatListRow(props: ComponentProps<typeof AgentChatListRow>) {
  return (
    <OverlayBoundary open onClose={noop} fallback={null}>
      <Suspense fallback={null}>
        <LoadedChatListRow {...props} />
      </Suspense>
    </OverlayBoundary>
  );
}
