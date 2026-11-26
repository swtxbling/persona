// @vitest-environment jsdom
// Controlled CloseFinished (useCloseFinished, CloseFinishedDialogView, finishedLabel) bypasses terminal-list/store/api/toast
// singletons, caches/tracks scopeKey subscriptions without churn, preserves render purity across abandoned concurrent renders,
// fences scope switches, cancel/reopen ABA, and unmount on both preview and close, recovers via try/finally even with throwing
// observers, and preserves 100% default fallback parity.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, t } from "../../i18n";
import type { CloseFinishedResult } from "../../lib/terminal-list";
import { buildTerminalTree, type PaneHostDTO } from "../../lib/terminals";
import type { Session } from "../../lib/types";
import type { CloseFinishedDeps, CloseFinishedDialogViewProps } from "./CloseFinished";

const mocks = vi.hoisted(() => ({
  previewFinished: vi.fn(),
  closeFinished: vi.fn(),
  getSession: vi.fn(),
  errorText: vi.fn((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`),
  toast: vi.fn(),
}));

vi.mock("../../lib/terminal-list", async (original) => ({
  ...(await original<typeof import("../../lib/terminal-list")>()),
  previewFinished: (...args: unknown[]) => mocks.previewFinished(...args),
  closeFinished: (...args: unknown[]) => mocks.closeFinished(...args),
}));

vi.mock("../../lib/store", async (original) => ({
  ...(await original<typeof import("../../lib/store")>()),
  getSession: (mid: string, sid: string) => mocks.getSession(mid, sid),
}));

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  errorText: (e: unknown) => mocks.errorText(e),
}));

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  toast: (text: string, tone?: string) => mocks.toast(text, tone),
}));

const { CloseFinishedDialogView, finishedLabel, useCloseFinished } = await import("./CloseFinished");

function deferred<T = CloseFinishedResult>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const HOST: PaneHostDTO = {
  kind: "herdr",
  stream: true,
  control: true,
  new_tab: true,
  workspaces: [{ id: "w1", label: "app" }],
  tabs: [{ id: "t1", workspace_id: "w1", label: "agent-1" }],
  panes: [{ pane: "w1:p2", terminal: "pane:w1:p2", tab_id: "t1", workspace_id: "w1", agent_session: "stopped-1", foreground: "zsh" }],
};

const TREE = buildTerminalTree(
  { hosts: [HOST] },
  [{ machine_id: "m1", session_id: "stopped-1", title: "Write the docs", cwd: "/app", status: "offline", capabilities: { read: true, terminal: true } }],
);

const PREVIEW_ONE: CloseFinishedResult = {
  closed: [{ pane: "w1:p2", session_id: "stopped-1", tab_id: "t1", workspace_id: "w1" }],
  kept: [{ pane: "w1:p9", session_id: "s9", why: "vim" }],
  preview: true,
};

const CLOSED_ONE: CloseFinishedResult = {
  closed: [{ pane: "w1:p2", session_id: "stopped-1", tab_id: "t1", workspace_id: "w1" }],
  kept: [],
  preview: false,
};

let container: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
const activeDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const findButton = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

const expectNoDefaultSingletons = () => {
  expect(mocks.previewFinished).not.toHaveBeenCalled();
  expect(mocks.closeFinished).not.toHaveBeenCalled();
  expect(mocks.getSession).not.toHaveBeenCalled();
  expect(mocks.errorText).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n("en");
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.errorText.mockImplementation((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CloseFinishedDialogView & finishedLabel (pure presentation and override)", () => {
  it("renders pure CloseFinishedDialogView rows, kept notice, busy state, and actions without touching singletons", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    await act(async () => root.render(
      <CloseFinishedDialogView
        open
        rows={[{ key: "w1:p2", label: "Finished: Write the docs" }]}
        kept={2}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    ));

    const dlg = activeDialog()!;
    expect(dlg).not.toBeNull();
    expect(dlg.textContent).toContain(t("terminal-terminalpage.close_finished_title", { count: 1 }));
    expect(dlg.textContent).toContain("Finished: Write the docs");
    expect(dlg.textContent).toContain(t("terminal-terminalpage.close_finished_kept", { count: 2 }));

    await act(async () => findButton(t("common.cancel"))!.click());
    await act(async () => findButton(t("terminal-terminalpage.close_finished_confirm"))!.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <CloseFinishedDialogView
        open
        rows={[{ key: "w1:p2", label: "Finished: Write the docs" }]}
        kept={0}
        busy
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    ));
    expect(findButton(t("common.cancel"))!.disabled).toBe(true);
    expect(findButton(t("terminal-terminalpage.close_finished_confirm"))!.getAttribute("aria-busy")).toBe("true");
    expectNoDefaultSingletons();
  });

  it("supports optional getSession override on finishedLabel without calling store.getSession", () => {
    const customSession = { machine_id: "m1", session_id: "s-custom", title: "Custom Title", cwd: "/app", status: "offline" } as Session;
    const label = finishedLabel([], "w1:p99", "s-custom", "m1", () => customSession);
    expect(label).toBe(t("lib-terminals.finished", { title: "Custom Title" }));
    expect(mocks.getSession).not.toHaveBeenCalled();

    mocks.getSession.mockReturnValueOnce({ machine_id: "m1", session_id: "s-default", title: "Store Title", cwd: "/app", status: "offline" } as Session);
    expect(finishedLabel([], "w1:p98", "s-default", "m1")).toBe(t("lib-terminals.finished", { title: "Store Title" }));
    expect(mocks.getSession).toHaveBeenCalledWith("m1", "s-default");
  });
});

describe("useCloseFinished controlled deps, subscription stability, render purity, and async fencing", () => {
  function Harness({ deps, reload, spacesOf = () => TREE }: {
    deps?: CloseFinishedDeps;
    reload: (mid: string) => void;
    spacesOf?: (mid: string) => typeof TREE;
  }) {
    const finished = useCloseFinished({ spacesOf, reload, deps });
    return (
      <>
        <button type="button" data-start-m1 onClick={() => void finished.start("m1")}>start-m1</button>
        <button type="button" data-start-m2 onClick={() => void finished.start("m2")}>start-m2</button>
        <span data-previewing>{finished.previewing ?? ""}</span>
        {finished.dialog}
      </>
    );
  }

  it("bypasses all default singletons, enforces single-flight on start/confirm, supports custom renderView, and avoids scope subscription churn", async () => {
    const previewGate = deferred<CloseFinishedResult>();
    const closeGate = deferred<CloseFinishedResult>();
    const previewCalls: Array<{ mid: string; signal: AbortSignal }> = [];
    const closeCalls: Array<{ mid: string; panes: readonly string[]; signal: AbortSignal }> = [];
    const notify = vi.fn();
    const reload = vi.fn();
    const getSession = vi.fn((_mid: string, sid: string) => ({
      machine_id: "m1",
      session_id: sid,
      title: "Controlled Session Title",
      cwd: "/app",
      status: "offline",
    } as Session));

    let scope = "s1";
    const scopeListeners = new Set<() => void>();
    const subscribeScopeKey = vi.fn((l: () => void) => {
      scopeListeners.add(l);
      return () => { scopeListeners.delete(l); };
    });

    const makeDeps = (): CloseFinishedDeps => ({
      // Fresh inline getter on every render must not re-subscribe subscribeScopeKey.
      scopeKey: () => scope,
      subscribeScopeKey,
      previewFinished: (mid, signal) => {
        previewCalls.push({ mid, signal });
        return previewGate.promise;
      },
      closeFinished: (mid, panes, signal) => {
        closeCalls.push({ mid, panes, signal });
        return closeGate.promise;
      },
      getSession,
      notify,
      formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
    });

    await act(async () => root.render(<StrictMode><Harness deps={makeDeps()} reload={reload} spacesOf={() => []} /></StrictMode>));
    const subCountAfterMount = subscribeScopeKey.mock.calls.length;
    await act(async () => root.render(<StrictMode><Harness deps={makeDeps()} reload={reload} spacesOf={() => []} /></StrictMode>));
    expect(subscribeScopeKey).toHaveBeenCalledTimes(subCountAfterMount);

    // Synchronous double-click on start admits only one preview.
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click();
      container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click();
      container.querySelector<HTMLButtonElement>("[data-start-m2]")!.click();
    });
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0].mid).toBe("m1");
    expect(container.querySelector("[data-previewing]")!.textContent).toBe("m1");

    await act(async () => previewGate.resolve(PREVIEW_ONE));
    await flush();
    expect(container.querySelector("[data-previewing]")!.textContent).toBe("");
    expect(activeDialog()!.textContent).toContain(t("lib-terminals.finished", { title: "Controlled Session Title" }));
    expect(getSession).toHaveBeenCalledWith("m1", "stopped-1");

    // Synchronous double-click on confirm admits only one close.
    await act(async () => {
      const btn = findButton(t("terminal-terminalpage.close_finished_confirm"))!;
      btn.click();
      btn.click();
    });
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0].panes).toEqual(["w1:p2"]);

    await act(async () => closeGate.resolve(CLOSED_ONE));
    await flush();
    expect(activeDialog()).toBeNull();
    expect(notify).toHaveBeenCalledWith(t("terminal-terminalpage.closed_finished", { count: 1 }), "ok");
    expect(reload).toHaveBeenCalledWith("m1");

    // Custom renderView seam works cleanly.
    const seenProps: CloseFinishedDialogViewProps[] = [];
    await act(async () => root.render(
      <Harness
        reload={reload}
        deps={{
          scopeKey: "s1",
          renderView: (props) => {
            seenProps.push(props);
            return <div data-custom-cf={String(props.open)} />;
          },
        }}
      />,
    ));
    expect(container.querySelector("[data-custom-cf]")?.getAttribute("data-custom-cf")).toBe("false");
    expect(seenProps.length).toBeGreaterThan(0);
    expectNoDefaultSingletons();
  });

  it.each(["resolve", "reject"] as const)(
    "aborts in-flight preview and fences stale %s across scope ABA burst (s1 -> s2 -> s1), cancel/reopen ABA, and unmount",
    async (staleOutcome) => {
      let scope = "s1";
      const scopeListeners = new Set<() => void>();
      const previewRuns: Array<{ mid: string; signal: AbortSignal; gate: ReturnType<typeof deferred<CloseFinishedResult>> }> = [];
      const notify = vi.fn();
      const onError = vi.fn();
      const reload = vi.fn();
      let latestViewProps: CloseFinishedDialogViewProps | null = null;

      const deps: CloseFinishedDeps = {
        scopeKey: () => scope,
        subscribeScopeKey: (l) => {
          scopeListeners.add(l);
          return () => { scopeListeners.delete(l); };
        },
        previewFinished: (mid, signal) => {
          const gate = deferred<CloseFinishedResult>();
          previewRuns.push({ mid, signal, gate });
          return gate.promise;
        },
        closeFinished: vi.fn(),
        getSession: () => undefined,
        notify,
        formatError: (e) => (e instanceof Error ? e.message : String(e)),
        onError,
        renderView: (p) => {
          latestViewProps = p;
          return <CloseFinishedDialogView {...p} />;
        },
      };

      await act(async () => root.render(<Harness deps={deps} reload={reload} />));

      // 1. Synchronous scope ABA burst (s1 -> s2 -> s1) aborts preview #1 and fences its late settlement.
      await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
      expect(previewRuns).toHaveLength(1);
      expect(previewRuns[0].signal.aborted).toBe(false);

      await act(async () => {
        scope = "s2";
        scopeListeners.forEach((l) => l());
        scope = "s1";
        scopeListeners.forEach((l) => l());
      });
      expect(previewRuns[0].signal.aborted).toBe(true);
      expect(container.querySelector("[data-previewing]")!.textContent).toBe("");

      await act(async () => {
        if (staleOutcome === "resolve") previewRuns[0].gate.resolve(PREVIEW_ONE);
        else previewRuns[0].gate.reject(new Error("stale preview failure"));
      });
      await flush();
      expect(activeDialog()).toBeNull();
      expect(notify).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();

      // 2. Cancel + reopen ABA while preview #2 is in-flight: preview #2 is aborted and fenced; preview #3 opens cleanly.
      await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
      expect(previewRuns).toHaveLength(2);
      await act(async () => { latestViewProps!.onCancel(); });
      expect(previewRuns[1].signal.aborted).toBe(true);
      expect(container.querySelector("[data-previewing]")!.textContent).toBe("");

      await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
      expect(previewRuns).toHaveLength(3);
      expect(previewRuns[2].signal.aborted).toBe(false);

      await act(async () => {
        if (staleOutcome === "resolve") previewRuns[1].gate.resolve({ closed: [], kept: [], preview: true });
        else previewRuns[1].gate.reject(new Error("canceled preview failure"));
      });
      await flush();
      expect(container.querySelector("[data-previewing]")!.textContent).toBe("m1");
      expect(notify).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();

      // 3. Unmount aborts preview #3 and fences its late settlement.
      await act(async () => root.render(null));
      expect(previewRuns[2].signal.aborted).toBe(true);
      await act(async () => {
        if (staleOutcome === "resolve") previewRuns[2].gate.resolve(PREVIEW_ONE);
        else previewRuns[2].gate.reject(new Error("after unmount"));
      });
      await flush();
      expect(notify).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expectNoDefaultSingletons();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "aborts in-flight close and fences stale %s across scope switch, cancel/reopen ABA, and unmount",
    async (staleOutcome) => {
      let scope = "s1";
      const scopeListeners = new Set<() => void>();
      const closeRuns: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<CloseFinishedResult>> }> = [];
      const notify = vi.fn();
      const onError = vi.fn();
      const reload = vi.fn();
      let latestViewProps: CloseFinishedDialogViewProps | null = null;

      const deps: CloseFinishedDeps = {
        scopeKey: () => scope,
        subscribeScopeKey: (l) => {
          scopeListeners.add(l);
          return () => { scopeListeners.delete(l); };
        },
        previewFinished: async () => PREVIEW_ONE,
        closeFinished: (_mid, _panes, signal) => {
          const gate = deferred<CloseFinishedResult>();
          closeRuns.push({ signal, gate });
          return gate.promise;
        },
        getSession: () => undefined,
        notify,
        formatError: (e) => (e instanceof Error ? e.message : String(e)),
        onError,
        renderView: (p) => {
          latestViewProps = p;
          return <CloseFinishedDialogView {...p} />;
        },
      };

      await act(async () => root.render(<Harness deps={deps} reload={reload} />));

      // Open dialog and begin close #1.
      await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
      await flush();
      await act(async () => findButton(t("terminal-terminalpage.close_finished_confirm"))!.click());
      expect(closeRuns).toHaveLength(1);
      expect(closeRuns[0].signal.aborted).toBe(false);

      // Switch scope s1 -> s2 -> s1 while close #1 is pending: aborts and fences close #1.
      await act(async () => {
        scope = "s2";
        scopeListeners.forEach((l) => l());
        scope = "s1";
        scopeListeners.forEach((l) => l());
      });
      expect(closeRuns[0].signal.aborted).toBe(true);
      expect(activeDialog()).toBeNull();

      await act(async () => {
        if (staleOutcome === "resolve") closeRuns[0].gate.resolve(CLOSED_ONE);
        else closeRuns[0].gate.reject(new Error("stale close failure"));
      });
      await flush();
      expect(notify).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();

      // Reopen dialog, begin close #2, cancel via onCancel, reopen dialog, settle stale close #2 -> must not clobber reopened dialog.
      await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
      await flush();
      await act(async () => findButton(t("terminal-terminalpage.close_finished_confirm"))!.click());
      expect(closeRuns).toHaveLength(2);
      await act(async () => { latestViewProps!.onCancel(); });
      expect(closeRuns[1].signal.aborted).toBe(true);

      await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
      await flush();
      expect(activeDialog()).not.toBeNull();

      await act(async () => {
        if (staleOutcome === "resolve") closeRuns[1].gate.resolve(CLOSED_ONE);
        else closeRuns[1].gate.reject(new Error("canceled close failure"));
      });
      await flush();
      expect(activeDialog()).not.toBeNull();
      expect(notify).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();

      // Begin close #3 and unmount -> aborts close #3 and fences stale settlement.
      await act(async () => findButton(t("terminal-terminalpage.close_finished_confirm"))!.click());
      expect(closeRuns).toHaveLength(3);
      await act(async () => root.render(null));
      expect(closeRuns[2].signal.aborted).toBe(true);
      await act(async () => {
        if (staleOutcome === "resolve") closeRuns[2].gate.resolve(CLOSED_ONE);
        else closeRuns[2].gate.reject(new Error("unmounted close failure"));
      });
      await flush();
      expect(notify).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expectNoDefaultSingletons();
    },
  );

  it("keeps committed scope and in-flight preview intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const previewGate = deferred<CloseFinishedResult>();
    let capturedSignal: AbortSignal | null = null;
    const reload = vi.fn();
    const notify = vi.fn();
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
          <Harness
            reload={reload}
            deps={{
              scopeKey: state.scope,
              previewFinished: (_mid, signal) => {
                capturedSignal = signal;
                return previewGate.promise;
              },
              notify,
              getSession: () => undefined,
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<TransitionHarness />));
    await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    expect(container.querySelector("[data-previewing]")!.textContent).toBe("m1");

    // Suspended concurrent transition to s2 must NOT abort committed s1 preview.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);

    // Abandon transition back to s1 -> preview completes cleanly and opens dialog.
    await act(async () => setHarness({ scope: "s1", block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => previewGate.resolve(PREVIEW_ONE));
    await flush();
    expect(activeDialog()).not.toBeNull();
    expect(container.querySelector("[data-previewing]")!.textContent).toBe("");
    expectNoDefaultSingletons();
  });

  it("releases busy via try/finally on sync/async failures and throwing notify/formatError/onError observers, allowing immediate retry", async () => {
    let previewAttempt = 0;
    let closeAttempt = 0;
    const notify = vi.fn<(message: string, tone?: string) => void>(() => { throw new Error("notify boom"); });
    const formatError = vi.fn<(error: unknown) => string>(() => { throw new Error("format boom"); });
    const onError = vi.fn<(message: string, error: unknown) => void>(() => { throw new Error("onError boom"); });
    const reload = vi.fn();

    const deps: CloseFinishedDeps = {
      scopeKey: "s1",
      previewFinished: () => {
        previewAttempt += 1;
        if (previewAttempt === 1) throw new Error("sync preview boom");
        return Promise.resolve(PREVIEW_ONE);
      },
      closeFinished: () => {
        closeAttempt += 1;
        if (closeAttempt === 1) return Promise.reject(new Error("async close boom"));
        return Promise.resolve(CLOSED_ONE);
      },
      getSession: () => undefined,
      notify,
      formatError,
      onError,
    };

    await act(async () => root.render(<Harness deps={deps} reload={reload} />));

    // Attempt 1: sync preview throw + throwing formatError/notify/onError still releases busy cleanly.
    await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
    await flush();
    expect(container.querySelector("[data-previewing]")!.textContent).toBe("");
    expect(formatError).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // Attempt 2: preview succeeds, close rejects with throwing observers -> still closes dialog, reloads, and releases busy.
    await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
    await flush();
    expect(activeDialog()).not.toBeNull();

    await act(async () => findButton(t("terminal-terminalpage.close_finished_confirm"))!.click());
    await flush();
    expect(activeDialog()).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith("m1");

    // Attempt 3: can immediately start and complete cleanly after recovery.
    notify.mockImplementation(() => {});
    await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
    await flush();
    await act(async () => findButton(t("terminal-terminalpage.close_finished_confirm"))!.click());
    await flush();
    expect(closeAttempt).toBe(2);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(t("terminal-terminalpage.closed_finished", { count: 1 }), "ok");
  });

  it("preserves default previewFinished, closeFinished, toast, errorText, and getSession fallbacks when deps is omitted", async () => {
    mocks.previewFinished
      .mockResolvedValueOnce({ closed: [], kept: [], preview: true })
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(PREVIEW_ONE);
    mocks.closeFinished.mockResolvedValueOnce(CLOSED_ONE);
    mocks.getSession.mockReturnValue({ machine_id: "m1", session_id: "stopped-1", title: "From Store", cwd: "/app", status: "offline" } as Session);
    const reload = vi.fn();

    await act(async () => root.render(<Harness reload={reload} spacesOf={() => []} />));

    // Empty preview -> info toast + reload.
    await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
    await flush();
    expect(mocks.previewFinished).toHaveBeenCalledTimes(1);
    expect(mocks.previewFinished.mock.calls[0][0]).toBe("m1");
    expect(mocks.toast).toHaveBeenCalledWith(t("terminal-terminalpage.finished_none"), undefined);
    expect(reload).toHaveBeenCalledWith("m1");

    // Failed preview -> errorText + error toast.
    await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
    await flush();
    expect(mocks.errorText).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenLastCalledWith(
      t("terminal-terminalpage.close_finished_failed", { error: "default-err:denied" }),
      "error",
    );

    // Preview + confirm -> uses store.getSession for label, calls closeFinished, ok toast + reload.
    await act(async () => container.querySelector<HTMLButtonElement>("[data-start-m1]")!.click());
    await flush();
    expect(mocks.getSession).toHaveBeenCalledWith("m1", "stopped-1");
    expect(activeDialog()!.textContent).toContain(t("lib-terminals.finished", { title: "From Store" }));

    await act(async () => findButton(t("terminal-terminalpage.close_finished_confirm"))!.click());
    await flush();
    expect(mocks.closeFinished).toHaveBeenCalledTimes(1);
    expect(mocks.closeFinished.mock.calls[0][0]).toBe("m1");
    expect(mocks.closeFinished.mock.calls[0][1]).toEqual(["w1:p2"]);
    expect(mocks.toast).toHaveBeenLastCalledWith(t("terminal-terminalpage.closed_finished", { count: 1 }), "ok");
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
