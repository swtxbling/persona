// @vitest-environment jsdom
// Controlled BotmuxSwitch bypasses api/errorText/toast singletons, caches getter snapshots without subscription churn,
// preserves render purity across abandoned concurrent transitions, fences GET/PUT across machine/scope/ABA/unmount
// races, recovers cleanly via try/finally, and preserves default fallbacks.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotmuxSwitchDeps } from "./BotmuxSwitch";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  errorText: vi.fn((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`),
  toast: vi.fn(),
}));

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  api: (...args: unknown[]) => mocks.api(...args),
  errorText: (e: unknown) => mocks.errorText(e),
}));

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  toast: (message: string, tone?: string) => mocks.toast(message, tone),
}));

const { BotmuxSwitch, BotmuxSwitchView } = await import("./BotmuxSwitch");
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

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

const sw = () => host.querySelector<HTMLButtonElement>('button[data-testid="botmux-switch"][role="switch"]');

const expectNoDefaultSingletons = () => {
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.errorText).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n("en");
  mocks.api.mockReset();
  mocks.errorText.mockReset();
  mocks.errorText.mockImplementation((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`);
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

describe("BotmuxSwitchView (pure presentation)", () => {
  it("renders null, on, off, and saving states with ARIA wiring without touching singletons", async () => {
    const onToggle = vi.fn();

    await act(async () => root.render(<BotmuxSwitchView on={null} onToggle={onToggle} />));
    expect(sw()).toBeNull();

    await act(async () => root.render(<BotmuxSwitchView on={true} onToggle={onToggle} />));
    expect(sw()?.getAttribute("aria-checked")).toBe("true");
    expect(sw()?.getAttribute("aria-label")).toBe(t("machines-botmuxswitch.label"));
    expect(sw()?.getAttribute("title")).toBe(t("machines-botmuxswitch.footer"));
    expect(sw()?.disabled).toBe(false);
    expect(sw()?.textContent).toContain(t("machines-botmuxswitch.on"));
    expect(document.getElementById(sw()!.getAttribute("aria-describedby")!)?.textContent).toBe(t("machines-botmuxswitch.footer"));

    await act(async () => sw()!.click());
    expect(onToggle).toHaveBeenCalledWith(false);

    await act(async () => root.render(<BotmuxSwitchView on={false} saving onToggle={onToggle} />));
    expect(sw()?.getAttribute("aria-checked")).toBe("false");
    expect(sw()?.disabled).toBe(true);
    expect(sw()?.textContent).toContain(t("machines-botmuxswitch.off"));
    expectNoDefaultSingletons();
  });
});

describe("BotmuxSwitch controlled deps, snapshot caching, fencing, and default fallback", () => {
  it("bypasses GET when controlled on is supplied, caches getter snapshots without subscription churn, and supports renderView", async () => {
    const onListeners = new Set<() => void>();
    const scopeListeners = new Set<() => void>();
    let onSubs = 0;
    let scopeSubs = 0;
    let currentOn: boolean | null = true;
    let currentScope = "s1";
    let onReads = 0;
    const readBotmux = vi.fn();
    const saveBotmux = vi.fn((_mid: string, next: boolean) => {
      currentOn = next;
      onListeners.forEach((l) => l());
    });

    const subscribeOn = (l: () => void) => {
      onSubs += 1;
      onListeners.add(l);
      return () => { onListeners.delete(l); };
    };
    const subscribeScopeKey = (l: () => void) => {
      scopeSubs += 1;
      scopeListeners.add(l);
      return () => { scopeListeners.delete(l); };
    };

    const makeDeps = (): BotmuxSwitchDeps => ({
      scopeKey: () => currentScope,
      subscribeScopeKey,
      on: () => {
        onReads += 1;
        return currentOn;
      },
      subscribeOn,
      readBotmux,
      saveBotmux,
    });

    await act(async () => root.render(<BotmuxSwitch machineID="mac-1" deps={makeDeps()} />));
    expect(sw()?.getAttribute("aria-checked")).toBe("true");
    expect(readBotmux).not.toHaveBeenCalled();
    expect(onSubs).toBe(1);
    expect(scopeSubs).toBe(1);
    expect(onReads).toBeLessThan(10);

    // Re-rendering with a fresh deps wrapper keeps the exact same subscriptions (no churn).
    await act(async () => root.render(<BotmuxSwitch machineID="mac-1" deps={makeDeps()} />));
    expect(onSubs).toBe(1);
    expect(scopeSubs).toBe(1);

    // Equal re-emission stays cached; toggling updates controlled state synchronously without GET.
    await act(async () => { onListeners.forEach((l) => l()); });
    expect(sw()?.getAttribute("aria-checked")).toBe("true");

    await act(async () => sw()!.click());
    expect(saveBotmux).toHaveBeenCalledTimes(1);
    expect(saveBotmux.mock.calls[0][0]).toBe("mac-1");
    expect(saveBotmux.mock.calls[0][1]).toBe(false);
    expect(sw()?.getAttribute("aria-checked")).toBe("false");

    // Controlled null hides default view while still feeding custom renderView.
    currentOn = null;
    await act(async () => { onListeners.forEach((l) => l()); });
    expect(sw()).toBeNull();

    await act(async () => root.render(
      <BotmuxSwitch
        machineID="mac-1"
        deps={{
          on: null,
          renderView: (p) => <div data-custom-botmux={`${String(p.on)}|${String(p.saving)}`} />,
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-botmux]")?.getAttribute("data-custom-botmux")).toBe("null|false");
    expect(readBotmux).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("enforces single-flight saves and recovers via try/finally even when formatError, notify, and onError throw", async () => {
    const readGate = deferred<{ on: boolean }>();
    const saveGate1 = deferred<{ on: boolean }>();
    const saveGate2 = deferred<{ on: boolean }>();
    const readBotmux = vi.fn(() => readGate.promise);
    const saveBotmux = vi.fn()
      .mockImplementationOnce(() => saveGate1.promise)
      .mockImplementationOnce(() => { throw new Error("sync save fail"); })
      .mockImplementationOnce(() => saveGate2.promise);
    const notify = vi.fn();
    const formatError = vi.fn((e: unknown) => `fmt:${e instanceof Error ? e.message : String(e)}`);
    const onError = vi.fn();

    const deps: BotmuxSwitchDeps = {
      readBotmux,
      saveBotmux,
      notify,
      formatError,
      onError,
    };

    await act(async () => root.render(<StrictMode><BotmuxSwitch machineID="mac-1" deps={deps} /></StrictMode>));
    expect(sw()).toBeNull();

    await act(async () => readGate.resolve({ on: true }));
    await flush();
    expect(sw()?.getAttribute("aria-checked")).toBe("true");

    // Synchronous double-click dispatches only one PUT and shows optimistic false while disabled.
    await act(async () => {
      sw()!.click();
      sw()!.click();
    });
    expect(saveBotmux).toHaveBeenCalledTimes(1);
    expect(saveBotmux.mock.calls[0][1]).toBe(false);
    expect(sw()?.disabled).toBe(true);
    expect(sw()?.getAttribute("aria-checked")).toBe("false");

    // Throwing formatError, notify, and onError still revert state and clear saving cleanly.
    formatError.mockImplementationOnce(() => { throw new Error("fmt boom"); });
    notify.mockImplementationOnce(() => { throw new Error("toast boom"); });
    onError.mockImplementationOnce(() => { throw new Error("observer boom"); });

    await act(async () => saveGate1.reject(new Error("hub rejected")));
    await flush();
    expect(sw()?.getAttribute("aria-checked")).toBe("true");
    expect(sw()?.disabled).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // Synchronous throw in saveBotmux reverts cleanly and keeps control unlocked.
    await act(async () => sw()!.click());
    expect(saveBotmux).toHaveBeenCalledTimes(2);
    expect(sw()?.getAttribute("aria-checked")).toBe("true");
    expect(sw()?.disabled).toBe(false);
    expect(notify).toHaveBeenLastCalledWith(t("machines-botmuxswitch.save_failed", { error: "fmt:sync save fail" }), "error");
    expect(onError).toHaveBeenCalledTimes(2);

    // Subsequent retry succeeds with authoritative server value.
    await act(async () => sw()!.click());
    expect(saveBotmux).toHaveBeenCalledTimes(3);
    expect(sw()?.disabled).toBe(true);
    await act(async () => saveGate2.resolve({ on: false }));
    await flush();
    expect(sw()?.getAttribute("aria-checked")).toBe("false");
    expect(sw()?.disabled).toBe(false);
    // Only the throwing-formatError fallback touched default errorText; api and toast stayed fully bypassed.
    expect(mocks.errorText).toHaveBeenCalledTimes(1);
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "aborts GET/PUT and fences stale %s across machine switch, ABA m1->m2->m1, scopeKey ABA burst, and unmount",
    async (staleOutcome) => {
      const reads: Array<{ machineID: string; signal: AbortSignal; gate: ReturnType<typeof deferred<{ on: boolean }>> }> = [];
      const saves: Array<{ machineID: string; next: boolean; signal: AbortSignal; gate: ReturnType<typeof deferred<{ on: boolean }>> }> = [];
      const notify = vi.fn();
      const onError = vi.fn();
      const scopeListeners = new Set<() => void>();
      let currentScope = "s1";

      const deps: BotmuxSwitchDeps = {
        scopeKey: () => currentScope,
        subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
        readBotmux: (machineID, signal) => {
          const gate = deferred<{ on: boolean }>();
          reads.push({ machineID, signal, gate });
          return gate.promise;
        },
        saveBotmux: (machineID, next, signal) => {
          const gate = deferred<{ on: boolean }>();
          saves.push({ machineID, next, signal, gate });
          return gate.promise;
        },
        notify,
        formatError: (e) => (e instanceof Error ? e.message : String(e)),
        onError,
      };

      // 1. Mount m1, resolve GET, start PUT on m1.
      await act(async () => root.render(<BotmuxSwitch machineID="m1" deps={deps} />));
      await act(async () => reads[0].gate.resolve({ on: true }));
      await flush();
      await act(async () => sw()!.click());
      expect(saves).toHaveLength(1);
      expect(saves[0].signal.aborted).toBe(false);
      expect(sw()?.disabled).toBe(true);

      // 2. Switch m1 -> m2 -> m1 (ABA): m1's PUT and m2's GET are both aborted, state resets cleanly.
      await act(async () => root.render(<BotmuxSwitch machineID="m2" deps={deps} />));
      expect(saves[0].signal.aborted).toBe(true);
      expect(sw()).toBeNull();
      expect(reads).toHaveLength(2);
      expect(reads[1].machineID).toBe("m2");

      await act(async () => root.render(<BotmuxSwitch machineID="m1" deps={deps} />));
      expect(reads[1].signal.aborted).toBe(true);
      expect(reads).toHaveLength(3);
      expect(reads[2].machineID).toBe("m1");

      // Resolve m1 visit-2 GET and start a new PUT on m1 visit 2.
      await act(async () => reads[2].gate.resolve({ on: true }));
      await flush();
      expect(sw()?.getAttribute("aria-checked")).toBe("true");
      expect(sw()?.disabled).toBe(false);

      await act(async () => sw()!.click());
      expect(saves).toHaveLength(2);
      expect(sw()?.disabled).toBe(true);

      // Stale m2 GET and stale m1 visit-1 PUT settle out of order: neither mutates m1 visit 2 nor fires toast.
      await act(async () => {
        reads[1].gate.resolve({ on: false });
        if (staleOutcome === "resolve") saves[0].gate.resolve({ on: true });
        else saves[0].gate.reject(new Error("stale ABA put error"));
      });
      await flush();
      expect(sw()?.disabled).toBe(true);
      expect(sw()?.getAttribute("aria-checked")).toBe("false");
      expect(notify).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();

      // 3. Synchronous scopeKey ABA burst (s1 -> s2 -> s1) aborts m1 visit-2 PUT and resets switch cleanly.
      await act(async () => {
        currentScope = "s2";
        scopeListeners.forEach((l) => l());
        currentScope = "s1";
        scopeListeners.forEach((l) => l());
      });
      expect(saves[1].signal.aborted).toBe(true);
      expect(sw()).toBeNull();

      await act(async () => {
        if (staleOutcome === "resolve") saves[1].gate.resolve({ on: false });
        else saves[1].gate.reject(new Error("stale scope ABA error"));
      });
      await flush();
      expect(notify).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();

      // 4. Resolve post-ABA GET, start another PUT, then unmount: aborts PUT and suppresses late settlement.
      const latestRead = reads.at(-1)!;
      await act(async () => latestRead.gate.resolve({ on: false }));
      await flush();
      await act(async () => sw()!.click());
      const unmountSave = saves.at(-1)!;
      expect(unmountSave.signal.aborted).toBe(false);

      await act(async () => root.render(null));
      expect(unmountSave.signal.aborted).toBe(true);
      await act(async () => {
        if (staleOutcome === "resolve") unmountSave.gate.resolve({ on: true });
        else unmountSave.gate.reject(new Error("after unmount"));
      });
      await flush();
      expect(notify).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expectNoDefaultSingletons();
    },
  );

  it("keeps committed machine and in-flight save intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const saveGate = deferred<{ on: boolean }>();
    let capturedSignal: AbortSignal | null = null;
    const notify = vi.fn();
    const renderedMachines: string[] = [];

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    let setHarness!: (next: { machineID: string; block: boolean }) => void;
    function Harness() {
      const [state, setState] = useState({ machineID: "m1", block: false });
      setHarness = setState;
      renderedMachines.push(state.machineID);
      return (
        <Suspense fallback={<div data-fallback />}>
          <BotmuxSwitch
            machineID={state.machineID}
            deps={{
              on: true,
              saveBotmux: (_mid, _next, signal) => {
                capturedSignal = signal;
                return saveGate.promise;
              },
              notify,
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => sw()!.click());
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    expect(sw()?.disabled).toBe(true);

    // Suspended concurrent transition to m2 must NOT abort committed m1 save.
    await act(async () => {
      startTransition(() => setHarness({ machineID: "m2", block: true }));
    });
    expect(renderedMachines).toContain("m2");
    expect(capturedSignal!.aborted).toBe(false);
    expect(sw()?.disabled).toBe(true);

    // Abandon back to m1: save completes cleanly.
    await act(async () => setHarness({ machineID: "m1", block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => saveGate.resolve({ on: false }));
    await flush();
    expect(sw()?.disabled).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("preserves default api, errorText, and toast fallbacks when deps are omitted", async () => {
    mocks.api
      .mockResolvedValueOnce({ on: true })
      .mockRejectedValueOnce(new Error("put boom"));

    await act(async () => root.render(<BotmuxSwitch machineID="mac a" />));
    await flush();
    expect(mocks.api).toHaveBeenCalledWith("/machines/mac%20a/botmux", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sw()?.getAttribute("aria-checked")).toBe("true");

    await act(async () => sw()!.click());
    await flush();
    expect(mocks.api).toHaveBeenNthCalledWith(
      2,
      "/machines/mac%20a/botmux",
      expect.objectContaining({ method: "PUT", json: { on: false }, signal: expect.any(AbortSignal) }),
    );
    expect(mocks.errorText).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(t("machines-botmuxswitch.save_failed", { error: "default-err:put boom" }), "error");
    expect(sw()?.getAttribute("aria-checked")).toBe("true");

    // Older hub 404 hides switch without firing toast.
    mocks.toast.mockClear();
    mocks.api.mockRejectedValueOnce(new Error("404"));
    await act(async () => root.render(<BotmuxSwitch machineID="old-hub" />));
    await flush();
    expect(sw()).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
