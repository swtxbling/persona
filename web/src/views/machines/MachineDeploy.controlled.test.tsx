// @vitest-environment jsdom
// Controlled MachineDeploy and useDeploy bypass module-global deployRequests, store.getState, store.refresh, api,
// errorText, and toast; preserve render purity across abandoned concurrent transitions; fence machine/scope/ABA/unmount
// races without leaking admission; recover via try/finally; and preserve default fallbacks.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manager } from "../../lib/managers";
import type { Machine } from "../../lib/types";
import type { MachineDeployDeps } from "./MachineDeploy";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  errorText: vi.fn((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`),
  getState: vi.fn(() => ({ machines: [] as Machine[] })),
  refresh: vi.fn(() => Promise.resolve()),
  toast: vi.fn(),
}));

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  api: (...args: unknown[]) => mocks.api(...args),
  errorText: (e: unknown) => mocks.errorText(e),
}));

vi.mock("../../lib/store", async (original) => ({
  ...(await original<typeof import("../../lib/store")>()),
  getState: () => mocks.getState(),
  refresh: () => mocks.refresh(),
}));

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  toast: (message: string, tone?: string) => mocks.toast(message, tone),
}));

const { MachineDeploy, MachineDeployView, useDeploy } = await import("./MachineDeploy");
const { machineDeployment } = await import("../../lib/machine-deploy");
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

const makeMachine = (patch: Partial<Machine> = {}): Machine => ({
  id: "box-1",
  name: "Build Box",
  online: true,
  kind: "ssh",
  node_mismatch: true,
  can_deploy: true,
  ...patch,
});

const makeManager = (id: string, name: string): Manager => ({
  id,
  name,
  online: true,
}) as Manager;

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

const deployBtn = (container: ParentNode = host) =>
  [...container.querySelectorAll("button")].find((b) => b.getAttribute("data-testid") !== "deploy-details") as HTMLButtonElement | undefined;

const detailsBtn = (container: ParentNode = host) =>
  container.querySelector<HTMLButtonElement>('[data-testid="deploy-details"]');

const expectNoDefaultSingletons = () => {
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.errorText).not.toHaveBeenCalled();
  expect(mocks.getState).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n("en");
  mocks.api.mockReset();
  mocks.errorText.mockReset();
  mocks.errorText.mockImplementation((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`);
  mocks.getState.mockReset();
  mocks.getState.mockReturnValue({ machines: [] });
  mocks.refresh.mockReset();
  mocks.refresh.mockResolvedValue(undefined);
  mocks.toast.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("MachineDeployView (pure presentation)", () => {
  it("renders hidden, mismatch, co-located note, Details, and pending states without touching singletons", async () => {
    const onDetails = vi.fn();
    const onDeploy = vi.fn();

    await act(async () => root.render(
      <MachineDeployView deployment={machineDeployment(makeMachine({ node_mismatch: false }))} pending={false} onDeploy={onDeploy} />,
    ));
    expect(host.innerHTML).toBe("");

    const mismatch = machineDeployment(makeMachine({ deploy_error: "ssh timeout" }));
    await act(async () => root.render(
      <MachineDeployView
        deployment={mismatch}
        pending={false}
        coLocatedNames="Alpha and Beta"
        onDetails={onDetails}
        onDeploy={onDeploy}
      />,
    ));
    expect(host.querySelector('[role="status"]')?.textContent).toContain(mismatch.message);
    expect(host.querySelector('[data-testid="deploy-co-located-note"]')?.textContent).toContain("Alpha and Beta");
    expect(host.textContent).toContain("ssh timeout");

    await act(async () => detailsBtn()!.click());
    await act(async () => deployBtn()!.click());
    expect(onDetails).toHaveBeenCalledTimes(1);
    expect(onDeploy).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <MachineDeployView deployment={mismatch} pending={true} onDeploy={onDeploy} />,
    ));
    expect(deployBtn()?.disabled).toBe(true);
    expect(deployBtn()?.getAttribute("aria-busy")).toBe("true");
    expect(deployBtn()?.textContent).toContain(t("machines-machinedeploy.requesting"));
    expectNoDefaultSingletons();
  });
});

describe("useDeploy and MachineDeploy controlled deps, admission isolation, fencing, and default fallback", () => {
  it("runs fully controlled via deps without touching singletons, shares controlled inFlightSet, honors getMachine/custom admission hooks, and supports renderView", async () => {
    const req1 = deferred();
    const refresh1 = deferred();
    const inFlightSet = new Set<string>();
    const requestDeploy = vi.fn(() => req1.promise);
    const refreshMachines = vi.fn(() => refresh1.promise);
    const notify = vi.fn();
    const onError = vi.fn();
    const scopeListeners = new Set<() => void>();
    let scopeSubs = 0;
    const subscribeScopeKey = (l: () => void) => {
      scopeSubs += 1;
      scopeListeners.add(l);
      return () => { scopeListeners.delete(l); };
    };

    const machine = makeMachine({ id: "box-1" });
    let latestMachine: Machine = machine;
    const makeDeps = (): MachineDeployDeps => ({
      scopeKey: () => "s1",
      subscribeScopeKey,
      inFlightSet,
      getMachine: (id) => (id === latestMachine.id ? latestMachine : undefined),
      requestDeploy,
      refreshMachines,
      notify,
      formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
      onError,
    });

    // Two sibling MachineDeploy views share the controlled inFlightSet.
    await act(async () => root.render(
      <StrictMode>
        <div data-slot="first"><MachineDeploy machine={machine} hostedManagers={[makeManager("m1", "Alpha")]} deps={makeDeps()} /></div>
        <div data-slot="second"><MachineDeploy machine={machine} deps={makeDeps()} /></div>
      </StrictMode>,
    ));
    const first = () => host.querySelector('[data-slot="first"]')!;
    const second = () => host.querySelector('[data-slot="second"]')!;
    expect(first().querySelector('[data-testid="deploy-co-located-note"]')?.textContent).toContain("Alpha");
    const subsAfterMount = scopeSubs;

    // Fresh deps wrapper with stable subscribeScopeKey causes zero subscription churn.
    await act(async () => root.render(
      <StrictMode>
        <div data-slot="first"><MachineDeploy machine={machine} hostedManagers={[makeManager("m1", "Alpha")]} deps={makeDeps()} /></div>
        <div data-slot="second"><MachineDeploy machine={machine} deps={makeDeps()} /></div>
      </StrictMode>,
    ));
    expect(scopeSubs).toBe(subsAfterMount);

    // Click first -> admitted in controlled inFlightSet; click second -> blocked by shared inFlightSet.
    await act(async () => deployBtn(first())!.click());
    await act(async () => deployBtn(second())!.click());
    expect(requestDeploy).toHaveBeenCalledTimes(1);
    expect(inFlightSet.has("box-1")).toBe(true);
    expect(deployBtn(first())?.disabled).toBe(true);

    await act(async () => req1.resolve());
    await flush();
    expect(refreshMachines).toHaveBeenCalledTimes(1);
    expect(inFlightSet.has("box-1")).toBe(true);

    await act(async () => refresh1.resolve());
    await flush();
    expect(inFlightSet.has("box-1")).toBe(false);
    expect(deployBtn(first())?.disabled).toBe(false);

    // Latest getMachine reporting deploying=true prevents a new request.
    latestMachine = makeMachine({ id: "box-1", deploying: true });
    await act(async () => deployBtn(first())!.click());
    expect(requestDeploy).toHaveBeenCalledTimes(1);

    // Custom admission hooks (isInFlight / beginInFlight / endInFlight) work cleanly.
    latestMachine = makeMachine({ id: "box-2" });
    let blocked = true;
    const ended: string[] = [];
    const customReq = vi.fn(async () => {});
    const customRefresh = vi.fn(async () => {});
    await act(async () => root.render(
      <MachineDeploy
        machine={latestMachine}
        deps={{
          getMachine: () => latestMachine,
          isInFlight: () => blocked,
          beginInFlight: () => true,
          endInFlight: (id) => { ended.push(id); },
          requestDeploy: customReq,
          refreshMachines: customRefresh,
        }}
      />,
    ));
    await act(async () => deployBtn()!.click());
    expect(customReq).not.toHaveBeenCalled();

    blocked = false;
    await act(async () => deployBtn()!.click());
    await flush();
    expect(customReq).toHaveBeenCalledTimes(1);
    expect(customRefresh).toHaveBeenCalledTimes(1);
    expect(ended).toEqual(["box-2"]);

    // Custom renderView seam works cleanly.
    await act(async () => root.render(
      <MachineDeploy
        machine={latestMachine}
        deps={{
          renderView: (p) => <div data-custom-deploy={`${String(p.deployment.visible)}|${String(p.pending)}`} />,
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-deploy]")?.getAttribute("data-custom-deploy")).toBe("true|false");
    expectNoDefaultSingletons();
  });

  it("isolates scoped deploys from module-global deployRequests and recovers via try/finally even when observers throw", async () => {
    const scopedGate = deferred();
    const defaultGate = deferred();
    mocks.api.mockImplementationOnce(() => defaultGate.promise);

    let scopedDeploy!: () => Promise<boolean>;
    let scopedError = "";
    let scopedPending = false;
    let defaultDeploy!: () => Promise<boolean>;

    function Harness({ scopedDeps }: { scopedDeps: MachineDeployDeps }) {
      const m = makeMachine({ id: "shared-id" });
      const scoped = useDeploy(m, scopedDeps);
      const fallback = useDeploy(m);
      scopedDeploy = scoped.deploy;
      scopedError = scoped.error;
      scopedPending = scoped.pending;
      defaultDeploy = fallback.deploy;
      return <div data-state={`${scoped.pending}|${scoped.error}|${fallback.pending}`} />;
    }

    const formatError = vi.fn(() => { throw new Error("fmt boom"); });
    const notify = vi.fn(() => { throw new Error("toast boom"); });
    const onError = vi.fn(() => { throw new Error("observer boom"); });
    const endInFlight = vi.fn(() => { throw new Error("release boom"); });

    const scopedDeps: MachineDeployDeps = {
      scopeKey: "isolated-shell",
      getMachine: () => makeMachine({ id: "shared-id" }),
      requestDeploy: vi.fn()
        .mockImplementationOnce(() => scopedGate.promise)
        .mockImplementationOnce(async () => {}),
      refreshMachines: vi.fn(async () => { throw new Error("refresh failed"); }),
      formatError,
      notify,
      onError,
      endInFlight,
    };

    await act(async () => root.render(<Harness scopedDeps={scopedDeps} />));

    // Starting scoped deploy does NOT block uncontrolled default deploy on the same machine ID.
    let scopedPromise!: Promise<boolean>;
    let defaultPromise!: Promise<boolean>;
    await act(async () => {
      scopedPromise = scopedDeploy();
      defaultPromise = defaultDeploy();
    });
    expect(scopedPending).toBe(true);
    expect(mocks.api).toHaveBeenCalledTimes(1);

    // Rejecting scoped deploy with throwing formatError/notify/onError/endInFlight still clears pending cleanly.
    await act(async () => scopedGate.reject(new Error("deploy refused")));
    await expect(scopedPromise).resolves.toBe(false);
    await flush();
    expect(scopedPending).toBe(false);
    expect(scopedError).toBe("default-err:deploy refused");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(endInFlight).toHaveBeenCalledTimes(1);

    // Retry succeeds even when refreshMachines throws (non-blocking refresh parity).
    let retryPromise!: Promise<boolean>;
    await act(async () => { retryPromise = scopedDeploy(); });
    await expect(retryPromise).resolves.toBe(true);
    await flush();
    expect(scopedPending).toBe(false);
    expect(scopedError).toBe("");

    // Clean up default deploy.
    await act(async () => defaultGate.resolve(undefined));
    await expect(defaultPromise).resolves.toBe(true);
  });

  it.each(["resolve", "reject"] as const)(
    "aborts in-flight deploy/refresh, releases admission without leaking, and fences stale %s across machine switch, ABA m1->m2->m1, scopeKey ABA burst, and unmount",
    async (staleOutcome) => {
      const inFlightSet = new Set<string>();
      const deployCalls: Array<{ id: string; signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];
      const refreshCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];
      const notify = vi.fn();
      const onError = vi.fn();
      const scopeListeners = new Set<() => void>();
      let currentScope = "s1";

      const deps: MachineDeployDeps = {
        scopeKey: () => currentScope,
        subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
        inFlightSet,
        getMachine: () => undefined,
        requestDeploy: (id, signal) => {
          const gate = deferred<void>();
          deployCalls.push({ id, signal, gate });
          return gate.promise;
        },
        refreshMachines: (signal) => {
          const gate = deferred<void>();
          refreshCalls.push({ signal, gate });
          return gate.promise;
        },
        notify,
        formatError: (e) => (e instanceof Error ? e.message : String(e)),
        onError,
      };

      let apiRef!: ReturnType<typeof useDeploy>;
      function Harness({ machine }: { machine: Machine }) {
        apiRef = useDeploy(machine, deps);
        return <div data-pending={String(apiRef.pending)} data-error={apiRef.error} />;
      }

      const m1 = makeMachine({ id: "m1" });
      const m2 = makeMachine({ id: "m2" });

      // 1. Start deploy on m1 (visit 1).
      await act(async () => root.render(<Harness machine={m1} />));
      let p1!: Promise<boolean>;
      await act(async () => { p1 = apiRef.deploy(); });
      expect(deployCalls).toHaveLength(1);
      expect(inFlightSet.has("m1")).toBe(true);
      expect(apiRef.pending).toBe(true);

      // 2. Switch m1 -> m2 -> m1 (ABA): visit 1 aborts and releases m1 immediately so visit 2 can run.
      await act(async () => root.render(<Harness machine={m2} />));
      expect(deployCalls[0].signal.aborted).toBe(true);
      expect(inFlightSet.has("m1")).toBe(false);
      expect(apiRef.pending).toBe(false);

      await act(async () => root.render(<Harness machine={m1} />));
      let p2!: Promise<boolean>;
      await act(async () => { p2 = apiRef.deploy(); });
      expect(deployCalls).toHaveLength(2);
      expect(inFlightSet.has("m1")).toBe(true);
      expect(apiRef.pending).toBe(true);

      // Stale visit 1 settles out of order BEFORE visit 2: must NOT delete visit 2's admission, clear pending, call refresh, or fire toast.
      await act(async () => {
        if (staleOutcome === "resolve") deployCalls[0].gate.resolve();
        else deployCalls[0].gate.reject(new Error("stale ABA deploy error"));
      });
      await expect(p1).resolves.toBe(false);
      await flush();
      expect(inFlightSet.has("m1")).toBe(true);
      expect(apiRef.pending).toBe(true);
      expect(apiRef.error).toBe("");
      expect(refreshCalls).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();

      // Advance visit 2 into refreshMachines phase, then trigger synchronous scopeKey ABA burst (s1 -> s2 -> s1).
      await act(async () => deployCalls[1].gate.resolve());
      await flush();
      expect(refreshCalls).toHaveLength(1);
      expect(refreshCalls[0].signal.aborted).toBe(false);

      await act(async () => {
        currentScope = "s2";
        scopeListeners.forEach((l) => l());
        currentScope = "s1";
        scopeListeners.forEach((l) => l());
      });
      expect(refreshCalls[0].signal.aborted).toBe(true);
      expect(inFlightSet.has("m1")).toBe(false);
      expect(apiRef.pending).toBe(false);

      await act(async () => {
        if (staleOutcome === "resolve") refreshCalls[0].gate.resolve();
        else refreshCalls[0].gate.reject(new Error("stale refresh error"));
      });
      await expect(p2).resolves.toBe(false);
      await flush();
      expect(notify).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();

      // 3. Unmount while deploy is pending aborts signal, releases admission immediately, and discards late failure.
      let p3!: Promise<boolean>;
      await act(async () => { p3 = apiRef.deploy(); });
      expect(inFlightSet.has("m1")).toBe(true);
      const last = deployCalls.at(-1)!;
      await act(async () => root.render(null));
      expect(last.signal.aborted).toBe(true);
      expect(inFlightSet.size).toBe(0);

      await act(async () => {
        if (staleOutcome === "resolve") last.gate.resolve();
        else last.gate.reject(new Error("after unmount"));
      });
      await expect(p3).resolves.toBe(false);
      await flush();
      expect(notify).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expectNoDefaultSingletons();
    },
  );

  it("keeps committed deploy and admission intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const deployGate = deferred<void>();
    const refreshGate = deferred<void>();
    const inFlightSet = new Set<string>();
    let capturedSignal: AbortSignal | null = null;
    const renderedIds: string[] = [];

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    let setHarness!: (next: { id: string; block: boolean }) => void;
    function Harness() {
      const [state, setState] = useState({ id: "m1", block: false });
      setHarness = setState;
      renderedIds.push(state.id);
      return (
        <Suspense fallback={<div data-fallback />}>
          <MachineDeploy
            machine={makeMachine({ id: state.id })}
            deps={{
              inFlightSet,
              getMachine: () => undefined,
              requestDeploy: (_id, signal) => {
                capturedSignal = signal;
                return deployGate.promise;
              },
              refreshMachines: () => refreshGate.promise,
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => deployBtn()!.click());
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    expect(inFlightSet.has("m1")).toBe(true);

    // Suspended concurrent transition to m2 must NOT abort m1 or release admission.
    await act(async () => {
      startTransition(() => setHarness({ id: "m2", block: true }));
    });
    expect(renderedIds).toContain("m2");
    expect(capturedSignal!.aborted).toBe(false);
    expect(inFlightSet.has("m1")).toBe(true);

    // Abandon back to m1: deploy and refresh finish cleanly and release admission.
    await act(async () => setHarness({ id: "m1", block: false }));
    await act(async () => deployGate.resolve());
    await flush();
    await act(async () => refreshGate.resolve());
    await flush();
    expect(inFlightSet.has("m1")).toBe(false);
    expect(deployBtn()?.disabled).toBe(false);
    expectNoDefaultSingletons();
  });

  it("preserves default getState, api, refresh, errorText, toast, and shared deployRequests without leaking on unmount", async () => {
    const req1 = deferred();
    const machine = makeMachine({ id: "default box" });
    mocks.getState.mockReturnValue({ machines: [machine] });
    mocks.api
      .mockImplementationOnce(() => req1.promise)
      .mockRejectedValueOnce(new Error("deploy failed"));

    await act(async () => root.render(
      <>
        <div data-a><MachineDeploy machine={machine} /></div>
        <div data-b><MachineDeploy machine={machine} /></div>
      </>,
    ));

    // Shared default deployRequests blocks duplicate click across siblings.
    await act(async () => deployBtn(host.querySelector("[data-a]")!)!.click());
    await act(async () => deployBtn(host.querySelector("[data-b]")!)!.click());
    expect(mocks.getState).toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledWith("/machines/default%20box/deploy", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }));

    // Unmounting releases default deployRequests so a remounted component can retry immediately.
    await act(async () => root.render(null));
    await act(async () => root.render(<MachineDeploy machine={machine} />));
    await act(async () => deployBtn()!.click());
    await flush();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.errorText).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(t("machines-machinedeploy.failed", { error: "default-err:deploy failed" }), "error");

    // Settle aborted req1 safely.
    await act(async () => req1.resolve(undefined));
    await flush();
  });
});
