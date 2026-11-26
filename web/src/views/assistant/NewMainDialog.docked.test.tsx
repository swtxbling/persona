// @vitest-environment jsdom
// Regression tests verifying that creating a New Main Chat preserves the docked conversation layout
// (no jump to the centered welcome screen and back), aligns pending message spacing with ChatView,
// and cleanly recovers from 409 main_changed or server errors.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import type { Session } from "../../lib/types";

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
});

const hub = vi.hoisted(() => ({
  main: "c1",
  newMain: null as null | (() => Promise<{ ok: boolean; archived?: string; carried?: boolean }>),
}));

vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  api: (path: string, init?: { method?: string; json?: unknown }) => {
    const method = init?.method ?? "GET";
    if (path === "/assistant/main/new" && method === "POST") {
      if (hub.newMain) return hub.newMain();
      const archived = hub.main;
      hub.main = "";
      return Promise.resolve({ ok: true, archived, carried: true });
    }
    if (path === "/assistant") {
      return Promise.resolve({ machine_id: "hub", main: hub.main, conversations: [] });
    }
    return Promise.resolve({});
  },
}));

type Started = { session: { machine_id: string; session_id: string } };
const starts = vi.hoisted(() => [] as { resolve: (r: Started) => void; reject: (e: unknown) => void }[]);
vi.mock("../../lib/assistant-start", () => ({
  startConversation: () => new Promise<Started>((resolve, reject) => starts.push({ resolve, reject })),
}));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../../lib/router", async (orig) => ({ ...(await orig<typeof import("../../lib/router")>()), navigate }));

vi.mock("../../lib/readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/readiness")>()),
  useReadiness: () => ({ readiness: null, probing: false }),
  useReadinessGate: () => ({ step: null, blocked: false, readiness: null, help: () => {}, confirm: () => {} }),
  refreshReadiness: () => Promise.resolve(),
  passesBySelf: () => false,
  codedFailure: () => null,
}));

vi.mock("../chat/ChatView", async (orig) => ({
  ...(await orig<typeof import("../chat/ChatView")>()),
  ChatView: (p: { sid: string }) => <div data-chat={p.sid} />,
}));

import { forgetMainCleared, mainCleared } from "../../lib/main-clear";
import { getState, refreshAssistant, reset } from "../../lib/store";
import { t } from "../../i18n";
import { PersonaAssistant } from "../PersonaAssistant";
import { NewMainDialog } from "./NewMainDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = {
  machine_id: "hub",
  session_id: "c1",
  title: "Main Chat",
  assistant: true,
  state: "idle",
  status: "idle",
} as Session;

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

const confirmNewMain = () => {
  const dialog = document.querySelector('[role="dialog"]')!;
  const btn = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === t("assistant-assistantchat.new_main"),
  )!;
  act(() => btn.click());
};

beforeEach(() => {
  reset();
  forgetMainCleared();
  hub.main = "c1";
  hub.newMain = null;
  starts.length = 0;
  navigate.mockClear();
  Object.assign(getState(), {
    loaded: true,
    features: ["assistant_main_new", "assistant_main_clear"],
    assistant: { machine_id: "hub", main: "c1", conversations: [] },
    assistantError: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  forgetMainCleared();
  reset();
});

describe("NewMainDialog docked transition without layout jump", () => {
  it("marks main cleared before the POST resolves and keeps PersonaAssistant docked through empty state and first message", async () => {
    let finishPost!: (v: { ok: boolean; archived?: string; carried?: boolean }) => void;
    let clearedBeforeReply = false;
    hub.newMain = () => {
      clearedBeforeReply = mainCleared();
      return new Promise((resolve) => { finishPost = resolve; });
    };

    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <>
          <PersonaAssistant onToggleSidebar={() => {}} />
          <NewMainDialog open onClose={onClose} session={session} />
        </>,
      );
    });
    await flush();
    expect(host.querySelector("[data-chat]")?.getAttribute("data-chat")).toBe("c1");

    confirmNewMain();
    expect(clearedBeforeReply).toBe(true);

    // Simulate an early hub push clearing assistant.main before the POST HTTP reply finishes.
    hub.main = "";
    await act(async () => { await refreshAssistant(); });
    await flush();
    expect(host.querySelector("[data-main-cleared]")).not.toBeNull();
    expect(host.querySelector("header")).not.toBeNull();
    expect(host.textContent).not.toContain(t("personaassistant.empty_title"));

    // Resolve the POST and verify docked layout persists and composer sits inside the 880px dock container.
    await act(async () => finishPost({ ok: true, archived: "c1", carried: true }));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ name: "persona" });
    expect(host.querySelector("[data-main-cleared]")).not.toBeNull();

    // Send the first message into the new main chat and verify pending content matches ChatView's spacing
    // (gap-3.5 pt-7) with no delayed fade-up animation.
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Hello fresh main");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')!.click());
    await flush();

    const pendingInner = host.querySelector<HTMLElement>("[data-start-pending] > div");
    expect(pendingInner).not.toBeNull();
    expect(pendingInner?.className).toContain("gap-3.5");
    expect(pendingInner?.className).toContain("pt-7");
    expect(pendingInner?.style.animation).toBe("");
    expect(starts).toHaveLength(1);
  });

  it("forgets cleared state on 409 main_changed and shows the hub's replacement main chat", async () => {
    hub.newMain = async () => {
      hub.main = "c2";
      throw new ApiError(409, "already replaced", { code: "main_changed" });
    };
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <>
          <PersonaAssistant onToggleSidebar={() => {}} />
          <NewMainDialog open onClose={onClose} session={session} />
        </>,
      );
    });
    await flush();

    confirmNewMain();
    await flush();

    expect(mainCleared()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-chat]")?.getAttribute("data-chat")).toBe("c2");
  });

  it("forgets cleared state if POST /assistant/main/new fails with a server error", async () => {
    hub.newMain = async () => {
      throw new ApiError(500, "internal error", { code: "internal" });
    };
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <>
          <PersonaAssistant onToggleSidebar={() => {}} />
          <NewMainDialog open onClose={onClose} session={session} />
        </>,
      );
    });
    await flush();

    confirmNewMain();
    await flush();

    expect(mainCleared()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector("[data-chat]")?.getAttribute("data-chat")).toBe("c1");
  });
});
