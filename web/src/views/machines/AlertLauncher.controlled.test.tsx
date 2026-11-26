// @vitest-environment jsdom
// Controlled AlertLauncher (LauncherSectionView, LauncherSection) bypasses default API/router/settingsHref singletons,
// caches fresh getter snapshots, preserves render purity across abandoned concurrent renders, fences load/check/navigate
// across scope/machine/ABA/unmount transitions, recovers via try/finally, and preserves default fallback parity.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { LauncherHealthRecord } from "../../lib/machine-alerts";
import type { Launcher, Machine } from "../../lib/types";
import type { LauncherSectionDeps } from "./AlertLauncher";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  navigate: vi.fn(),
  settingsHref: vi.fn(),
}));

vi.mock("../../lib/api", async (original) => {
  const real = await original<typeof import("../../lib/api")>();
  return {
    ...real,
    api: (...args: unknown[]) => mocks.api(...args),
  };
});

vi.mock("../../lib/router", async (original) => ({
  ...(await original<typeof import("../../lib/router")>()),
  navigate: (to: unknown) => mocks.navigate(to),
}));

vi.mock("../settings/nav", async (original) => {
  const real = await original<typeof import("../settings/nav")>();
  return {
    ...real,
    settingsHref: (...args: Parameters<typeof real.settingsHref>) => {
      mocks.settingsHref(...args);
      return real.settingsHref(...args);
    },
  };
});

const { failureKind, LauncherSection, LauncherSectionView } = await import("./AlertLauncher");

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

const FIXED_NOW = 1_700_000_000_000;
const CHECKED_AT = new Date(FIXED_NOW - 5 * 60_000).toISOString();
const RESETS_AT = new Date(FIXED_NOW + 60 * 60_000).toISOString();

const MACHINE_A: Machine = { id: "mac-a", name: "Mac A", online: true, kind: "ssh" };
const MACHINE_B: Machine = { id: "mac-b", name: "Mac B", online: true, kind: "ssh" };

const RECORDS_A: LauncherHealthRecord[] = [
  { machine: "mac-a", launcher: "codex", state: "failing", kind: "usage_limit", error: "usage limit hit", checked_at: CHECKED_AT, fails: 3, resets_at: RESETS_AT },
  { machine: "mac-a", launcher: "team", state: "blocked", kind: "auth", error: "401 unauthorized", checked_at: CHECKED_AT, fails: 2 },
  { machine: "mac-b", launcher: "claude", state: "blocked", kind: "auth", error: "expired token", checked_at: CHECKED_AT, fails: 1 },
];

const expectNoDefaultSingletons = () => {
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.settingsHref).not.toHaveBeenCalled();
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(mocks).forEach((fn) => fn.mockReset());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("LauncherSectionView (pure presentation)", () => {
  it("renders failing launchers, healthy alternatives, clock-injected checked time, checking state, and callbacks without touching singletons", async () => {
    const onTestAgain = vi.fn();
    const onOpenSettings = vi.fn();
    const list: Launcher[] = [
      { name: "claude" },
      { name: "team", display_name: "Team relay" },
      { name: "codex", agent: "codex" },
    ];

    await act(async () => root.render(
      <LauncherSectionView
        online
        failing={RECORDS_A.filter((r) => r.machine === "mac-a")}
        list={list}
        checking="codex"
        checked={{ team: t("machines-alerts.launcher_works") }}
        now={FIXED_NOW}
        onTestAgain={onTestAgain}
        onOpenSettings={onOpenSettings}
      />,
    ));

    expect(host.querySelectorAll('[data-testid="failing-launchers"] [data-launcher]')).toHaveLength(2);
    expect(host.querySelector('[data-launcher="codex"]')?.textContent).toContain(failureKind("usage_limit"));
    expect(host.querySelector('[data-launcher="codex"]')?.textContent).toContain("5");
    expect(host.querySelector('[data-launcher="team"]')?.textContent).toContain("Team relay");
    expect(host.querySelector('[data-launcher="team"] [role="status"]')?.textContent).toBe(t("machines-alerts.launcher_works"));
    expect(host.querySelector('[data-testid="healthy-launchers"]')?.textContent).toBe("claude");

    const codexBtn = host.querySelector<HTMLButtonElement>('[data-launcher="codex"] [data-testid="test-again"]')!;
    const teamBtn = host.querySelector<HTMLButtonElement>('[data-launcher="team"] [data-testid="test-again"]')!;
    expect(codexBtn.getAttribute("aria-busy")).toBe("true");
    expect(teamBtn.disabled).toBe(true);

    // Clear checking and invoke callbacks.
    await act(async () => root.render(
      <LauncherSectionView
        online
        failing={RECORDS_A.filter((r) => r.machine === "mac-a")}
        list={list}
        checking=""
        checked={{}}
        now={FIXED_NOW}
        onTestAgain={onTestAgain}
        onOpenSettings={onOpenSettings}
      />,
    ));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-launcher="team"] [data-testid="test-again"]')!.click();
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(t("machines-alerts.launcher_settings")))!.click();
    });
    expect(onTestAgain).toHaveBeenCalledWith("team");
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });
});

describe("LauncherSection (controlled mode)", () => {
  it("bypasses default singletons, loads launchers, checks health with concurrency guard, handles empty reload, and uses injected clock and navigation", async () => {
    const loadLaunchers = vi.fn(async (_mid: string, _signal: AbortSignal) => [
      { name: "claude" },
      { name: "team", display_name: "Team relay" },
    ]);
    const checkDeferred = deferred<LauncherHealthRecord[]>();
    const checkLauncher = vi.fn(() => checkDeferred.promise);
    const nav = vi.fn();
    const onRecords = vi.fn();
    const onReload = vi.fn();
    let nowMs = FIXED_NOW;
    const nowListeners = new Set<() => void>();
    const subscribeNow = vi.fn((l: () => void) => {
      nowListeners.add(l);
      return () => { nowListeners.delete(l); };
    });

    const deps: LauncherSectionDeps = {
      loadLaunchers,
      checkLauncher,
      navigate: nav,
      settingsHref: "/custom-models",
      now: () => nowMs,
      subscribeNow,
    };

    await act(async () => root.render(
      <StrictMode>
        <LauncherSection machine={MACHINE_A} records={RECORDS_A} onRecords={onRecords} onReload={onReload} deps={deps} />
      </StrictMode>,
    ));
    await flush();

    expect(host.querySelector('[data-testid="healthy-launchers"]')?.textContent).toBe("claude");
    expect(host.querySelector('[data-launcher="codex"]')?.textContent).toContain("5");

    // Advance injected clock by 10 minutes.
    await act(async () => {
      nowMs = FIXED_NOW + 10 * 60_000;
      nowListeners.forEach((l) => l());
    });
    expect(host.querySelector('[data-launcher="codex"]')?.textContent).toContain("15");

    // Trigger check and verify concurrent clicks are guarded.
    const teamBtn = host.querySelector<HTMLButtonElement>('[data-launcher="team"] [data-testid="test-again"]')!;
    await act(async () => {
      teamBtn.click();
      teamBtn.click();
    });
    expect(checkLauncher).toHaveBeenCalledTimes(1);
    expect(teamBtn.getAttribute("aria-busy")).toBe("true");

    // Resolve with empty records to trigger onReload.
    checkDeferred.resolve([]);
    await flush();
    expect(onRecords).toHaveBeenCalledWith([]);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-launcher="team"] [role="status"]')?.textContent).toBe(t("machines-alerts.launcher_no_result"));
    expect(teamBtn.getAttribute("aria-busy")).not.toBe("true");

    // Open settings navigates to custom settingsHref.
    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(t("machines-alerts.launcher_settings")))!.click();
    });
    expect(nav).toHaveBeenCalledWith("/custom-models", expect.any(AbortSignal));
    expectNoDefaultSingletons();
  });

  it("caches getter snapshots with zero subscription churn across inline arrow getters and direct-to-subscribed transitions", async () => {
    let nowMs = FIXED_NOW;
    const listeners = new Set<() => void>();
    const subscribeNow = vi.fn((l: () => void) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    });
    const loadLaunchers = vi.fn(async () => [{ name: "claude" }]);
    let renderCount = 0;

    function Harness({ mode }: { mode: "direct" | "getter" }) {
      renderCount += 1;
      return (
        <LauncherSection
          machine={MACHINE_A}
          records={RECORDS_A}
          onRecords={() => {}}
          deps={{
            loadLaunchers,
            now: mode === "direct" ? nowMs : () => nowMs,
            subscribeNow: mode === "direct" ? undefined : subscribeNow,
            navigate: () => {},
            settingsHref: "/models",
          }}
        />
      );
    }

    await act(async () => root.render(<Harness mode="direct" />));
    await flush();
    expect(loadLaunchers).toHaveBeenCalledTimes(1);

    // Switch direct -> getter+subscribe with same value: must not remount or reload.
    await act(async () => root.render(<Harness mode="getter" />));
    await flush();
    expect(loadLaunchers).toHaveBeenCalledTimes(1);
    expect(subscribeNow).toHaveBeenCalledTimes(1);

    // Re-render with fresh inline arrow getter: zero subscription churn.
    await act(async () => root.render(<Harness mode="getter" />));
    await act(async () => root.render(<Harness mode="getter" />));
    expect(subscribeNow).toHaveBeenCalledTimes(1);
    expect(renderCount).toBeLessThan(10);
    expectNoDefaultSingletons();
  });

  it("fences loadLaunchers and checkLauncher across scopeKey switch, machine.id switch, synchronous ABA bursts, and unmount", async () => {
    let currentScope = "scope-a";
    const scopeListeners = new Set<() => void>();
    const subscribeScopeKey = (l: () => void) => {
      scopeListeners.add(l);
      return () => { scopeListeners.delete(l); };
    };

    const loadSignals: AbortSignal[] = [];
    const loadDeferreds: ReturnType<typeof deferred<Launcher[]>>[] = [];
    const loadLaunchers = vi.fn((_mid: string, signal: AbortSignal) => {
      loadSignals.push(signal);
      const d = deferred<Launcher[]>();
      loadDeferreds.push(d);
      return d.promise;
    });

    const checkSignals: AbortSignal[] = [];
    const checkDeferreds: ReturnType<typeof deferred<LauncherHealthRecord[]>>[] = [];
    const checkLauncher = vi.fn((_mid: string, _launcher: string, signal: AbortSignal) => {
      checkSignals.push(signal);
      const d = deferred<LauncherHealthRecord[]>();
      checkDeferreds.push(d);
      return d.promise;
    });

    const onRecords = vi.fn();
    const deps: LauncherSectionDeps = {
      scopeKey: () => currentScope,
      subscribeScopeKey,
      loadLaunchers,
      checkLauncher,
      now: FIXED_NOW,
      navigate: () => {},
      settingsHref: "/models",
    };

    await act(async () => root.render(
      <LauncherSection machine={MACHINE_A} records={RECORDS_A} onRecords={onRecords} deps={deps} />,
    ));
    await flush();
    expect(loadDeferreds).toHaveLength(1);
    loadDeferreds[0]!.resolve([{ name: "claude" }]);
    await flush();
    expect(host.querySelector('[data-testid="healthy-launchers"]')?.textContent).toBe("claude");

    // Start check in scope-a, then fire a synchronous ABA burst (scope-a -> scope-b -> scope-a).
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-launcher="team"] [data-testid="test-again"]')!.click();
    });
    expect(checkSignals).toHaveLength(1);
    expect(checkSignals[0]!.aborted).toBe(false);

    await act(async () => {
      currentScope = "scope-b";
      scopeListeners.forEach((l) => l());
      currentScope = "scope-a";
      scopeListeners.forEach((l) => l());
    });
    await flush();

    // ABA burst must abort in-flight check, reset list & checking, and start a fresh load.
    expect(checkSignals[0]!.aborted).toBe(true);
    expect(loadDeferreds).toHaveLength(2);
    expect(host.querySelector('[data-testid="healthy-launchers"]')).toBeNull();

    // Resolving stale check must not call onRecords or write checked status.
    checkDeferreds[0]!.resolve([{ machine: "mac-a", launcher: "team", state: "ok" }]);
    await flush();
    expect(onRecords).not.toHaveBeenCalled();
    expect(host.querySelector('[data-launcher="team"] [role="status"]')).toBeNull();

    // Switch machine.id while load #2 is pending -> aborts load #2 and starts load #3 for mac-b.
    await act(async () => root.render(
      <LauncherSection machine={MACHINE_B} records={RECORDS_A} onRecords={onRecords} deps={deps} />,
    ));
    await flush();
    expect(loadSignals[1]!.aborted).toBe(true);
    expect(loadDeferreds).toHaveLength(3);

    // Resolving stale load #2 must not overwrite mac-b's loading state.
    loadDeferreds[1]!.resolve([{ name: "stale-launcher" }]);
    await flush();
    expect(host.querySelector('[data-testid="healthy-launchers"]')).toBeNull();

    // Unmount aborts active load #3.
    act(() => root.unmount());
    expect(loadSignals[2]!.aborted).toBe(true);
    loadDeferreds[2]!.resolve([{ name: "after-unmount" }]);
    await flush();
    expectNoDefaultSingletons();
  });

  it("keeps committed state and live operations untouched during an abandoned concurrent transition render", async () => {
    const neverResolving = new Promise<void>(() => {});
    const checkDeferred = deferred<LauncherHealthRecord[]>();
    const checkSignals: AbortSignal[] = [];
    const loadLaunchers = vi.fn(async () => [{ name: "claude" }]);
    const checkLauncher = vi.fn((_mid: string, _launcher: string, signal: AbortSignal) => {
      checkSignals.push(signal);
      return checkDeferred.promise;
    });
    const onRecords = vi.fn();

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
          <LauncherSection
            machine={next ? MACHINE_B : MACHINE_A}
            records={RECORDS_A}
            onRecords={onRecords}
            deps={{
              scopeKey: next ? "scope-b" : "scope-a",
              loadLaunchers,
              checkLauncher,
              now: FIXED_NOW,
              navigate: () => {},
              settingsHref: "/models",
            }}
          />
          <Suspender suspend={next} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await flush();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-launcher="team"] [data-testid="test-again"]')!.click();
    });
    expect(checkSignals).toHaveLength(1);
    expect(checkSignals[0]!.aborted).toBe(false);

    // Start a transition to MACHINE_B / scope-b that suspends and never commits.
    await act(async () => {
      triggerTransition();
    });
    expect(checkSignals[0]!.aborted).toBe(false);

    // Completing the live check in scope-a still succeeds cleanly.
    checkDeferred.resolve([{ machine: "mac-a", launcher: "team", state: "ok" }]);
    await flush();
    expect(onRecords).toHaveBeenCalledWith([expect.objectContaining({ launcher: "team", state: "ok" })]);
    expect(host.querySelector('[data-launcher="team"] [role="status"]')?.textContent).toBe(t("machines-alerts.launcher_works"));
    expectNoDefaultSingletons();
  });

  it("recovers via try/finally on synchronous throws and async rejections even when formatError/onError throw", async () => {
    const errors: string[] = [];
    let mode: "sync-throw" | "async-reject" = "sync-throw";
    const loadLaunchers = vi.fn(() => {
      throw new Error("sync load boom");
    });
    const checkLauncher = vi.fn(() => {
      if (mode === "sync-throw") throw new Error("sync check boom");
      return Promise.reject(new Error("async check boom"));
    });
    const formatError = vi.fn((err: unknown) => {
      if (mode === "sync-throw") throw new Error("formatter crashed");
      return `formatted:${(err as Error).message}`;
    });
    const onError = vi.fn((msg: string) => {
      errors.push(msg);
      throw new Error("observer crashed");
    });

    await act(async () => root.render(
      <LauncherSection
        machine={MACHINE_A}
        records={RECORDS_A}
        onRecords={() => {}}
        deps={{ loadLaunchers, checkLauncher, formatError, onError, now: FIXED_NOW, navigate: () => {}, settingsHref: "/models" }}
      />,
    ));
    await flush();

    // Load sync throw fell back to list-failed message without crashing.
    expect(host.textContent).toContain(t("machines-alerts.launcher_list_failed"));

    // Sync throw in checkLauncher releases checking state and surfaces error.
    const teamBtn = host.querySelector<HTMLButtonElement>('[data-launcher="team"] [data-testid="test-again"]')!;
    await act(async () => { teamBtn.click(); });
    await flush();
    expect(teamBtn.getAttribute("aria-busy")).not.toBe("true");
    expect(teamBtn.disabled).toBe(false);
    expect(host.querySelector('[data-launcher="team"] [role="status"]')?.textContent).toContain("sync check boom");

    // Async reject in checkLauncher also releases checking state cleanly.
    mode = "async-reject";
    await act(async () => { teamBtn.click(); });
    await flush();
    expect(teamBtn.getAttribute("aria-busy")).not.toBe("true");
    expect(host.querySelector('[data-launcher="team"] [role="status"]')?.textContent).toContain("formatted:async check boom");
    expect(errors).toContain("formatted:async check boom");
    expectNoDefaultSingletons();
  });

  it("supports custom renderView and preserves default fallback parity when deps is omitted", async () => {
    const renderView = vi.fn((props) => <div data-testid="custom-launcher-view">{props.failing.length}</div>);
    await act(async () => root.render(
      <LauncherSection
        machine={MACHINE_A}
        records={RECORDS_A}
        onRecords={() => {}}
        deps={{ loadLaunchers: async () => [], renderView }}
      />,
    ));
    await flush();
    expect(host.querySelector('[data-testid="custom-launcher-view"]')?.textContent).toBe("2");
    expectNoDefaultSingletons();

    // Omitting deps falls back to default api, settingsHref, and navigate.
    mocks.api.mockResolvedValueOnce({ launchers: [{ name: "claude" }] });
    mocks.api.mockResolvedValueOnce({ records: [{ machine: "mac-a", launcher: "team", state: "ok" }] });
    const onRecords = vi.fn();

    await act(async () => root.render(
      <LauncherSection machine={MACHINE_A} records={RECORDS_A} onRecords={onRecords} />,
    ));
    await flush();
    expect(mocks.api).toHaveBeenCalledWith("/machines/mac-a/launchers", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(host.querySelector('[data-testid="healthy-launchers"]')?.textContent).toBe("claude");

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-launcher="team"] [data-testid="test-again"]')!.click();
    });
    await flush();
    expect(mocks.api).toHaveBeenCalledWith(
      "/launchers/health/check?machine=mac-a&launcher=team",
      expect.objectContaining({ method: "POST", timeout: 180_000, signal: expect.any(AbortSignal) }),
    );
    expect(onRecords).toHaveBeenCalledWith([expect.objectContaining({ launcher: "team", state: "ok" })]);

    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(t("machines-alerts.launcher_settings")))!.click();
    });
    expect(mocks.settingsHref).toHaveBeenCalledWith("models", null, false, null, "providers");
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
});
