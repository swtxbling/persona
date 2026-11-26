// @vitest-environment jsdom
// Deterministic regression tests for B1 (recoverable chunk failure + retry for LazyAgentFilterButton,
// LazyAgentFilterChips, LazyAgentChatListRow, and LazyDelegatedCard) and B2 (WindowedRows ResizeObserver +
// IntersectionObserver tracking and offscreen-part unmounting with 400 delayed LazyAgentChatListRow items).
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DIMENSION_FILTERS, type AgentFacetCounts, type EvalContext } from "../../lib/agent-chatlist-filter";
import type { DelegatedAnswer } from "../../lib/delegate";
import type { Session } from "../../lib/types";
import type { AgentChatListRow, AgentFilterButton, AgentFilterChips } from "./AgentChatListControls";
import { createLazyAgentChatListControls } from "./LazyAgentChatListControls";
import { WindowedRows } from "../WindowedRows";
import { createLazyDelegatedCard } from "../chat/Interactions";
import { SESSION_LIST_METRICS } from "../../ui/list-metrics";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const makeSession = (index: number): Session => ({
  machine_id: "m1",
  session_id: `s-${index}`,
  title: `Agent Session ${index}`,
  cwd: "/code/persona",
  status: "idle",
  state: "idle",
  updated_at: "2026-11-20T10:00:00Z",
});

const emptyFacets: AgentFacetCounts = {
  harnesses: [],
  projects: [],
  models: [],
  machines: [],
  pinned: 0,
};

const emptyMutes = { spaces: [], sessions: [] };

const emptyEvalCtx: EvalContext = {
  machines: [{ id: "m1", name: "Laptop", online: true }],
  interactions: [],
  pins: { spaces: [], sessions: [] },
  now: Date.parse("2026-11-20T10:05:00Z"),
};

const makeRowProps = (s: Session): ComponentProps<typeof AgentChatListRow> => ({
  s,
  k: `s:${s.machine_id}/${s.session_id}`,
  reg: () => () => {},
  hover: () => {},
  active: false,
  to: { name: "session", mid: s.machine_id, sid: s.session_id },
  go: () => () => {},
  pinned: false,
  mutes: emptyMutes,
  filters: DEFAULT_DIMENSION_FILTERS,
  ctx: emptyEvalCtx,
});

const makeDelegated = (id: string, title: string): DelegatedAnswer => ({
  ix: {
    id,
    machine_id: "m1",
    session_id: "s1",
    kind: "question",
    created_at: "2026-11-20T10:00:00Z",
    questions: [{ question: title, options: [{ label: "Yes" }] }],
  },
  answers: { [title]: "Yes" },
  reason: "Matched default preference",
  at: Date.parse("2026-11-20T10:01:00Z"),
});

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("B1: recoverable lazy boundaries for filter controls, chat-list rows, and delegated cards", () => {
  it("recovers LazyAgentFilterButton on click retry after a transient chunk load failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const loader = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Failed to fetch dynamically imported module");
      return {
        AgentFilterButton: (() => <button type="button" data-testid="recovered-filter-btn">Filter OK</button>) as unknown as typeof AgentFilterButton,
        AgentFilterChips: (() => null) as unknown as typeof AgentFilterChips,
        AgentChatListRow: (() => null) as unknown as typeof AgentChatListRow,
      };
    });
    const { LazyAgentFilterButton } = createLazyAgentChatListControls(loader);

    await act(async () => {
      root.render(
        <LazyAgentFilterButton
          filters={DEFAULT_DIMENSION_FILTERS}
          onChange={() => {}}
          facets={emptyFacets}
          chatList={false}
          onToggleChatList={() => {}}
        />,
      );
    });
    await flush();

    expect(attempts).toBe(1);
    const retryBtn = host.querySelector<HTMLButtonElement>("[data-lazy-retry]");
    expect(retryBtn).not.toBeNull();
    expect(host.querySelector('[data-testid="recovered-filter-btn"]')).toBeNull();

    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(attempts).toBe(2);
    expect(host.querySelector("[data-lazy-retry]")).toBeNull();
    expect(host.querySelector('[data-testid="recovered-filter-btn"]')?.textContent).toBe("Filter OK");
  });

  it("recovers LazyAgentFilterChips on click retry after a transient chunk load failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const loader = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Failed to fetch dynamically imported module");
      return {
        AgentFilterButton: (() => null) as unknown as typeof AgentFilterButton,
        AgentFilterChips: (() => <div data-testid="recovered-filter-chips">Chips OK</div>) as unknown as typeof AgentFilterChips,
        AgentChatListRow: (() => null) as unknown as typeof AgentChatListRow,
      };
    });
    const { LazyAgentFilterChips } = createLazyAgentChatListControls(loader);

    await act(async () => {
      root.render(
        <LazyAgentFilterChips
          filters={DEFAULT_DIMENSION_FILTERS}
          onChange={() => {}}
          facets={emptyFacets}
        />,
      );
    });
    await flush();

    expect(attempts).toBe(1);
    const retryBtn = host.querySelector<HTMLButtonElement>("[data-lazy-retry]");
    expect(retryBtn).not.toBeNull();

    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(attempts).toBe(2);
    expect(host.querySelector("[data-lazy-retry]")).toBeNull();
    expect(host.querySelector('[data-testid="recovered-filter-chips"]')?.textContent).toBe("Chips OK");
  });

  it("recovers LazyAgentChatListRow on click retry and also when the session identity changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const loader = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Failed to fetch dynamically imported module");
      return {
        AgentFilterButton: (() => null) as unknown as typeof AgentFilterButton,
        AgentFilterChips: (() => null) as unknown as typeof AgentFilterChips,
        AgentChatListRow: (({ s }: ComponentProps<typeof AgentChatListRow>) => (
          <div data-testid="agent-chatlist-row" data-session-id={s.session_id}>{s.title}</div>
        )) as unknown as typeof AgentChatListRow,
      };
    });
    const { LazyAgentChatListRow } = createLazyAgentChatListControls(loader);

    const s1 = makeSession(1);
    await act(async () => {
      root.render(<LazyAgentChatListRow {...makeRowProps(s1)} />);
    });
    await flush();

    expect(attempts).toBe(1);
    expect(host.querySelector("[data-chatlist-row-shell]")).not.toBeNull();
    const retryBtn = host.querySelector<HTMLButtonElement>("[data-lazy-retry]");
    expect(retryBtn).not.toBeNull();

    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(attempts).toBe(2);
    expect(host.querySelector("[data-lazy-retry]")).toBeNull();
    expect(host.querySelector('[data-testid="agent-chatlist-row"]')?.textContent).toBe("Agent Session 1");

    // Also verify automatic reset on identity change (separate instance failing attempt 1, then receiving new session)
    let idAttempts = 0;
    const loader2 = vi.fn(async () => {
      idAttempts += 1;
      if (idAttempts === 1) throw new Error("Failed to fetch dynamically imported module");
      return {
        AgentFilterButton: (() => null) as unknown as typeof AgentFilterButton,
        AgentFilterChips: (() => null) as unknown as typeof AgentFilterChips,
        AgentChatListRow: (({ s }: ComponentProps<typeof AgentChatListRow>) => (
          <div data-testid="agent-chatlist-row-2">{s.session_id}</div>
        )) as unknown as typeof AgentChatListRow,
      };
    });
    const { LazyAgentChatListRow: Row2 } = createLazyAgentChatListControls(loader2);
    await act(async () => {
      root.render(<Row2 {...makeRowProps(makeSession(10))} />);
    });
    await flush();
    expect(host.querySelector("[data-lazy-retry]")).not.toBeNull();

    await act(async () => {
      root.render(<Row2 {...makeRowProps(makeSession(11))} />);
    });
    await flush();
    expect(idAttempts).toBe(2);
    expect(host.querySelector('[data-testid="agent-chatlist-row-2"]')?.textContent).toBe("s-11");
  });

  it("recovers LazyDelegatedCard on click retry and on delegated interaction id change", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const loader = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Failed to fetch dynamically imported module");
      return function DelegatedStub({ d }: { d: DelegatedAnswer }) {
        return <div data-testid="recovered-delegated">{d.ix.id}</div>;
      };
    });
    const LazyDelegated = createLazyDelegatedCard(loader);

    await act(async () => {
      root.render(<LazyDelegated d={makeDelegated("ix-1", "Approve deploy?")} />);
    });
    await flush();

    expect(attempts).toBe(1);
    const retryBtn = host.querySelector<HTMLButtonElement>("[data-lazy-retry]");
    expect(retryBtn).not.toBeNull();

    await act(async () => {
      retryBtn!.click();
    });
    await flush();

    expect(attempts).toBe(2);
    expect(host.querySelector("[data-lazy-retry]")).toBeNull();
    expect(host.querySelector('[data-testid="recovered-delegated"]')?.textContent).toBe("ix-1");

    // Separate instance: switching d.ix.id resets failed state automatically.
    let idAttempts = 0;
    const loader2 = vi.fn(async () => {
      idAttempts += 1;
      if (idAttempts === 1) throw new Error("Failed to fetch dynamically imported module");
      return function DelegatedStub2({ d }: { d: DelegatedAnswer }) {
        return <div data-testid="recovered-delegated-2">{d.ix.id}</div>;
      };
    });
    const LazyDelegated2 = createLazyDelegatedCard(loader2);
    await act(async () => {
      root.render(<LazyDelegated2 d={makeDelegated("ix-a", "Question A")} />);
    });
    await flush();
    expect(host.querySelector("[data-lazy-retry]")).not.toBeNull();

    await act(async () => {
      root.render(<LazyDelegated2 d={makeDelegated("ix-b", "Question B")} />);
    });
    await flush();
    expect(idAttempts).toBe(2);
    expect(host.querySelector('[data-testid="recovered-delegated-2"]')?.textContent).toBe("ix-b");
  });
});

describe("B2: WindowedRows observer tracking with 400 delayed LazyAgentChatListRow items", () => {
  it("observes stable row shells before chunk arrival, measures heights on resolution, and unmounts offscreen parts", async () => {
    const resizeObserved = new Set<Element>();
    let resizeCallback: ResizeObserverCallback | null = null;
    class FakeResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe(el: Element) {
        resizeObserved.add(el);
      }
      unobserve(el: Element) {
        resizeObserved.delete(el);
      }
      disconnect() {
        resizeObserved.clear();
      }
    }

    const intersectObserved = new Set<Element>();
    let intersectCallback: IntersectionObserverCallback | null = null;
    class FakeIntersectionObserver {
      constructor(cb: IntersectionObserverCallback) {
        intersectCallback = cb;
      }
      observe(el: Element) {
        intersectObserved.add(el);
      }
      unobserve(el: Element) {
        intersectObserved.delete(el);
      }
      disconnect() {
        intersectObserved.clear();
      }
    }

    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const gate = deferred<{
      AgentFilterButton: typeof AgentFilterButton;
      AgentFilterChips: typeof AgentFilterChips;
      AgentChatListRow: typeof AgentChatListRow;
    }>();
    const { LazyAgentChatListRow } = createLazyAgentChatListControls(() => gate.promise);

    const items = Array.from({ length: 400 }, (_, i) => makeSession(i));

    // Step 1: Mount WindowedRows with 400 items while the controls chunk is still pending.
    await act(async () => {
      root.render(
        <div data-row-scroller="" style={{ height: 600, overflowY: "auto" }}>
          <div data-testid="agent-chatlist-section">
            <WindowedRows
              items={items}
              render={(s) => <LazyAgentChatListRow key={`s:${s.machine_id}/${s.session_id}`} {...makeRowProps(s)} />}
            />
          </div>
        </div>,
      );
    });
    await flush();

    const { windowHead: HEAD, windowPart: PART } = SESSION_LIST_METRICS;

    // Initial render draws head (30) + last (1) = 31 row shells; ResizeObserver must observe the head shells already.
    const initialShells = [...host.querySelectorAll<HTMLElement>("[data-chatlist-row-shell]")];
    expect(initialShells.length).toBe(HEAD + 1);
    expect(resizeObserved.size).toBe(HEAD);
    for (const shell of initialShells.slice(0, HEAD)) {
      expect(resizeObserved.has(shell)).toBe(true);
    }

    // Step 2: Simulate part 1 gap entering viewport BEFORE the chunk resolves so part 1 mounts its shells.
    const part1Gap = host.querySelector<HTMLElement>('[data-rows-part="1"][data-rows-gap]')!;
    expect(part1Gap).not.toBeNull();
    expect(intersectObserved.has(part1Gap)).toBe(true);

    const makeIntersectEntry = (
      target: Element,
      isIntersecting: boolean,
      top: number,
      bottom: number,
    ): IntersectionObserverEntry =>
      ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        intersectionRect: { top, bottom } as DOMRectReadOnly,
        boundingClientRect: { top, bottom } as DOMRectReadOnly,
        rootBounds: { top: 0, bottom: 600 } as DOMRectReadOnly,
        time: 0,
      }) as IntersectionObserverEntry;

    await act(async () => {
      intersectCallback!([makeIntersectEntry(part1Gap, true, 200, 500)], {} as IntersectionObserver);
    });
    await flush();

    // Part 1 is now drawn (PART rows) -> total HEAD + PART + 1 shells, HEAD + PART observed by ResizeObserver,
    // and part 1's first & last shells observed by IntersectionObserver.
    expect(host.querySelector('[data-rows-part="1"][data-rows-gap]')).toBeNull();
    const shellsWithPart1 = [...host.querySelectorAll<HTMLElement>("[data-chatlist-row-shell]")];
    expect(shellsWithPart1.length).toBe(HEAD + PART + 1);
    expect(resizeObserved.size).toBe(HEAD + PART);
    const part1First = shellsWithPart1[HEAD]!;
    const part1Last = shellsWithPart1[HEAD + PART - 1]!;
    expect(intersectObserved.has(part1First)).toBe(true);
    expect(intersectObserved.has(part1Last)).toBe(true);

    // Step 3: Resolve the lazy chunk AFTER initial render and observer setup settled.
    await act(async () => {
      gate.resolve({
        AgentFilterButton: (() => null) as unknown as typeof AgentFilterButton,
        AgentFilterChips: (() => null) as unknown as typeof AgentFilterChips,
        AgentChatListRow: (({ s }: ComponentProps<typeof AgentChatListRow>) => (
          <div data-testid="agent-chatlist-row" data-session-id={s.session_id}>{s.title}</div>
        )) as unknown as typeof AgentChatListRow,
      });
      await gate.promise;
    });
    await flush();

    // All drawn shells now contain real chat-list rows AND remain directly observed by ResizeObserver & IntersectionObserver.
    expect(host.querySelectorAll('[data-testid="agent-chatlist-row"]').length).toBe(HEAD + PART + 1);
    expect(part1First.querySelector('[data-testid="agent-chatlist-row"]')).not.toBeNull();
    expect(part1Last.querySelector('[data-testid="agent-chatlist-row"]')).not.toBeNull();
    expect(resizeObserved.has(part1First)).toBe(true);
    expect(intersectObserved.has(part1First)).toBe(true);
    expect(intersectObserved.has(part1Last)).toBe(true);

    // Step 4: Fire ResizeObserver with real row geometry (64px per row -> part 1 = PART * 64).
    const partHeight = PART * 64;
    vi.spyOn(part1First, "getBoundingClientRect").mockReturnValue({ top: 1920, bottom: 1984 } as DOMRect);
    vi.spyOn(part1Last, "getBoundingClientRect").mockReturnValue({ top: 1920 + partHeight - 64, bottom: 1920 + partHeight } as DOMRect);
    await act(async () => {
      resizeCallback!(
        [{ target: part1First } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    // Step 5: Scroll part 1 out of viewport (both first and last rows below root) -> WindowedRows unmounts part 1 and restores a measured-height gap!
    await act(async () => {
      intersectCallback!(
        [
          makeIntersectEntry(part1First, false, 2000, 2064),
          makeIntersectEntry(part1Last, false, 2000 + partHeight - 64, 2000 + partHeight),
        ],
        {} as IntersectionObserver,
      );
    });
    await flush();

    const restoredGap = host.querySelector<HTMLElement>('[data-rows-part="1"][data-rows-gap]');
    expect(restoredGap).not.toBeNull();
    expect(restoredGap!.style.height).toBe(`${partHeight}px`);
    expect(host.querySelectorAll('[data-testid="agent-chatlist-row"]').length).toBe(HEAD + 1);
  });
});
