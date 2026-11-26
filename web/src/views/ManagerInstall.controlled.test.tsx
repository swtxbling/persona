// @vitest-environment jsdom
// Controlled NewManager and CodeDialog bypass lib/managers and ui/atoms singletons (including useNow), cache clock and
// scope getters without subscription churn, preserve render purity across abandoned concurrent transitions, fence async
// createManager/renewCode/copyText across open/shown/scope switches, ABA bursts, and unmount, reset CodeDialog last on
// scope change, recover via try/finally, and preserve relative-clock default behavior.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import type { InstallCode, Manager } from "../lib/managers";
import type { CodeDialogDeps, CreateManagerResult, NewManagerDeps, ShownCode } from "./ManagerInstall";

const mocks = vi.hoisted(() => ({
  createManager: vi.fn(),
  renewCode: vi.fn(),
  managerError: vi.fn((e: unknown) => `default-mgr-err:${e instanceof Error ? e.message : String(e)}`),
  useNow: vi.fn(),
  toast: vi.fn(),
  copyText: vi.fn(),
}));

vi.mock("../lib/managers", async (original) => ({
  ...(await original<typeof import("../lib/managers")>()),
  createManager: (name: string) => mocks.createManager(name),
  renewCode: (id: string, name: string, fresh: boolean) => mocks.renewCode(id, name, fresh),
  managerError: (e: unknown) => mocks.managerError(e),
}));

vi.mock("../ui/atoms", async (original) => {
  const real = await original<typeof import("../ui/atoms")>();
  return {
    ...real,
    useNow: (every?: number, on?: boolean) => {
      mocks.useNow(every, on);
      return real.useNow(every, on);
    },
    toast: (message: string, tone?: string) => mocks.toast(message, tone),
    copyText: (text: string) => mocks.copyText(text),
  };
});

const { CodeDialog, CodeDialogView, CopyLineView, NewManager, NewManagerView } = await import("./ManagerInstall");

const deferred = <T = void,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

const setInput = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const activeDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const findButton = (rootEl: ParentNode, text: string) =>
  [...rootEl.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const copyButtons = (rootEl: ParentNode) =>
  [...rootEl.querySelectorAll<HTMLButtonElement>(`button[aria-label="${t("settings-managers.copy")}"]`)];

const FIXED_NOW = Date.parse("2026-11-26T08:00:00.000Z");
const makeCode = (patch: Partial<InstallCode> = {}): InstallCode => ({
  code: "mi_alpha",
  expires_at: new Date(FIXED_NOW + 5 * 60_000).toISOString(),
  commands: {
    service: "curl -fsSL https://hub.example.com/i/mi_alpha | sh",
    docker: "docker run persona/manager mi_alpha",
  },
  ...patch,
});

const makeShown = (patch: Partial<ShownCode> = {}): ShownCode => ({
  id: "m-1",
  name: "Work",
  code: makeCode(),
  fresh: true,
  ...patch,
});

const makeManager = (patch: Partial<Manager> = {}): Manager => ({
  id: "m-new",
  name: "Studio",
  online: false,
  ...patch,
});

const expectNoDefaultSingletons = () => {
  expect(mocks.createManager).not.toHaveBeenCalled();
  expect(mocks.renewCode).not.toHaveBeenCalled();
  expect(mocks.managerError).not.toHaveBeenCalled();
  expect(mocks.useNow).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
  expect(mocks.copyText).not.toHaveBeenCalled();
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.managerError.mockImplementation((e: unknown) => `default-mgr-err:${e instanceof Error ? e.message : String(e)}`);
  mocks.copyText.mockResolvedValue(true);
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

describe("Pure presentational ManagerInstall views", () => {
  it("renders NewManagerView, CodeDialogView, and CopyLineView without touching singletons", async () => {
    const onNameChange = vi.fn();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const onRenew = vi.fn();
    const onCopy = vi.fn();

    await act(async () => root.render(
      <NewManagerView
        open
        name="Studio"
        valid
        busy={false}
        error="Name already exists"
        onNameChange={onNameChange}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    ));
    expect(activeDialog()?.querySelector('[role="alert"]')?.textContent).toBe("Name already exists");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Active CodeDialogView renders countdown, code, commands, and disabled copy when copyingText is set.
    const shown = makeShown();
    await act(async () => root.render(
      <CodeDialogView
        open
        shown={shown}
        secondsLeft={125}
        commands={[{ label: t("settings-managers.install_service"), text: shown.code.commands!.service! }]}
        busy={false}
        copyingText={null}
        onClose={onClose}
        onRenew={onRenew}
        onCopy={onCopy}
      />,
    ));
    expect(activeDialog()?.textContent).toContain("2:05");
    expect(activeDialog()?.textContent).toContain("mi_alpha");
    await act(async () => { copyButtons(activeDialog()!)[0].click(); });
    expect(onCopy).toHaveBeenCalledWith("mi_alpha");

    // Expired CodeDialogView renders renewal action and busy state.
    await act(async () => root.render(
      <CodeDialogView
        open
        shown={shown}
        secondsLeft={0}
        commands={[]}
        busy
        onClose={onClose}
        onRenew={onRenew}
        onCopy={onCopy}
      />,
    ));
    expect(activeDialog()?.textContent).toContain(t("settings-managers.expired"));
    expect(findButton(activeDialog()!, t("settings-managers.new_code"))?.getAttribute("aria-busy")).toBe("true");

    // Standalone CopyLineView honors disabled state.
    await act(async () => root.render(<CopyLineView text="cmd-1" disabled onCopy={onCopy} />));
    expect(copyButtons(host)[0].disabled).toBe(true);
    expectNoDefaultSingletons();
  });
});

describe("NewManager controlled deps, fencing, render purity, and recovery", () => {
  it("bypasses singletons, avoids subscription churn on bridge switch, fences open/scope ABA & unmount, and recovers via try/finally", async () => {
    const scopeListeners = new Set<() => void>();
    let currentScope = "s1";
    const onClose = vi.fn();
    const onMade = vi.fn();
    const onError = vi.fn();
    const calls: Array<{ name: string; signal: AbortSignal; gate: ReturnType<typeof deferred<CreateManagerResult>> }> = [];

    // Direct mode -> type draft -> switch in-place to getter + subscribe on same scope.
    await act(async () => root.render(
      <StrictMode>
        <NewManager open onClose={onClose} onMade={onMade} deps={{ scopeKey: "s1", validName: (n) => n.trim().length >= 3 }} />
      </StrictMode>,
    ));
    await setInput(activeDialog()!.querySelector("input")!, "ab");
    expect(findButton(activeDialog()!, t("settings-managers.create"))?.disabled).toBe(true);
    await setInput(activeDialog()!.querySelector("input")!, "Studio");
    expect(findButton(activeDialog()!, t("settings-managers.create"))?.disabled).toBe(false);

    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const makeDeps = (extra?: Partial<NewManagerDeps>): NewManagerDeps => ({
      scopeKey: () => currentScope,
      subscribeScopeKey,
      createManager: (name, signal) => {
        const gate = deferred<CreateManagerResult>();
        calls.push({ name, signal, gate });
        return gate.promise;
      },
      formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
      onError,
      ...extra,
    });

    const renderSub = (open = true, extra?: Partial<NewManagerDeps>) => root.render(
      <StrictMode>
        <NewManager open={open} onClose={onClose} onMade={onMade} deps={makeDeps(extra)} />
      </StrictMode>,
    );
    await act(async () => renderSub(true));
    expect(activeDialog()!.querySelector("input")!.value).toBe("Studio");

    // Inline getter re-renders never churn subscribeScopeKey.
    const subCount = subscribeScopeKey.mock.calls.length;
    await act(async () => renderSub(true));
    await act(async () => renderSub(true));
    expect(subscribeScopeKey).toHaveBeenCalledTimes(subCount);

    // Single-flight guard blocks duplicate clicks.
    await act(async () => {
      findButton(activeDialog()!, t("settings-managers.create"))!.click();
      findButton(activeDialog()!, t("settings-managers.create"))!.click();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("Studio");
    expect(findButton(activeDialog()!, t("settings-managers.create"))?.getAttribute("aria-busy")).toBe("true");

    // Open close/reopen ABA (true -> false -> true) aborts in-flight createManager, resets draft, and discards stale settle.
    await act(async () => renderSub(false));
    await act(async () => renderSub(true));
    expect(calls[0].signal.aborted).toBe(true);
    expect(activeDialog()!.querySelector("input")!.value).toBe("");
    expect(findButton(activeDialog()!, t("settings-managers.create"))?.getAttribute("aria-busy")).toBeNull();
    await act(async () => { calls[0].gate.resolve({ ...makeCode(), manager: makeManager() }); });
    await flush();
    expect(onMade).not.toHaveBeenCalled();

    // Synchronous scopeKey ABA burst (s1 -> s2 -> s1) aborts in-flight createManager and discards stale rejection.
    await setInput(activeDialog()!.querySelector("input")!, "Lab");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    expect(calls).toHaveLength(2);
    await act(async () => {
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
      currentScope = "s1";
      scopeListeners.forEach((l) => l());
    });
    expect(calls[1].signal.aborted).toBe(true);
    expect(activeDialog()!.querySelector("input")!.value).toBe("");
    await act(async () => { calls[1].gate.reject(new Error("stale scope")); });
    await flush();
    expect(onError).not.toHaveBeenCalled();

    // Unmount aborts active request and fences late resolve.
    await setInput(activeDialog()!.querySelector("input")!, "Desk");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    expect(calls).toHaveLength(3);
    await act(async () => root.render(null));
    expect(calls[2].signal.aborted).toBe(true);
    await act(async () => { calls[2].gate.resolve({ ...makeCode(), manager: makeManager() }); });
    await flush();
    expect(onMade).not.toHaveBeenCalled();

    // Error recovery: sync throw, async rejection, and throwing formatError / onError still release busy and preserve draft.
    let mode: "syncThrow" | "asyncReject" | "ok" = "syncThrow";
    let fmtThrows = false;
    const throwingOnError = vi.fn(() => { throw new Error("observer boom"); });
    await act(async () => root.render(
      <NewManager
        open
        onClose={onClose}
        onMade={onMade}
        deps={{
          scopeKey: "s3",
          createManager: () => {
            if (mode === "syncThrow") throw new Error("sync create boom");
            if (mode === "asyncReject") return Promise.reject(new Error("async create boom"));
            return Promise.resolve({ ...makeCode(), manager: makeManager({ name: "Office" }) });
          },
          formatError: (e) => {
            if (fmtThrows) throw new Error("formatter boom");
            return `custom:${e instanceof Error ? e.message : String(e)}`;
          },
          onError: throwingOnError,
        }}
      />,
    ));
    await setInput(activeDialog()!.querySelector("input")!, "Office");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    expect(activeDialog()!.querySelector('[role="alert"]')?.textContent).toBe("custom:sync create boom");
    expect(activeDialog()!.querySelector("input")!.value).toBe("Office");
    expect(findButton(activeDialog()!, t("settings-managers.create"))?.getAttribute("aria-busy")).toBeNull();

    mode = "asyncReject";
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    await flush();
    expect(activeDialog()!.querySelector('[role="alert"]')?.textContent).toBe("custom:async create boom");
    expect(findButton(activeDialog()!, t("settings-managers.create"))?.getAttribute("aria-busy")).toBeNull();
    expect(throwingOnError).toHaveBeenCalledTimes(2);

    // Retry succeeds cleanly.
    mode = "ok";
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    await flush();
    expect(onMade).toHaveBeenCalledTimes(1);
    expect(onMade.mock.calls[0][0].name).toBe("Office");

    // Custom renderView seam works cleanly.
    await act(async () => root.render(
      <NewManager
        open
        onClose={onClose}
        onMade={onMade}
        deps={{ renderView: (p) => <div data-custom-new={`${p.open}:${p.valid}`} /> }}
      />,
    ));
    expect(host.querySelector("[data-custom-new]")?.getAttribute("data-custom-new")).toBe("true:false");
    expectNoDefaultSingletons();

    // Throwing formatError falls back safely without leaving busy stuck.
    fmtThrows = true;
    mode = "asyncReject";
    await act(async () => root.render(
      <NewManager
        open
        onClose={onClose}
        onMade={onMade}
        deps={{
          scopeKey: "s4",
          createManager: () => Promise.reject(new Error("format fallback")),
          formatError: () => {
            if (fmtThrows) throw new Error("formatter boom");
            return "unreachable";
          },
          onError: throwingOnError,
        }}
      />,
    ));
    await setInput(activeDialog()!.querySelector("input")!, "Fallback");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    await flush();
    expect(activeDialog()!.querySelector('[role="alert"]')?.textContent).toBe("default-mgr-err:format fallback");
    expect(findButton(activeDialog()!, t("settings-managers.create"))?.getAttribute("aria-busy")).toBeNull();
  });

  it("keeps committed draft and in-flight createManager intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const createGate = deferred<CreateManagerResult>();
    const onMade = vi.fn();
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
          <NewManager
            open
            onClose={() => {}}
            onMade={onMade}
            deps={{
              scopeKey: state.scope,
              createManager: (_name, signal) => {
                capturedSignal = signal;
                return createGate.promise;
              },
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await setInput(activeDialog()!.querySelector("input")!, "Studio");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    expect(capturedSignal!.aborted).toBe(false);

    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);

    await act(async () => setHarness({ scope: "s1", block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => { createGate.resolve({ ...makeCode(), manager: makeManager({ name: "Studio" }) }); });
    await flush();
    expect(onMade).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });
});

describe("CodeDialog controlled clock, last reset, async fencing, render purity, and recovery", () => {
  it("supports controlled now and subscribeNow without calling useNow, avoids subscription churn, and resets last on scope change", async () => {
    const nowListeners = new Set<() => void>();
    const scopeListeners = new Set<() => void>();
    let liveNow = FIXED_NOW;
    let currentScope = "s1";
    const shown = makeShown();

    // Direct fixed now renders countdown without touching useNow.
    await act(async () => root.render(
      <StrictMode>
        <CodeDialog shown={shown} onClose={() => {}} onCode={() => {}} deps={{ scopeKey: "s1", now: FIXED_NOW }} />
      </StrictMode>,
    ));
    expect(activeDialog()?.textContent).toContain("5:00");
    expect(mocks.useNow).not.toHaveBeenCalled();

    // Switch in-place to getter + subscribeNow and subscribeScopeKey.
    const subscribeNow = vi.fn((l: () => void) => { nowListeners.add(l); return () => { nowListeners.delete(l); }; });
    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const renderSub = (nextShown: ShownCode | null) => root.render(
      <StrictMode>
        <CodeDialog
          shown={nextShown}
          onClose={() => {}}
          onCode={() => {}}
          deps={{
            scopeKey: () => currentScope,
            subscribeScopeKey,
            now: () => liveNow,
            subscribeNow,
          }}
        />
      </StrictMode>,
    );
    await act(async () => renderSub(shown));
    expect(activeDialog()?.textContent).toContain("5:00");

    // Inline getters never churn subscriptions across re-renders.
    const nowSubCount = subscribeNow.mock.calls.length;
    const scopeSubCount = subscribeScopeKey.mock.calls.length;
    await act(async () => renderSub(shown));
    await act(async () => renderSub(shown));
    expect(subscribeNow).toHaveBeenCalledTimes(nowSubCount);
    expect(subscribeScopeKey).toHaveBeenCalledTimes(scopeSubCount);

    // Advancing controlled clock past expiry switches to expired view immediately.
    liveNow = FIXED_NOW + 6 * 60_000;
    await act(async () => { nowListeners.forEach((l) => l()); });
    expect(activeDialog()?.textContent).toContain(t("settings-managers.expired"));

    // Closing within same scope retains last for exit animation; switching scopeKey wipes last immediately.
    await act(async () => renderSub(null));
    currentScope = "s2";
    await act(async () => { scopeListeners.forEach((l) => l()); });
    expect(activeDialog()).toBeNull();

    // Custom renderView seam works cleanly.
    await act(async () => root.render(
      <CodeDialog
        shown={shown}
        onClose={() => {}}
        onCode={() => {}}
        deps={{
          now: FIXED_NOW,
          renderView: (p) => <div data-custom-code={`${p.shown.id}:${p.secondsLeft}`} />,
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-code]")?.getAttribute("data-custom-code")).toBe("m-1:300");
    expectNoDefaultSingletons();
  });

  it("fences renewCode and copyText across shown switches, shown=null ABA, scopeKey ABA, abandoned transitions, and unmount, and recovers via try/finally", async () => {
    const scopeListeners = new Set<() => void>();
    let currentScope = "s1";
    const onCode = vi.fn();
    const notify = vi.fn();
    const onError = vi.fn();
    const renewCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<{ id: string; code: InstallCode }>> }> = [];
    const copyCalls: Array<{ text: string; signal?: AbortSignal; gate: ReturnType<typeof deferred<boolean>> }> = [];

    const activeShown = makeShown();
    const otherShown = makeShown({ id: "m-2", name: "Home", code: makeCode({ code: "mi_beta" }) });
    const expiredShown = makeShown({ code: makeCode({ expires_at: new Date(FIXED_NOW - 10_000).toISOString() }) });

    const makeDeps = (extra?: Partial<CodeDialogDeps>): CodeDialogDeps => ({
      scopeKey: () => currentScope,
      subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
      now: FIXED_NOW,
      renewCode: (_id, _name, _fresh, signal) => {
        const gate = deferred<{ id: string; code: InstallCode }>();
        renewCalls.push({ signal, gate });
        return gate.promise;
      },
      copyText: (text, signal) => {
        const gate = deferred<boolean>();
        copyCalls.push({ text, signal, gate });
        return gate.promise;
      },
      notify,
      formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
      onError,
      ...extra,
    });

    // 1) copyText single-flight guard + shown=null -> same shown ABA aborts and fences late rejection.
    await act(async () => root.render(<CodeDialog shown={activeShown} onClose={() => {}} onCode={onCode} deps={makeDeps()} />));
    await act(async () => {
      copyButtons(activeDialog()!)[0].click();
      copyButtons(activeDialog()!)[0].click();
    });
    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0].text).toBe("mi_alpha");
    expect(copyButtons(activeDialog()!)[0].disabled).toBe(true);

    await act(async () => root.render(<CodeDialog shown={null} onClose={() => {}} onCode={onCode} deps={makeDeps()} />));
    await act(async () => root.render(<CodeDialog shown={activeShown} onClose={() => {}} onCode={onCode} deps={makeDeps()} />));
    expect(copyCalls[0].signal?.aborted).toBe(true);
    expect(copyButtons(activeDialog()!)[0].disabled).toBe(false);
    await act(async () => { copyCalls[0].gate.reject(new Error("stale copy")); });
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // 2) renewCode single-flight guard + shown switch (expiredShown -> otherShown -> expiredShown ABA) aborts and fences stale resolve.
    await act(async () => root.render(<CodeDialog shown={expiredShown} onClose={() => {}} onCode={onCode} deps={makeDeps()} />));
    await act(async () => {
      findButton(activeDialog()!, t("settings-managers.new_code"))!.click();
      findButton(activeDialog()!, t("settings-managers.new_code"))!.click();
    });
    expect(renewCalls).toHaveLength(1);
    expect(findButton(activeDialog()!, t("settings-managers.new_code"))?.getAttribute("aria-busy")).toBe("true");

    await act(async () => root.render(<CodeDialog shown={otherShown} onClose={() => {}} onCode={onCode} deps={makeDeps()} />));
    await act(async () => root.render(<CodeDialog shown={expiredShown} onClose={() => {}} onCode={onCode} deps={makeDeps()} />));
    expect(renewCalls[0].signal.aborted).toBe(true);
    expect(findButton(activeDialog()!, t("settings-managers.new_code"))?.getAttribute("aria-busy")).toBeNull();
    await act(async () => { renewCalls[0].gate.resolve({ id: "m-1", code: makeCode({ code: "mi_stale" }) }); });
    await flush();
    expect(onCode).not.toHaveBeenCalled();

    // 3) Synchronous scopeKey ABA burst (s1 -> s2 -> s1) aborts in-flight renewCode and discards stale rejection.
    await act(async () => { findButton(activeDialog()!, t("settings-managers.new_code"))!.click(); });
    expect(renewCalls).toHaveLength(2);
    await act(async () => {
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
      currentScope = "s1";
      scopeListeners.forEach((l) => l());
    });
    expect(renewCalls[1].signal.aborted).toBe(true);
    expect(findButton(activeDialog()!, t("settings-managers.new_code"))?.getAttribute("aria-busy")).toBeNull();
    await act(async () => { renewCalls[1].gate.reject(new Error("stale renew")); });
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // 4) Unmount aborts in-flight renewCode and discards late resolve.
    await act(async () => { findButton(activeDialog()!, t("settings-managers.new_code"))!.click(); });
    expect(renewCalls).toHaveLength(3);
    await act(async () => root.render(null));
    expect(renewCalls[2].signal.aborted).toBe(true);
    await act(async () => { renewCalls[2].gate.resolve({ id: "m-1", code: makeCode({ code: "mi_unmounted" }) }); });
    await flush();
    expect(onCode).not.toHaveBeenCalled();

    // 5) Abandoned concurrent transition render preserves committed scope and in-flight renewCode.
    const suspendGate = deferred<void>();
    const transitionRenewGate = deferred<{ id: string; code: InstallCode }>();
    let transitionSignal: AbortSignal | null = null;
    const renderedScopes: string[] = [];

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    let setHarness!: (next: { scope: string; shown: ShownCode | null; block: boolean }) => void;
    function Harness() {
      const [state, setState] = useState<{ scope: string; shown: ShownCode | null; block: boolean }>({ scope: "s1", shown: expiredShown, block: false });
      setHarness = setState;
      renderedScopes.push(state.scope);
      return (
        <Suspense fallback={<div data-fallback />}>
          <CodeDialog
            shown={state.shown}
            onClose={() => {}}
            onCode={onCode}
            deps={{
              scopeKey: state.scope,
              now: FIXED_NOW,
              renewCode: (_id, _name, _fresh, signal) => {
                transitionSignal = signal;
                return transitionRenewGate.promise;
              },
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => { findButton(activeDialog()!, t("settings-managers.new_code"))!.click(); });
    expect(transitionSignal!.aborted).toBe(false);

    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", shown: null, block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(transitionSignal!.aborted).toBe(false);

    await act(async () => setHarness({ scope: "s1", shown: expiredShown, block: false }));
    expect(transitionSignal!.aborted).toBe(false);
    await act(async () => { transitionRenewGate.resolve({ id: "m-1", code: makeCode({ code: "mi_renewed" }) }); });
    await flush();
    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ code: "mi_renewed" }), "m-1");

    // 6) try/finally recovery for renewCode & copyText with throwing notify / formatError / onError.
    let renewMode: "syncThrow" | "asyncReject" | "ok" = "syncThrow";
    let copyMode: "syncThrow" | "asyncReject" | "ok" = "syncThrow";
    const throwingNotify = vi.fn(() => { throw new Error("toast crashed"); });
    const throwingOnError = vi.fn(() => { throw new Error("observer crashed"); });

    await act(async () => root.render(
      <CodeDialog
        shown={expiredShown}
        onClose={() => {}}
        onCode={onCode}
        deps={{
          scopeKey: "s4",
          now: FIXED_NOW,
          renewCode: () => {
            if (renewMode === "syncThrow") throw new Error("renew sync");
            if (renewMode === "asyncReject") return Promise.reject(new Error("renew async"));
            return Promise.resolve({ id: "m-1", code: makeCode({ code: "mi_retry_ok" }) });
          },
          notify: throwingNotify,
          formatError: (e) => `err:${e instanceof Error ? e.message : String(e)}`,
          onError: throwingOnError,
        }}
      />,
    ));

    await act(async () => { findButton(activeDialog()!, t("settings-managers.new_code"))!.click(); });
    expect(throwingNotify).toHaveBeenCalledWith("err:renew sync", "error");
    expect(findButton(activeDialog()!, t("settings-managers.new_code"))?.getAttribute("aria-busy")).toBeNull();

    renewMode = "asyncReject";
    await act(async () => { findButton(activeDialog()!, t("settings-managers.new_code"))!.click(); });
    await flush();
    expect(throwingNotify).toHaveBeenCalledWith("err:renew async", "error");
    expect(findButton(activeDialog()!, t("settings-managers.new_code"))?.getAttribute("aria-busy")).toBeNull();

    renewMode = "ok";
    await act(async () => { findButton(activeDialog()!, t("settings-managers.new_code"))!.click(); });
    await flush();
    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ code: "mi_retry_ok" }), "m-1");

    // Copy sync throw, async reject, and retry recovery.
    const copiedTexts: string[] = [];
    await act(async () => root.render(
      <CodeDialog
        shown={activeShown}
        onClose={() => {}}
        onCode={onCode}
        deps={{
          scopeKey: "s5",
          now: FIXED_NOW,
          copyText: (text) => {
            if (copyMode === "syncThrow") throw new Error("copy sync");
            if (copyMode === "asyncReject") return Promise.reject(new Error("copy async"));
            copiedTexts.push(text);
            return Promise.resolve(true);
          },
          notify: throwingNotify,
          formatError: (e) => `copy:${e instanceof Error ? e.message : String(e)}`,
          onError: throwingOnError,
        }}
      />,
    ));

    await act(async () => { copyButtons(activeDialog()!)[0].click(); });
    expect(copyButtons(activeDialog()!)[0].disabled).toBe(false);
    copyMode = "asyncReject";
    await act(async () => { copyButtons(activeDialog()!)[0].click(); });
    await flush();
    expect(copyButtons(activeDialog()!)[0].disabled).toBe(false);
    copyMode = "ok";
    await act(async () => { copyButtons(activeDialog()!)[0].click(); });
    await flush();
    expect(copiedTexts).toEqual(["mi_alpha"]);
    expectNoDefaultSingletons();

    // Throwing formatError on renewCode still falls back safely and releases busy.
    await act(async () => root.render(
      <CodeDialog
        shown={expiredShown}
        onClose={() => {}}
        onCode={onCode}
        deps={{
          scopeKey: "s6",
          now: FIXED_NOW,
          renewCode: () => Promise.reject(new Error("renew format fallback")),
          notify: throwingNotify,
          formatError: () => { throw new Error("formatter boom"); },
          onError: throwingOnError,
        }}
      />,
    ));
    await act(async () => { findButton(activeDialog()!, t("settings-managers.new_code"))!.click(); });
    await flush();
    expect(throwingNotify).toHaveBeenCalledWith("default-mgr-err:renew format fallback", "error");
    expect(findButton(activeDialog()!, t("settings-managers.new_code"))?.getAttribute("aria-busy")).toBeNull();
  });
});

describe("ManagerInstall default fallback parity (relative live wall-clock)", () => {
  it("preserves default createManager, renewCode, managerError, useNow, copyText, and toast fallbacks when deps is omitted", async () => {
    const onMade = vi.fn();
    const onCode = vi.fn();

    // NewManager default error then retry success.
    mocks.createManager
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValueOnce({ code: "mi_default", expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), manager: makeManager({ name: "Default" }) });

    await act(async () => root.render(<NewManager open onClose={() => {}} onMade={onMade} />));
    await setInput(activeDialog()!.querySelector("input")!, "Default");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    await flush();
    expect(mocks.createManager).toHaveBeenCalledWith("Default");
    expect(mocks.managerError).toHaveBeenCalled();
    expect(activeDialog()!.querySelector('[role="alert"]')?.textContent).toBe("default-mgr-err:create failed");

    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    await flush();
    expect(onMade).toHaveBeenCalledTimes(1);

    // CodeDialog active (relative to Date.now()) uses default useNow(1000) and copyText.
    const liveShown = makeShown({
      code: makeCode({ expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }),
    });
    await act(async () => root.render(<CodeDialog shown={liveShown} onClose={() => {}} onCode={onCode} />));
    expect(mocks.useNow).toHaveBeenCalledWith(1000, undefined);
    await act(async () => { copyButtons(activeDialog()!)[0].click(); });
    await flush();
    expect(mocks.copyText).toHaveBeenCalledWith("mi_alpha");

    // CodeDialog expired (relative to Date.now()) calls default renewCode + toast on error, then onCode on success.
    const expiredLiveShown = makeShown({
      code: makeCode({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
    });
    const renewedCode = makeCode({ code: "mi_live_renewed", expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
    mocks.renewCode
      .mockRejectedValueOnce(new Error("renew failed"))
      .mockResolvedValueOnce({ id: "m-1", code: renewedCode });

    await act(async () => root.render(<CodeDialog shown={expiredLiveShown} onClose={() => {}} onCode={onCode} />));
    await act(async () => { findButton(activeDialog()!, t("settings-managers.new_code"))!.click(); });
    await flush();
    expect(mocks.renewCode).toHaveBeenCalledWith("m-1", "Work", true);
    expect(mocks.toast).toHaveBeenCalledWith("default-mgr-err:renew failed", "error");

    await act(async () => { findButton(activeDialog()!, t("settings-managers.new_code"))!.click(); });
    await flush();
    expect(onCode).toHaveBeenCalledWith(renewedCode, "m-1");
  });

  it("blocks Escape, backdrop, and Cancel close while default createManager is in flight so onMade is not dropped", async () => {
    const createGate = deferred<CreateManagerResult>();
    mocks.createManager.mockReturnValueOnce(createGate.promise);
    const onClose = vi.fn();
    const onMade = vi.fn();

    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <NewManager
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          onMade={(manager, code) => {
            onMade(manager, code);
            setOpen(false);
          }}
        />
      );
    }

    await act(async () => root.render(<Host />));
    await setInput(activeDialog()!.querySelector("input")!, "Studio");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.create"))!.click(); });
    expect(mocks.createManager).toHaveBeenCalledWith("Studio");

    // Attempt Escape, Cancel, and backdrop dismiss while creation is in flight.
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await act(async () => { findButton(activeDialog()!, t("common.cancel"))!.click(); });
    const backdrop = activeDialog()?.parentElement;
    if (backdrop) {
      await act(async () => { backdrop.click(); });
    }
    expect(onClose).not.toHaveBeenCalled();
    expect(activeDialog()).not.toBeNull();

    const created: CreateManagerResult = {
      code: "mi_created_busy",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      manager: makeManager({ id: "m-created", name: "Studio" }),
    };
    await act(async () => { createGate.resolve(created); });
    await flush();

    expect(onMade).toHaveBeenCalledTimes(1);
    expect(onMade).toHaveBeenCalledWith(created.manager, created);
    expect(onClose).not.toHaveBeenCalled();
  });
});
