// @vitest-environment jsdom
// Controlled HubNoticeLine decouples hubUpdate/onHubEvent/localStorage/router/toast singletons, caches dismissed
// getters via sameValue, preserves sequence fencing (hub_update pushes invalidate older GETs), fences actions across
// scope/ABA/unmount, preserves concurrent render purity, recovers via try/finally, and preserves default behavior.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubUpdateStatus } from "../../lib/hub-update";
import type { HubNoticeLineDeps } from "./HubNoticeRow";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(m: Record<string, unknown>) => void>>(),
  onHubEvent: vi.fn(),
  hubUpdate: vi.fn(),
  startHubUpdate: vi.fn(),
  setHubUpdateSettings: vi.fn(),
  dismissedHubNotices: vi.fn(),
  dismissHubNotice: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/hub-update", async (original) => {
  const real = await original<typeof import("../../lib/hub-update")>();
  return {
    ...real,
    hubUpdate: () => mocks.hubUpdate(),
    startHubUpdate: (now: boolean) => mocks.startHubUpdate(now),
    setHubUpdateSettings: (s: Record<string, unknown>) => mocks.setHubUpdateSettings(s),
    dismissedHubNotices: () => mocks.dismissedHubNotices(),
    dismissHubNotice: (key: string) => mocks.dismissHubNotice(key),
  };
});

vi.mock("../../lib/store", async (original) => ({
  ...(await original<typeof import("../../lib/store")>()),
  onHubEvent: (type: string, l: (m: Record<string, unknown>) => void) => {
    mocks.onHubEvent(type);
    if (!mocks.listeners.has(type)) mocks.listeners.set(type, new Set());
    mocks.listeners.get(type)!.add(l);
    return () => { mocks.listeners.get(type)?.delete(l); };
  },
}));

vi.mock("../../lib/router", async (original) => ({
  ...(await original<typeof import("../../lib/router")>()),
  navigate: (to: string) => mocks.navigate(to),
}));

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  toast: (msg: string, tone?: string) => mocks.toast(msg, tone),
}));

const { HubNoticeLine, HubNoticeLineView, HubNoticeView } = await import("./HubNoticeRow");

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const BASE: HubUpdateStatus = {
  version: "1.0.0",
  build: 1,
  channel: "release",
  can_update: true,
  busy: [],
  auto: false,
  auto_notice: false,
  confirmed: true,
  state: "idle",
};
const AVAILABLE: HubUpdateStatus = {
  ...BASE,
  latest: { version: "1.1.0", build: 2, newer: true, bad: false },
};
const AUTO_ON: HubUpdateStatus = {
  ...BASE,
  auto: true,
  auto_notice: true,
};
const DOWNLOADING: HubUpdateStatus = {
  ...AVAILABLE,
  state: "downloading",
};

const expectNoDefaultSingletons = () => {
  expect(mocks.onHubEvent).not.toHaveBeenCalled();
  expect(mocks.hubUpdate).not.toHaveBeenCalled();
  expect(mocks.startHubUpdate).not.toHaveBeenCalled();
  expect(mocks.setHubUpdateSettings).not.toHaveBeenCalled();
  expect(mocks.dismissedHubNotices).not.toHaveBeenCalled();
  expect(mocks.dismissHubNotice).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
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
  Object.values(mocks).forEach((v) => {
    if (typeof v === "function") v.mockReset();
  });
  mocks.listeners.clear();
  mocks.dismissedHubNotices.mockReturnValue([]);
  mocks.dismissHubNotice.mockImplementation((key: string) => [key]);
  mocks.hubUpdate.mockResolvedValue(AVAILABLE);
  mocks.startHubUpdate.mockResolvedValue(DOWNLOADING);
  mocks.setHubUpdateSettings.mockResolvedValue(BASE);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Pure presentational HubNoticeView / HubNoticeLineView", () => {
  it("renders pure view and invokes callbacks without touching singletons", async () => {
    expect(HubNoticeLineView).toBe(HubNoticeView);
    const onOpen = vi.fn();
    const onAutoOff = vi.fn();
    const onSeen = vi.fn();
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();

    await act(async () => root.render(
      <HubNoticeView
        notice={{ kind: "available", version: "1.1.0", build: 2 }}
        busy={false}
        onOpen={onOpen}
        onAutoOff={onAutoOff}
        onSeen={onSeen}
        onUpdate={onUpdate}
        onDismiss={onDismiss}
      />,
    ));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice"] > button')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-update"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-dismiss"]')!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith("build:2");

    await act(async () => root.render(
      <HubNoticeView
        notice={{ kind: "auto_on" }}
        busy
        onOpen={onOpen}
        onAutoOff={onAutoOff}
        onSeen={onSeen}
        onUpdate={onUpdate}
        onDismiss={onDismiss}
      />,
    ));
    expect(host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-auto-off"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-seen"]')?.getAttribute("aria-busy")).toBe("true");
    expectNoDefaultSingletons();
  });
});

describe("Controlled HubNoticeLine sequence fencing, getter caching, and direct-to-subscribed transitions", () => {
  it("fences hub_update pushes against older GETs, respects resumed vs fresh hello, and caches fresh-array dismissed getters", async () => {
    const hubListeners = new Map<string, Set<(m: Record<string, unknown>) => void>>();
    const dismissedListeners = new Set<() => void>();
    const scopeListeners = new Set<() => void>();
    const readCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<HubUpdateStatus | null>> }> = [];
    let dismissedList: string[] = [];

    const emitHub = (type: string, msg: Record<string, unknown>) =>
      act(async () => { hubListeners.get(type)?.forEach((l) => l({ type, ...msg })); });

    const subscribeHubEvent = vi.fn((type: string, l: (m: Record<string, unknown>) => void) => {
      if (!hubListeners.has(type)) hubListeners.set(type, new Set());
      hubListeners.get(type)!.add(l);
      return () => { hubListeners.get(type)?.delete(l); };
    });

    const readStatus = vi.fn((signal: AbortSignal) => {
      const gate = deferred<HubUpdateStatus | null>();
      readCalls.push({ signal, gate });
      return gate.promise;
    });

    // Mount in direct mode.
    await act(async () => root.render(
      <StrictMode>
        <HubNoticeLine
          deps={{
            scopeKey: "s1",
            readStatus,
            subscribeHubEvent,
            dismissed: [],
            dismissNotice: vi.fn(),
            navigate: vi.fn(),
            notify: vi.fn(),
          }}
        />
      </StrictMode>,
    ));
    const initialRead = readCalls.at(-1)!;
    expect(initialRead.signal.aborted).toBe(false);

    // hub_update push arrives before initial GET finishes: aborts older GET and renders updating notice.
    await emitHub("hub_update", { update: DOWNLOADING });
    expect(initialRead.signal.aborted).toBe(true);
    expect(host.querySelector('[data-testid="hub-notice"]')?.getAttribute("data-kind")).toBe("updating");

    // Stale initial GET resolves afterwards: ignored.
    initialRead.gate.resolve(AVAILABLE);
    await flush();
    expect(host.querySelector('[data-testid="hub-notice"]')?.getAttribute("data-kind")).toBe("updating");

    // Resumed hello does not trigger a new read.
    const countBeforeResumed = readCalls.length;
    await emitHub("hello", { resumed: true });
    expect(readCalls).toHaveLength(countBeforeResumed);

    // Fresh hello triggers a new read and lands.
    await emitHub("hello", {});
    expect(readCalls).toHaveLength(countBeforeResumed + 1);
    readCalls.at(-1)!.gate.resolve(AVAILABLE);
    await flush();
    expect(host.querySelector('[data-testid="hub-notice"]')?.getAttribute("data-kind")).toBe("available");

    // Switch in-place from direct dismissed/scopeKey to subscribed fresh-array getters on the same scope.
    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const subscribeDismissed = vi.fn((l: () => void) => { dismissedListeners.add(l); return () => { dismissedListeners.delete(l); }; });

    const renderSub = () => root.render(
      <StrictMode>
        <HubNoticeLine
          deps={{
            scopeKey: () => "s1",
            subscribeScopeKey,
            readStatus,
            subscribeHubEvent,
            dismissed: () => [...dismissedList],
            subscribeDismissed,
            dismissNotice: vi.fn(),
            navigate: vi.fn(),
            notify: vi.fn(),
          }}
        />
      </StrictMode>,
    );
    const readsBeforeSwitch = readCalls.length;
    await act(async () => renderSub());
    // Status is preserved across direct -> subscribed switch on same scope without re-reading.
    expect(readCalls).toHaveLength(readsBeforeSwitch);
    expect(host.querySelector('[data-testid="hub-notice"]')?.getAttribute("data-kind")).toBe("available");

    // Inline arrow getters must not churn subscriptions.
    const scopeSubCount = subscribeScopeKey.mock.calls.length;
    const disSubCount = subscribeDismissed.mock.calls.length;
    await act(async () => renderSub());
    await act(async () => renderSub());
    expect(subscribeScopeKey).toHaveBeenCalledTimes(scopeSubCount);
    expect(subscribeDismissed).toHaveBeenCalledTimes(disSubCount);

    // Updating dismissed via subscribeDismissed hides the dismissed notice.
    dismissedList = ["build:2"];
    await act(async () => { dismissedListeners.forEach((l) => l()); });
    expect(host.querySelector('[data-testid="hub-notice"]')).toBeNull();
    expectNoDefaultSingletons();
  });

  it("supports custom renderView and navigate override", async () => {
    const navigated: string[] = [];
    const kinds: string[] = [];
    await act(async () => root.render(
      <HubNoticeLine
        deps={{
          readStatus: () => AVAILABLE,
          subscribeHubEvent: () => () => {},
          dismissed: [],
          navigate: (to) => { navigated.push(to); },
          renderView: (props) => {
            kinds.push(props.notice.kind);
            return <button type="button" data-custom-open onClick={props.onOpen}>{props.notice.kind}</button>;
          },
        }}
      />,
    ));
    expect(kinds).toEqual(["available"]);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-custom-open]")!.click());
    expect(navigated).toEqual(["/settings?tab=hub"]);
    expectNoDefaultSingletons();
  });
});

describe("Scope, ABA, unmount fencing, concurrent render purity, and try/finally recovery", () => {
  it("fences readStatus, startUpdate, setUpdateSettings, and dismissNotice across scope switch, ABA bursts, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    const hubListeners = new Map<string, Set<(m: Record<string, unknown>) => void>>();
    let currentScope = "s1";
    const notify = vi.fn();
    const onError = vi.fn();

    const readCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<HubUpdateStatus | null>> }> = [];
    const updateCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<HubUpdateStatus>> }> = [];
    const settingCalls: Array<{ payload: Record<string, unknown>; signal: AbortSignal; gate: ReturnType<typeof deferred<HubUpdateStatus>> }> = [];
    const dismissCalls: Array<{ key: string; signal: AbortSignal; gate: ReturnType<typeof deferred<string[]>> }> = [];

    const deps: HubNoticeLineDeps = {
      scopeKey: () => currentScope,
      subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
      readStatus: (signal) => {
        const gate = deferred<HubUpdateStatus | null>();
        readCalls.push({ signal, gate });
        return gate.promise;
      },
      subscribeHubEvent: (type, l) => {
        if (!hubListeners.has(type)) hubListeners.set(type, new Set());
        hubListeners.get(type)!.add(l);
        return () => { hubListeners.get(type)?.delete(l); };
      },
      dismissNotice: (key, signal) => {
        const gate = deferred<string[]>();
        dismissCalls.push({ key, signal, gate });
        return gate.promise;
      },
      startUpdate: (_now, signal) => {
        const gate = deferred<HubUpdateStatus>();
        updateCalls.push({ signal, gate });
        return gate.promise;
      },
      setUpdateSettings: (payload, signal) => {
        const gate = deferred<HubUpdateStatus>();
        settingCalls.push({ payload, signal, gate });
        return gate.promise;
      },
      notify,
      onError,
    };

    await act(async () => root.render(<HubNoticeLine deps={deps} />));
    readCalls[0].gate.resolve(AVAILABLE);
    await flush();

    // Start async update + async dismiss in s1, then switch scope s1 -> s2.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-update"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-dismiss"]')!.click());
    expect(updateCalls).toHaveLength(1);
    expect(dismissCalls).toHaveLength(1);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-update"]')?.disabled).toBe(true);

    currentScope = "s2";
    await act(async () => { scopeListeners.forEach((l) => l()); });
    expect(updateCalls[0].signal.aborted).toBe(true);
    expect(dismissCalls[0].signal.aborted).toBe(true);
    expect(host.querySelector('[data-testid="hub-notice"]')).toBeNull();

    // Stale rejections from s1 are ignored.
    updateCalls[0].gate.reject(new Error("stale update"));
    dismissCalls[0].gate.reject(new Error("stale dismiss"));
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // Resolve s2 as auto_on, click Turn off, then trigger synchronous ABA burst s2 -> s3 -> s2.
    readCalls[1].gate.resolve(AUTO_ON);
    await flush();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-auto-off"]')!.click());
    expect(settingCalls).toHaveLength(1);
    expect(settingCalls[0].payload).toEqual({ auto: false });

    await act(async () => {
      currentScope = "s3";
      scopeListeners.forEach((l) => l());
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
    });
    expect(settingCalls[0].signal.aborted).toBe(true);
    settingCalls[0].gate.reject(new Error("stale settings"));
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // Unmount aborts active readStatus and ignores late resolve/reject.
    const latestRead = readCalls.at(-1)!;
    await act(async () => root.render(null));
    expect(latestRead.signal.aborted).toBe(true);
    latestRead.gate.reject(new Error("unmounted read"));
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed status and in-flight startUpdate intact across an abandoned concurrent transition render", async () => {
    const suspendGate = deferred<void>();
    const updateGate = deferred<HubUpdateStatus>();
    let updateSignal: AbortSignal | null = null;
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
          <HubNoticeLine
            deps={{
              scopeKey: state.scope,
              readStatus: () => AVAILABLE,
              subscribeHubEvent: () => () => {},
              dismissed: [],
              startUpdate: (_now, signal) => {
                updateSignal = signal;
                return updateGate.promise;
              },
              notify: vi.fn(),
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-update"]')!.click());
    expect(updateSignal!.aborted).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-update"]')?.disabled).toBe(true);

    // Suspended concurrent transition to s2 must NOT abort s1's startUpdate.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(updateSignal!.aborted).toBe(false);

    // Abandon back to s1; resolving updateGate transitions notice to updating cleanly.
    await act(async () => setHarness({ scope: "s1", block: false }));
    updateGate.resolve(DOWNLOADING);
    await flush();
    expect(host.querySelector('[data-testid="hub-notice"]')?.getAttribute("data-kind")).toBe("updating");
    expectNoDefaultSingletons();
  });

  it("recovers busy via try/finally on sync throws and async rejections even when notify/onError throw", async () => {
    const notify = vi.fn(() => { throw new Error("toast crash"); });
    const errors: string[] = [];
    let updateMode: "sync" | "async" | "ok" = "sync";
    let dismissMode: "sync" | "async" | "ok" = "sync";

    await act(async () => root.render(
      <HubNoticeLine
        deps={{
          readStatus: () => AVAILABLE,
          subscribeHubEvent: () => () => {},
          startUpdate: () => {
            if (updateMode === "sync") throw new Error("update sync");
            if (updateMode === "async") return Promise.reject(new Error("update async"));
            return Promise.resolve(AVAILABLE);
          },
          dismissNotice: (key) => {
            if (dismissMode === "sync") throw new Error("dismiss sync");
            if (dismissMode === "async") return Promise.reject(new Error("dismiss async"));
            return Promise.resolve([key]);
          },
          notify,
          formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
          onError: (msg) => { errors.push(msg); },
        }}
      />,
    ));

    const updateBtn = () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-update"]')!;
    await act(async () => updateBtn().click());
    expect(updateBtn().disabled).toBe(false);
    expect(errors).toEqual(["fmt:update sync"]);

    updateMode = "async";
    await act(async () => updateBtn().click());
    await flush();
    expect(updateBtn().disabled).toBe(false);
    expect(errors).toEqual(["fmt:update sync", "fmt:update async"]);

    updateMode = "ok";
    await act(async () => updateBtn().click());
    await flush();
    expect(updateBtn().disabled).toBe(false);

    const dismissBtn = () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-dismiss"]')!;
    await act(async () => dismissBtn().click());
    dismissMode = "async";
    await act(async () => dismissBtn().click());
    await flush();
    dismissMode = "ok";
    await act(async () => dismissBtn().click());
    await flush();
    expect(host.querySelector('[data-testid="hub-notice"]')).toBeNull();
    expect(errors).toEqual(["fmt:update sync", "fmt:update async", "fmt:dismiss sync", "fmt:dismiss async"]);
    expectNoDefaultSingletons();
  });

  it("preserves default hubUpdate, onHubEvent, localStorage, router, and toast behavior when deps is omitted", async () => {
    mocks.startHubUpdate.mockRejectedValueOnce(new Error("hub busy"));
    await act(async () => root.render(<HubNoticeLine />));
    await flush();
    expect(mocks.hubUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.onHubEvent).toHaveBeenCalledWith("hub_update");
    expect(mocks.onHubEvent).toHaveBeenCalledWith("hello");
    expect(mocks.dismissedHubNotices).toHaveBeenCalledTimes(1);

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice"] > button')!.click());
    expect(mocks.navigate).toHaveBeenCalledWith("/settings?tab=hub");

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-update"]')!.click());
    await flush();
    expect(mocks.startHubUpdate).toHaveBeenCalledWith(false);
    expect(mocks.toast).toHaveBeenCalledWith("hub busy", "error");

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="hub-notice-dismiss"]')!.click());
    expect(mocks.dismissHubNotice).toHaveBeenCalledWith("build:2");
    expect(host.querySelector('[data-testid="hub-notice"]')).toBeNull();
  });
});
