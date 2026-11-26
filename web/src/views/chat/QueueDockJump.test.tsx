// @vitest-environment jsdom
// Regression tests verifying that queued messages and AssistantActionBar trays float above the dock without
// resizing the composer card or shifting the chat scroll container.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item, Session } from "../../lib/types";

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
});

const transcript = vi.hoisted(() => ({ items: [] as Item[], loading: false, error: "", hasMore: false, streaming: "" }));
vi.mock("./useTranscript", () => ({ useTranscript: () => transcript }));
vi.mock("../../lib/panel", async (importOriginal) => ({ ...await importOriginal<typeof import("../../lib/panel")>(), usePanel: () => null }));
vi.mock("../../lib/router", async (importOriginal) => ({ ...await importOriginal<typeof import("../../lib/router")>(), useRoute: () => ({ name: "persona", sid: "c1" }) }));
vi.mock("../assistant/Persona", () => ({ usePersona: () => ({ name: "Persona" }) }));

const { ChatView } = await import("./ChatView");
const { getState, reset, upsertSession } = await import("../../lib/store");
const { loadPages } = await import("../../lib/lazy-page");
await loadPages();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const setSession = (overrides: Partial<Session>) => {
  act(() => {
    upsertSession({
      machine_id: "hub",
      session_id: "c1",
      title: "Main Chat",
      status: "working",
      state: "working",
      assistant: true,
      agent: "claude",
      queued: [],
      ...overrides,
    } as Session);
  });
};

beforeEach(() => {
  localStorage.clear();
  transcript.items = [];
  Object.assign(getState(), {
    assistant: { machine_id: "hub", main: "c1", conversations: [] },
    interactions: [],
    answered: {},
  });
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

describe("floating chat queue and action-bar overlays", () => {
  it("mounts the assistant queue as a single-line capsule inside the action bar across 0 -> 1 -> 3 -> 5 -> 1 -> 0", async () => {
    setSession({ queued: [] });
    act(() => root.render(<ChatView mid="hub" sid="c1" assistant onToggleSidebar={() => {}} />));
    await flush();

    const dockBar = () => host.querySelector<HTMLElement>("[data-chat-dock-bar]")!;
    const bar = () => host.querySelector<HTMLElement>("[data-assistant-actionbar]")!;
    const dockAbove = () => host.querySelector<HTMLElement>("[data-chat-dock-above]")!;
    const composerTop = () => host.querySelector("[data-composer-top]");

    expect(dockBar()).not.toBeNull();
    expect(dockBar().className).toContain("relative");
    expect(dockBar().className).toContain("shrink-0");
    expect(bar()).not.toBeNull();
    expect(dockAbove().contains(bar())).toBe(false);
    expect(bar().className).toContain("shrink-0");
    expect(host.querySelector("[data-queue-panel]")).toBeNull();

    for (const count of [1, 3, 5, 1]) {
      const queued = Array.from({ length: count }, (_, i) => `Queued item #${i + 1}`);
      setSession({ queued });
      await flush();

      const panel = host.querySelector<HTMLElement>("[data-queue-panel]");
      const toggle = host.querySelector<HTMLButtonElement>("[data-queue-toggle]");
      const popover = host.querySelector<HTMLElement>("[data-queue-popover]");

      expect(panel).not.toBeNull();
      expect(dockBar().contains(panel)).toBe(true);
      expect(composerTop()).toBeNull();
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(toggle?.className).toContain("h-7");
      expect(popover?.hidden).toBe(true);
      expect(popover?.className).toContain("absolute");
    }

    setSession({ queued: [] });
    await flush();
    expect(host.querySelector("[data-queue-panel]")).toBeNull();
  });

  it("opens the queue popover without entering dock flow, closes on Escape without bubbling, and coordinates with action trays", async () => {
    setSession({ queued: ["One", "Two", "Three", "Four", "Five"] });
    act(() => root.render(<ChatView mid="hub" sid="c1" assistant onToggleSidebar={() => {}} />));
    await flush();

    const toggle = host.querySelector<HTMLButtonElement>("[data-queue-toggle]")!;
    const popover = host.querySelector<HTMLElement>("[data-queue-popover]")!;
    const needs = host.querySelector<HTMLButtonElement>('[data-tray-entry="needs"]')!;

    // Open Needs you tray first; action bar remains shrink-0 and tray is positioned as overlay.
    act(() => needs.click());
    expect(host.querySelector("section.assistant-action-tray")).not.toBeNull();
    expect(host.querySelector("[data-assistant-actionbar]")?.classList.contains("shrink-0")).toBe(true);

    // Clicking the queue toggle closes the open tray and opens the floating queue popover.
    act(() => toggle.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    act(() => toggle.click());
    expect(host.querySelector("section.assistant-action-tray")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(popover.hidden).toBe(false);

    // Expanding the fold inside the popover reveals all 5 items while keeping the popover floating.
    const fold = popover.querySelector<HTMLButtonElement>("[data-queue-fold]")!;
    expect(popover.querySelectorAll("[data-queue-row]")).toHaveLength(3);
    act(() => fold.click());
    expect(popover.querySelectorAll("[data-queue-row]")).toHaveLength(5);
    expect(popover.className).toContain("absolute");

    // Escape closes the queue popover without letting the event reach window (which would interrupt the turn).
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    try {
      act(() => void fold.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(popover.hidden).toBe(true);
      expect(windowEsc).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowEsc);
    }

    // Outside pointerdown also closes an open queue popover.
    act(() => toggle.click());
    expect(popover.hidden).toBe(false);
    act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(popover.hidden).toBe(true);
  });

  it("mounts an agent chat's queue as a floating strip outside dockAbove and composer top", async () => {
    setSession({ assistant: false, queued: ["Agent follow-up 1", "Agent follow-up 2"] });
    act(() => root.render(<ChatView mid="hub" sid="c1" onToggleSidebar={() => {}} />));
    await flush();

    const dockAbove = host.querySelector<HTMLElement>("[data-chat-dock-above]")!;
    const panel = host.querySelector<HTMLElement>("[data-queue-panel][data-queue-strip]")!;
    const popover = host.querySelector<HTMLElement>("[data-queue-popover]")!;

    expect(panel).not.toBeNull();
    expect(dockAbove.contains(panel)).toBe(false);
    expect(host.querySelector("[data-composer-top]")).toBeNull();
    expect(popover.hidden).toBe(true);
    expect(popover.className).toContain("absolute");
  });
});
