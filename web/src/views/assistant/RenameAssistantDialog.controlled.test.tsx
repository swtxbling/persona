// @vitest-environment jsdom
// Controlled RenameAssistantDialog bypasses lib/managers, lib/api, and ui/atoms singletons, avoids subscription churn on
// scope getter updates, preserves render purity across abandoned concurrent transitions, fences renameManager across
// scopeKey, manager?.id, open close/reopen ABA, and unmount, preserves draft on failure, recovers via try/finally, and
// preserves default behavior.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { Manager } from "../../lib/managers";
import type { RenameAssistantDialogDeps } from "./RenameAssistantDialog";

const mocks = vi.hoisted(() => ({
  renameManager: vi.fn(),
  errorText: vi.fn((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`),
  toast: vi.fn(),
}));

vi.mock("../../lib/managers", async (original) => ({
  ...(await original<typeof import("../../lib/managers")>()),
  renameManager: (id: string, name: string) => mocks.renameManager(id, name),
}));

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  errorText: (e: unknown) => mocks.errorText(e),
}));

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  toast: (message: string, tone?: string) => mocks.toast(message, tone),
}));

const { RenameAssistantDialog, RenameAssistantDialogView } = await import("./RenameAssistantDialog");

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

const M_ONE: Manager = { id: "m-1", name: "Alpha", online: true };
const M_TWO: Manager = { id: "m-2", name: "Beta", online: true };

const expectNoDefaultSingletons = () => {
  expect(mocks.renameManager).not.toHaveBeenCalled();
  expect(mocks.errorText).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.errorText.mockImplementation((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`);
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

describe("Pure presentational RenameAssistantDialogView", () => {
  it("renders title, draft input, disabled/busy button states, and callbacks without touching singletons", async () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const onClose = vi.fn();

    // Unchanged draft keeps Save disabled.
    await act(async () => root.render(
      <RenameAssistantDialogView
        open
        draft="Alpha"
        currentName="Alpha"
        valid
        busy={false}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onClose={onClose}
      />,
    ));
    expect(activeDialog()?.textContent).toContain(t("assistant-profile.name_dialog_title"));
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.disabled).toBe(true);

    // Changed valid draft enables Save and submits.
    await act(async () => root.render(
      <RenameAssistantDialogView
        open
        draft="Alpha Prime"
        currentName="Alpha"
        valid
        busy={false}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onClose={onClose}
      />,
    ));
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.disabled).toBe(false);
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    expect(onSave).toHaveBeenCalledTimes(1);

    // Busy disables Cancel and marks Save aria-busy.
    await act(async () => root.render(
      <RenameAssistantDialogView
        open
        draft="Alpha Prime"
        currentName="Alpha"
        valid
        busy
        onDraftChange={onDraftChange}
        onSave={onSave}
        onClose={onClose}
      />,
    ));
    expect(findButton(activeDialog()!, t("common.cancel"))?.disabled).toBe(true);
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.getAttribute("aria-busy")).toBe("true");
    expectNoDefaultSingletons();
  });
});

describe("RenameAssistantDialog controlled deps, fencing, render purity, recovery, and default fallback", () => {
  it("bypasses singletons, avoids subscription churn across bridge switch, and supports custom validName and renderView", async () => {
    const scopeListeners = new Set<() => void>();
    const onClose = vi.fn();

    await act(async () => root.render(
      <StrictMode>
        <RenameAssistantDialog
          open
          onClose={onClose}
          manager={M_ONE}
          currentName="Alpha"
          deps={{ scopeKey: "s1", validName: (n) => n.trim().length >= 4 }}
        />
      </StrictMode>,
    ));
    await setInput(activeDialog()!.querySelector("input")!, "abc");
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.disabled).toBe(true);
    await setInput(activeDialog()!.querySelector("input")!, "Alpha New");
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.disabled).toBe(false);

    // Bridge switch to getter + subscribeScopeKey on the same scope preserves typed draft without churning subscriptions.
    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const renderSub = () => root.render(
      <StrictMode>
        <RenameAssistantDialog
          open
          onClose={onClose}
          manager={M_ONE}
          currentName="Alpha"
          deps={{
            scopeKey: () => "s1",
            subscribeScopeKey,
            validName: (n) => n.trim().length >= 4,
          }}
        />
      </StrictMode>,
    );
    await act(async () => renderSub());
    expect(activeDialog()!.querySelector("input")!.value).toBe("Alpha New");

    const subCount = subscribeScopeKey.mock.calls.length;
    await act(async () => renderSub());
    await act(async () => renderSub());
    expect(subscribeScopeKey).toHaveBeenCalledTimes(subCount);

    // Custom renderView seam works cleanly.
    await act(async () => root.render(
      <RenameAssistantDialog
        open
        onClose={onClose}
        manager={M_ONE}
        currentName="Alpha"
        deps={{ renderView: (p) => <div data-custom-rename={`${p.open}:${p.draft}`} /> }}
      />,
    ));
    expect(host.querySelector("[data-custom-rename]")?.getAttribute("data-custom-rename")).toBe("true:Alpha");
    expectNoDefaultSingletons();
  });

  it("fences renameManager across open close/reopen ABA, manager?.id switches & ABA, scopeKey ABA bursts, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    let currentScope = "s1";
    const onClose = vi.fn();
    const notify = vi.fn();
    const onError = vi.fn();
    const calls: Array<{ id: string; name: string; signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];

    const makeDeps = (): RenameAssistantDialogDeps => ({
      scopeKey: () => currentScope,
      subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
      renameManager: (id, name, signal) => {
        const gate = deferred<void>();
        calls.push({ id, name, signal, gate });
        return gate.promise;
      },
      notify,
      formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
      onError,
    });

    // 1) Single-flight guard prevents duplicate submissions.
    await act(async () => root.render(
      <RenameAssistantDialog open onClose={onClose} manager={M_ONE} currentName="Alpha" deps={makeDeps()} />,
    ));
    await setInput(activeDialog()!.querySelector("input")!, "Alpha 2");
    await act(async () => {
      findButton(activeDialog()!, t("settings-managers.save"))!.click();
      findButton(activeDialog()!, t("settings-managers.save"))!.click();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("m-1");
    expect(calls[0].name).toBe("Alpha 2");
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.getAttribute("aria-busy")).toBe("true");

    // 2) Open close/reopen ABA (true -> false -> true) aborts, resets draft, and discards stale resolve.
    await act(async () => root.render(
      <RenameAssistantDialog open={false} onClose={onClose} manager={M_ONE} currentName="Alpha" deps={makeDeps()} />,
    ));
    await act(async () => root.render(
      <RenameAssistantDialog open onClose={onClose} manager={M_ONE} currentName="Alpha" deps={makeDeps()} />,
    ));
    expect(calls[0].signal.aborted).toBe(true);
    expect(activeDialog()!.querySelector("input")!.value).toBe("Alpha");
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.getAttribute("aria-busy")).toBeNull();
    await act(async () => { calls[0].gate.resolve(); });
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 3) Manager switch ABA (m-1 -> m-2 -> m-1) aborts, resets draft, and discards stale rejection.
    await setInput(activeDialog()!.querySelector("input")!, "Alpha 3");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    expect(calls).toHaveLength(2);
    await act(async () => root.render(
      <RenameAssistantDialog open onClose={onClose} manager={M_TWO} currentName="Beta" deps={makeDeps()} />,
    ));
    await act(async () => root.render(
      <RenameAssistantDialog open onClose={onClose} manager={M_ONE} currentName="Alpha" deps={makeDeps()} />,
    ));
    expect(calls[1].signal.aborted).toBe(true);
    expect(activeDialog()!.querySelector("input")!.value).toBe("Alpha");
    await act(async () => { calls[1].gate.reject(new Error("stale manager")); });
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // 3b) Manager null ABA (m-1 -> null -> m-1) also aborts, resets draft, and discards stale resolve.
    await setInput(activeDialog()!.querySelector("input")!, "Alpha 3b");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    expect(calls).toHaveLength(3);
    await act(async () => root.render(
      <RenameAssistantDialog open onClose={onClose} manager={null} currentName="Alpha" deps={makeDeps()} />,
    ));
    await act(async () => root.render(
      <RenameAssistantDialog open onClose={onClose} manager={M_ONE} currentName="Alpha" deps={makeDeps()} />,
    ));
    expect(calls[2].signal.aborted).toBe(true);
    expect(activeDialog()!.querySelector("input")!.value).toBe("Alpha");
    await act(async () => { calls[2].gate.resolve(); });
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 4) Synchronous scopeKey ABA burst (s1 -> s2 -> s1) aborts and discards stale resolve.
    await setInput(activeDialog()!.querySelector("input")!, "Alpha 4");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    expect(calls).toHaveLength(4);
    await act(async () => {
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
      currentScope = "s1";
      scopeListeners.forEach((l) => l());
    });
    expect(calls[3].signal.aborted).toBe(true);
    expect(activeDialog()!.querySelector("input")!.value).toBe("Alpha");
    await act(async () => { calls[3].gate.resolve(); });
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 5) Unmount aborts in-flight renameManager and fences late resolve/reject.
    await setInput(activeDialog()!.querySelector("input")!, "Alpha 5");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    expect(calls).toHaveLength(5);
    await act(async () => root.render(null));
    expect(calls[4].signal.aborted).toBe(true);
    await act(async () => { calls[4].gate.reject(new Error("unmounted rename")); });
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed draft and in-flight renameManager intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const renameGate = deferred<void>();
    const notify = vi.fn();
    const onClose = vi.fn();
    let capturedSignal: AbortSignal | null = null;
    const renderedScopes: string[] = [];

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    let setHarness!: (next: { scope: string; manager: Manager; block: boolean }) => void;
    function Harness() {
      const [state, setState] = useState({ scope: "s1", manager: M_ONE, block: false });
      setHarness = setState;
      renderedScopes.push(state.scope);
      return (
        <Suspense fallback={<div data-fallback />}>
          <RenameAssistantDialog
            open
            onClose={onClose}
            manager={state.manager}
            currentName={state.manager.name}
            deps={{
              scopeKey: state.scope,
              renameManager: (_id, _name, signal) => {
                capturedSignal = signal;
                return renameGate.promise;
              },
              notify,
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await setInput(activeDialog()!.querySelector("input")!, "Alpha Kept");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    expect(capturedSignal!.aborted).toBe(false);

    // Suspended transition to s2 / M_TWO must not abort committed rename or corrupt draft.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", manager: M_TWO, block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);
    expect(activeDialog()!.querySelector("input")!.value).toBe("Alpha Kept");

    // Abandon transition back to s1; resolving renameGate completes cleanly with toast and onClose.
    await act(async () => setHarness({ scope: "s1", manager: M_ONE, block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => { renameGate.resolve(); });
    await flush();
    expect(notify).toHaveBeenCalledWith(t("assistant-profile.name_saved"), "ok");
    expect(onClose).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("preserves draft on failure and releases busy via try/finally even when formatError, notify, or onError throws", async () => {
    let mode: "syncThrow" | "asyncReject" | "ok" = "syncThrow";
    const onClose = vi.fn();
    const throwingNotify = vi.fn(() => { throw new Error("toast crashed"); });
    const throwingOnError = vi.fn(() => { throw new Error("observer crashed"); });

    await act(async () => root.render(
      <RenameAssistantDialog
        open
        onClose={onClose}
        manager={M_ONE}
        currentName="Alpha"
        deps={{
          scopeKey: "s1",
          renameManager: () => {
            if (mode === "syncThrow") throw new Error("sync rename boom");
            if (mode === "asyncReject") return Promise.reject(new Error("async rename boom"));
            return Promise.resolve();
          },
          notify: throwingNotify,
          formatError: (e) => `custom:${e instanceof Error ? e.message : String(e)}`,
          onError: throwingOnError,
        }}
      />,
    ));

    await setInput(activeDialog()!.querySelector("input")!, "Alpha Retry");

    // 1) Sync throw preserves draft, notifies, calls onError, and keeps button unblocked.
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    expect(activeDialog()!.querySelector("input")!.value).toBe("Alpha Retry");
    expect(throwingNotify).toHaveBeenCalledWith(t("assistant-profile.name_failed", { error: "custom:sync rename boom" }), "error");
    expect(throwingOnError).toHaveBeenCalledWith("custom:sync rename boom");
    expect(onClose).not.toHaveBeenCalled();
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.getAttribute("aria-busy")).toBeNull();

    // 2) Async rejection preserves draft and releases busy via try/finally despite throwing observers.
    mode = "asyncReject";
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    await flush();
    expect(activeDialog()!.querySelector("input")!.value).toBe("Alpha Retry");
    expect(throwingNotify).toHaveBeenCalledWith(t("assistant-profile.name_failed", { error: "custom:async rename boom" }), "error");
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.getAttribute("aria-busy")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // 3) Retry succeeds and closes even when success notify throws.
    mode = "ok";
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    await flush();
    expect(throwingNotify).toHaveBeenCalledWith(t("assistant-profile.name_saved"), "ok");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.getAttribute("aria-busy")).toBeNull();
    expectNoDefaultSingletons();

    // 4) Throwing formatError falls back safely to errorText without leaving busy stuck.
    await act(async () => root.render(
      <RenameAssistantDialog
        open
        onClose={onClose}
        manager={M_ONE}
        currentName="Alpha"
        deps={{
          scopeKey: "s2",
          renameManager: () => Promise.reject(new Error("fmt fallback")),
          notify: throwingNotify,
          formatError: () => { throw new Error("formatter boom"); },
          onError: throwingOnError,
        }}
      />,
    ));
    await setInput(activeDialog()!.querySelector("input")!, "Alpha Fallback");
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    await flush();
    expect(throwingNotify).toHaveBeenCalledWith(t("assistant-profile.name_failed", { error: "default-err:fmt fallback" }), "error");
    expect(activeDialog()!.querySelector("input")!.value).toBe("Alpha Fallback");
    expect(findButton(activeDialog()!, t("settings-managers.save"))?.getAttribute("aria-busy")).toBeNull();
  });

  it("preserves 100% backward-compatible default renameManager, errorText, and toast behavior when deps is omitted", async () => {
    const onClose = vi.fn();
    mocks.renameManager
      .mockRejectedValueOnce(new Error("server refused"))
      .mockResolvedValueOnce({ manager: { ...M_ONE, name: "Renamed" } });

    await act(async () => root.render(
      <RenameAssistantDialog open onClose={onClose} manager={M_ONE} currentName="Alpha" />,
    ));
    await setInput(activeDialog()!.querySelector("input")!, "  Renamed  ");

    // Failure path uses default renameManager, errorText, and toast, and keeps draft.
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    await flush();
    expect(mocks.renameManager).toHaveBeenCalledWith("m-1", "Renamed");
    expect(mocks.errorText).toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(t("assistant-profile.name_failed", { error: "default-err:server refused" }), "error");
    expect(onClose).not.toHaveBeenCalled();
    expect(activeDialog()!.querySelector("input")!.value).toBe("  Renamed  ");

    // Retry success calls default toast ok and onClose.
    await act(async () => { findButton(activeDialog()!, t("settings-managers.save"))!.click(); });
    await flush();
    expect(mocks.toast).toHaveBeenCalledWith(t("assistant-profile.name_saved"), "ok");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
