// @vitest-environment jsdom
// Controlled AlertPressure (AgentGroupsView, AgentGroups, PressureSectionView, PressureSection) bypasses default
// useDiagnosis/useNow/stopAgents/store.refresh singletons, caches fresh getter snapshots, preserves render purity
// across abandoned concurrent renders, fences diagnosis/stop/refresh/handoff across scope/machine/ABA/unmount, blocks
// dialog close while busy, recovers via try/finally, and preserves default fallback parity.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { Diagnosis } from "../../lib/machine-diagnosis";
import type { StopOutcome } from "../../lib/machine-handoff";
import type { Machine, MachineMetrics, Session } from "../../lib/types";
import type { DiagnosisRead } from "./AlertParts";
import type { PressureSectionDeps } from "./AlertPressure";

const FIXED_NOW = 1_700_000_000_000;

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  stopAgents: vi.fn(),
  useNow: vi.fn(),
  useDiagnosis: vi.fn(),
  defaultReload: vi.fn(),
  defaultDiagnosis: { state: "loading" } as DiagnosisRead,
}));

vi.mock("../../lib/store", async (original) => ({
  ...(await original<typeof import("../../lib/store")>()),
  refresh: () => mocks.refresh(),
}));

vi.mock("../../lib/machine-handoff", async (original) => ({
  ...(await original<typeof import("../../lib/machine-handoff")>()),
  stopAgents: (list: readonly Session[]) => mocks.stopAgents(list),
}));

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  useNow: (every?: number, on?: boolean) => {
    mocks.useNow(every, on);
    return FIXED_NOW;
  },
}));

vi.mock("./AlertParts", async (original) => ({
  ...(await original<typeof import("./AlertParts")>()),
  useDiagnosis: (mid: string, sections: readonly string[], on?: boolean) => {
    mocks.useDiagnosis(mid, sections, on);
    return { read: mocks.defaultDiagnosis, reload: mocks.defaultReload };
  },
}));

const { AgentGroups, AgentGroupsView, PressureSection, PressureSectionView } = await import("./AlertPressure");

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const GB = 1024 ** 3;
const MACHINE_A: Machine = { id: "laptop-a", name: "Laptop A", online: true, kind: "ssh", system: { cores: 8, memory: 32 * GB } };
const MACHINE_B: Machine = { id: "laptop-b", name: "Laptop B", online: true, kind: "ssh", system: { cores: 8, memory: 32 * GB } };
const METRICS_A: MachineMetrics = {
  machine_id: "laptop-a",
  online: true,
  points: [],
  latest: { t: 1, cpu: 42, load: 4, mem_used: 28 * GB, mem_total: 32 * GB, disk_used: 200 * GB, disk_total: 500 * GB },
};

const makeAgent = (sid: string, title: string, state: Session["state"], extra: Partial<Session> = {}): Session => ({
  machine_id: "laptop-a",
  session_id: sid,
  title,
  cwd: "/code",
  state,
  status: state === "needs_you" ? "blocked" : state === "unread" ? "done" : state ?? "idle",
  ...extra,
});

const AGENTS: Session[] = [
  makeAgent("n1", "Needs answer", "needs_you"),
  makeAgent("w1", "Running build", "working"),
  makeAgent("i1", "Idle draft", "idle", { state_since: new Date(FIXED_NOW - 95 * 60_000).toISOString() }),
  makeAgent("u1", "Unread report", "unread"),
];

const SAMPLE_DIAGNOSIS: Diagnosis = {
  machine_id: "laptop-a",
  at: 1,
  processes: {
    mem_total: 32 * GB,
    count: 120,
    groups: [
      { name: "claude", kind: "agent", count: 4, rss: 8 * GB, cpu: 20 },
      { name: "node", kind: "other", count: 8, rss: 6 * GB, cpu: 50 },
    ],
  },
};

const expectNoDefaultSingletons = () => {
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.stopAgents).not.toHaveBeenCalled();
  expect(mocks.useNow).not.toHaveBeenCalled();
  expect(mocks.useDiagnosis).not.toHaveBeenCalled();
  expect(mocks.defaultReload).not.toHaveBeenCalled();
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.stopAgents.mockReset().mockResolvedValue([]);
  mocks.useNow.mockReset();
  mocks.useDiagnosis.mockReset();
  mocks.defaultReload.mockReset();
  mocks.defaultDiagnosis = { state: "ok", data: SAMPLE_DIAGNOSIS };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AgentGroupsView & PressureSectionView (pure presentation)", () => {
  it("renders AgentGroupsView and PressureSectionView purely with injected clock and callbacks without touching singletons", async () => {
    await act(async () => root.render(<AgentGroupsView agents={AGENTS} known="yes" now={FIXED_NOW} />));
    expect(host.querySelector('[data-group="idle"]')?.textContent).toContain("1");
    expectNoDefaultSingletons();

    const onHandoff = vi.fn();
    const onOpenStopDialog = vi.fn();
    const onCloseStopDialog = vi.fn();
    const onConfirmStop = vi.fn();

    await act(async () => root.render(
      <PressureSectionView
        kind="load"
        machine={MACHINE_A}
        metrics={METRICS_A}
        agents={AGENTS}
        agentsKnown="yes"
        diagnosis={{ state: "ok", data: SAMPLE_DIAGNOSIS }}
        showAllProcesses={false}
        now={FIXED_NOW}
        idleAgents={[AGENTS[2]!, AGENTS[3]!]}
        asking={[AGENTS[2]!, AGENTS[3]!]}
        busy
        outcome={null}
        stopError="custom stop alert"
        onRetryDiagnosis={() => {}}
        onToggleShowAllProcesses={() => {}}
        onOpenStopDialog={onOpenStopDialog}
        onCloseStopDialog={onCloseStopDialog}
        onConfirmStop={onConfirmStop}
        onHandoff={onHandoff}
      />,
    ));

    expect(host.querySelector('[data-testid="load-definition"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="stop-error"]')?.textContent).toBe("custom stop alert");
    // Cancel & confirm buttons disabled while busy.
    const confirmBtn = document.body.querySelector<HTMLButtonElement>('[data-testid="stop-confirm"]')!;
    const cancelBtn = [...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes(t("common.cancel"))) as HTMLButtonElement;
    expect(confirmBtn.getAttribute("aria-busy")).toBe("true");
    expect(cancelBtn.disabled).toBe(true);
    expectNoDefaultSingletons();
  });
});

describe("AgentGroups & PressureSection (controlled mode)", () => {
  it("bypasses useNow in AgentGroups when controlled now is supplied and supports subscribed clock ticks", async () => {
    let nowMs = FIXED_NOW;
    const listeners = new Set<() => void>();
    const subscribeNow = vi.fn((l: () => void) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    });

    await act(async () => root.render(
      <AgentGroups agents={AGENTS} known="yes" deps={{ now: () => nowMs, subscribeNow }} />,
    ));
    const before = host.querySelector('[data-group="idle"]')?.textContent ?? "";
    expectNoDefaultSingletons();

    await act(async () => {
      nowMs = FIXED_NOW + 2 * 3600_000;
      listeners.forEach((l) => l());
    });
    const after = host.querySelector('[data-group="idle"]')?.textContent ?? "";
    expect(after).not.toBe(before);
    expect(subscribeNow).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("bypasses default singletons, loads diagnosis via loadDiagnosis, stops idle agents, blocks dialog close while busy, and refreshes", async () => {
    const loadDiag = vi.fn(async (_mid: string, _sections: readonly string[], _signal: AbortSignal) => SAMPLE_DIAGNOSIS);
    const stopDeferred = deferred<StopOutcome[]>();
    const stopFn = vi.fn(() => stopDeferred.promise);
    const refreshFn = vi.fn(async () => {});
    const onHandoff = vi.fn();

    const deps: PressureSectionDeps = {
      loadDiagnosis: loadDiag,
      stopAgents: stopFn,
      refresh: refreshFn,
      now: FIXED_NOW,
      onHandoff,
    };

    await act(async () => root.render(
      <StrictMode>
        <PressureSection
          kind="memory"
          machine={MACHINE_A}
          metrics={METRICS_A}
          agents={AGENTS}
          agentsKnown="yes"
          onHandoff={() => {}}
          deps={deps}
        />
      </StrictMode>,
    ));
    await flush();

    expect(host.querySelectorAll('[data-process]')).toHaveLength(2);
    expectNoDefaultSingletons();

    // Open stop confirmation dialog and start stop.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="stop-idle"]')!.click();
    });
    expect(document.body.querySelectorAll('[data-testid="stop-list"] li')).toHaveLength(2);

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="stop-confirm"]')!.click();
    });
    expect(stopFn).toHaveBeenCalledTimes(1);

    // While busy, Escape / cancel cannot close the dialog and duplicate confirm clicks are ignored.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      document.body.querySelector<HTMLButtonElement>('[data-testid="stop-confirm"]')!.click();
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(stopFn).toHaveBeenCalledTimes(1);

    // Resolve stop -> dialog closes, outcome renders, refresh runs.
    stopDeferred.resolve([
      { session: AGENTS[2]!, ok: true },
      { session: AGENTS[3]!, ok: false, error: "busy" },
    ]);
    await flush();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[data-testid="stop-outcome"]')?.textContent).toContain("busy");
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Trigger controlled handoff.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="handoff"]')!.click();
    });
    expect(onHandoff).toHaveBeenCalledWith(expect.any(AbortSignal));
    expectNoDefaultSingletons();
  });

  it("caches fresh diagnosis/clock getter snapshots with sameValue and keeps identity across direct-to-subscribed transitions", async () => {
    let diag: DiagnosisRead = { state: "ok", data: SAMPLE_DIAGNOSIS };
    let nowMs = FIXED_NOW;
    const diagListeners = new Set<() => void>();
    const subscribeDiagnosis = vi.fn((l: () => void) => {
      diagListeners.add(l);
      return () => { diagListeners.delete(l); };
    });
    const subscribeNow = vi.fn(() => () => {});
    const onReloadDiagnosis = vi.fn();
    let renders = 0;

    function Harness({ mode }: { mode: "direct" | "getter" }) {
      renders += 1;
      return (
        <PressureSection
          kind="memory"
          machine={MACHINE_A}
          metrics={METRICS_A}
          agents={AGENTS}
          agentsKnown="yes"
          onHandoff={() => {}}
          deps={{
            // Fresh object clone on every snapshot read verifies sameValue caching.
            diagnosis: mode === "direct" ? diag : () => (diag.state === "ok" ? { state: "ok", data: { ...diag.data } } : { ...diag }),
            subscribeDiagnosis: mode === "direct" ? undefined : subscribeDiagnosis,
            onReloadDiagnosis,
            now: mode === "direct" ? nowMs : () => nowMs,
            subscribeNow: mode === "direct" ? undefined : subscribeNow,
            stopAgents: async () => [],
            refresh: async () => {},
          }}
        />
      );
    }

    await act(async () => root.render(<Harness mode="direct" />));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="stop-idle"]')!.click();
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    // Switch direct -> getter+subscribe: dialog stays open (zero remount).
    await act(async () => root.render(<Harness mode="getter" />));
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(subscribeDiagnosis).toHaveBeenCalledTimes(1);
    expect(subscribeNow).toHaveBeenCalledTimes(1);

    // Inline arrow re-renders cause zero subscription churn.
    await act(async () => root.render(<Harness mode="getter" />));
    await act(async () => root.render(<Harness mode="getter" />));
    expect(subscribeDiagnosis).toHaveBeenCalledTimes(1);
    expect(subscribeNow).toHaveBeenCalledTimes(1);
    expect(renders).toBeLessThan(12);

    // Transition diagnosis to failed and click retry -> invokes controlled onReloadDiagnosis.
    await act(async () => {
      diag = { state: "failed", failure: { kind: "deadline", text: "Timed out" } };
      diagListeners.forEach((l) => l());
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-diagnosis="deadline"] button')!.click();
    });
    expect(onReloadDiagnosis).toHaveBeenCalledWith(expect.any(AbortSignal));
    expectNoDefaultSingletons();
  });

  it("fences diagnosis load and stop/refresh across scopeKey switch, machine.id switch, synchronous ABA bursts, and unmount", async () => {
    let currentScope = "scope-a";
    const scopeListeners = new Set<() => void>();
    const subscribeScopeKey = (l: () => void) => {
      scopeListeners.add(l);
      return () => { scopeListeners.delete(l); };
    };

    const diagSignals: AbortSignal[] = [];
    const diagDeferreds: ReturnType<typeof deferred<Diagnosis>>[] = [];
    const loadDiagnosis = vi.fn((_mid: string, _sections: readonly string[], signal: AbortSignal) => {
      diagSignals.push(signal);
      const d = deferred<Diagnosis>();
      diagDeferreds.push(d);
      return d.promise;
    });

    const stopSignals: AbortSignal[] = [];
    const stopDeferreds: ReturnType<typeof deferred<StopOutcome[]>>[] = [];
    const stopFn = vi.fn((_list: readonly Session[], signal: AbortSignal) => {
      stopSignals.push(signal);
      const d = deferred<StopOutcome[]>();
      stopDeferreds.push(d);
      return d.promise;
    });
    const refreshFn = vi.fn();

    const deps: PressureSectionDeps = {
      scopeKey: () => currentScope,
      subscribeScopeKey,
      loadDiagnosis,
      stopAgents: stopFn,
      refresh: refreshFn,
      now: FIXED_NOW,
    };

    await act(async () => root.render(
      <PressureSection kind="memory" machine={MACHINE_A} metrics={METRICS_A} agents={AGENTS} agentsKnown="yes" onHandoff={() => {}} deps={deps} />,
    ));
    await flush();
    expect(diagDeferreds).toHaveLength(1);
    diagDeferreds[0]!.resolve(SAMPLE_DIAGNOSIS);
    await flush();

    // Open stop dialog and start stop.
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="stop-idle"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="stop-confirm"]')!.click(); });
    expect(stopSignals).toHaveLength(1);
    expect(stopSignals[0]!.aborted).toBe(false);

    // Synchronous ABA burst: scope-a -> scope-b -> scope-a.
    await act(async () => {
      currentScope = "scope-b";
      scopeListeners.forEach((l) => l());
      currentScope = "scope-a";
      scopeListeners.forEach((l) => l());
    });
    await flush();

    // ABA burst aborts stop, resets dialog/busy/outcome, and starts fresh diagnosis load.
    expect(stopSignals[0]!.aborted).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(diagDeferreds).toHaveLength(2);

    // Resolving stale stop must not write outcome or trigger refresh.
    stopDeferreds[0]!.resolve([{ session: AGENTS[2]!, ok: true }]);
    await flush();
    expect(host.querySelector('[data-testid="stop-outcome"]')).toBeNull();
    expect(refreshFn).not.toHaveBeenCalled();

    // Switch machine.id while diag #2 is pending and stop dialog is open -> aborts diag #2 and closes dialog.
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="stop-idle"]')!.click(); });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => root.render(
      <PressureSection kind="memory" machine={MACHINE_B} metrics={METRICS_A} agents={AGENTS} agentsKnown="yes" onHandoff={() => {}} deps={deps} />,
    ));
    await flush();
    expect(diagSignals[1]!.aborted).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(diagDeferreds).toHaveLength(3);

    // Unmount aborts diag #3.
    act(() => root.unmount());
    expect(diagSignals[2]!.aborted).toBe(true);
    diagDeferreds[2]!.resolve(SAMPLE_DIAGNOSIS);
    await flush();
    expectNoDefaultSingletons();
  });

  it("preserves committed state and live stop operation during an abandoned concurrent transition render", async () => {
    const neverResolving = new Promise<void>(() => {});
    const stopDeferred = deferred<StopOutcome[]>();
    const stopSignals: AbortSignal[] = [];
    const stopFn = vi.fn((_list: readonly Session[], signal: AbortSignal) => {
      stopSignals.push(signal);
      return stopDeferred.promise;
    });
    const refreshFn = vi.fn();

    function Suspender({ suspend }: { suspend: boolean }) {
      if (suspend) throw neverResolving;
      return null;
    }

    let triggerTransition!: () => void;
    function Harness() {
      const [next, setNext] = useState(false);
      triggerTransition = () => startTransition(() => setNext(true));
      return (
        <Suspense fallback={<div />}>
          <PressureSection
            kind="memory"
            machine={next ? MACHINE_B : MACHINE_A}
            metrics={METRICS_A}
            agents={AGENTS}
            agentsKnown="yes"
            onHandoff={() => {}}
            deps={{
              scopeKey: next ? "scope-b" : "scope-a",
              diagnosis: { state: "ok", data: SAMPLE_DIAGNOSIS },
              stopAgents: stopFn,
              refresh: refreshFn,
              now: FIXED_NOW,
            }}
          />
          <Suspender suspend={next} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="stop-idle"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="stop-confirm"]')!.click(); });
    expect(stopSignals).toHaveLength(1);
    expect(stopSignals[0]!.aborted).toBe(false);

    // Abandoned transition render must not abort the active stop operation.
    await act(async () => {
      triggerTransition();
    });
    expect(stopSignals[0]!.aborted).toBe(false);

    stopDeferred.resolve([{ session: AGENTS[2]!, ok: true }]);
    await flush();
    expect(host.querySelector('[data-testid="stop-outcome"]')).not.toBeNull();
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("recovers via try/finally on sync throw and async reject in loadDiagnosis and stopAgents even when callbacks throw", async () => {
    let mode: "sync" | "async" = "sync";
    const errors: string[] = [];
    const loadDiagnosis = vi.fn(() => {
      if (mode === "sync") throw new Error("sync diag fail");
      return Promise.reject(new Error("async diag fail"));
    });
    const stopFn = vi.fn(() => {
      if (mode === "sync") throw new Error("sync stop fail");
      return Promise.reject(new Error("async stop fail"));
    });
    const formatError = vi.fn((err: unknown) => {
      if (mode === "sync") throw new Error("formatter threw");
      return `fmt:${(err as Error).message}`;
    });
    const onError = vi.fn((msg: string) => {
      errors.push(msg);
      throw new Error("observer threw");
    });

    await act(async () => root.render(
      <PressureSection
        kind="memory"
        machine={MACHINE_A}
        metrics={METRICS_A}
        agents={AGENTS}
        agentsKnown="yes"
        onHandoff={() => {}}
        deps={{ loadDiagnosis, stopAgents: stopFn, refresh: async () => {}, now: FIXED_NOW, formatError, onError }}
      />,
    ));
    await flush();
    expect(host.querySelector('[data-diagnosis="error"]')?.textContent).toContain("sync diag fail");

    // Sync throw in stopAgents releases busy, closes dialog, and surfaces role="alert".
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="stop-idle"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="stop-confirm"]')!.click(); });
    await flush();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[data-testid="stop-error"]')?.textContent).toContain("sync stop fail");

    // Async rejection in retry diagnosis and stopAgents also recovers cleanly.
    mode = "async";
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-diagnosis="error"] button')!.click(); });
    await flush();
    expect(host.querySelector('[data-diagnosis="error"]')?.textContent).toContain("async diag fail");

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="stop-idle"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="stop-confirm"]')!.click(); });
    await flush();
    expect(host.querySelector('[data-testid="stop-error"]')?.textContent).toContain("fmt:async stop fail");
    expect(errors).toContain("fmt:async stop fail");
    expectNoDefaultSingletons();
  });

  it("supports renderView and preserves default fallback parity when deps is omitted", async () => {
    await act(async () => root.render(
      <PressureSection
        kind="cpu"
        machine={MACHINE_A}
        metrics={METRICS_A}
        agents={AGENTS}
        agentsKnown="yes"
        onHandoff={() => {}}
        deps={{
          diagnosis: { state: "ok", data: SAMPLE_DIAGNOSIS },
          now: FIXED_NOW,
          stopAgents: async () => [],
          refresh: async () => {},
          renderView: (props) => <div data-testid="custom-pressure-view">{props.kind}:{props.idleAgents.length}</div>,
        }}
      />,
    ));
    expect(host.querySelector('[data-testid="custom-pressure-view"]')?.textContent).toBe("cpu:2");
    expectNoDefaultSingletons();

    // Omitting deps falls back to useDiagnosis, useNow, stopAgents, and store.refresh.
    mocks.stopAgents.mockResolvedValueOnce([{ session: AGENTS[2]!, ok: true }]);
    await act(async () => root.render(
      <PressureSection
        kind="memory"
        machine={MACHINE_A}
        metrics={METRICS_A}
        agents={AGENTS}
        agentsKnown="yes"
        onHandoff={() => {}}
      />,
    ));
    expect(mocks.useDiagnosis).toHaveBeenCalledWith("laptop-a", ["processes"], true);
    expect(mocks.useNow).toHaveBeenCalledWith(60_000, undefined);

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="stop-idle"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="stop-confirm"]')!.click(); });
    await flush();
    expect(mocks.stopAgents).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
