// @vitest-environment jsdom
// Controlled AlertDeploy (DeploySectionView, DeploySection) bypasses default store/roster/useDeploy singletons,
// caches fresh getter snapshots, preserves render purity across abandoned concurrent renders, fences deploy actions
// across scope/machine/ABA/unmount transitions, recovers via try/finally, and preserves default fallback parity.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { machineDeployment } from "../../lib/machine-deploy";
import type { Manager, ManagerList } from "../../lib/managers";
import type { Machine, Session } from "../../lib/types";
import type { DeploySectionDeps } from "./AlertDeploy";

const mocks = vi.hoisted(() => ({
  hubVersion: "v1-202611141020",
  roster: null as ManagerList | null,
  useStore: vi.fn(),
  useRoster: vi.fn(),
  useDeploy: vi.fn(),
  defaultDeploy: vi.fn(),
  defaultPending: false,
  defaultError: "",
}));

vi.mock("../../lib/store", async (original) => {
  const real = await original<typeof import("../../lib/store")>();
  return {
    ...real,
    useStore: <T,>(selector: (state: ReturnType<typeof real.getState>) => T) => {
      mocks.useStore();
      return selector({ ...real.getState(), version: mocks.hubVersion });
    },
  };
});

vi.mock("../../lib/managers", async (original) => {
  const real = await original<typeof import("../../lib/managers")>();
  return {
    ...real,
    useRoster: () => {
      mocks.useRoster();
      return mocks.roster;
    },
  };
});

vi.mock("./MachineDeploy", async (original) => {
  const real = await original<typeof import("./MachineDeploy")>();
  return {
    ...real,
    useDeploy: (machine: Machine) => {
      mocks.useDeploy(machine);
      return {
        deployment: machineDeployment(machine),
        pending: mocks.defaultPending,
        error: mocks.defaultError,
        deploy: () => mocks.defaultDeploy(machine),
      };
    },
  };
});

const { deployProgress, DeploySection, DeploySectionView } = await import("./AlertDeploy");

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

const STUDIO: Machine = {
  id: "studio",
  name: "Studio Mac",
  online: true,
  kind: "ssh",
  can_deploy: true,
  node_mismatch: true,
  node_version: "v1-202611110815",
  machine_uid: "uid-studio",
  hostname: "studio.local",
};

const MINI: Machine = {
  id: "mini",
  name: "Mac Mini",
  online: true,
  kind: "ssh",
  can_deploy: true,
  node_mismatch: true,
  node_version: "v1-202611100815",
};

const HOSTED_MANAGER: Manager = {
  id: "m-1",
  name: "Studio Assistant",
  online: true,
  machine_uid: "uid-studio",
  host: "studio.local",
  deploy: "service",
  version: "v1-202611100800",
};

const WORKING_AGENT: Session = {
  machine_id: "studio",
  session_id: "w1",
  title: "Build task",
  cwd: "/code",
  state: "working",
  status: "working",
};

const expectNoDefaultSingletons = () => {
  expect(mocks.useStore).not.toHaveBeenCalled();
  expect(mocks.useRoster).not.toHaveBeenCalled();
  expect(mocks.useDeploy).not.toHaveBeenCalled();
  expect(mocks.defaultDeploy).not.toHaveBeenCalled();
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  mocks.hubVersion = "v1-202611141020";
  mocks.roster = null;
  mocks.defaultPending = false;
  mocks.defaultError = "";
  mocks.useStore.mockReset();
  mocks.useRoster.mockReset();
  mocks.useDeploy.mockReset();
  mocks.defaultDeploy.mockReset().mockResolvedValue(true);
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

describe("DeploySectionView (pure presentation)", () => {
  it("renders builds, hosted managers, working count, stepper, and confirm dialog without touching singletons", async () => {
    const onOpenConfirm = vi.fn();
    const onCloseConfirm = vi.fn();
    const onConfirmRedeploy = vi.fn();
    const deployment = machineDeployment(STUDIO);

    await act(async () => root.render(
      <DeploySectionView
        machine={STUDIO}
        hubVersion="v1-202611141020"
        hostedManagers={[HOSTED_MANAGER]}
        workingCount={1}
        deployment={deployment}
        progress={deployProgress(STUDIO, false, false, 0, false, "")}
        pending={false}
        error=""
        asking
        onOpenConfirm={onOpenConfirm}
        onCloseConfirm={onCloseConfirm}
        onConfirmRedeploy={onConfirmRedeploy}
      />,
    ));

    expect(host.querySelector('[data-testid="builds"]')?.textContent).toContain("v1-202611141020");
    expect(host.querySelector('[data-testid="builds"]')?.textContent).toContain("v1-202611110815");
    expect(host.querySelector('[data-testid="deploy-hosted-why"]')?.textContent).toContain("Studio Assistant");
    expect(document.body.querySelector('[data-testid="redeploy-confirm-managers"]')?.textContent).toContain("Studio Assistant");

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="redeploy-confirm"]')!.click();
    });
    expect(onConfirmRedeploy).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });
});

describe("DeploySection (controlled mode)", () => {
  it("bypasses default store, roster, and useDeploy bridges and drives confirmation, deploy, refresh, and phase tracking", async () => {
    const deployDeferred = deferred<boolean>();
    const deployFn = vi.fn(() => deployDeferred.promise);
    const refreshFn = vi.fn(async () => {});
    const deps: DeploySectionDeps = {
      hubVersion: "v1-202611141020",
      roster: { default: "m-1", managers: [HOSTED_MANAGER] },
      deploy: deployFn,
      refresh: refreshFn,
    };

    const renderMachine = async (m: Machine) => {
      await act(async () => root.render(
        <StrictMode>
          <DeploySection machine={m} agents={[WORKING_AGENT]} deps={deps} />
        </StrictMode>,
      ));
      await flush();
    };

    await renderMachine(STUDIO);
    expectNoDefaultSingletons();
    expect(host.querySelector('[data-testid="deploy-hosted-managers"]')?.textContent).toContain("Studio Assistant");

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="redeploy"]')!.click();
    });
    expect(document.body.querySelector('[data-testid="redeploy-confirm"]')).not.toBeNull();
    expect(deployFn).not.toHaveBeenCalled();

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="redeploy-confirm"]')!.click();
    });
    expect(deployFn).toHaveBeenCalledTimes(1);
    expect(deployFn).toHaveBeenCalledWith(STUDIO, expect.any(AbortSignal));

    deployDeferred.resolve(true);
    await flush();
    expect(refreshFn).toHaveBeenCalledTimes(1);

    await renderMachine({ ...STUDIO, deploying: true, deploy_phase: "transferring" });
    expect(host.querySelector('[data-step="transferring"]')?.getAttribute("data-state")).toBe("current");

    await renderMachine({ ...STUDIO, node_mismatch: false, node_version: "v1-202611141020" });
    expect(host.querySelector('[data-testid="deploy-done"]')?.textContent).toContain("v1-202611141020");
    expectNoDefaultSingletons();
  });

  it("caches fresh getter objects/arrays with sameValue and preserves identity across direct-to-subscribed transitions", async () => {
    let hubVer = "v1-202611141020";
    let managers: Manager[] = [HOSTED_MANAGER];
    const verListeners = new Set<() => void>();
    const mgrListeners = new Set<() => void>();
    const subscribeHubVersion = vi.fn((l: () => void) => {
      verListeners.add(l);
      return () => { verListeners.delete(l); };
    });
    const subscribeHostedManagers = vi.fn((l: () => void) => {
      mgrListeners.add(l);
      return () => { mgrListeners.delete(l); };
    });
    const deployFn = vi.fn(async () => true);
    let renders = 0;

    function Harness({ mode }: { mode: "direct" | "getter" }) {
      renders += 1;
      return (
        <DeploySection
          machine={STUDIO}
          agents={[]}
          deps={{
            hubVersion: mode === "direct" ? hubVer : () => hubVer,
            subscribeHubVersion: mode === "direct" ? undefined : subscribeHubVersion,
            // Return a fresh array and fresh manager clones on every snapshot read to verify sameValue caching.
            hostedManagers: mode === "direct" ? managers : () => managers.map((m) => ({ ...m })),
            subscribeHostedManagers: mode === "direct" ? undefined : subscribeHostedManagers,
            deploy: deployFn,
          }}
        />
      );
    }

    await act(async () => root.render(<Harness mode="direct" />));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="redeploy"]')!.click();
    });
    expect(document.body.querySelector('[data-testid="redeploy-confirm"]')).not.toBeNull();

    // Switching direct -> getter+subscribe must keep the open dialog intact (no remount).
    await act(async () => root.render(<Harness mode="getter" />));
    expect(document.body.querySelector('[data-testid="redeploy-confirm"]')).not.toBeNull();
    expect(subscribeHubVersion).toHaveBeenCalledTimes(1);
    expect(subscribeHostedManagers).toHaveBeenCalledTimes(1);

    // Inline arrow re-renders must not churn subscriptions or loop.
    await act(async () => root.render(<Harness mode="getter" />));
    await act(async () => root.render(<Harness mode="getter" />));
    expect(subscribeHubVersion).toHaveBeenCalledTimes(1);
    expect(subscribeHostedManagers).toHaveBeenCalledTimes(1);
    expect(renders).toBeLessThan(12);

    // Mutating subscribed values updates rendered output.
    await act(async () => {
      hubVer = "v1-202611151200";
      managers = [{ ...HOSTED_MANAGER, name: "Updated Assistant" }];
      verListeners.forEach((l) => l());
      mgrListeners.forEach((l) => l());
    });
    expect(host.querySelector('[data-testid="builds"]')?.textContent).toContain("v1-202611151200");
    expect(host.querySelector('[data-testid="deploy-hosted-why"]')?.textContent).toContain("Updated Assistant");
    expectNoDefaultSingletons();
  });

  it("fences deploy across scopeKey switch, machine.id switch, synchronous ABA bursts, and unmount", async () => {
    let currentScope = "scope-a";
    const scopeListeners = new Set<() => void>();
    const subscribeScopeKey = (l: () => void) => {
      scopeListeners.add(l);
      return () => { scopeListeners.delete(l); };
    };

    const signals: AbortSignal[] = [];
    const deferreds: ReturnType<typeof deferred<boolean>>[] = [];
    const deployFn = vi.fn((_m: Machine, signal: AbortSignal) => {
      signals.push(signal);
      const d = deferred<boolean>();
      deferreds.push(d);
      return d.promise;
    });
    const refreshFn = vi.fn();
    const onError = vi.fn();

    const deps: DeploySectionDeps = {
      scopeKey: () => currentScope,
      subscribeScopeKey,
      hubVersion: "v1-202611141020",
      roster: null,
      deploy: deployFn,
      refresh: refreshFn,
      onError,
    };

    await act(async () => root.render(<DeploySection machine={STUDIO} agents={[]} deps={deps} />));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="redeploy"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="redeploy-confirm"]')!.click(); });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    expect(host.querySelector('[data-testid="deploy-stepper"]')).not.toBeNull();

    // Synchronous ABA burst resets stepper and aborts active deploy.
    await act(async () => {
      currentScope = "scope-b";
      scopeListeners.forEach((l) => l());
      currentScope = "scope-a";
      scopeListeners.forEach((l) => l());
    });
    await flush();
    expect(signals[0]!.aborted).toBe(true);
    expect(host.querySelector('[data-testid="deploy-stepper"]')).toBeNull();

    // Late rejection from aborted deploy must not surface error or call refresh/onError.
    deferreds[0]!.reject(new Error("late failure"));
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(refreshFn).not.toHaveBeenCalled();

    // Start a second deploy on STUDIO, then switch to MINI.
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="redeploy"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="redeploy-confirm"]')!.click(); });
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);

    await act(async () => root.render(<DeploySection machine={MINI} agents={[]} deps={deps} />));
    await flush();
    expect(signals[1]!.aborted).toBe(true);
    expect(host.querySelector('[data-testid="deploy-stepper"]')).toBeNull();

    // Start a third deploy on MINI and unmount while pending.
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="redeploy"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="redeploy-confirm"]')!.click(); });
    expect(signals).toHaveLength(3);
    act(() => root.unmount());
    expect(signals[2]!.aborted).toBe(true);
    deferreds[2]!.resolve(true);
    await flush();
    expect(refreshFn).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps sawBusy/furthest and live deploy pure during an abandoned concurrent transition render", async () => {
    const neverResolving = new Promise<void>(() => {});
    const deployDeferred = deferred<boolean>();
    const signals: AbortSignal[] = [];
    const deployFn = vi.fn((_m: Machine, signal: AbortSignal) => {
      signals.push(signal);
      return deployDeferred.promise;
    });

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
          <DeploySection
            machine={next ? { ...STUDIO, deploying: true, deploy_phase: "confirming" } : STUDIO}
            agents={[]}
            deps={{
              scopeKey: next ? "scope-b" : "scope-a",
              hubVersion: "v1-202611141020",
              roster: null,
              deploy: deployFn,
            }}
          />
          <Suspender suspend={next} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="redeploy"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="redeploy-confirm"]')!.click(); });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    // Abandoned render tries to switch scope and push phase "confirming" — must not abort or mutate committed progress.
    await act(async () => {
      triggerTransition();
    });
    expect(signals[0]!.aborted).toBe(false);
    expect(host.querySelector('[data-step="confirming"]')?.getAttribute("data-state")).toBe("todo");

    deployDeferred.resolve(true);
    await flush();
    expectNoDefaultSingletons();
  });

  it("recovers via try/finally on sync throw and async reject even when formatError/notify/onError throw", async () => {
    let mode: "sync" | "async" = "sync";
    const errors: string[] = [];
    const deployFn = vi.fn(() => {
      if (mode === "sync") throw new Error("sync deploy boom");
      return Promise.reject(new Error("async deploy boom"));
    });
    const formatError = vi.fn((err: unknown) => {
      if (mode === "sync") throw new Error("formatter broke");
      return `fmt:${(err as Error).message}`;
    });
    const notify = vi.fn(() => {
      throw new Error("notify broke");
    });
    const onError = vi.fn((msg: string) => {
      errors.push(msg);
      throw new Error("observer broke");
    });

    await act(async () => root.render(
      <DeploySection
        machine={STUDIO}
        agents={[]}
        deps={{ hubVersion: "v1-202611141020", roster: null, deploy: deployFn, formatError, notify, onError }}
      />,
    ));

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="redeploy"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="redeploy-confirm"]')!.click(); });
    await flush();

    expect(host.querySelector('[data-testid="deploy-failed"]')?.textContent).toContain("sync deploy boom");
    expect(host.querySelector('[data-testid="redeploy"]')?.textContent).toBe(t("machines-alerts.try_again"));

    // Retry with async rejection; pending must release and display formatted error.
    mode = "async";
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="redeploy"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="redeploy-confirm"]')!.click(); });
    await flush();

    expect(host.querySelector('[data-testid="deploy-failed"]')?.textContent).toContain("fmt:async deploy boom");
    expect(errors).toContain("fmt:async deploy boom");
    expect(notify).toHaveBeenCalledTimes(2);
    expectNoDefaultSingletons();
  });

  it("supports renderHostedManagers, renderView, and preserves default fallback parity when deps is omitted", async () => {
    await act(async () => root.render(
      <DeploySection
        machine={STUDIO}
        agents={[]}
        deps={{
          hubVersion: "v1-202611141020",
          hostedManagers: [HOSTED_MANAGER],
          deploy: async () => true,
          renderHostedManagers: ({ managers }) => <div data-testid="custom-hosted">{managers.length}</div>,
        }}
      />,
    ));
    expect(host.querySelector('[data-testid="custom-hosted"]')?.textContent).toBe("1");
    expectNoDefaultSingletons();

    await act(async () => root.render(
      <DeploySection
        machine={STUDIO}
        agents={[]}
        deps={{
          hubVersion: "v1-202611141020",
          roster: null,
          deploy: async () => true,
          renderView: (props) => <div data-testid="custom-deploy-view">{props.hubVersion}</div>,
        }}
      />,
    ));
    expect(host.querySelector('[data-testid="custom-deploy-view"]')?.textContent).toBe("v1-202611141020");
    expectNoDefaultSingletons();

    // Omitting deps mounts default bridges (useStore, useRoster, useDeploy).
    mocks.roster = { default: "m-1", managers: [HOSTED_MANAGER] };
    await act(async () => root.render(<DeploySection machine={STUDIO} agents={[]} />));
    expect(mocks.useStore).toHaveBeenCalled();
    expect(mocks.useRoster).toHaveBeenCalled();
    expect(mocks.useDeploy).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="deploy-hosted-managers"]')?.textContent).toContain("Studio Assistant");

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="redeploy"]')!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="redeploy-confirm"]')!.click(); });
    await flush();
    expect(mocks.defaultDeploy).toHaveBeenCalledTimes(1);
  });
});
