// @vitest-environment jsdom
// Regression tests for narrow-sidebar (190px-220px) readability in SidebarTree/DirectionMarks
// and deep-scroll layout-read avoidance in Sidebar's useGlide.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

import type { RepoMachine } from "../lib/agent-repos-core";
import type { Space } from "../lib/agent-groups";
import { reset } from "../lib/store";
import type { TodoTree, TreeTodo } from "../lib/todo-tree";
import type { Machine, Session } from "../lib/types";
import { DirectionCountsText, DirectionStateText } from "./DirectionMarks";
import { Sidebar } from "./Sidebar";
import { ROW_TITLE_MIN } from "./SidebarParts";
import { Section } from "./SidebarSection";
import { RepoMachineSection, SpaceSection, TodoTreeView, TreeTodoRows } from "./SidebarTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const reg = () => () => {};
const hover = () => {};
const go = () => () => {};
const onRowMenu = () => {};
const onSpaceMenu = () => {};

const makeSession = (id: string, title = "Fix narrow sidebar clipping"): Session => ({
  machine_id: "m1",
  session_id: id,
  title,
  cwd: "/code/persona",
  status: "working",
  state: "working",
  updated_at: "2026-11-20T10:00:00Z",
});

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

beforeEach(() => {
  localStorage.clear();
  reset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  reset();
  vi.restoreAllMocks();
});

describe("narrow-sidebar (190px-220px) readability", () => {
  it("protects TreeTodoRows titles with ROW_TITLE_MIN and lets trailing state labels shrink/truncate", () => {
    const td: TreeTodo = {
      key: "todo:t1",
      todoId: "t1",
      name: "Refactor startup lazy dialog loading across narrow layouts",
      state: "needs_you",
      taskState: "needs_you",
      goalProgress: { done: 3, total: 5 },
      folded: true,
      sessions: [makeSession("s1")],
      agents: [],
    };

    act(() =>
      root.render(
        <div style={{ width: 200 }}>
          <TreeTodoRows td={td} reg={reg} hover={hover} activeKey="" go={go} onRowMenu={onRowMenu} />
        </div>,
      ),
    );

    const link = host.querySelector<HTMLAnchorElement>('a[href*="/todos"]');
    expect(link).not.toBeNull();
    expect(link!.className).toContain("min-w-0");
    expect(link!.className).toContain(`@min-[10rem]:${ROW_TITLE_MIN}`);
    expect(link!.className).toContain("basis-auto");
    expect(link!.closest("[data-tree-branch-row]")?.className).toContain("@container");

    const stateEl = host.querySelector<HTMLElement>('[data-task-state="needs_you"]');
    expect(stateEl).not.toBeNull();
    expect(stateEl!.className).toContain("min-w-0");
    expect(stateEl!.className).toContain("shrink-[20]");
    expect(stateEl!.className).toContain("truncate");
    expect(stateEl!.className).not.toContain("shrink-0");
  });

  it("allows DirectionCountsText and DirectionStateText to shrink while keeping the status dot intact", () => {
    act(() =>
      root.render(
        <div style={{ width: 190 }}>
          <DirectionCountsText direction={{ running: true, counts: { needs_you: 2, working: 1, stuck: 0, review: 0 } }} />
          <DirectionStateText state="needs_you" />
        </div>,
      ),
    );

    const counts = host.querySelector<HTMLElement>("[data-direction-counts]");
    expect(counts).not.toBeNull();
    expect(counts!.className).toContain("min-w-0");
    expect(counts!.className).toContain("shrink-[20]");
    expect(counts!.className).not.toContain("shrink-0");

    const textSpan = counts!.querySelector<HTMLElement>(".text-attention");
    expect(textSpan?.className).toContain("min-w-0");
    expect(textSpan?.className).toContain("truncate");
  });

  it("protects pinned direction titles in TreeProjectSection/Section at 190px while letting trailing counts shrink", () => {
    const tree: TodoTree = {
      projects: [
        {
          key: "dir:core",
          name: "Persona Core Startup & Sidebar Architecture",
          state: "needs_you",
          folded: false,
          sessions: [makeSession("s1")],
          todos: [],
          direction: {
            secretary: false,
            running: true,
            counts: { needs_you: 2, working: 1, stuck: 0, review: 0 },
          },
        },
      ],
      todos: [],
      loose: [],
    };

    act(() =>
      root.render(
        <div style={{ width: 190 }}>
          <TodoTreeView tree={tree} reg={reg} hover={hover} activeKey="" go={go} onRowMenu={onRowMenu} />
          <Section top title="Persona chats" folded={false} onToggle={() => {}} right={<span data-top-right>2</span>}>
            <div />
          </Section>
        </div>,
      ),
    );

    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")];
    const dirBtn = buttons.find((b) => b.textContent?.includes("Persona Core Startup & Sidebar Architecture"));
    expect(dirBtn).not.toBeNull();
    expect(dirBtn!.className).toContain("min-w-0");
    expect(dirBtn!.className).toContain(`@min-[10rem]:${ROW_TITLE_MIN}`);
    expect(dirBtn!.className).toContain("basis-auto");
    expect(dirBtn!.parentElement?.className).toContain("@container");

    const counts = host.querySelector<HTMLElement>("[data-direction-counts]");
    expect(counts).not.toBeNull();
    expect(counts!.className).toContain("min-w-0");
    expect(counts!.className).toContain("shrink-[20]");

    // Top-level sections keep min-w-0 so headings with multiple action controls never overflow.
    const topBtn = buttons.find((b) => b.textContent?.includes("Persona chats"));
    expect(topBtn).not.toBeNull();
    expect(topBtn!.className).toContain("min-w-0");
    expect(topBtn!.className).not.toContain(ROW_TITLE_MIN);
  });

  it("gives SpaceSection title wrapper min-w-0 so long space names truncate inside narrow sidebars", () => {
    const sp: Space = {
      key: "m1/very-long-space-name",
      name: "VeryLongWorkspaceNameThatMustTruncateCleanly",
      machineId: "m1",
      sessions: [makeSession("s1")],
    };

    act(() =>
      root.render(
        <div style={{ width: 200 }}>
          <SpaceSection
            sp={sp}
            machineName="Studio Workstation"
            reg={reg}
            hover={hover}
            activeKey=""
            go={go}
            pinned={false}
            muted={false}
            onMenu={onSpaceMenu}
            onRowMenu={onRowMenu}
          />
        </div>,
      ),
    );

    const nameEl = [...host.querySelectorAll<HTMLElement>("span")].find(
      (el) => el.textContent === sp.name,
    );
    expect(nameEl).not.toBeNull();
    expect(nameEl!.className).toContain("min-w-0");
    expect(nameEl!.className).toContain("truncate");
    expect(nameEl!.parentElement?.className).toContain("min-w-0");
  });

  it("makes RepoWorktreeRows container-responsive and protects worktree titles at 190px-220px", () => {
    const machine: Machine = { id: "m1", name: "Laptop", online: true, last_seen: "2026-11-20T10:00:00Z" };
    const s = makeSession("s1");
    const repoMachine: RepoMachine = {
      key: "m1",
      foldKey: "repo-m1",
      machine,
      needs: 0,
      sessions: [s],
      repos: [
        {
          key: "repo:m1/persona",
          machineId: "m1",
          repo: "/code/persona",
          name: "persona",
          count: 1,
          worktrees: [
            {
              key: "wt:main",
              name: "main",
              path: "/code/persona",
              main: true,
              sessions: [],
              tree: [],
              children: [],
              childStates: { needs_you: 0, working: 0, done: 0 },
            },
            {
              key: "wt:perf",
              name: "perf-lazy-dialogs-feature",
              path: "/code/persona-wt",
              main: false,
              sessions: [s],
              tree: [s],
              children: [],
              childStates: { needs_you: 0, working: 0, done: 0 },
            },
          ],
        },
      ],
    };

    act(() =>
      root.render(
        <div style={{ width: 200 }}>
          <RepoMachineSection
            m={repoMachine}
            flat
            machines={[machine]}
            reg={reg}
            hover={hover}
            activeKey=""
            go={go}
            onRowMenu={onRowMenu}
          />
        </div>,
      ),
    );

    const titleBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (btn) => btn.textContent?.includes("perf-lazy-dialogs-feature"),
    );
    expect(titleBtn).not.toBeNull();
    expect(titleBtn!.className).toContain("min-w-0");
    expect(titleBtn!.className).toContain(`@min-[10.5rem]:${ROW_TITLE_MIN}`);
    expect(titleBtn!.className).not.toMatch(/(^|\s)min-w-\(--row-title-min\)(\s|$)/);
    expect(titleBtn!.className).toContain("basis-auto");

    const rowDiv = titleBtn!.parentElement!;
    expect(rowDiv.className).toContain("@container");

    const kindSpan = [...rowDiv.querySelectorAll<HTMLElement>("span")].find(
      (el) => el.className.includes("@max-[15rem]:sr-only"),
    );
    expect(kindSpan).not.toBeNull();

    const trailingCount = rowDiv.querySelector<HTMLElement>(".tabular-nums");
    expect(trailingCount).not.toBeNull();
    expect(trailingCount!.className).toContain("min-w-0");
    expect(trailingCount!.className).toContain("shrink-[20]");
    expect(trailingCount!.className).toContain("truncate");
  });

  it("relaxes nested RepoWorktreeRows titles via container queries across depths 0..5 so trailing menus never overflow (B5)", () => {
    const machine: Machine = { id: "m1", name: "Laptop", online: true, last_seen: "2026-11-20T10:00:00Z" };
    const s = makeSession("s1");
    const makeNested = (depth: number, maxDepth: number): RepoMachine["repos"][number]["worktrees"][number] => ({
      key: `wt:depth-${depth}`,
      name: `nested-worktree-level-${depth}`,
      path: `/code/persona/wt-${depth}`,
      main: false,
      sessions: [s],
      tree: [s],
      target: {
        owner: "user",
        manager: "assistant",
        label: `nested-worktree-level-${depth}`,
        host: "herdr",
        cwd: `/code/persona/wt-${depth}`,
        machine_id: "m1",
        workspace_id: `ws-${depth}`,
      } as unknown as RepoMachine["repos"][number]["worktrees"][number]["target"],
      children: depth < maxDepth ? [makeNested(depth + 1, maxDepth)] : [],
      childStates: { needs_you: 0, working: depth < maxDepth ? 1 : 0, done: 0 },
    });

    const repoMachine: RepoMachine = {
      key: "m1",
      foldKey: "repo-m1-deep",
      machine,
      needs: 0,
      sessions: [s],
      repos: [
        {
          key: "repo:m1/persona-deep",
          machineId: "m1",
          repo: "/code/persona",
          name: "persona",
          count: 6,
          worktrees: [
            {
              key: "wt:main-deep",
              name: "main",
              path: "/code/persona",
              main: true,
              sessions: [],
              tree: [],
              children: [],
              childStates: { needs_you: 0, working: 0, done: 0 },
            },
            makeNested(0, 5),
          ],
        },
      ],
    };

    act(() =>
      root.render(
        <div style={{ width: 190 }}>
          <RepoMachineSection
            m={repoMachine}
            flat
            machines={[machine]}
            reg={reg}
            hover={hover}
            activeKey=""
            go={go}
            onRowMenu={onRowMenu}
            onWorkspaceMenu={() => {}}
          />
        </div>,
      ),
    );

    for (let depth = 0; depth <= 5; depth++) {
      const btn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent?.includes(`nested-worktree-level-${depth}`),
      );
      expect(btn, `depth ${depth} title button`).not.toBeNull();
      expect(btn!.className).toContain("min-w-0");
      expect(btn!.className).toContain(`@min-[10.5rem]:${ROW_TITLE_MIN}`);
      expect(btn!.className).not.toMatch(/(^|\s)min-w-\(--row-title-min\)(\s|$)/);
      const row = btn!.parentElement!;
      expect(row.className).toContain("@container");
      expect(row.querySelector("[data-row-menu]")).not.toBeNull();
    }
  });
});

describe("Sidebar deep-scroll glide optimization", () => {
  it("skips per-frame layout reads when scrolling a non-sticky active row, but still measures sticky PersonaRow", async () => {
    const rafQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const flushRaf = () => {
      const pending = rafQueue.splice(0, rafQueue.length);
      for (const cb of pending) cb(performance.now());
    };

    // Route active on "home" (a regular NavRow, not inside [data-sidebar-sticky]).
    act(() =>
      root.render(
        <Sidebar route={{ name: "home" }} onSearch={() => {}} onNewAgent={() => {}} />,
      ),
    );
    await flush();
    act(() => flushRaf());

    const scroller = host.querySelector<HTMLElement>("[data-sidebar-rows]")!;
    expect(scroller).not.toBeNull();

    const rectSpy = vi.spyOn(scroller, "getBoundingClientRect");
    rectSpy.mockClear();
    rafQueue.length = 0;

    // Simulate deep scrolling of the sidebar scroll container itself.
    act(() => {
      for (let i = 0; i < 10; i++) {
        scroller.scrollTop = i * 120;
        scroller.dispatchEvent(new Event("scroll"));
      }
      flushRaf();
    });

    expect(rafQueue.length).toBe(0);
    expect(rectSpy).not.toHaveBeenCalled();

    // Switch active route to "persona" (the sticky PersonaRow inside [data-sidebar-sticky]).
    act(() =>
      root.render(
        <Sidebar route={{ name: "persona" }} onSearch={() => {}} onNewAgent={() => {}} />,
      ),
    );
    await flush();
    act(() => flushRaf());
    rectSpy.mockClear();

    act(() => {
      scroller.scrollTop = 240;
      scroller.dispatchEvent(new Event("scroll"));
      flushRaf();
    });

    expect(rectSpy).toHaveBeenCalled();
  });
});
