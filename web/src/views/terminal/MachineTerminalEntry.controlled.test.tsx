// @vitest-environment jsdom
// Controlled MachineTerminalEntry (MachineTerminalEntryView & MachineTerminalEntry) bypasses api/navigate/errorText
// singletons, tracks committed scopeKey + target identity (mid/cwd/workspaceId/host), preserves render purity across
// abandoned concurrent transitions, fences target/scope switches, ABA, and unmount on start and auto-resume navigate,
// recovers via try/finally even with throwing observers, and preserves 100% default fallback parity.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, t } from "../../i18n";
import type { MachineTerminalTarget } from "../../lib/machine-terminal";
import type { Listing } from "../../lib/terminal-panes";
import type { PaneHostDTO } from "../../lib/terminals";
import type { Machine } from "../../lib/types";
import type {
  MachineTerminalEntryDeps,
  MachineTerminalEntryViewProps,
  MachineTerminalOpenRequest,
} from "./MachineTerminalEntry";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  errorText: vi.fn((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`),
  navigate: vi.fn(),
}));

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  api: (...args: unknown[]) => mocks.api(...args),
  errorText: (e: unknown) => mocks.errorText(e),
}));
vi.mock("../../lib/router", async (original) => ({
  ...(await original<typeof import("../../lib/router")>()),
  navigate: (...args: unknown[]) => mocks.navigate(...args),
}));

const { MachineTerminalEntry, MachineTerminalEntryView } = await import("./MachineTerminalEntry");

function deferred<T = { terminal: string }>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const makeMachine = (id: string, name: string, online = true): Machine => ({
  id,
  name,
  online,
} as Machine);

const makeHost = (patch: Partial<PaneHostDTO> = {}): PaneHostDTO => ({
  kind: "herdr",
  stream: true,
  control: true,
  new_tab: true,
  workspaces: [],
  tabs: [],
  panes: [],
  ...patch,
});

const emptyListing = (hostPatch: Partial<PaneHostDTO> = {}): Listing => ({
  data: { hosts: [makeHost(hostPatch)] },
});

const resumableListing = (paneTerminal: string, cwd = "/code/app"): Listing => ({
  data: {
    hosts: [
      makeHost({
        workspaces: [{ id: "ws1", label: "app", cwd }],
        tabs: [{ id: "t1", workspace_id: "ws1", label: "shell" }],
        panes: [{ pane: "w1:p1", terminal: paneTerminal, tab_id: "t1", workspace_id: "ws1", cwd }],
      }),
    ],
  },
});

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
const findButton = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const alertText = () => host.querySelector('[role="alert"]')?.textContent?.trim() ?? "";

const expectNoDefaultSingletons = () => {
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.errorText).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n("en");
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.errorText.mockImplementation((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("MachineTerminalEntryView (pure presentation)", () => {
  it("renders offline, error, loading, ready, and unavailable states and wires callbacks without touching singletons", async () => {
    const onBack = vi.fn();
    const onRetry = vi.fn();
    const onStart = vi.fn();

    await act(async () => root.render(
      <MachineTerminalEntryView
        machineLabel="Build Box"
        cwd="/srv/app"
        status="offline"
        pending={false}
        error=""
        onBack={onBack}
        onRetry={onRetry}
        onStart={onStart}
      />,
    ));
    expect(host.textContent).toContain("Build Box");
    expect(host.textContent).toContain("/srv/app");
    expect(host.textContent).toContain(t("terminal-terminalpage.offline"));
    await act(async () => findButton(t("terminal-terminalpage.back_terminals"))!.click());
    expect(onBack).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <MachineTerminalEntryView
        machineLabel="Build Box"
        status="error"
        listingError="Listing timed out"
        pending={false}
        error=""
        onBack={onBack}
        onRetry={onRetry}
        onStart={onStart}
      />,
    ));
    expect(alertText()).toContain("Listing timed out");
    await act(async () => findButton(t("terminal-terminalpage.retry"))!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <MachineTerminalEntryView
        machineLabel="Build Box"
        status="loading"
        pending={false}
        error=""
        onBack={onBack}
        onRetry={onRetry}
        onStart={onStart}
      />,
    ));
    expect(host.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => root.render(
      <MachineTerminalEntryView
        machineLabel="Build Box"
        status="ready"
        pending={false}
        error="Create failed"
        onBack={onBack}
        onRetry={onRetry}
        onStart={onStart}
      />,
    ));
    expect(alertText()).toBe("Create failed");
    await act(async () => findButton(t("terminal-terminalpage.new_terminal"))!.click());
    expect(onStart).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <MachineTerminalEntryView
        machineLabel="Build Box"
        status="unavailable"
        pending={false}
        error=""
        onBack={onBack}
        onRetry={onRetry}
        onStart={onStart}
      />,
    ));
    expect(host.textContent).toContain(t("work-entry.terminal_unavailable"));
    expectNoDefaultSingletons();
  });
});

describe("MachineTerminalEntry controlled deps, target/scope tracking, render purity, and async fencing", () => {
  it("bypasses api/navigate/errorText, handles auto-resume and Back, avoids scope subscription churn, and supports renderView", async () => {
    const scopeListeners = new Set<() => void>();
    const scope = "s1";
    const subscribeScopeKey = vi.fn((l: () => void) => {
      scopeListeners.add(l);
      return () => { scopeListeners.delete(l); };
    });
    const navSpy = vi.fn();
    const openTerminal = vi.fn();
    const retry = vi.fn();

    const makeDeps = (): MachineTerminalEntryDeps => ({
      scopeKey: () => scope,
      subscribeScopeKey,
      openTerminal,
      navigate: navSpy,
      formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
    });

    // Auto-resume navigates via controlled deps.navigate without touching router.navigate.
    await act(async () => root.render(
      <StrictMode>
        <MachineTerminalEntry
          target={{ mid: "m1", cwd: "/code/app" }}
          machine={makeMachine("m1", "Laptop")}
          listing={resumableListing("pane:existing-1", "/code/app")}
          canCreateSpace
          canOpenFolder
          retry={retry}
          deps={makeDeps()}
        />
      </StrictMode>,
    ));
    expect(navSpy).toHaveBeenCalledWith({ name: "terminal", mid: "m1", id: "pane:existing-1", view: "terminals" }, true, {});
    const subCount = subscribeScopeKey.mock.calls.length;
    const navCountAfterMount = navSpy.mock.calls.length;

    // Re-rendering with a fresh inline scopeKey getter must NOT churn subscribeScopeKey or re-fire auto-resume.
    await act(async () => root.render(
      <StrictMode>
        <MachineTerminalEntry
          target={{ mid: "m1", cwd: "/code/app" }}
          machine={makeMachine("m1", "Laptop")}
          listing={resumableListing("pane:existing-1", "/code/app")}
          canCreateSpace
          canOpenFolder
          retry={retry}
          deps={makeDeps()}
        />
      </StrictMode>,
    ));
    expect(subscribeScopeKey).toHaveBeenCalledTimes(subCount);
    expect(navSpy).toHaveBeenCalledTimes(navCountAfterMount);

    // Clicking Back calls controlled navigate.
    await act(async () => findButton(t("terminal-terminalpage.back_terminals"))!.click());
    expect(navSpy).toHaveBeenLastCalledWith({ name: "terminal", view: "terminals" }, true, {});

    // Custom renderView seam works cleanly.
    const seen: MachineTerminalEntryViewProps[] = [];
    await act(async () => root.render(
      <MachineTerminalEntry
        target={{ mid: "m1", cwd: "/code/new" }}
        machine={makeMachine("m1", "Laptop")}
        listing={emptyListing()}
        canCreateSpace
        canOpenFolder
        retry={retry}
        deps={{
          scopeKey: "s1",
          navigate: navSpy,
          openTerminal,
          renderView: (p) => {
            seen.push(p);
            return <div data-custom-mte={`${p.machineLabel}|${p.status}`} />;
          },
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-mte]")?.getAttribute("data-custom-mte")).toBe("Laptop|ready");
    expect(seen.length).toBeGreaterThan(0);
    expectNoDefaultSingletons();
  });

  it.each(["resolve", "reject"] as const)(
    "enforces single-flight and fences stale %s across target ABA (mid/cwd/workspaceId/host), scope ABA burst, and unmount",
    async (staleOutcome) => {
      let scope = "s1";
      const scopeListeners = new Set<() => void>();
      const runs: Array<{ mid: string; at: MachineTerminalOpenRequest; signal: AbortSignal; gate: ReturnType<typeof deferred<{ terminal: string }>> }> = [];
      const navSpy = vi.fn();
      const onError = vi.fn();
      const retry = vi.fn();

      const deps: MachineTerminalEntryDeps = {
        scopeKey: () => scope,
        subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
        openTerminal: (mid, at, signal) => {
          const gate = deferred<{ terminal: string }>();
          runs.push({ mid, at, signal, gate });
          return gate.promise;
        },
        navigate: navSpy,
        formatError: (e) => (e instanceof Error ? e.message : String(e)),
        onError,
      };

      const renderEntry = (target: MachineTerminalTarget) =>
        root.render(
          <MachineTerminalEntry
            target={target}
            machine={makeMachine(target.mid, `Machine ${target.mid}`)}
            listing={emptyListing()}
            canCreateSpace
            canOpenFolder
            retry={retry}
            deps={deps}
          />,
        );

      const t1: MachineTerminalTarget = { mid: "m1", cwd: "/code/a", workspaceId: "w1", host: "herdr" };
      const t2: MachineTerminalTarget = { mid: "m1", cwd: "/code/b", workspaceId: "w2", host: "herdr" };
      const startLabel = t("terminal-terminalpage.new_terminal");

      await act(async () => renderEntry(t1));

      // 1. Synchronous double-click admits only one openTerminal request.
      await act(async () => {
        const btn = findButton(startLabel)!;
        btn.click();
        btn.click();
      });
      expect(runs).toHaveLength(1);
      expect(runs[0].mid).toBe("m1");
      expect(runs[0].at).toEqual({ kind: "herdr", cwd: "/code/a" });
      expect(findButton(startLabel)!.getAttribute("aria-busy")).toBe("true");

      // 2. Target ABA (t1 -> t2 -> t1) aborts run #1, resets pending, and fences stale settlement even while run #2 is active.
      await act(async () => renderEntry(t2));
      expect(runs[0].signal.aborted).toBe(true);
      await act(async () => renderEntry(t1));
      expect(findButton(startLabel)!.getAttribute("aria-busy")).toBeNull();

      await act(async () => findButton(startLabel)!.click());
      expect(runs).toHaveLength(2);
      expect(findButton(startLabel)!.getAttribute("aria-busy")).toBe("true");

      await act(async () => {
        if (staleOutcome === "resolve") runs[0].gate.resolve({ terminal: "pane:stale-aba" });
        else runs[0].gate.reject(new Error("stale target ABA"));
      });
      await flush();
      expect(navSpy).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(alertText()).toBe("");
      expect(findButton(startLabel)!.getAttribute("aria-busy")).toBe("true");

      // 3. Changing only host/workspaceId also invalidates and aborts run #2.
      await act(async () => renderEntry({ ...t1, host: "tmux" }));
      expect(runs[1].signal.aborted).toBe(true);
      await act(async () => {
        if (staleOutcome === "resolve") runs[1].gate.resolve({ terminal: "pane:stale-host" });
        else runs[1].gate.reject(new Error("stale host switch"));
      });
      await flush();
      expect(navSpy).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(alertText()).toBe("");

      // 4. Synchronous scope ABA burst (s1 -> s2 -> s1) aborts run #3 and fences stale settlement.
      await act(async () => renderEntry(t1));
      await act(async () => findButton(startLabel)!.click());
      expect(runs).toHaveLength(3);
      await act(async () => {
        scope = "s2";
        scopeListeners.forEach((l) => l());
        scope = "s1";
        scopeListeners.forEach((l) => l());
      });
      expect(runs[2].signal.aborted).toBe(true);
      await act(async () => {
        if (staleOutcome === "resolve") runs[2].gate.resolve({ terminal: "pane:stale-scope" });
        else runs[2].gate.reject(new Error("stale scope burst"));
      });
      await flush();
      expect(navSpy).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(alertText()).toBe("");

      // 5. Unmount aborts run #4 and fences stale settlement.
      await act(async () => findButton(startLabel)!.click());
      expect(runs).toHaveLength(4);
      await act(async () => root.render(null));
      expect(runs[3].signal.aborted).toBe(true);
      await act(async () => {
        if (staleOutcome === "resolve") runs[3].gate.resolve({ terminal: "pane:after-unmount" });
        else runs[3].gate.reject(new Error("after unmount"));
      });
      await flush();
      expect(navSpy).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expectNoDefaultSingletons();
    },
  );

  it("keeps committed target and in-flight creation intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const openGate = deferred<{ terminal: string }>();
    let capturedSignal: AbortSignal | null = null;
    const navSpy = vi.fn();
    const renderedCwds: string[] = [];

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    let setHarness!: (next: { cwd: string; block: boolean }) => void;
    function TransitionHarness() {
      const [state, setState] = useState({ cwd: "/code/a", block: false });
      setHarness = setState;
      renderedCwds.push(state.cwd);
      return (
        <Suspense fallback={<div data-fallback />}>
          <MachineTerminalEntry
            target={{ mid: "m1", cwd: state.cwd }}
            machine={makeMachine("m1", "Laptop")}
            listing={emptyListing()}
            canCreateSpace
            canOpenFolder
            retry={() => {}}
            deps={{
              scopeKey: "s1",
              openTerminal: (_mid, _at, signal) => {
                capturedSignal = signal;
                return openGate.promise;
              },
              navigate: navSpy,
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    const startLabel = t("terminal-terminalpage.new_terminal");
    await act(async () => root.render(<TransitionHarness />));
    await act(async () => findButton(startLabel)!.click());
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    expect(findButton(startLabel)!.getAttribute("aria-busy")).toBe("true");

    // Suspended concurrent transition to /code/b must NOT abort committed /code/a creation.
    await act(async () => {
      startTransition(() => setHarness({ cwd: "/code/b", block: true }));
    });
    expect(renderedCwds).toContain("/code/b");
    expect(capturedSignal!.aborted).toBe(false);

    // Abandon transition back to /code/a -> creation resolves cleanly and navigates.
    await act(async () => setHarness({ cwd: "/code/a", block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => openGate.resolve({ terminal: "pane:survived" }));
    await flush();
    expect(navSpy).toHaveBeenCalledWith({ name: "terminal", mid: "m1", id: "pane:survived", view: "terminals" }, true, {});
    expectNoDefaultSingletons();
  });

  it("recovers via try/finally on sync/async failures and throwing formatError/onError/navigate observers, and resets error on target switch", async () => {
    let attempt = 0;
    const formatError = vi.fn<(error: unknown) => string>(() => { throw new Error("fmt boom"); });
    const onError = vi.fn<(message: string, error: unknown) => void>(() => { throw new Error("observer boom"); });
    const navSpy = vi.fn();
    const deps: MachineTerminalEntryDeps = {
      scopeKey: "s1",
      openTerminal: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("sync create boom");
        if (attempt === 2) return Promise.reject(new Error("async create boom"));
        return Promise.resolve({ terminal: "pane:recovered" });
      },
      navigate: navSpy,
      formatError,
      onError,
    };
    const startLabel = t("terminal-terminalpage.new_terminal");

    await act(async () => root.render(
      <MachineTerminalEntry
        target={{ mid: "m1", cwd: "/code/a" }}
        machine={makeMachine("m1", "Laptop")}
        listing={emptyListing()}
        canCreateSpace
        canOpenFolder
        retry={() => {}}
        deps={deps}
      />,
    ));

    // Attempt 1: sync throw + throwing formatError/onError falls back to errorText and releases pending.
    await act(async () => findButton(startLabel)!.click());
    await flush();
    expect(alertText()).toBe(t("terminal-terminalpage.new_failed", { error: "default-err:sync create boom" }));
    expect(findButton(startLabel)!.getAttribute("aria-busy")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);

    // Attempt 2: async rejection with custom formatError.
    formatError.mockImplementation((e: unknown) => `custom:${e instanceof Error ? e.message : String(e)}`);
    await act(async () => findButton(startLabel)!.click());
    await flush();
    expect(alertText()).toBe(t("terminal-terminalpage.new_failed", { error: "custom:async create boom" }));

    // Switching target clears prior error immediately; throwing navigate still recovers pending cleanly; retry succeeds.
    await act(async () => root.render(
      <MachineTerminalEntry
        target={{ mid: "m1", cwd: "/code/b" }}
        machine={makeMachine("m1", "Laptop")}
        listing={emptyListing()}
        canCreateSpace
        canOpenFolder
        retry={() => {}}
        deps={deps}
      />,
    ));
    expect(alertText()).toBe("");

    navSpy.mockImplementationOnce(() => { throw new Error("nav boom"); });
    await act(async () => findButton(startLabel)!.click());
    await flush();
    expect(alertText()).toBe(t("terminal-terminalpage.new_failed", { error: "custom:nav boom" }));
    expect(findButton(startLabel)!.getAttribute("aria-busy")).toBeNull();

    await act(async () => findButton(startLabel)!.click());
    await flush();
    expect(navSpy).toHaveBeenLastCalledWith({ name: "terminal", mid: "m1", id: "pane:recovered", view: "terminals" }, true, {});
  });

  it("preserves default api, navigate, and errorText fallbacks when deps is omitted", async () => {
    mocks.api.mockRejectedValueOnce(new Error("refused")).mockResolvedValueOnce({ terminal: "pane:default" });

    // Auto-resume uses default router.navigate.
    await act(async () => root.render(
      <MachineTerminalEntry
        target={{ mid: "m1", cwd: "/code/app" }}
        machine={makeMachine("m1", "Laptop")}
        listing={resumableListing("pane:auto-1", "/code/app")}
        canCreateSpace
        canOpenFolder
        retry={() => {}}
      />,
    ));
    expect(mocks.navigate).toHaveBeenCalledWith({ name: "terminal", mid: "m1", id: "pane:auto-1", view: "terminals" }, true, {});

    // Create path uses default api, errorText, and navigate.
    await act(async () => root.render(
      <MachineTerminalEntry
        target={{ mid: "m1", cwd: "/code/new" }}
        machine={makeMachine("m1", "Laptop")}
        listing={emptyListing()}
        canCreateSpace
        canOpenFolder
        retry={() => {}}
      />,
    ));
    const startLabel = t("terminal-terminalpage.new_terminal");

    await act(async () => findButton(startLabel)!.click());
    await flush();
    expect(mocks.errorText).toHaveBeenCalled();
    expect(alertText()).toBe(t("terminal-terminalpage.new_failed", { error: "default-err:refused" }));

    await act(async () => findButton(startLabel)!.click());
    await flush();
    expect(mocks.api).toHaveBeenLastCalledWith("/machines/m1/panes", {
      method: "POST",
      json: { kind: "herdr", cwd: "/code/new" },
      signal: expect.any(AbortSignal),
    });
    expect(mocks.navigate).toHaveBeenLastCalledWith({ name: "terminal", mid: "m1", id: "pane:default", view: "terminals" }, true, {});

    // Back button uses default router.navigate.
    await act(async () => findButton(t("terminal-terminalpage.back_terminals"))!.click());
    expect(mocks.navigate).toHaveBeenLastCalledWith({ name: "terminal", view: "terminals" }, true, {});
  });
});
