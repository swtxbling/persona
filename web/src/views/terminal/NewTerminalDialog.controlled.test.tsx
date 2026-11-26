// @vitest-environment jsdom
// Controlled NewTerminalDialog (NewTerminalDialogView & NewTerminalDialog) bypasses useScopedMachines/usePanes/useStore/api/navigate
// singletons, caches fresh getter snapshots via sameValue without subscription churn, preserves render purity across abandoned
// concurrent transitions, fences scope switches, open close/reopen ABA, and unmount, recovers via try/finally, and keeps defaults.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, t } from "../../i18n";
import type { Listing } from "../../lib/terminal-panes";
import type { PanesResponse } from "../../lib/terminals";
import type { Machine } from "../../lib/types";
import type { NewTerminalDialogDeps, NewTerminalDialogViewProps, NewTerminalTarget } from "./NewTerminalDialog";

const mocks = vi.hoisted(() => ({
  useScopedMachines: vi.fn(),
  usePanes: vi.fn(),
  useStore: vi.fn(),
  api: vi.fn(),
  errorText: vi.fn((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`),
  navigate: vi.fn(),
}));

vi.mock("../../lib/current-assistant", () => ({
  useScopedMachines: () => mocks.useScopedMachines(),
}));
vi.mock("../../lib/terminal-panes", async (original) => ({
  ...(await original<typeof import("../../lib/terminal-panes")>()),
  usePanes: (...args: unknown[]) => mocks.usePanes(...args),
}));
vi.mock("../../lib/store", async (original) => ({
  ...(await original<typeof import("../../lib/store")>()),
  useStore: (selector: (s: { features: string[] }) => unknown) => mocks.useStore(selector),
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

const { NewTerminalDialog, NewTerminalDialogView } = await import("./NewTerminalDialog");

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

const paneHost = (workspaces: { id: string; label: string }[] = []): PanesResponse => ({
  hosts: [{ kind: "herdr", control: true, stream: true, new_tab: true, workspaces, tabs: [], panes: [] }],
});

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
const activeDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const findButton = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const alertTexts = () => [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent?.trim() ?? "");

const expectNoDefaultSingletons = () => {
  expect(mocks.useScopedMachines).not.toHaveBeenCalled();
  expect(mocks.usePanes).not.toHaveBeenCalled();
  expect(mocks.useStore).not.toHaveBeenCalled();
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.errorText).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n("en");
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.errorText.mockImplementation((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NewTerminalDialogView (pure presentation)", () => {
  it("renders choices, listing error retry, empty state, inline error, and pending status without touching singletons", async () => {
    const onClose = vi.fn();
    const onRetry = vi.fn();
    const onStart = vi.fn();
    const m1 = makeMachine("m1", "Workstation");
    const m2 = makeMachine("m2", "Broken Box");

    await act(async () => root.render(
      <NewTerminalDialogView
        open
        busy={false}
        pending={false}
        error="Open failed"
        choices={[
          {
            machine: m1,
            spaces: [{ id: "ws1", host: "herdr", label: "Core", branch: "", cwd: "/core", canOpen: true, tabs: [] }],
            home: undefined,
            listing: { data: paneHost([{ id: "ws1", label: "Core" }]) },
          },
          {
            machine: m2,
            spaces: [],
            home: undefined,
            listing: { error: "Node offline" },
          },
        ]}
        onClose={onClose}
        onRetry={onRetry}
        onStart={onStart}
      />,
    ));

    const dlg = activeDialog()!;
    expect(dlg.textContent).toContain("Workstation");
    expect(dlg.textContent).toContain("Broken Box");
    expect(alertTexts()).toEqual(expect.arrayContaining([expect.stringContaining("Node offline"), "Open failed"]));

    await act(async () => findButton(t("terminal-terminalpage.new_in_space", { name: "Core" }))!.click());
    expect(onStart).toHaveBeenCalledWith("m1", { kind: "herdr", workspace_id: "ws1" });

    await act(async () => findButton(t("sidebar.retry"))!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    // Pending disables buttons and renders status; empty choices renders none_online.
    await act(async () => root.render(
      <NewTerminalDialogView
        open
        busy
        pending
        error=""
        choices={[]}
        onClose={onClose}
        onRetry={onRetry}
        onStart={onStart}
      />,
    ));
    expect(activeDialog()!.textContent).toContain(t("terminal-terminalpage.none_online"));
    expect(document.querySelectorAll('[role="status"]').length).toBe(2);
    expectNoDefaultSingletons();
  });
});

describe("NewTerminalDialog controlled deps, getter caching, render purity, and async fencing", () => {
  it("bypasses all default singletons, caches fresh getter snapshots without subscription churn, and supports custom renderView", async () => {
    const machineListeners = new Set<() => void>();
    const panesListeners = new Set<() => void>();
    const newSpaceListeners = new Set<() => void>();
    const scopeListeners = new Set<() => void>();

    let machines: Machine[] = [makeMachine("one", "Computer one", true), makeMachine("off", "Offline", false)];
    let listing: Record<string, Listing> = { one: { data: paneHost([{ id: "w1", label: "Alpha" }]) } };
    let busy = false;
    let canNewSpace = true;
    const scope = "s1";
    let machineReads = 0;
    let panesReads = 0;

    const subscribeMachines = vi.fn((l: () => void) => { machineListeners.add(l); return () => { machineListeners.delete(l); }; });
    const subscribePanes = vi.fn((l: () => void) => { panesListeners.add(l); return () => { panesListeners.delete(l); }; });
    const subscribeCanNewSpace = vi.fn((l: () => void) => { newSpaceListeners.add(l); return () => { newSpaceListeners.delete(l); }; });
    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });

    const refreshSpy = vi.fn();
    const openTerminal = vi.fn(async () => ({ terminal: "pane:controlled" }));
    const navSpy = vi.fn();
    const onClose = vi.fn();
    const onOpened = vi.fn();

    const makeDeps = (): NewTerminalDialogDeps => ({
      scopeKey: () => scope,
      subscribeScopeKey,
      // Fresh array and nested object allocations on every call must stabilize via sameValue.
      machines: () => {
        machineReads += 1;
        return machines.map((m) => ({ ...m }));
      },
      subscribeMachines,
      // Fresh object AND fresh inline refresh arrow on every call must NOT loop in useSyncExternalStore.
      panes: () => {
        panesReads += 1;
        return {
          listing: JSON.parse(JSON.stringify(listing)) as Record<string, Listing>,
          busy,
          refresh: () => refreshSpy(),
        };
      },
      subscribePanes,
      canNewSpace: () => canNewSpace,
      subscribeCanNewSpace,
      openTerminal,
      navigate: navSpy,
      formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
    });

    await act(async () => root.render(<StrictMode><NewTerminalDialog open onClose={onClose} onOpened={onOpened} deps={makeDeps()} /></StrictMode>));
    expect(findButton(t("terminal-terminalpage.new_in_space", { name: "Alpha" }))).toBeDefined();
    expect(machineReads).toBeLessThan(20);
    expect(panesReads).toBeLessThan(20);

    const subCounts = {
      machines: subscribeMachines.mock.calls.length,
      panes: subscribePanes.mock.calls.length,
      newSpace: subscribeCanNewSpace.mock.calls.length,
      scope: subscribeScopeKey.mock.calls.length,
    };

    // Re-rendering with fresh inline getter closures must NOT churn any subscription.
    await act(async () => root.render(<StrictMode><NewTerminalDialog open onClose={onClose} onOpened={onOpened} deps={makeDeps()} /></StrictMode>));
    expect(subscribeMachines).toHaveBeenCalledTimes(subCounts.machines);
    expect(subscribePanes).toHaveBeenCalledTimes(subCounts.panes);
    expect(subscribeCanNewSpace).toHaveBeenCalledTimes(subCounts.newSpace);
    expect(subscribeScopeKey).toHaveBeenCalledTimes(subCounts.scope);

    // Unchanged semantic re-emissions stay cached and stable.
    await act(async () => {
      machineListeners.forEach((l) => l());
      panesListeners.forEach((l) => l());
    });
    expect(findButton(t("terminal-terminalpage.new_in_space", { name: "Alpha" }))).toBeDefined();

    // Mutate listing to error -> Retry button calls latest inline refresh; then mutate to empty home workspace.
    listing = { one: { error: "Temporary failure" } };
    await act(async () => { panesListeners.forEach((l) => l()); });
    await act(async () => findButton(t("sidebar.retry"))!.click());
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    listing = { one: { data: paneHost([]) } };
    await act(async () => { panesListeners.forEach((l) => l()); });
    expect(findButton(t("terminal-terminalpage.new_terminal"))).toBeDefined();

    // Flipping canNewSpace to false hides the home button and shows no_panes_agent.
    canNewSpace = false;
    await act(async () => { newSpaceListeners.forEach((l) => l()); });
    expect(findButton(t("terminal-terminalpage.new_terminal"))).toBeUndefined();
    expect(activeDialog()!.textContent).toContain(t("terminal-terminalpage.no_panes_agent"));

    // Flip back to true and open home terminal cleanly.
    canNewSpace = true;
    await act(async () => { newSpaceListeners.forEach((l) => l()); });
    await act(async () => findButton(t("terminal-terminalpage.new_terminal"))!.click());
    await flush();
    expect(openTerminal).toHaveBeenCalledWith("one", { kind: "herdr", cwd: "~", new_space: true }, expect.any(AbortSignal));
    expect(navSpy).toHaveBeenCalledWith({ name: "terminal", mid: "one", id: "pane:controlled", view: "terminals" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpened).toHaveBeenCalledTimes(1);

    // Custom renderView seam works cleanly.
    const captured: NewTerminalDialogViewProps[] = [];
    await act(async () => root.render(
      <NewTerminalDialog
        open
        onClose={onClose}
        deps={{
          machines,
          panes: { listing, busy },
          canNewSpace: true,
          renderView: (p) => {
            captured.push(p);
            return <div data-custom-ntd={String(p.choices.length)} />;
          },
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-ntd]")?.getAttribute("data-custom-ntd")).toBe("1");
    expect(captured.length).toBeGreaterThan(0);
    expectNoDefaultSingletons();
  });

  it.each(["resolve", "reject"] as const)(
    "enforces single-flight and fences stale %s across scope ABA, open close/reopen ABA (true -> false -> true), and unmount",
    async (staleOutcome) => {
      let scope = "s1";
      const scopeListeners = new Set<() => void>();
      const runs: Array<{ mid: string; at: NewTerminalTarget; signal: AbortSignal; gate: ReturnType<typeof deferred<{ terminal: string }>> }> = [];
      const navSpy = vi.fn();
      const onClose = vi.fn();
      const onOpened = vi.fn();
      const onError = vi.fn();

      const deps: NewTerminalDialogDeps = {
        scopeKey: () => scope,
        subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
        machines: [makeMachine("one", "Computer one")],
        panes: { listing: { one: { data: paneHost([{ id: "ws1", label: "Example" }]) } }, busy: false },
        canNewSpace: true,
        openTerminal: (mid, at, signal) => {
          const gate = deferred<{ terminal: string }>();
          runs.push({ mid, at, signal, gate });
          return gate.promise;
        },
        navigate: navSpy,
        formatError: (e) => (e instanceof Error ? e.message : String(e)),
        onError,
      };
      const label = t("terminal-terminalpage.new_in_space", { name: "Example" });

      await act(async () => root.render(<NewTerminalDialog open onClose={onClose} onOpened={onOpened} deps={deps} />));

      // 1. Synchronous double-click admits only one start.
      await act(async () => {
        const btn = findButton(label)!;
        btn.click();
        btn.click();
      });
      expect(runs).toHaveLength(1);
      expect(findButton(label)!.disabled).toBe(true);

      // 2. Synchronous scope ABA burst (s1 -> s2 -> s1) aborts run #1, resets pending, and fences late settlement.
      await act(async () => {
        scope = "s2";
        scopeListeners.forEach((l) => l());
        scope = "s1";
        scopeListeners.forEach((l) => l());
      });
      expect(runs[0].signal.aborted).toBe(true);
      expect(findButton(label)!.disabled).toBe(false);

      await act(async () => {
        if (staleOutcome === "resolve") runs[0].gate.resolve({ terminal: "pane:stale-scope" });
        else runs[0].gate.reject(new Error("stale scope failure"));
      });
      await flush();
      expect(navSpy).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(onOpened).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(alertTexts()).toEqual([]);

      // 3. Close/reopen ABA (open: true -> false -> true) aborts run #2, resets pending, and fences late settlement even while run #3 is active.
      await act(async () => findButton(label)!.click());
      expect(runs).toHaveLength(2);
      expect(runs[1].signal.aborted).toBe(false);

      await act(async () => root.render(<NewTerminalDialog open={false} onClose={onClose} onOpened={onOpened} deps={deps} />));
      expect(runs[1].signal.aborted).toBe(true);
      await act(async () => root.render(<NewTerminalDialog open onClose={onClose} onOpened={onOpened} deps={deps} />));
      expect(findButton(label)!.disabled).toBe(false);

      await act(async () => findButton(label)!.click());
      expect(runs).toHaveLength(3);
      expect(findButton(label)!.disabled).toBe(true);

      await act(async () => {
        if (staleOutcome === "resolve") runs[1].gate.resolve({ terminal: "pane:stale-aba" });
        else runs[1].gate.reject(new Error("stale close/reopen error"));
      });
      await flush();
      expect(navSpy).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(onOpened).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(alertTexts()).toEqual([]);
      expect(findButton(label)!.disabled).toBe(true);

      // 4. Unmount aborts run #3 and fences late settlement.
      await act(async () => root.render(null));
      expect(runs[2].signal.aborted).toBe(true);
      await act(async () => {
        if (staleOutcome === "resolve") runs[2].gate.resolve({ terminal: "pane:after-unmount" });
        else runs[2].gate.reject(new Error("after unmount"));
      });
      await flush();
      expect(navSpy).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(onOpened).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expectNoDefaultSingletons();
    },
  );

  it("keeps committed scope and in-flight terminal open intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const openGate = deferred<{ terminal: string }>();
    let capturedSignal: AbortSignal | null = null;
    const navSpy = vi.fn();
    const onClose = vi.fn();
    const onOpened = vi.fn();
    const renderedScopes: string[] = [];

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    let setHarness!: (next: { scope: string; block: boolean }) => void;
    function TransitionHarness() {
      const [state, setState] = useState({ scope: "s1", block: false });
      setHarness = setState;
      renderedScopes.push(state.scope);
      return (
        <Suspense fallback={<div data-fallback />}>
          <NewTerminalDialog
            open
            onClose={onClose}
            onOpened={onOpened}
            deps={{
              scopeKey: state.scope,
              machines: [makeMachine("one", "Computer one")],
              panes: { listing: { one: { data: paneHost([{ id: "ws1", label: "Example" }]) } }, busy: false },
              canNewSpace: true,
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

    const label = t("terminal-terminalpage.new_in_space", { name: "Example" });
    await act(async () => root.render(<TransitionHarness />));
    await act(async () => findButton(label)!.click());
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    expect(findButton(label)!.disabled).toBe(true);

    // Suspended concurrent transition to s2 must NOT abort committed s1 openTerminal.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);

    // Abandon transition back to s1 -> openGate resolves cleanly and navigates.
    await act(async () => setHarness({ scope: "s1", block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => openGate.resolve({ terminal: "pane:survived" }));
    await flush();
    expect(navSpy).toHaveBeenCalledWith({ name: "terminal", mid: "one", id: "pane:survived", view: "terminals" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpened).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("resets error across open/scope transitions and recovers via try/finally even when formatError/onError/openTerminal/navigate throw", async () => {
    let attempt = 0;
    const formatError = vi.fn<(error: unknown) => string>(() => { throw new Error("fmt boom"); });
    const onError = vi.fn<(message: string, error: unknown) => void>(() => { throw new Error("observer boom"); });
    const navSpy = vi.fn();
    const onClose = vi.fn();
    const makeDeps = (scopeKey: string): NewTerminalDialogDeps => ({
      scopeKey,
      machines: [makeMachine("one", "Computer one")],
      panes: { listing: { one: { data: paneHost([{ id: "ws1", label: "Example" }]) } }, busy: false },
      canNewSpace: true,
      openTerminal: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("sync boom");
        if (attempt === 2) return Promise.reject(new Error("async boom"));
        return Promise.resolve({ terminal: "pane:ok" });
      },
      navigate: navSpy,
      formatError,
      onError,
    });
    const label = t("terminal-terminalpage.new_in_space", { name: "Example" });

    await act(async () => root.render(<NewTerminalDialog open onClose={onClose} deps={makeDeps("s1")} />));

    // Sync throw + throwing observers -> falls back to errorText, releases pending cleanly.
    await act(async () => findButton(label)!.click());
    await flush();
    expect(alertTexts()).toEqual([t("terminal-terminalpage.new_failed", { error: "default-err:sync boom" })]);
    expect(findButton(label)!.disabled).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);

    // Close + reopen resets stale error cleanly.
    await act(async () => root.render(<NewTerminalDialog open={false} onClose={onClose} deps={makeDeps("s1")} />));
    await act(async () => root.render(<NewTerminalDialog open onClose={onClose} deps={makeDeps("s1")} />));
    expect(alertTexts()).toEqual([]);

    // Async rejection + scope switch resets error; throwing navigate still recovers pending cleanly; next retry succeeds.
    formatError.mockImplementation((e: unknown) => `custom:${e instanceof Error ? e.message : String(e)}`);
    await act(async () => findButton(label)!.click());
    await flush();
    expect(alertTexts()).toEqual([t("terminal-terminalpage.new_failed", { error: "custom:async boom" })]);

    await act(async () => root.render(<NewTerminalDialog open onClose={onClose} deps={makeDeps("s2")} />));
    expect(alertTexts()).toEqual([]);

    navSpy.mockImplementationOnce(() => { throw new Error("nav boom"); });
    await act(async () => findButton(label)!.click());
    await flush();
    expect(alertTexts()).toEqual([t("terminal-terminalpage.new_failed", { error: "custom:nav boom" })]);
    expect(findButton(label)!.disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => findButton(label)!.click());
    await flush();
    expect(navSpy).toHaveBeenLastCalledWith({ name: "terminal", mid: "one", id: "pane:ok", view: "terminals" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("preserves default useScopedMachines, usePanes, useStore, api, navigate, and errorText fallbacks when deps is omitted", async () => {
    const refresh = vi.fn();
    mocks.useScopedMachines.mockReturnValue([makeMachine("one", "Computer one")]);
    mocks.usePanes.mockReturnValue({ listing: { one: { data: paneHost([{ id: "ws1", label: "Example" }]) } }, busy: false, refresh });
    mocks.useStore.mockImplementation((sel: (s: { features: string[] }) => unknown) => sel({ features: ["pane_new_space"] }));
    mocks.api.mockRejectedValueOnce(new Error("hub down")).mockResolvedValueOnce({ terminal: "pane:default" });
    const onClose = vi.fn();
    const onOpened = vi.fn();

    await act(async () => root.render(<NewTerminalDialog open onClose={onClose} onOpened={onOpened} />));
    expect(mocks.useScopedMachines).toHaveBeenCalled();
    expect(mocks.usePanes).toHaveBeenCalled();
    expect(mocks.useStore).toHaveBeenCalled();

    const label = t("terminal-terminalpage.new_in_space", { name: "Example" });
    await act(async () => findButton(label)!.click());
    await flush();
    expect(mocks.errorText).toHaveBeenCalled();
    expect(alertTexts()).toEqual([t("terminal-terminalpage.new_failed", { error: "default-err:hub down" })]);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => findButton(label)!.click());
    await flush();
    expect(mocks.api).toHaveBeenLastCalledWith("/machines/one/panes", { method: "POST", json: { kind: "herdr", workspace_id: "ws1" } });
    expect(mocks.navigate).toHaveBeenCalledWith({ name: "terminal", mid: "one", id: "pane:default", view: "terminals" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpened).toHaveBeenCalledTimes(1);
  });
});
