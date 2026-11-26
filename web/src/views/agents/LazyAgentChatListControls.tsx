// On-demand lazy wrappers for the opt-in Agents filter button, filter chips, and chat-list rows (Settings › Agents ›
// Filter, off by default): keeps AgentChatListControls.tsx (~23 KB) off cold first screens while recovering safely on
// chunk load failures and preserving a stable measurable direct-sibling shell for WindowedRows.
import { Suspense, type ComponentProps } from "react";
import { lazyPage } from "../../lib/lazy-page";
import { RecoverableLazyBoundary } from "../LazyOverlay";
import type { AgentChatListRow, AgentFilterButton, AgentFilterChips } from "./AgentChatListControls";

type AgentChatListControlsModule = {
  AgentFilterButton: typeof AgentFilterButton;
  AgentFilterChips: typeof AgentFilterChips;
  AgentChatListRow: typeof AgentChatListRow;
};

/** Factory so unit tests can inject deterministic deferred or failing chunk loaders. */
export function createLazyAgentChatListControls(load: () => Promise<AgentChatListControlsModule>, listed = false) {
  const LoadedFilterButton = lazyPage(() => load().then((m) => m.AgentFilterButton), { listed });
  const LoadedFilterChips = lazyPage(() => load().then((m) => m.AgentFilterChips), { listed });
  const LoadedChatListRow = lazyPage(() => load().then((m) => m.AgentChatListRow), { listed });

  /** Preloads the opt-in filter controls chunk (used by tests that assert synchronous first paint). */
  const preloadAgentChatListControls = () =>
    Promise.all([LoadedFilterButton.preload(), LoadedFilterChips.preload(), LoadedChatListRow.preload()]);

  function LazyAgentFilterButton(props: ComponentProps<typeof AgentFilterButton>) {
    return (
      <RecoverableLazyBoundary compact>
        <Suspense fallback={null}>
          <LoadedFilterButton {...props} />
        </Suspense>
      </RecoverableLazyBoundary>
    );
  }

  function LazyAgentFilterChips(props: ComponentProps<typeof AgentFilterChips>) {
    return (
      <RecoverableLazyBoundary>
        <Suspense fallback={null}>
          <LoadedFilterChips {...props} />
        </Suspense>
      </RecoverableLazyBoundary>
    );
  }

  function LazyAgentChatListRow(props: ComponentProps<typeof AgentChatListRow>) {
    // Keep a stable direct-sibling row shell so WindowedRows attaches ResizeObserver and IntersectionObserver on
    // initial commit even while the controls chunk is still loading, then remeasures automatically when row DOM lands.
    const resetKey = `${props.s.machine_id}/${props.s.session_id}`;
    return (
      <div data-chatlist-row-shell="" className="min-h-11">
        <RecoverableLazyBoundary resetKey={resetKey}>
          <Suspense fallback={null}>
            <LoadedChatListRow {...props} />
          </Suspense>
        </RecoverableLazyBoundary>
      </div>
    );
  }

  return {
    LazyAgentFilterButton,
    LazyAgentFilterChips,
    LazyAgentChatListRow,
    preloadAgentChatListControls,
  };
}

export const {
  LazyAgentFilterButton,
  LazyAgentFilterChips,
  LazyAgentChatListRow,
  preloadAgentChatListControls,
} = createLazyAgentChatListControls(() => import("./AgentChatListControls"), true);
