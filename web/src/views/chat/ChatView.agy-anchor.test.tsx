// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item, Session } from "../../lib/types";

const roCallbacks = vi.hoisted(() => new Set<ResizeObserverCallback>());

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
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
});
