// @vitest-environment jsdom
// Controlled ResourcesPanel bypasses api/errorText/onManagerChoice/fromShownManager/onHubEvent/visiblePoll/Date.now,
// caches fresh-array snapshots without subscription churn, preserves render purity across abandoned concurrent renders,
// fences load & save across scope/manager/ABA/unmount races, recovers via try/finally, and preserves default fallbacks.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceDefinition, ResourcesPanelDeps, ResourceStatus } from "./ResourcesPanel";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  errorText: vi.fn((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`),
  onManagerChoice: vi.fn(),
  fromShownManager: vi.fn((_event: Record<string, unknown>) => true),
  onHubEvent: vi.fn(),
  visiblePoll: vi.fn(),
  managerListeners: new Set<() => void>(),
  hubListeners: new Set<(event: Record<string, unknown>) => void>(),
  pollRefresh: null as (() => void) | null,
}));

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  api: (...args: unknown[]) => mocks.api(...args),
  errorText: (e: unknown) => mocks.errorText(e),
}));

vi.mock("../../lib/manager-choice", async (original) => ({
  ...(await original<typeof import("../../lib/manager-choice")>()),
  onManagerChoice: (listener: () => void) => {
    mocks.onManagerChoice(listener);
    mocks.managerListeners.add(listener);
    return () => { mocks.managerListeners.delete(listener); };
  },
  fromShownManager: (event: Record<string, unknown>) => mocks.fromShownManager(event),
}));

vi.mock("../../lib/store", async (original) => ({
  ...(await original<typeof import("../../lib/store")>()),
  onHubEvent: (type: string, listener: (event: Record<string, unknown>) => void) => {
    mocks.onHubEvent(type, listener);
    mocks.hubListeners.add(listener);
    return () => { mocks.hubListeners.delete(listener); };
  },
}));

vi.mock("../../lib/visible-poll", async (original) => ({
  ...(await original<typeof import("../../lib/visible-poll")>()),
  visiblePoll: (refresh: () => void, period: number, page: unknown) => {
    mocks.visiblePoll(refresh, period, page);
    mocks.pollRefresh = refresh;
    refresh();
    return () => {
      if (mocks.pollRefresh === refresh) mocks.pollRefresh = null;
    };
  },
}));

const { ResourceCard, ResourcesPanel, ResourcesPanelView } = await import("./ResourcesPanel");
const { initI18n, t } = await import("../../i18n");

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const FIXED_NOW = Date.parse("2026-11-26T10:01:00.000Z");

const makeResource = (id: string, observedAt = "2026-11-26T10:00:50.000Z", capacity = 2): ResourceStatus => ({
  id,
  capacity,
  mirror: { machine: "computer-a", target: "runner.example.com" },
  mirror_state: {
    unknown: false,
    observed_at: observedAt,
    queue: { slots: capacity, running: [], waiting: [] },
  },
  leases: [],
});

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

const findButton = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

const setTextarea = async (el: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const expectNoDefaultSingletons = () => {
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.errorText).not.toHaveBeenCalled();
  expect(mocks.onManagerChoice).not.toHaveBeenCalled();
  expect(mocks.fromShownManager).not.toHaveBeenCalled();
  expect(mocks.onHubEvent).not.toHaveBeenCalled();
  expect(mocks.visiblePoll).not.toHaveBeenCalled();
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n("en");
  mocks.api.mockReset();
  mocks.errorText.mockReset();
  mocks.errorText.mockImplementation((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`);
  mocks.onManagerChoice.mockReset();
  mocks.fromShownManager.mockReset();
  mocks.fromShownManager.mockReturnValue(true);
  mocks.onHubEvent.mockReset();
  mocks.visiblePoll.mockReset();
  mocks.managerListeners.clear();
  mocks.hubListeners.clear();
  mocks.pollRefresh = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("ResourcesPanelView (pure presentation)", () => {
  it("renders loading, empty, cards with deterministic now, error alert, and editor without touching singletons or Date.now", async () => {
    // Point Date.now far away from FIXED_NOW: any accidental Date.now() read would break the 10-second freshness output.
    vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW + 9_999_000);
    const onConfigure = vi.fn();
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const onCancelEdit = vi.fn();

    await act(async () => root.render(
      <ResourcesPanelView
        resources={null}
        now={FIXED_NOW}
        editing={false}
        draft=""
        saving={false}
        onConfigure={onConfigure}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onCancelEdit={onCancelEdit}
      />,
    ));
    expect(host.querySelector('[aria-label]')?.getAttribute("aria-label")).toBe(t("resources.title"));
    expect(host.textContent).not.toContain(t("resources.empty"));

    await act(async () => root.render(
      <ResourcesPanelView
        resources={[makeResource("ci.alpha")]}
        now={FIXED_NOW}
        error="Load failed"
        editing={true}
        draft="[]"
        saving={true}
        onConfigure={onConfigure}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onCancelEdit={onCancelEdit}
      />,
    ));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Load failed");
    expect(host.textContent).toContain("ci.alpha");
    expect(host.textContent).toContain(t("resources.fresh", { seconds: 10 }));
    expect(findButton(t("resources.save"))?.disabled).toBe(true);

    await act(async () => findButton(t("resources.configure"))!.click());
    await act(async () => findButton(t("resources.cancel"))!.click());
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("keeps ResourceCard export usable standalone", async () => {
    await act(async () => root.render(<ResourceCard resource={makeResource("ci.card")} now={FIXED_NOW} />));
    expect(host.textContent).toContain("ci.card");
    expect(host.textContent).toContain(t("resources.fresh", { seconds: 10 }));
  });
});

describe("ResourcesPanel controlled deps, clock injection, snapshot caching, fencing, and default fallback", () => {
  it("bypasses Date.now and all singletons in controlled resources mode, caches fresh-array getters without subscription churn, and supports renderView", async () => {
    // Point Date.now far away from FIXED_NOW so any accidental Date.now() read would turn fresh cards stale.
    vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW + 9_999_000);
    const resourceListeners = new Set<() => void>();
    const nowListeners = new Set<() => void>();
    const scopeListeners = new Set<() => void>();
    let resourceSubs = 0;
    let nowSubs = 0;
    let scopeSubs = 0;
    let list: ResourceStatus[] = [makeResource("ci.one", "2026-11-26T10:00:50.000Z", 2)];
    let clock = FIXED_NOW;
    let reads = 0;

    const subscribeResources = (l: () => void) => {
      resourceSubs += 1;
      resourceListeners.add(l);
      return () => { resourceListeners.delete(l); };
    };
    const subscribeNow = (l: () => void) => {
      nowSubs += 1;
      nowListeners.add(l);
      return () => { nowListeners.delete(l); };
    };
    const subscribeScopeKey = (l: () => void) => {
      scopeSubs += 1;
      scopeListeners.add(l);
      return () => { scopeListeners.delete(l); };
    };

    const savedDefs: ResourceDefinition[][] = [];
    const saveResources = vi.fn(async (defs: ResourceDefinition[]) => {
      savedDefs.push(defs);
      list = defs.map((d) => ({
        ...d,
        mirror_state: { unknown: false, observed_at: "2026-11-26T10:00:55.000Z", queue: { slots: d.capacity, running: [], waiting: [] } },
        leases: [],
      }));
      resourceListeners.forEach((l) => l());
    });

    const makeDeps = (): ResourcesPanelDeps => ({
      scopeKey: () => "s1",
      subscribeScopeKey,
      // Return fresh cloned arrays/objects every snapshot read to verify sameValue caching prevents loops.
      resources: () => {
        reads += 1;
        return list.map((r) => ({ ...r, mirror: { ...r.mirror }, mirror_state: { ...r.mirror_state }, leases: [...r.leases] }));
      },
      subscribeResources,
      now: () => clock,
      subscribeNow,
      saveResources,
    });

    await act(async () => root.render(<ResourcesPanel deps={makeDeps()} />));
    expect(host.textContent).toContain("ci.one");
    expect(host.textContent).toContain(t("resources.fresh", { seconds: 10 }));
    expect(resourceSubs).toBe(1);
    expect(nowSubs).toBe(1);
    expect(scopeSubs).toBe(1);
    expect(reads).toBeLessThan(15);

    // Re-rendering with a fresh deps wrapper keeps identical subscriptions (no churn).
    await act(async () => root.render(<ResourcesPanel deps={makeDeps()} />));
    expect(resourceSubs).toBe(1);
    expect(nowSubs).toBe(1);
    expect(scopeSubs).toBe(1);

    // Semantically unchanged re-emission does not loop; advancing controlled clock updates staleness cleanly.
    await act(async () => { resourceListeners.forEach((l) => l()); });
    expect(host.textContent).toContain(t("resources.fresh", { seconds: 10 }));

    clock = FIXED_NOW + 40_000;
    await act(async () => { nowListeners.forEach((l) => l()); });
    expect(host.textContent).toContain(t("resources.stale", { seconds: 50 }));

    // Configure -> edit -> save updates via controlled saveResources without calling api GET/PUT or Date.now.
    await act(async () => findButton(t("resources.configure"))!.click());
    const textarea = host.querySelector("textarea")!;
    expect(textarea.value).toContain("ci.one");
    await setTextarea(textarea, JSON.stringify([{ id: "ci.two", capacity: 4, mirror: { machine: "computer-b", target: "runner-b.example.com" } }]));
    await act(async () => findButton(t("resources.save"))!.click());
    await flush();

    expect(saveResources).toHaveBeenCalledTimes(1);
    expect(savedDefs[0][0].id).toBe("ci.two");
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("ci.two");

    // Custom renderView seam works cleanly.
    await act(async () => root.render(
      <ResourcesPanel
        deps={{
          resources: list,
          now: FIXED_NOW,
          renderView: (p) => <div data-custom-resources={`${p.resources?.length ?? "null"}|${p.now}`} />,
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-resources]")?.getAttribute("data-custom-resources")).toBe(`1|${FIXED_NOW}`);
    expectNoDefaultSingletons();
  });

  it("supports controlled subscribers, single-flight save, and try/finally recovery even when formatError and onError throw", async () => {
    // Point Date.now far away from FIXED_NOW so any accidental Date.now() read would break the 10-second freshness output.
    vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW + 9_999_000);
    const load1 = deferred<{ resources: ResourceStatus[] }>();
    const load2 = deferred<{ resources: ResourceStatus[] }>();
    const load3 = deferred<{ resources: ResourceStatus[] }>();
    const save1 = deferred<void>();
    const save2 = deferred<void>();

    const readResources = vi.fn()
      .mockImplementationOnce(() => load1.promise)
      .mockImplementationOnce(() => load2.promise)
      .mockImplementationOnce(() => load3.promise);
    const saveResources = vi.fn()
      .mockImplementationOnce(() => save1.promise)
      .mockImplementationOnce(() => { throw new Error("sync put boom"); })
      .mockImplementationOnce(() => save2.promise);

    let triggerPoll!: () => void;
    let pushEvent!: (resources: ResourceStatus[]) => void;
    let pollIntervalSeen = 0;
    const formatError = vi.fn((e: unknown) => `fmt:${e instanceof Error ? e.message : String(e)}`);
    const onError = vi.fn();

    const deps: ResourcesPanelDeps = {
      readResources,
      saveResources,
      onManagerChoice: () => () => {},
      onResourcesEvent: (l) => { pushEvent = l; return () => {}; },
      poll: (refresh, ms) => {
        triggerPoll = refresh;
        pollIntervalSeen = ms;
        refresh();
        return () => {};
      },
      pollIntervalMs: 5_000,
      now: FIXED_NOW,
      formatError,
      onError,
    };

    await act(async () => root.render(<StrictMode><ResourcesPanel deps={deps} /></StrictMode>));
    expect(pollIntervalSeen).toBe(5_000);
    // StrictMode ran mount #1 (aborted) + mount #2 -> load2 is active.
    await act(async () => load2.resolve({ resources: [makeResource("ci.initial")] }));
    await flush();
    expect(host.textContent).toContain("ci.initial");

    // Live event push updates list and supersedes any in-flight poll load.
    await act(async () => triggerPoll());
    await act(async () => pushEvent([makeResource("ci.pushed")]));
    await flush();
    expect(host.textContent).toContain("ci.pushed");

    // Invalid JSON keeps draft open, formats error, and invokes onError without calling saveResources.
    await act(async () => findButton(t("resources.configure"))!.click());
    await setTextarea(host.querySelector("textarea")!, "{bad");
    await act(async () => findButton(t("resources.save"))!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("fmt:");
    expect(saveResources).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")).not.toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);

    // Non-array JSON rejects with resources.invalid.
    await setTextarea(host.querySelector("textarea")!, "{}");
    await act(async () => findButton(t("resources.save"))!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(`fmt:${t("resources.invalid")}`);
    expect(saveResources).not.toHaveBeenCalled();

    // Valid JSON + synchronous double-click enforces single-flight on save.
    const validDraft = JSON.stringify([{ id: "ci.saved", capacity: 3, mirror: { machine: "m1", target: "t1" } }]);
    await setTextarea(host.querySelector("textarea")!, validDraft);
    await act(async () => {
      findButton(t("resources.save"))!.click();
      findButton(t("resources.save"))!.click();
    });
    expect(saveResources).toHaveBeenCalledTimes(1);
    expect(findButton(t("resources.save"))?.disabled).toBe(true);

    // Rejecting save with throwing formatError and onError still releases saving cleanly.
    formatError.mockImplementationOnce(() => { throw new Error("fmt fail"); });
    onError.mockImplementationOnce(() => { throw new Error("observer fail"); });
    await act(async () => save1.reject(new Error("put rejected")));
    await flush();
    expect(findButton(t("resources.save"))?.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("default-err:put rejected");

    // Synchronous throw in saveResources releases cleanly too.
    await act(async () => findButton(t("resources.save"))!.click());
    await flush();
    expect(saveResources).toHaveBeenCalledTimes(2);
    expect(findButton(t("resources.save"))?.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("fmt:sync put boom");

    // Final save resolves PUT and reloads via readResources.
    const postSaveLoad = deferred<{ resources: ResourceStatus[] }>();
    readResources.mockImplementationOnce(() => postSaveLoad.promise);
    await act(async () => findButton(t("resources.save"))!.click());
    expect(saveResources).toHaveBeenCalledTimes(3);
    await act(async () => save2.resolve());
    await flush();
    await act(async () => postSaveLoad.resolve({ resources: [makeResource("ci.saved")] }));
    await flush();
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("ci.saved");
    expect(host.textContent).toContain(t("resources.fresh", { seconds: 10 }));
    // Only the throwing-formatError fallback touched default errorText; all other singletons stayed bypassed.
    expect(mocks.errorText).toHaveBeenCalledTimes(1);
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.onManagerChoice).not.toHaveBeenCalled();
    expect(mocks.fromShownManager).not.toHaveBeenCalled();
    expect(mocks.onHubEvent).not.toHaveBeenCalled();
    expect(mocks.visiblePoll).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "aborts load and save, resets editor/draft/error/saving, and fences stale %s across scopeKey ABA, manager switch ABA, cancel, and unmount",
    async (staleOutcome) => {
      const loads: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<{ resources: ResourceStatus[] }>> }> = [];
      const saves: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];
      const scopeListeners = new Set<() => void>();
      const managerListeners = new Set<() => void>();
      let currentScope = "s1";
      const onError = vi.fn();

      const deps: ResourcesPanelDeps = {
        scopeKey: () => currentScope,
        subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
        readResources: (signal) => {
          const gate = deferred<{ resources: ResourceStatus[] }>();
          loads.push({ signal, gate });
          return gate.promise;
        },
        saveResources: (_defs, signal) => {
          const gate = deferred<void>();
          saves.push({ signal, gate });
          return gate.promise;
        },
        onManagerChoice: (l) => { managerListeners.add(l); return () => { managerListeners.delete(l); }; },
        onResourcesEvent: () => () => {},
        poll: (refresh) => { refresh(); return () => {}; },
        now: FIXED_NOW,
        formatError: (e) => (e instanceof Error ? e.message : String(e)),
        onError,
      };

      // 1. Initial load resolves, open editor, start save on s1.
      await act(async () => root.render(<ResourcesPanel deps={deps} />));
      await act(async () => loads[0].gate.resolve({ resources: [makeResource("ci.s1")] }));
      await flush();
      await act(async () => findButton(t("resources.configure"))!.click());
      await setTextarea(host.querySelector("textarea")!, "[]");
      await act(async () => findButton(t("resources.save"))!.click());
      expect(saves).toHaveLength(1);
      expect(findButton(t("resources.save"))?.disabled).toBe(true);

      // 2. Synchronous scopeKey ABA burst (s1 -> s2 -> s1) aborts save, resets editor/saving/resources, starts fresh load.
      await act(async () => {
        currentScope = "s2";
        scopeListeners.forEach((l) => l());
        currentScope = "s1";
        scopeListeners.forEach((l) => l());
      });
      expect(saves[0].signal.aborted).toBe(true);
      expect(host.querySelector("textarea")).toBeNull();
      expect(loads).toHaveLength(2);

      // Stale save from visit 1 settles out of order: completely ignored.
      await act(async () => {
        if (staleOutcome === "resolve") saves[0].gate.resolve();
        else saves[0].gate.reject(new Error("stale scope ABA save"));
      });
      await flush();
      expect(onError).not.toHaveBeenCalled();
      expect(host.querySelector('[role="alert"]')).toBeNull();

      // 3. Manager switch ABA while both a load (loads[1]) and a new save are active.
      await act(async () => loads[1].gate.resolve({ resources: [makeResource("ci.m1")] }));
      await flush();
      await act(async () => findButton(t("resources.configure"))!.click());
      await act(async () => findButton(t("resources.save"))!.click());
      expect(saves).toHaveLength(2);
      const saveM1 = saves[1];

      // Fire manager switch twice synchronously (m1 -> m2 -> m1 ABA).
      await act(async () => {
        managerListeners.forEach((l) => l());
        managerListeners.forEach((l) => l());
      });
      expect(saveM1.signal.aborted).toBe(true);
      expect(host.querySelector("textarea")).toBeNull();
      expect(loads).toHaveLength(3);

      // Stale m1 save settles: must not clobber active manager state.
      await act(async () => {
        if (staleOutcome === "resolve") saveM1.gate.resolve();
        else saveM1.gate.reject(new Error("stale manager ABA save"));
      });
      await flush();
      expect(onError).not.toHaveBeenCalled();

      // 4. Resolve latest load, open editor, start save, cancel edit -> aborts save & fences late settle.
      await act(async () => loads[2].gate.resolve({ resources: [makeResource("ci.m2")] }));
      await flush();
      await act(async () => findButton(t("resources.configure"))!.click());
      await act(async () => findButton(t("resources.save"))!.click());
      const cancelledSave = saves.at(-1)!;
      await act(async () => findButton(t("resources.cancel"))!.click());
      expect(cancelledSave.signal.aborted).toBe(true);
      expect(host.querySelector("textarea")).toBeNull();
      await act(async () => {
        if (staleOutcome === "resolve") cancelledSave.gate.resolve();
        else cancelledSave.gate.reject(new Error("cancelled save"));
      });
      await flush();
      expect(onError).not.toHaveBeenCalled();

      // 5. Start another save and unmount -> aborts save and cleans up subscriptions.
      await act(async () => findButton(t("resources.configure"))!.click());
      await act(async () => findButton(t("resources.save"))!.click());
      const unmountSave = saves.at(-1)!;
      await act(async () => root.render(null));
      expect(unmountSave.signal.aborted).toBe(true);
      expect(scopeListeners.size).toBe(0);
      expect(managerListeners.size).toBe(0);

      await act(async () => {
        if (staleOutcome === "resolve") unmountSave.gate.resolve();
        else unmountSave.gate.reject(new Error("after unmount"));
      });
      await flush();
      expect(onError).not.toHaveBeenCalled();
      expectNoDefaultSingletons();
    },
  );

  it("keeps committed editor and in-flight save intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const saveGate = deferred<void>();
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
          <ResourcesPanel
            deps={{
              scopeKey: state.scope,
              resources: [makeResource("ci.concurrent")],
              now: FIXED_NOW,
              saveResources: (_defs, signal) => {
                capturedSignal = signal;
                return saveGate.promise;
              },
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => findButton(t("resources.configure"))!.click());
    await act(async () => findButton(t("resources.save"))!.click());
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    expect(findButton(t("resources.save"))?.disabled).toBe(true);

    // Suspended concurrent transition to s2 must NOT abort committed s1 save or wipe editor.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);
    expect(host.querySelector("textarea")).not.toBeNull();
    expect(findButton(t("resources.save"))?.disabled).toBe(true);

    // Abandon back to s1: save completes cleanly and closes editor.
    await act(async () => setHarness({ scope: "s1", block: false }));
    await act(async () => saveGate.resolve());
    await flush();
    expect(host.querySelector("textarea")).toBeNull();
    expectNoDefaultSingletons();
  });

  it("preserves default api, onManagerChoice, onHubEvent, visiblePoll, errorText, and live relative-timestamp clock fallbacks when deps are omitted", async () => {
    // Use relative timestamps (Date.now() - 60_000), never hardcoded future wall-clock dates.
    const staleObserved = new Date(Date.now() - 60_000).toISOString();
    const freshObserved = new Date(Date.now() - 5_000).toISOString();

    mocks.api
      .mockResolvedValueOnce({ resources: [makeResource("ci.default", staleObserved)] })
      .mockResolvedValueOnce({ resources: [makeResource("ci.reloaded", freshObserved)] });

    await act(async () => root.render(<ResourcesPanel />));
    await flush();

    expect(mocks.onManagerChoice).toHaveBeenCalledTimes(1);
    expect(mocks.onHubEvent).toHaveBeenCalledWith("resources", expect.any(Function));
    expect(mocks.visiblePoll).toHaveBeenCalledWith(expect.any(Function), 15_000, expect.any(Object));
    expect(mocks.api).toHaveBeenCalledWith("/resources", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(host.textContent).toContain("ci.default");
    expect(host.querySelector('[role="status"]')).not.toBeNull();

    // Hub push filtered by fromShownManager updates resources immediately.
    const pushedObserved = new Date(Date.now() - 4_000).toISOString();
    mocks.fromShownManager.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => {
      mocks.hubListeners.forEach((l) => l({ resources: [makeResource("ci.other-manager", pushedObserved)] }));
    });
    expect(host.textContent).toContain("ci.default");

    await act(async () => {
      mocks.hubListeners.forEach((l) => l({ resources: [makeResource("ci.live-push", pushedObserved)] }));
    });
    expect(host.textContent).toContain("ci.live-push");

    // Default onManagerChoice triggers a reload.
    await act(async () => {
      mocks.managerListeners.forEach((l) => l());
    });
    await flush();
    expect(host.textContent).toContain("ci.reloaded");

    // Default errorText is used when PUT fails.
    mocks.api.mockRejectedValueOnce(new Error("default put fail"));
    await act(async () => findButton(t("resources.configure"))!.click());
    await act(async () => findButton(t("resources.save"))!.click());
    await flush();
    expect(mocks.errorText).toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("default-err:default put fail");
  });
});
