// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item, Session } from "../../lib/types";

const roCallbacks = vi.hoisted(() => new Set<ResizeObserverCallback>());

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = (q: string) => ({ matches: /pointer: fine|prefers-reduced-motion/.test(q), addEventListener() {}, removeEventListener() {} });
  g.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      roCallbacks.add(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      roCallbacks.delete(this.cb);
    }
  };
  g.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  g.CSS ??= { escape: (s: string) => s.replace(/["\\]/g, "\\$&") };
});

const transcript = vi.hoisted(() => ({ items: [] as Item[], loading: false, error: "", hasMore: false, streaming: "" }));
vi.mock("./useTranscript", () => ({ useTranscript: () => transcript }));
vi.mock("../../lib/panel", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/panel")>()), usePanel: () => null }));
vi.mock("../../lib/router", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/router")>()), useRoute: () => ({ name: "session", mid: "m", sid: "s" }) }));

const nav = vi.hoisted(() => ({ onJump: null as ((lineId: string) => Promise<void>) | null }));
vi.mock("./ChatNavRail", () => ({
  ChatNavRail: (p: { onJump?: (lineId: string) => Promise<void> }) => {
    nav.onJump = p.onJump ?? null;
    return null;
  },
}));

const { ChatView } = await import("./ChatView");
const { reset, upsertSession } = await import("../../lib/store");
const { forgetExpanded } = await import("./expanded");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const longThought = Array.from({ length: 24 }, (_, i) => `Line ${i + 1}: Deep AGY reasoning detail.`).join("\n");
const items: Item[] = [
  { id: "1@u#0", seq: 1, role: "user", kind: "text", text: "Explain the root cause", ts: "2026-11-26T00:00:00Z" },
  { id: "2@p#thinking", seq: 2, role: "assistant", kind: "thinking", text: longThought, ts: "2026-11-26T00:00:01Z" },
  { id: "2@p#text", seq: 2, role: "assistant", kind: "text", text: "Root cause summary.", ts: "2026-11-26T00:00:05Z" },
];

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await vi.dynamicImportSettled(); });
};

beforeEach(() => {
  localStorage.clear();
  forgetExpanded();
  roCallbacks.clear();
  nav.onJump = null;
  transcript.items = [...items];
  upsertSession({ machine_id: "m", session_id: "s", title: "AGY Anchor", status: "idle", state: "idle", agent: "antigravity", cwd: "/work" } as Session);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  reset();
  vi.unstubAllGlobals();
});

async function mountWithOpenWorkGroup() {
  act(() => root.render(<ChatView mid="m" sid="s" onToggleSidebar={() => {}} />));
  await flush();
  const wgBtn = host.querySelector<HTMLButtonElement>('[data-work-group] > button[aria-expanded="false"]')!;
  await act(async () => wgBtn.click());
  await flush();

  const sc = host.querySelector<HTMLElement>("[data-chat-scroll]")!;
  let scrollHeight = 1400;
  Object.defineProperty(sc, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(sc, "clientHeight", { configurable: true, value: 700 });
  sc.getBoundingClientRect = () => ({ top: 60, bottom: 760, left: 0, right: 900, width: 900, height: 700, x: 0, y: 60, toJSON() {} });
  // Drop the WorkGroup unfold anchor (as user scrolling does), then re-engage atEnd === true at the bottom.
  await act(async () => sc.dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true })));
  sc.scrollTop = 640;
  await act(async () => sc.dispatchEvent(new Event("scroll", { bubbles: true })));
  sc.scrollTop = 700;
  await act(async () => sc.dispatchEvent(new Event("scroll", { bubbles: true })));

  const row = host.querySelector<HTMLElement>('[data-thinking="words"] > [role="button"]')!;
  let rowTop = 200;
  row.getBoundingClientRect = () => ({ top: rowTop, bottom: rowTop + 28, left: 40, right: 860, width: 820, height: 28, x: 40, y: rowTop, toJSON() {} });
  return {
    sc,
    row,
    setScrollHeight: (h: number) => {
      scrollHeight = h;
    },
    setRowTop: (t: number) => {
      rowTop = t;
    },
  };
}

describe("ChatView ThinkingRow disclosure scroll anchor", () => {
  it("anchors a clicked ThinkingRow div[role=button][aria-expanded] instead of jumping to scrollHeight when atEnd", async () => {
    const { sc, row, setScrollHeight } = await mountWithOpenWorkGroup();

    await act(async () => row.click());
    expect(row.getAttribute("aria-expanded")).toBe("true");

    // Simulate layout growth from expanding the 24-line thought (+1720px).
    setScrollHeight(3120);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });

    // Anchored at rowTop === 200, so scrollTop stays at 700 rather than jumping to 3120.
    expect(sc.scrollTop).toBe(700);
  });

  it("ignores clicks ending a text selection inside an expanded ThinkingRow so atEnd stays intact", async () => {
    const { sc, row, setScrollHeight } = await mountWithOpenWorkGroup();

    // Expand first, then simulate user scrolling back to the bottom (dropping prior unfold anchor and re-engaging atEnd).
    await act(async () => row.click());
    expect(row.getAttribute("aria-expanded")).toBe("true");
    await act(async () => sc.dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true })));
    sc.scrollTop = 640;
    await act(async () => sc.dispatchEvent(new Event("scroll", { bubbles: true })));
    sc.scrollTop = 700;
    await act(async () => sc.dispatchEvent(new Event("scroll", { bubbles: true })));

    // Simulate ending a text selection inside the expanded thought.
    const textNode = row.querySelector("span:nth-of-type(2)")!;
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      anchorNode: textNode,
    } as unknown as Selection);

    await act(async () => row.click());
    expect(row.getAttribute("aria-expanded")).toBe("true");

    // Because selection-end click was ignored, atEnd remains true and new bottom growth follows.
    setScrollHeight(1800);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(sc.scrollTop).toBe(1800);
  });

  it("anchors scroll on keyboard Enter activation of a focused ThinkingRow instead of jumping to scrollHeight", async () => {
    const { sc, row, setScrollHeight } = await mountWithOpenWorkGroup();

    row.focus();
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    });
    expect(row.getAttribute("aria-expanded")).toBe("true");

    setScrollHeight(3120);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(sc.scrollTop).toBe(700);
  });

  it("anchors scroll on keyboard Space activation of a focused ThinkingRow instead of jumping to scrollHeight", async () => {
    const { sc, row, setScrollHeight } = await mountWithOpenWorkGroup();

    row.focus();
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }));
    });
    expect(row.getAttribute("aria-expanded")).toBe("true");

    setScrollHeight(3120);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(sc.scrollTop).toBe(700);
  });

  it("still treats ArrowDown as reader movement and releases the disclosure anchor", async () => {
    const { sc, row, setRowTop, setScrollHeight } = await mountWithOpenWorkGroup();

    row.focus();
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    });
    expect(row.getAttribute("aria-expanded")).toBe("true");

    // Confirm the anchor is active right after Enter (rowTop shift 200 -> 230 compensates scrollTop by +30).
    setRowTop(230);
    setScrollHeight(3120);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(sc.scrollTop).toBe(730);

    // ArrowDown counts as readerMoves and drops the active unfold anchor.
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true }));
    });

    // After ArrowDown releases the anchor, a further rowTop shift (230 -> 290) no longer moves scrollTop.
    setRowTop(290);
    setScrollHeight(3200);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(sc.scrollTop).toBe(730);
  });

  it("keeps native button[aria-expanded] Enter/Space activation anchored cleanly", async () => {
    const { sc, setScrollHeight } = await mountWithOpenWorkGroup();
    const wgBtn = host.querySelector<HTMLButtonElement>('[data-work-group] > button[aria-expanded="true"]')!;
    wgBtn.getBoundingClientRect = () => ({ top: 160, bottom: 188, left: 40, right: 860, width: 820, height: 28, x: 40, y: 160, toJSON() {} });

    // Collapse via Enter (keydown + browser-synthesized click on native <button>).
    wgBtn.focus();
    await act(async () => {
      wgBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      wgBtn.click();
    });
    expect(wgBtn.getAttribute("aria-expanded")).toBe("false");

    setScrollHeight(2600);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(sc.scrollTop).toBe(700);

    // Drop the unfold anchor and re-engage atEnd, then re-expand via Space (keydown + synthesized click).
    await act(async () => sc.dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true })));
    sc.scrollTop = 1840;
    await act(async () => sc.dispatchEvent(new Event("scroll", { bubbles: true })));
    sc.scrollTop = 1900;
    await act(async () => sc.dispatchEvent(new Event("scroll", { bubbles: true })));

    wgBtn.focus();
    await act(async () => {
      wgBtn.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }));
      wgBtn.click();
    });
    expect(wgBtn.getAttribute("aria-expanded")).toBe("true");

    setScrollHeight(3400);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(sc.scrollTop).toBe(1900);
  });

  it.each([
    ["Enter", "Enter"],
    [" ", "Space"],
  ] as const)("cancels a competing held navigation landing on focused ThinkingRow %s activation", async (key, code) => {
    transcript.items = [
      ...items,
      { id: "3@u#0", seq: 3, role: "user", kind: "text", text: "Later navigation target", ts: "2026-11-26T00:00:06Z" },
      { id: "4@p#text", seq: 4, role: "assistant", kind: "text", text: "Later response", ts: "2026-11-26T00:00:07Z" },
    ];
    const { sc, row, setScrollHeight, setRowTop } = await mountWithOpenWorkGroup();
    expect(nav.onJump).toBeTypeOf("function");

    const target = host.querySelector<HTMLElement>('[data-line="seg:3@u#0"]')?.firstElementChild as HTMLElement;
    expect(target).toBeTruthy();
    let targetContentTop = 1400;
    target.getBoundingClientRect = () => ({
      top: targetContentTop - sc.scrollTop,
      bottom: targetContentTop - sc.scrollTop + 28,
      left: 0,
      right: 800,
      width: 800,
      height: 28,
      x: 0,
      y: targetContentTop - sc.scrollTop,
      toJSON() {},
    });

    // Retain focus on the disclosure while an asynchronous navigation jump resolves and holds a landing below it.
    await act(async () => row.focus({ preventScroll: true }));
    await act(async () => {
      await nav.onJump!("seg:3@u#0");
    });

    const topBefore = sc.scrollTop;
    setRowTop(900 - topBefore);
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
    });
    expect(row.getAttribute("aria-expanded")).toBe("true");

    // Expansion pushes the old navigation target down while the disclosure header itself does not move.
    targetContentTop += 300;
    setScrollHeight(3400);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(sc.scrollTop).toBe(topBefore);

    // ArrowDown still cancels the disclosure anchor (reader movement).
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true }));
    });
    setRowTop(900 - topBefore + 60);
    setScrollHeight(3500);
    await act(async () => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    expect(sc.scrollTop).toBe(topBefore);
  });
});
