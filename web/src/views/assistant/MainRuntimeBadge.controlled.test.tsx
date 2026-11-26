// @vitest-environment jsdom
// Controlled MainRuntimeBadge bypasses store/manager/api/document singletons, caches fresh-object getters via sameValue,
// preserves render purity across abandoned concurrent renders, fences polling/visibility reloads across
// scopeKey/sid/main/machine/manager/chosen/conn/ABA/unmount, recovers via try/finally, and preserves default parity.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { MainExecution } from "../../lib/main-runtime";
import type { Conn } from "../../lib/store";
import type { MainRuntimeAssistant, MainRuntimeBadgeDeps, MainRuntimeBadgeViewProps, MainRuntimeFetchParams } from "./MainRuntimeBadge";

const mocks = vi.hoisted(() => ({
  assistant: { machine_id: "hub", main: "main-1", conversations: [] } as { machine_id: string; main?: string; main_machine_id?: string; conversations: unknown[] } | null,
  conn: "online" as Conn,
  shownManager: "assistant",
  chosenManager: null as string | null,
  useStore: vi.fn(),
  useShownManager: vi.fn(),
  useChosenManager: vi.fn(),
  api: vi.fn(),
}));

vi.mock("../../lib/store", async (original) => ({
  ...(await original<typeof import("../../lib/store")>()),
  useStore: (select: (s: { assistant: typeof mocks.assistant; conn: Conn }) => unknown) => {
    mocks.useStore();
    return select({ assistant: mocks.assistant, conn: mocks.conn });
  },
}));

vi.mock("../../lib/manager-choice", async (original) => ({
  ...(await original<typeof import("../../lib/manager-choice")>()),
  useShownManager: () => {
    mocks.useShownManager();
    return mocks.shownManager;
  },
  useChosenManager: () => {
    mocks.useChosenManager();
    return mocks.chosenManager;
  },
}));

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  api: (...args: unknown[]) => mocks.api(...args),
}));

const { MainRuntimeBadge, MainRuntimeBadgeView } = await import("./MainRuntimeBadge");

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const RUNNING_SUMMARY = `${t("main-runtime.main")} · ${t("main-runtime.running")}`;
const STOPPED_SUMMARY = t("main-runtime.stopped");

const expectNoDefaultSingletons = () => {
  expect(mocks.useStore).not.toHaveBeenCalled();
  expect(mocks.useShownManager).not.toHaveBeenCalled();
  expect(mocks.useChosenManager).not.toHaveBeenCalled();
  expect(mocks.api).not.toHaveBeenCalled();
};

const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });

let host: HTMLDivElement;
let root: Root;

const badge = () => host.querySelector<HTMLButtonElement>("[data-main-runtime]");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.assistant = { machine_id: "hub", main: "main-1", conversations: [] };
  mocks.conn = "online";
  mocks.shownManager = "assistant";
  mocks.chosenManager = null;
  mocks.useStore.mockReset();
  mocks.useShownManager.mockReset();
  mocks.useChosenManager.mockReset();
  mocks.api.mockReset();
  mocks.api.mockResolvedValue({ session_id: "main-1", state: "running" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("MainRuntimeBadgeView (pure presentation)", () => {
  it("renders summary with tooltip expansion/collapse and returns null for empty summary without touching singletons", async () => {
    const onToggle = vi.fn();
    const onCollapse = vi.fn();

    await act(async () => root.render(
      <MainRuntimeBadgeView summary="" expanded={false} onToggle={onToggle} onCollapse={onCollapse} />,
    ));
    expect(badge()).toBeNull();

    await act(async () => root.render(
      <MainRuntimeBadgeView summary={RUNNING_SUMMARY} expanded={false} onToggle={onToggle} onCollapse={onCollapse} />,
    ));
    expect(badge()?.getAttribute("aria-label")).toBe(RUNNING_SUMMARY);
    expect(badge()?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => { badge()!.click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);

    await act(async () => {
      badge()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onCollapse).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <MainRuntimeBadgeView summary={RUNNING_SUMMARY} expanded onToggle={onToggle} onCollapse={onCollapse} />,
    ));
    expect(badge()?.getAttribute("aria-expanded")).toBe("true");
    expectNoDefaultSingletons();
  });
});

describe("MainRuntimeBadge controlled mode, snapshot caching, polling/visibility fencing, and error recovery", () => {
  it("bypasses singletons and document visibility listener, caches fresh-object getters, and preserves DOM identity across direct-to-subscribed switch", async () => {
    const docAddSpy = vi.spyOn(document, "addEventListener");
    const listeners = new Set<() => void>();
    let subCount = 0;
    const subscribe = (l: () => void) => {
      subCount += 1;
      listeners.add(l);
      return () => { listeners.delete(l); };
    };
    let assistant: MainRuntimeAssistant = { main: "main-1", main_machine_id: "m1" };
    let conn: Conn = "online";
    let shown = "mgr-a";
    let chosen: string | null = "mgr-a";
    let vis: DocumentVisibilityState = "visible";
    let assistantReads = 0;
    const timers = new Map<number, () => void>();
    let nextTimerId = 0; // Start at 0 to verify falsy handle cleanup.
    const clearedIds: unknown[] = [];
    const fetchMainRuntime = vi.fn(async ({ main }: MainRuntimeFetchParams): Promise<MainExecution> => ({
      session_id: main,
      machine_id: "m1",
      state: "running",
    }));

    // Direct mode first.
    await act(async () => root.render(
      <StrictMode>
        <MainRuntimeBadge
          deps={{
            scopeKey: "s1",
            assistant,
            conn,
            shownManager: shown,
            chosenManager: chosen,
            documentVisibility: vis,
            fetchMainRuntime,
            pollIntervalMs: 500,
            setTimer: (fn) => {
              const id = nextTimerId++;
              timers.set(id, fn);
              return id;
            },
            clearTimer: (id) => {
              clearedIds.push(id);
              timers.delete(id as number);
            },
          }}
        />
      </StrictMode>,
    ));
    await flush();
    const initialBadge = badge()!;
    expect(initialBadge).not.toBeNull();
    expect(initialBadge.getAttribute("aria-label")).toBe(RUNNING_SUMMARY);
    expect(docAddSpy.mock.calls.filter(([evt]) => evt === "visibilitychange")).toHaveLength(0);
    expectNoDefaultSingletons();

    // Switch in-place to fresh-object getters + shared subscribe on the same scope/values.
    const makeGetterDeps = (): MainRuntimeBadgeDeps => ({
      scopeKey: () => "s1",
      assistant: () => {
        assistantReads += 1;
        return { ...assistant };
      },
      conn: () => conn,
      shownManager: () => shown,
      chosenManager: () => chosen,
      documentVisibility: () => vis,
      subscribe,
      fetchMainRuntime,
      pollIntervalMs: 500,
      setTimer: (fn) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (id) => {
        clearedIds.push(id);
        timers.delete(id as number);
      },
    });
    await act(async () => root.render(<StrictMode><MainRuntimeBadge deps={makeGetterDeps()} /></StrictMode>));
    expect(badge()).toBe(initialBadge);
    expect(assistantReads).toBeLessThan(20);

    // Inline arrow getters on re-render must not churn subscriptions.
    const subsAfterAttach = subCount;
    await act(async () => root.render(<StrictMode><MainRuntimeBadge deps={makeGetterDeps()} /></StrictMode>));
    expect(subCount).toBe(subsAfterAttach);

    // Identical re-emission does not loop.
    await act(async () => { listeners.forEach((l) => l()); });
    expect(assistantReads).toBeLessThan(30);

    // Unmount clears the falsy timer handle (0) cleanly.
    await act(async () => root.render(null));
    expect(clearedIds).toContain(0);
    expect(timers.size).toBe(0);
    expectNoDefaultSingletons();
  });

  it("defers loading while hidden, reloads on visibility change, and polls via injected timers", async () => {
    const visListeners = new Set<() => void>();
    let vis: DocumentVisibilityState = "hidden";
    const timers: Array<{ id: number; ms: number; fn: () => void }> = [];
    let nextId = 1;
    const cleared: unknown[] = [];
    let state: MainExecution["state"] = "running";
    const fetchMainRuntime = vi.fn(async ({ main }: MainRuntimeFetchParams): Promise<MainExecution> => ({
      session_id: main,
      state,
    }));

    await act(async () => root.render(
      <MainRuntimeBadge
        deps={{
          scopeKey: "s1",
          assistant: { main: "main-1" },
          conn: "online",
          shownManager: "assistant",
          chosenManager: null,
          documentVisibility: () => vis,
          subscribeVisibility: (l) => {
            visListeners.add(l);
            return () => { visListeners.delete(l); };
          },
          pollIntervalMs: 1234,
          setTimer: (fn, ms) => {
            const id = nextId++;
            timers.push({ id, ms, fn });
            return id;
          },
          clearTimer: (id) => { cleared.push(id); },
          fetchMainRuntime,
        }}
      />,
    ));
    await flush();

    // Hidden on mount: no fetch and no poll timer yet.
    expect(fetchMainRuntime).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
    expect(badge()).toBeNull();

    // Visibility becomes visible -> fetches immediately and schedules poll timer.
    vis = "visible";
    await act(async () => { visListeners.forEach((l) => l()); await flush(); });
    expect(fetchMainRuntime).toHaveBeenCalledTimes(1);
    expect(badge()?.getAttribute("aria-label")).toBe(RUNNING_SUMMARY);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1234);

    // Timer fires -> polls again and updates state.
    state = "stopped";
    await act(async () => { timers[0].fn(); await flush(); });
    expect(fetchMainRuntime).toHaveBeenCalledTimes(2);
    expect(badge()?.getAttribute("aria-label")).toBe(STOPPED_SUMMARY);

    // Unmount clears the latest scheduled timer.
    await act(async () => root.render(null));
    expect(cleared).toContain(timers.at(-1)!.id);
    expectNoDefaultSingletons();
  });

  it("fences in-flight polls across scopeKey, ABA bursts, sid, main, machine, manager, chosen, conn, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    let currentScope = "s1";
    const requests: Array<{ params: MainRuntimeFetchParams; gate: ReturnType<typeof deferred<MainExecution | undefined>> }> = [];
    const activeTimers = new Set<number>();
    let nextId = 1;
    const onError = vi.fn();

    const makeDeps = (overrides: Partial<MainRuntimeBadgeDeps> = {}): MainRuntimeBadgeDeps => ({
      scopeKey: () => currentScope,
      subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
      assistant: { main: "main-1", main_machine_id: "m1" },
      conn: "online",
      shownManager: "mgr-1",
      chosenManager: "mgr-1",
      documentVisibility: "visible",
      pollIntervalMs: 5000,
      setTimer: () => {
        const id = nextId++;
        activeTimers.add(id);
        return id;
      },
      clearTimer: (id) => { activeTimers.delete(id as number); },
      fetchMainRuntime: (params) => {
        const gate = deferred<MainExecution | undefined>();
        requests.push({ params, gate });
        return gate.promise;
      },
      onError,
      ...overrides,
    });

    await act(async () => root.render(<MainRuntimeBadge sid="main-1" deps={makeDeps()} />));
    expect(requests).toHaveLength(1);

    // Resolve initial load and expand tooltip.
    await act(async () => {
      requests[0].gate.resolve({ session_id: "main-1", machine_id: "m1", state: "running" });
      await flush();
    });
    expect(badge()?.getAttribute("aria-label")).toBe(RUNNING_SUMMARY);
    await act(async () => { badge()!.click(); });
    expect(badge()?.getAttribute("aria-expanded")).toBe("true");
    expect(activeTimers.size).toBe(1);

    // Trigger conn reconnect -> starts request[1] and clears previous timer.
    await act(async () => root.render(<MainRuntimeBadge sid="main-1" deps={makeDeps({ conn: "connecting" })} />));
    expect(requests).toHaveLength(2);

    // Synchronous ABA burst on scopeKey (s1 -> s2 -> s1): aborts request[1], clears badge & expanded, starts request[2].
    await act(async () => {
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
      currentScope = "s1";
      scopeListeners.forEach((l) => l());
    });
    expect(requests[1].params.signal.aborted).toBe(true);
    expect(requests).toHaveLength(3);
    expect(badge()).toBeNull();

    // Late resolution from aborted request[1] must NOT overwrite new epoch state.
    await act(async () => {
      requests[1].gate.resolve({ session_id: "main-1", machine_id: "m1", state: "stopped" });
      await flush();
    });
    expect(badge()).toBeNull();

    // Switch manager -> aborts request[2], starts request[3].
    await act(async () => root.render(<MainRuntimeBadge sid="main-1" deps={makeDeps({ shownManager: "mgr-2", chosenManager: "mgr-2" })} />));
    expect(requests[2].params.signal.aborted).toBe(true);
    expect(requests).toHaveLength(4);

    // Late resolution of request[2] for mgr-1 must NOT show under mgr-2.
    await act(async () => {
      requests[2].gate.resolve({ session_id: "main-1", machine_id: "m1", state: "running" });
      await flush();
    });
    expect(badge()).toBeNull();

    // Resolve request[3] for mgr-2 -> displays badge with expanded reset to false.
    await act(async () => {
      requests[3].gate.resolve({ session_id: "main-1", machine_id: "m1", state: "running" });
      await flush();
    });
    expect(badge()?.getAttribute("aria-expanded")).toBe("false");

    // Switching sid to a non-main conversation hides badge and clears timers.
    await act(async () => root.render(<MainRuntimeBadge sid="other-chat" deps={makeDeps({ shownManager: "mgr-2", chosenManager: "mgr-2" })} />));
    expect(badge()).toBeNull();
    expect(activeTimers.size).toBe(0);

    // Mount on new main and unmount while in-flight -> aborts signal and discards late error.
    await act(async () => root.render(<MainRuntimeBadge sid="main-2" deps={makeDeps({ assistant: { main: "main-2", main_machine_id: "m2" } })} />));
    const latest = requests.at(-1)!;
    expect(latest.params.main).toBe("main-2");
    expect(latest.params.machine).toBe("m2");
    await act(async () => root.render(null));
    expect(latest.params.signal.aborted).toBe(true);
    expect(activeTimers.size).toBe(0);
    await act(async () => {
      latest.gate.reject(new Error("late after unmount"));
      await flush();
    });
    expect(onError).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed scope and in-flight poll intact across an abandoned concurrent transition render", async () => {
    const suspendGate = deferred<void>();
    const fetchGate = deferred<MainExecution>();
    let capturedSignal: AbortSignal | null = null;
    const renderedScopes: string[] = [];

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    let setHarness!: (next: { scope: string; block: boolean }) => void;
    function Harness() {
      const [state, setState] = useState({ scope: "s1", block: false });
      setHarness = setState;
      renderedScopes.push(state.scope);
      return (
        <Suspense fallback={<div data-fallback />}>
          <MainRuntimeBadge
            deps={{
              scopeKey: state.scope,
              assistant: { main: "main-1" },
              conn: "online",
              shownManager: "assistant",
              chosenManager: null,
              documentVisibility: "visible",
              setTimer: () => 1,
              clearTimer: () => {},
              fetchMainRuntime: ({ signal }) => {
                capturedSignal = signal;
                return fetchGate.promise;
              },
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    expect(capturedSignal!.aborted).toBe(false);

    // Suspended transition to s2 must NOT abort s1's in-flight fetch.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);

    // Revert back to s1 and resolve -> badge renders cleanly.
    await act(async () => setHarness({ scope: "s1", block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => {
      fetchGate.resolve({ session_id: "main-1", state: "running" });
      await flush();
    });
    expect(badge()?.getAttribute("aria-label")).toBe(RUNNING_SUMMARY);
    expectNoDefaultSingletons();
  });

  it("recovers via try/finally after sync throws and async rejections (including throwing onError) and supports renderView", async () => {
    const scheduled: Array<() => void> = [];
    const errors: unknown[] = [];
    let mode: "sync-throw" | "async-reject" | "ok" = "sync-throw";
    let renderedView: MainRuntimeBadgeViewProps | null = null;

    await act(async () => root.render(
      <MainRuntimeBadge
        deps={{
          scopeKey: "s1",
          assistant: { main: "main-1" },
          conn: "online",
          shownManager: "assistant",
          chosenManager: null,
          documentVisibility: "visible",
          pollIntervalMs: 1000,
          setTimer: (fn) => {
            scheduled.push(fn);
            return scheduled.length;
          },
          clearTimer: () => {},
          fetchMainRuntime: ({ main }) => {
            if (mode === "sync-throw") throw new Error("sync fetch failed");
            if (mode === "async-reject") return Promise.reject(new Error("async fetch failed"));
            return Promise.resolve({ session_id: main, state: "running" });
          },
          onError: (err) => {
            errors.push(err);
            throw new Error("observer crashed");
          },
          renderView: (props) => {
            renderedView = props;
            return <div data-custom-runtime>{props.summary}</div>;
          },
        }}
      />,
    ));
    await flush();

    // Sync throw reports error, clears data, and still schedules next poll.
    expect(errors).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    expect(renderedView).toBeNull();

    // Async reject reports error and schedules next poll.
    mode = "async-reject";
    await act(async () => { scheduled[0](); await flush(); });
    expect(errors).toHaveLength(2);
    expect(scheduled).toHaveLength(2);

    // Next poll succeeds and renders through custom renderView.
    mode = "ok";
    await act(async () => { scheduled[1](); await flush(); });
    expect(renderedView!.summary).toBe(RUNNING_SUMMARY);
    expect(host.querySelector("[data-custom-runtime]")?.textContent).toBe(RUNNING_SUMMARY);
    expectNoDefaultSingletons();
  });

  it("preserves default singletons and document visibility listener when deps is omitted", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    await act(async () => root.render(<MainRuntimeBadge />));
    await flush();

    expect(mocks.useStore).toHaveBeenCalled();
    expect(mocks.useShownManager).toHaveBeenCalled();
    expect(mocks.useChosenManager).toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledWith("/assistant?view=main-runtime", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(badge()?.getAttribute("aria-label")).toBe(RUNNING_SUMMARY);
    expect(addSpy.mock.calls.some(([evt]) => evt === "visibilitychange")).toBe(true);

    await act(async () => root.render(null));
    expect(removeSpy.mock.calls.some(([evt]) => evt === "visibilitychange")).toBe(true);
  });
});
