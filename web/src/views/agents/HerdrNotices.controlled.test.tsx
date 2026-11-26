// @vitest-environment jsdom
// Controlled HerdrNotices decouples store/watch/visibility/clipboard/timer singletons, caches fresh snapshots via
// sameValue, preserves render purity across abandoned concurrent renders, fences poll/start/copy and failure menus
// across scope switches, machine-set changes, ABA bursts, and unmount, recovers via try/finally, and preserves defaults.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { HerdrFailure, HerdrSnapshot } from "../../lib/herdr-notice";
import type { Machine } from "../../lib/types";
import type { HerdrNoticesDeps } from "./HerdrNotices";

const mocks = vi.hoisted(() => ({
  storeMachines: [] as Machine[],
  storeListeners: new Set<() => void>(),
  useStore: vi.fn(),
  herdrRead: vi.fn(),
  herdrStart: vi.fn(),
  copyText: vi.fn(),
}));

vi.mock("../../lib/store", async (original) => {
  const real = await original<typeof import("../../lib/store")>();
  const { useSyncExternalStore } = await import("react");
  return {
    ...real,
    useStore: <T,>(select: (s: ReturnType<typeof real.getState>) => T): T => {
      mocks.useStore();
      return useSyncExternalStore(
        (l) => {
          mocks.storeListeners.add(l);
          return () => { mocks.storeListeners.delete(l); };
        },
        () => select({ ...real.getState(), machines: mocks.storeMachines }),
      );
    },
  };
});

vi.mock("../../lib/herdr-notice", async (original) => {
  const real = await original<typeof import("../../lib/herdr-notice")>();
  class TrackedHerdrWatch extends real.HerdrWatch {
    constructor(hub = { read: mocks.herdrRead, start: mocks.herdrStart }) {
      super(hub);
    }
  }
  return {
    ...real,
    HerdrWatch: TrackedHerdrWatch,
  };
});

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  copyText: (text: string) => mocks.copyText(text),
}));

const { HerdrNoticeRowView, HerdrNotices, HerdrNoticesView } = await import("./HerdrNotices");

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const M1: Machine = { id: "m1", name: "Studio", online: true };
const M2: Machine = { id: "m2", name: "Laptop", online: true };
const FAIL1: HerdrFailure = { text: "port busy", detail: "port busy\nHTTP 500\nRequest r-1" };

const expectNoDefaultSingletons = () => {
  expect(mocks.useStore).not.toHaveBeenCalled();
  expect(mocks.herdrRead).not.toHaveBeenCalled();
  expect(mocks.herdrStart).not.toHaveBeenCalled();
  expect(mocks.copyText).not.toHaveBeenCalled();
};

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await Promise.resolve(); });
  }
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  mocks.useStore.mockReset();
  mocks.herdrRead.mockReset();
  mocks.herdrStart.mockReset();
  mocks.copyText.mockReset();
  mocks.storeListeners.clear();
  mocks.storeMachines = [M1];
  mocks.herdrRead.mockResolvedValue({ autostart: false, running: false, known: true });
  mocks.herdrStart.mockResolvedValue({ autostart: false, running: true, known: true });
  mocks.copyText.mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Pure presentational HerdrNotices views", () => {
  it("renders HerdrNoticesView and HerdrNoticeRowView without touching singletons", async () => {
    const onStart = vi.fn();
    const onCopyDetail = vi.fn();
    const onOpenMenu = vi.fn();
    const onCloseMenu = vi.fn();

    await act(async () => root.render(
      <HerdrNoticesView
        rows={[]}
        onStart={onStart}
        onCopyDetail={onCopyDetail}
        onOpenMenu={onOpenMenu}
        onCloseMenu={onCloseMenu}
      />,
    ));
    expect(host.innerHTML).toBe("");

    await act(async () => root.render(
      <HerdrNoticesView
        rows={[
          { machine: M1, starting: false, failure: FAIL1 },
          { machine: M2, starting: true },
        ]}
        openMenu={{ machineId: M1.id, at: { point: { x: 10, y: 20 } } }}
        onStart={onStart}
        onCopyDetail={onCopyDetail}
        onOpenMenu={onOpenMenu}
        onCloseMenu={onCloseMenu}
      />,
    ));
    const notices = host.querySelectorAll('[data-testid="herdr-notice"]');
    expect(notices).toHaveLength(2);
    expect(notices[0].textContent).toContain("Studio");
    expect(notices[0].textContent).toContain("port busy");
    expect(notices[1].textContent).toContain("Laptop");

    const startBtn = notices[0].querySelector<HTMLButtonElement>("button:not([aria-label])")!;
    await act(async () => startBtn.click());
    expect(onStart).toHaveBeenCalledWith(M1.id);

    const copyBtn = notices[0].querySelector<HTMLButtonElement>(`button[aria-label="${t("herdr-notice.copy_detail")}"]`)!;
    await act(async () => copyBtn.click());
    expect(onCopyDetail).toHaveBeenCalledWith(FAIL1.detail, M1.id);

    // Direct HerdrNoticeRowView renders cleanly as well.
    await act(async () => root.render(
      <HerdrNoticeRowView
        machine={M1}
        starting={false}
        failure={FAIL1}
        onStart={() => onStart("row")}
        onCopyDetail={(d) => onCopyDetail(d, "row")}
      />,
    ));
    expect(host.querySelector('[data-testid="herdr-notice-failure"]')?.textContent).toContain("port busy");
    expectNoDefaultSingletons();
  });
});

describe("Controlled HerdrNotices getter caching, direct-to-subscribed transitions, and custom timers/visibility", () => {
  it("caches fresh-array/Set/Map getters without infinite re-renders, avoids subscription churn, and preserves open failure menu across direct-to-subscribed switch", async () => {
    const machineListeners = new Set<() => void>();
    const snapListeners = new Set<() => void>();
    const scopeListeners = new Set<() => void>();
    const visListeners = new Set<() => void>();
    const docAddSpy = vi.spyOn(document, "addEventListener");
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const refreshSpy = vi.fn();

    const makeSnap = (): HerdrSnapshot => ({
      stopped: new Set([M1.id]),
      starting: new Set(),
      failures: new Map([[M1.id, { ...FAIL1 }]]),
    });

    await act(async () => root.render(
      <StrictMode>
        <HerdrNotices
          deps={{
            scopeKey: "s1",
            machines: [M1],
            snapshot: makeSnap(),
            documentVisibility: "hidden",
            pollIntervalMs: 1234,
            setInterval: (fn, ms) => {
              const handle = { fn, ms, cleared: false };
              timers.push(handle);
              return handle;
            },
            clearInterval: (id) => {
              (id as { cleared: boolean }).cleared = true;
            },
            refresh: refreshSpy,
            copyText: vi.fn(),
          }}
        />
      </StrictMode>,
    ));

    // Hidden visibility skips initial poll and does not attach document visibility listener.
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(docAddSpy.mock.calls.filter(([ev]) => ev === "visibilitychange")).toHaveLength(0);
    expect(timers.some((tm) => tm.ms === 1234)).toBe(true);

    // Open the failure context menu in direct mode.
    const failureSpan = host.querySelector<HTMLElement>('[data-testid="herdr-notice-failure"]')!;
    await act(async () => {
      failureSpan.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 25, clientY: 30 }));
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // Switch in-place from direct props to subscribed fresh-reference getters on the same scope.
    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const subscribeMachines = vi.fn((l: () => void) => { machineListeners.add(l); return () => { machineListeners.delete(l); }; });
    const subscribeSnapshot = vi.fn((l: () => void) => { snapListeners.add(l); return () => { snapListeners.delete(l); }; });
    const subscribeVisibility = vi.fn((l: () => void) => { visListeners.add(l); return () => { visListeners.delete(l); }; });
    let vis: DocumentVisibilityState = "hidden";

    const renderSub = () => root.render(
      <StrictMode>
        <HerdrNotices
          deps={{
            scopeKey: () => "s1",
            subscribeScopeKey,
            machines: () => [{ ...M1 }],
            subscribeMachines,
            snapshot: () => makeSnap(),
            subscribeSnapshot,
            documentVisibility: () => vis,
            subscribeVisibility,
            pollIntervalMs: 1234,
            setInterval: (fn, ms) => {
              const handle = { fn, ms, cleared: false };
              timers.push(handle);
              return handle;
            },
            clearInterval: (id) => {
              (id as { cleared: boolean }).cleared = true;
            },
            refresh: refreshSpy,
            copyText: vi.fn(),
          }}
        />
      </StrictMode>,
    );

    await act(async () => renderSub());
    // Failure menu survives direct -> subscribed transition on the same scope.
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // Inline arrow getters must not churn subscriptions on re-render.
    const scopeCalls = subscribeScopeKey.mock.calls.length;
    const machCalls = subscribeMachines.mock.calls.length;
    const snapCalls = subscribeSnapshot.mock.calls.length;
    await act(async () => renderSub());
    await act(async () => renderSub());
    expect(subscribeScopeKey).toHaveBeenCalledTimes(scopeCalls);
    expect(subscribeMachines).toHaveBeenCalledTimes(machCalls);
    expect(subscribeSnapshot).toHaveBeenCalledTimes(snapCalls);

    // Equal snapshot re-emission stays stable without error.
    await act(async () => { snapListeners.forEach((l) => l()); });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // Controlled visibility becoming visible triggers immediate poll via subscribeVisibility.
    vis = "visible";
    await act(async () => { visListeners.forEach((l) => l()); });
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // Active custom interval triggers next poll.
    const activeTimer = timers.filter((tm) => !tm.cleared).at(-1)!;
    await act(async () => activeTimer.fn());
    expect(refreshSpy).toHaveBeenCalledTimes(2);
    expectNoDefaultSingletons();
  });

  it("supports renderView override and direct documentVisibility hidden-to-visible transition", async () => {
    const refreshSpy = vi.fn();
    const renderedCounts: number[] = [];
    const snap: HerdrSnapshot = { stopped: new Set([M1.id]), starting: new Set(), failures: new Map() };
    const baseDeps: HerdrNoticesDeps = {
      machines: [M1],
      snapshot: snap,
      refresh: refreshSpy,
      setInterval: () => 1,
      clearInterval: () => {},
      renderView: (props) => {
        renderedCounts.push(props.rows.length);
        return <div data-custom-herdr={props.rows.length} />;
      },
    };

    await act(async () => root.render(<HerdrNotices deps={{ ...baseDeps, documentVisibility: "hidden" }} />));
    expect(host.querySelector("[data-custom-herdr]")?.getAttribute("data-custom-herdr")).toBe("1");
    expect(refreshSpy).not.toHaveBeenCalled();

    await act(async () => root.render(<HerdrNotices deps={{ ...baseDeps, documentVisibility: "visible" }} />));
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(renderedCounts.at(-1)).toBe(1);
    expectNoDefaultSingletons();
  });
});

describe("Scope, machine-set, ABA, unmount fencing, concurrent render purity, and try/finally recovery", () => {
  it("aborts and fences poll/start/copy and closes failure menu across scope switch, ABA bursts, machine removal, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    const machineListeners = new Set<() => void>();
    const snapListeners = new Set<() => void>();
    let currentScope = "s1";
    let machinesList: Machine[] = [M1];
    let currentSnap: HerdrSnapshot = {
      stopped: new Set([M1.id]),
      starting: new Set(),
      failures: new Map([[M1.id, FAIL1]]),
    };
    const onError = vi.fn();

    const refreshCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];
    const startCalls: Array<{ id: string; signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];
    const copyCalls: Array<{ text: string; signal: AbortSignal; gate: ReturnType<typeof deferred<boolean>> }> = [];
    const timers: Array<{ id: number; cleared: boolean }> = [];

    const deps: HerdrNoticesDeps = {
      scopeKey: () => currentScope,
      subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
      machines: () => machinesList.map((m) => ({ ...m })),
      subscribeMachines: (l) => { machineListeners.add(l); return () => { machineListeners.delete(l); }; },
      snapshot: () => ({
        stopped: new Set(currentSnap.stopped),
        starting: new Set(currentSnap.starting),
        failures: new Map(currentSnap.failures),
      }),
      subscribeSnapshot: (l) => { snapListeners.add(l); return () => { snapListeners.delete(l); }; },
      documentVisibility: "visible",
      setInterval: () => {
        const entry = { id: timers.length + 1, cleared: false };
        timers.push(entry);
        return entry;
      },
      clearInterval: (h) => { (h as { cleared: boolean }).cleared = true; },
      refresh: (_w, signal) => {
        const gate = deferred<void>();
        refreshCalls.push({ signal, gate });
        return gate.promise;
      },
      start: (id, signal) => {
        const gate = deferred<void>();
        startCalls.push({ id, signal, gate });
        return gate.promise;
      },
      copyText: (text, signal) => {
        const gate = deferred<boolean>();
        copyCalls.push({ text, signal, gate });
        return gate.promise;
      },
      onError,
    };

    await act(async () => root.render(<HerdrNotices deps={deps} />));
    expect(refreshCalls).toHaveLength(1);

    // Open menu, trigger start & copy.
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="herdr-notice-failure"]')!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      );
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="herdr-notice"] button:not([aria-label])')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("herdr-notice.copy_detail")}"]`)!.click());
    expect(startCalls).toHaveLength(1);
    expect(copyCalls).toHaveLength(1);

    // Scope switch s1 -> s2 aborts poll, start, copy and closes failure menu.
    currentScope = "s2";
    await act(async () => { scopeListeners.forEach((l) => l()); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(refreshCalls[0].signal.aborted).toBe(true);
    expect(startCalls[0].signal.aborted).toBe(true);
    expect(copyCalls[0].signal.aborted).toBe(true);
    expect(refreshCalls).toHaveLength(2);

    // Late rejections from s1 must be discarded.
    refreshCalls[0].gate.reject(new Error("stale poll"));
    startCalls[0].gate.reject(new Error("stale start"));
    copyCalls[0].gate.reject(new Error("stale copy"));
    await flush();
    expect(onError).not.toHaveBeenCalled();

    // Start op in s2 + open menu, then synchronous ABA scope burst s2 -> s3 -> s2.
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="herdr-notice-failure"]')!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      );
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="herdr-notice"] button:not([aria-label])')!.click());
    expect(startCalls).toHaveLength(2);

    await act(async () => {
      currentScope = "s3";
      scopeListeners.forEach((l) => l());
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(refreshCalls[1].signal.aborted).toBe(true);
    expect(startCalls[1].signal.aborted).toBe(true);

    // Row disappearance closes menu and aborts machine-set poll + start; row reappearance (ABA) does NOT reopen menu.
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="herdr-notice-failure"]')!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      );
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="herdr-notice"] button:not([aria-label])')!.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    const pollBeforeRemoval = refreshCalls.at(-1)!;
    const startBeforeRemoval = startCalls.at(-1)!;

    machinesList = [{ ...M1, online: false }];
    await act(async () => { machineListeners.forEach((l) => l()); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(pollBeforeRemoval.signal.aborted).toBe(true);
    expect(startBeforeRemoval.signal.aborted).toBe(true);

    machinesList = [M1];
    await act(async () => { machineListeners.forEach((l) => l()); });
    expect(document.querySelector('[role="menu"]')).toBeNull();

    // Unmount aborts active poll and clears timer.
    const lastPoll = refreshCalls.at(-1)!;
    await act(async () => root.render(null));
    expect(lastPoll.signal.aborted).toBe(true);
    expect(timers.every((tm) => tm.cleared)).toBe(true);
    lastPoll.gate.reject(new Error("unmounted poll"));
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed menu and in-flight start intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const startGate = deferred<void>();
    let startSignal: AbortSignal | null = null;
    const onError = vi.fn();
    const renderedScopes: string[] = [];
    const snap: HerdrSnapshot = {
      stopped: new Set([M1.id]),
      starting: new Set(),
      failures: new Map([[M1.id, FAIL1]]),
    };

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    let setState!: (next: { scope: string; block: boolean }) => void;
    function Harness() {
      const [s, setS] = useState({ scope: "s1", block: false });
      setState = setS;
      renderedScopes.push(s.scope);
      return (
        <Suspense fallback={<div data-fallback />}>
          <HerdrNotices
            deps={{
              scopeKey: s.scope,
              machines: [M1],
              snapshot: snap,
              documentVisibility: "hidden",
              setInterval: () => 1,
              clearInterval: () => {},
              start: (_id, signal) => {
                startSignal = signal;
                return startGate.promise;
              },
              onError,
            }}
          />
          <SuspendIf block={s.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="herdr-notice-failure"]')!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 15, clientY: 15 }),
      );
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="herdr-notice"] button:not([aria-label])')!.click());
    expect(startSignal!.aborted).toBe(false);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // Abandoned concurrent transition to s2 must NOT abort s1's start or close s1's menu.
    await act(async () => {
      startTransition(() => setState({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(startSignal!.aborted).toBe(false);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // Abandon back to s1 and reject startGate: error still lands cleanly in s1.
    await act(async () => setState({ scope: "s1", block: false }));
    expect(startSignal!.aborted).toBe(false);
    startGate.reject(new Error("start failed"));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("recovers via try/finally on sync throws and async rejections for refresh, start, and copyText", async () => {
    const errors: string[] = [];
    let pollMode: "sync" | "async" | "ok" = "sync";
    let startMode: "sync" | "async" | "ok" = "sync";
    let copyMode: "sync" | "async" | "ok" = "sync";
    let tick!: () => void;
    const pollCounts = { total: 0 };
    const startCounts = { total: 0 };
    const copyCounts = { total: 0 };

    await act(async () => root.render(
      <HerdrNotices
        deps={{
          machines: [M1],
          snapshot: { stopped: new Set([M1.id]), starting: new Set(), failures: new Map([[M1.id, FAIL1]]) },
          documentVisibility: "visible",
          setInterval: (fn) => { tick = fn; return 1; },
          clearInterval: () => {},
          refresh: () => {
            pollCounts.total += 1;
            if (pollMode === "sync") throw new Error("poll sync");
            if (pollMode === "async") return Promise.reject(new Error("poll async"));
            return Promise.resolve();
          },
          start: () => {
            startCounts.total += 1;
            if (startMode === "sync") throw new Error("start sync");
            if (startMode === "async") return Promise.reject(new Error("start async"));
            return Promise.resolve();
          },
          copyText: () => {
            copyCounts.total += 1;
            if (copyMode === "sync") throw new Error("copy sync");
            if (copyMode === "async") return Promise.reject(new Error("copy async"));
            return Promise.resolve(true);
          },
          onError: (e) => { errors.push(e instanceof Error ? e.message : String(e)); },
        }}
      />,
    ));
    expect(errors).toEqual(["poll sync"]);

    pollMode = "async";
    await act(async () => tick());
    await flush();
    expect(errors).toEqual(["poll sync", "poll async"]);

    pollMode = "ok";
    await act(async () => tick());
    await flush();
    expect(pollCounts.total).toBe(3);

    const startBtn = () => host.querySelector<HTMLButtonElement>('[data-testid="herdr-notice"] button:not([aria-label])')!;
    await act(async () => startBtn().click());
    startMode = "async";
    await act(async () => startBtn().click());
    await flush();
    startMode = "ok";
    await act(async () => startBtn().click());
    await flush();
    expect(startCounts.total).toBe(3);

    const copyBtn = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("herdr-notice.copy_detail")}"]`)!;
    await act(async () => copyBtn().click());
    copyMode = "async";
    await act(async () => copyBtn().click());
    await flush();
    copyMode = "ok";
    await act(async () => copyBtn().click());
    await flush();
    expect(copyCounts.total).toBe(3);
    expect(errors).toEqual(["poll sync", "poll async", "start sync", "start async", "copy sync", "copy async"]);
    expectNoDefaultSingletons();
  });

  it("preserves default store, HerdrWatch, and copyText behavior when deps is omitted", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mocks.herdrStart.mockRejectedValueOnce(new Error("cannot launch"));

    await act(async () => root.render(<HerdrNotices />));
    await flush();
    expect(mocks.useStore).toHaveBeenCalled();
    expect(mocks.herdrRead).toHaveBeenCalledWith(M1.id);
    expect(host.querySelector('[data-testid="herdr-notice"]')?.textContent).toContain("Studio");

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="herdr-notice"] button:not([aria-label])')!.click());
    await flush();
    expect(mocks.herdrStart).toHaveBeenCalledWith(M1.id);
    expect(host.querySelector('[data-testid="herdr-notice-failure"]')?.textContent).toContain("cannot launch");

    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("herdr-notice.copy_detail")}"]`)!.click());
    expect(mocks.copyText).toHaveBeenCalledWith("cannot launch");
  });
});
