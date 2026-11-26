// @vitest-environment jsdom
// Controlled PolicyDialog, PolicyDialogHost, and RulesDialog tests: pure *View components, singleton bypass,
// fresh-object/array getter snapshot caching, direct-to-subscribed transitions, render purity across abandoned
// concurrent renders, cross-scope/target/manager/editing/ABA/unmount fencing, busy dismissal blocking,
// sync throw & async reject try/finally recovery, and default fallback parity.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { InboxItem, InboxPolicy } from "../../lib/inbox";
import type { Manager } from "../../lib/managers";
import type { PolicyDialogDeps, PolicyTarget, RulesDialogDeps } from "./PolicyDialog";

const mocks = vi.hoisted(() => ({
  scopeManager: null as Manager | null,
  useScope: vi.fn(),
  otherManager: vi.fn((owner?: string) => owner),
  listInboxPolicies: vi.fn(),
  saveInboxPolicy: vi.fn(),
  removeInboxPolicy: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/current-assistant", async (original) => {
  const real = await original<typeof import("../../lib/current-assistant")>();
  return {
    ...real,
    useScope: () => {
      mocks.useScope();
      return {
        several: Boolean(mocks.scopeManager),
        id: mocks.scopeManager?.id ?? "assistant",
        manager: mocks.scopeManager,
        has: () => true,
      };
    },
  };
});

vi.mock("../../lib/manager-choice", async (original) => {
  const real = await original<typeof import("../../lib/manager-choice")>();
  return {
    ...real,
    otherManager: (owner?: string) => mocks.otherManager(owner),
  };
});

vi.mock("../../lib/inbox", async (original) => {
  const real = await original<typeof import("../../lib/inbox")>();
  return {
    ...real,
    saveInboxPolicy: (...args: unknown[]) => mocks.saveInboxPolicy(...args),
  };
});

vi.mock("../../lib/inbox-page", async (original) => {
  const real = await original<typeof import("../../lib/inbox-page")>();
  return {
    ...real,
    listInboxPolicies: (...args: unknown[]) => mocks.listInboxPolicies(...args),
    removeInboxPolicy: (policy: Pick<InboxPolicy, "id" | "manager">) => mocks.removeInboxPolicy(policy),
  };
});

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  toast: (message: string, tone?: string) => mocks.toast(message, tone),
}));

const {
  openPolicyDialog,
  PolicyDialog,
  PolicyDialogHost,
  PolicyDialogView,
  RulesDialog,
  RulesDialogView,
} = await import("./PolicyDialog");

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const CHAT_A = { tag: "chat", value: "c1", name: "Alpha Chat" };
const CHAT_B = { tag: "chat", value: "c2", name: "Beta Chat" };
const ITEM_A: InboxItem = {
  id: "lark:c1:1",
  source: "lark",
  kind: "group",
  account: "lark",
  account_name: "Lark",
  title: "Alpha Chat",
  preview: "",
  count: 1,
  tier: "fyi",
  manager: "m-1",
  mutes: [CHAT_A],
};

const POLICY_A: InboxPolicy = {
  id: "p1",
  source: "lark",
  source_name: "Lark",
  tag: "chat",
  value: "c1",
  name: "Alpha Chat",
  tier: "fyi",
  twin: "first",
  manager: "m-1",
};

const POLICY_B: InboxPolicy = {
  id: "p2",
  source: "lark",
  source_name: "Lark",
  tag: "chat",
  value: "c2",
  name: "Beta Chat",
  tier: "noise",
  manager: "m-2",
};

const MANAGER_1: Manager = { id: "m-1", name: "Work", online: true };
const MANAGER_2: Manager = { id: "m-2", name: "Home", online: false };

const TARGET_A: PolicyTarget = { item: ITEM_A, option: CHAT_A, source: "lark", policy: POLICY_A };
const TARGET_B: PolicyTarget = { option: CHAT_B, source: "lark", policy: POLICY_B };
const TARGET_UNLOADED: PolicyTarget = { item: ITEM_A, option: CHAT_A, source: "lark" };

const expectNoDefaultSingletons = () => {
  expect(mocks.useScope).not.toHaveBeenCalled();
  expect(mocks.otherManager).not.toHaveBeenCalled();
  expect(mocks.listInboxPolicies).not.toHaveBeenCalled();
  expect(mocks.saveInboxPolicy).not.toHaveBeenCalled();
  expect(mocks.removeInboxPolicy).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
};

const activeDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  mocks.scopeManager = null;
  mocks.useScope.mockReset();
  mocks.otherManager.mockClear();
  mocks.listInboxPolicies.mockReset();
  mocks.saveInboxPolicy.mockReset();
  mocks.removeInboxPolicy.mockReset();
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

describe("Pure PolicyDialogView, RulesDialogView, and renderView overrides", () => {
  it("renders PolicyDialogView and RulesDialogView directly without touching singletons", async () => {
    const onTierChange = vi.fn();
    const onTwinChange = vi.fn();
    const onSave = vi.fn();
    const onRemove = vi.fn();
    const onClose = vi.fn();

    await act(async () => root.render(
      <PolicyDialogView
        target={TARGET_A}
        policy={POLICY_A}
        loaded
        tier="fyi"
        twin="first"
        busy={false}
        error="Save rejected"
        onTierChange={onTierChange}
        onTwinChange={onTwinChange}
        onSave={onSave}
        onRemove={onRemove}
        onClose={onClose}
      />,
    ));

    expect(activeDialog()?.querySelector('[role="alert"]')?.textContent).toBe("Save rejected");
    await act(async () => { button(t("inbox-policydialog.save"))!.click(); });
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(onRemove).toHaveBeenCalledTimes(1);
    await act(async () => { button(t("inbox-policydialog.cancel"))!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);

    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const onRuleRemove = vi.fn();
    await act(async () => root.render(
      <RulesDialogView
        managersMode={false}
        list={[POLICY_A]}
        groups={null}
        failed=""
        busyKey={null}
        onRetry={onRetry}
        onEdit={onEdit}
        onRemove={onRuleRemove}
        onClose={onClose}
      />,
    ));

    expect(document.querySelector('[data-policy="p1"]')?.textContent).toContain("Alpha Chat");
    await act(async () => { button(t("inbox-policydialog.edit"))!.click(); });
    expect(onEdit).toHaveBeenCalledWith(POLICY_A);
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(onRuleRemove).toHaveBeenCalledWith(POLICY_A);
    expectNoDefaultSingletons();
  });

  it("supports custom renderView on PolicyDialog and RulesDialog", async () => {
    await act(async () => root.render(
      <PolicyDialog
        deps={{
          scopeKey: "s1",
          target: TARGET_A,
          closeTarget: vi.fn(),
          savePolicy: vi.fn(),
          renderView: (props) => <div data-policy-custom>{props.target.option.name}:{props.tier}</div>,
        }}
      />,
    ));
    expect(host.querySelector("[data-policy-custom]")?.textContent).toBe("Alpha Chat:fyi");

    await act(async () => root.render(
      <RulesDialog
        onClose={() => {}}
        deps={{
          scopeKey: "s1",
          manager: null,
          editing: null,
          listPolicies: () => [POLICY_A],
          removePolicy: vi.fn(),
          openPolicyDialog: vi.fn(),
          notify: vi.fn(),
          renderView: (props) => <div data-rules-custom>{props.list?.length ?? -1}</div>,
        }}
      />,
    ));
    expect(host.querySelector("[data-rules-custom]")?.textContent).toBe("1");
    expectNoDefaultSingletons();
  });
});

describe("Controlled PolicyDialog and PolicyDialogHost", () => {
  it("preserves selections across direct-to-subscribed fresh-object getters without subscription churn", async () => {
    const scopeListeners = new Set<() => void>();
    const targetListeners = new Set<() => void>();
    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const subscribeTarget = vi.fn((l: () => void) => { targetListeners.add(l); return () => { targetListeners.delete(l); }; });

    await act(async () => root.render(
      <StrictMode>
        <PolicyDialogHost
          deps={{
            scopeKey: "s1",
            target: TARGET_A,
            closeTarget: vi.fn(),
            savePolicy: vi.fn(),
          }}
        />
      </StrictMode>,
    ));

    // Change tier to "action" before switching to subscribed getter.
    await act(async () => { button(t("lib-inbox-page.policy_tier_action"))!.click(); });
    expect(button(t("lib-inbox-page.policy_tier_action"))?.getAttribute("aria-checked")).toBe("true");

    const renderSub = () => root.render(
      <StrictMode>
        <PolicyDialogHost
          deps={{
            scopeKey: () => "s1",
            subscribeScopeKey,
            target: () => ({
              ...TARGET_A,
              option: { ...TARGET_A.option },
              policy: TARGET_A.policy ? { ...TARGET_A.policy } : undefined,
            }),
            subscribeTarget,
            closeTarget: vi.fn(),
            savePolicy: vi.fn(),
          }}
        />
      </StrictMode>,
    );

    await act(async () => renderSub());
    expect(button(t("lib-inbox-page.policy_tier_action"))?.getAttribute("aria-checked")).toBe("true");

    const scopeSubs = subscribeScopeKey.mock.calls.length;
    const targetSubs = subscribeTarget.mock.calls.length;
    await act(async () => renderSub());
    await act(async () => renderSub());
    expect(subscribeScopeKey).toHaveBeenCalledTimes(scopeSubs);
    expect(subscribeTarget).toHaveBeenCalledTimes(targetSubs);
    expectNoDefaultSingletons();
  });

  it("blocks dismissal during in-flight save/remove and fences across scope, target, ABA, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    const targetListeners = new Set<() => void>();
    let currentScope = "s1";
    let currentTarget: PolicyTarget | null = TARGET_A;
    const closeTarget = vi.fn();
    const notify = vi.fn();
    const onError = vi.fn();

    const saveCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<InboxPolicy | null>> }> = [];
    const removeCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<boolean>> }> = [];
    const loadCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<InboxPolicy[]>> }> = [];

    const makeDeps = (): PolicyDialogDeps => ({
      scopeKey: () => currentScope,
      subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
      target: () => currentTarget,
      subscribeTarget: (l) => { targetListeners.add(l); return () => { targetListeners.delete(l); }; },
      closeTarget,
      listPolicies: (_m, signal) => {
        const gate = deferred<InboxPolicy[]>();
        loadCalls.push({ signal, gate });
        return gate.promise;
      },
      savePolicy: (_req, _tier, _twin, signal) => {
        const gate = deferred<InboxPolicy | null>();
        saveCalls.push({ signal, gate });
        return gate.promise;
      },
      removePolicy: (_req, signal) => {
        const gate = deferred<boolean>();
        removeCalls.push({ signal, gate });
        return gate.promise;
      },
      notify,
      onError,
    });

    await act(async () => root.render(<PolicyDialog deps={makeDeps()} />));

    // 1) Start save -> dismissal (Cancel & Escape) is blocked while busy.
    await act(async () => { button(t("inbox-policydialog.save"))!.click(); });
    expect(saveCalls).toHaveLength(1);
    expect(button(t("inbox-policydialog.cancel"))?.disabled).toBe(true);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(closeTarget).not.toHaveBeenCalled();

    // Switch scope s1 -> s2 aborts save and fences late resolve.
    currentScope = "s2";
    await act(async () => { scopeListeners.forEach((l) => l()); });
    expect(saveCalls[0].signal.aborted).toBe(true);
    await act(async () => {
      saveCalls[0].gate.resolve(POLICY_A);
      await Promise.resolve();
    });
    expect(closeTarget).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    // 2) Start remove -> synchronous ABA target burst TARGET_A -> TARGET_B -> TARGET_A aborts & fences remove.
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(removeCalls).toHaveLength(1);
    await act(async () => {
      currentTarget = TARGET_B;
      targetListeners.forEach((l) => l());
      currentTarget = TARGET_A;
      targetListeners.forEach((l) => l());
    });
    expect(removeCalls[0].signal.aborted).toBe(true);
    await act(async () => {
      removeCalls[0].gate.reject(new Error("stale remove"));
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();
    expect(activeDialog()?.querySelector('[role="alert"]')).toBeNull();

    // 3) Unloaded target triggers listPolicies -> switching target to null aborts load and renders null.
    currentTarget = TARGET_UNLOADED;
    await act(async () => { targetListeners.forEach((l) => l()); });
    expect(loadCalls).toHaveLength(1);
    currentTarget = null;
    await act(async () => { targetListeners.forEach((l) => l()); });
    expect(loadCalls[0].signal.aborted).toBe(true);
    expect(activeDialog()).toBeNull();
    await act(async () => {
      loadCalls[0].gate.resolve([POLICY_A]);
      await Promise.resolve();
    });
    expect(activeDialog()).toBeNull();

    // 4) Unmount aborts active save and discards late rejection.
    currentTarget = TARGET_A;
    await act(async () => { targetListeners.forEach((l) => l()); });
    await act(async () => { button(t("inbox-policydialog.save"))!.click(); });
    expect(saveCalls).toHaveLength(2);
    await act(async () => root.render(null));
    expect(saveCalls[1].signal.aborted).toBe(true);
    await act(async () => {
      saveCalls[1].gate.reject(new Error("unmounted save"));
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed PolicyDialog selections and in-flight save intact across an abandoned concurrent transition", async () => {
    const suspendGate = deferred<void>();
    const saveGate = deferred<InboxPolicy>();
    const closeTarget = vi.fn();
    const notify = vi.fn();
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
          <PolicyDialog
            deps={{
              scopeKey: state.scope,
              target: TARGET_A,
              closeTarget,
              savePolicy: (_req, _tier, _twin, signal) => {
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
    await act(async () => { button(t("inbox-policydialog.save"))!.click(); });
    expect(capturedSignal!.aborted).toBe(false);

    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);

    await act(async () => setHarness({ scope: "s1", block: false }));
    await act(async () => {
      saveGate.resolve(POLICY_A);
      await Promise.resolve();
    });
    expect(notify).toHaveBeenCalledWith(t("lib-inbox.policy_saved", { name: TARGET_A.option.name }), "ok");
    expect(closeTarget).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("recovers busy via try/finally on sync throw, async reject, and throwing notify/closeTarget/onError", async () => {
    const notify = vi.fn(() => { throw new Error("notify failed"); });
    const closeTarget = vi.fn(() => { throw new Error("close failed"); });
    const onError = vi.fn(() => { throw new Error("onError failed"); });
    let saveMode: "sync" | "async" | "ok" = "sync";
    let removeMode: "async" | "ok" = "async";

    await act(async () => root.render(
      <PolicyDialog
        deps={{
          scopeKey: "s1",
          target: TARGET_A,
          closeTarget,
          savePolicy: () => {
            if (saveMode === "sync") throw new Error("sync save");
            if (saveMode === "async") return Promise.reject(new Error("async save"));
            return Promise.resolve(POLICY_A);
          },
          removePolicy: () => (removeMode === "async" ? Promise.reject(new Error("async remove")) : Promise.resolve(true)),
          notify,
          formatError: (e) => `p:${e instanceof Error ? e.message : String(e)}`,
          onError,
        }}
      />,
    ));

    // Sync throw -> error shown, busy false, dismissal enabled.
    await act(async () => { button(t("inbox-policydialog.save"))!.click(); });
    expect(activeDialog()?.querySelector('[role="alert"]')?.textContent).toBe("p:sync save");
    expect(button(t("inbox-policydialog.cancel"))?.disabled).toBe(false);

    // Async reject -> busy cleared in finally.
    saveMode = "async";
    await act(async () => { button(t("inbox-policydialog.save"))!.click(); });
    expect(activeDialog()?.querySelector('[role="alert"]')?.textContent).toBe("p:async save");
    expect(button(t("inbox-policydialog.save"))?.getAttribute("aria-busy")).toBeNull();

    // Remove async reject -> busy cleared in finally, then succeeds even when notify & closeTarget throw.
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(activeDialog()?.querySelector('[role="alert"]')?.textContent).toBe("p:async remove");
    expect(button(t("inbox-policydialog.remove"))?.disabled).toBe(false);

    removeMode = "ok";
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(notify).toHaveBeenCalledWith(t("lib-inbox.policy_removed", { name: TARGET_A.option.name }), "ok");
    expect(closeTarget).toHaveBeenCalledTimes(1);
    expect(button(t("inbox-policydialog.save"))?.getAttribute("aria-busy")).toBeNull();
    expectNoDefaultSingletons();
  });
});

describe("Controlled RulesDialog", () => {
  it("loads single-assistant and per-manager rules, caches fresh-object getters, and fences loads/removes across scope, manager, editing, ABA, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    const managerListeners = new Set<() => void>();
    const editingListeners = new Set<() => void>();
    let currentScope = "s1";
    let currentManager: Manager | null = null;
    let currentEditing: PolicyTarget | null = null;
    const notify = vi.fn();
    const onError = vi.fn();
    const openEdit = vi.fn();

    const loadCalls: Array<{ manager: string | undefined; signal: AbortSignal; gate: ReturnType<typeof deferred<InboxPolicy[]>> }> = [];
    const removeCalls: Array<{ policy: InboxPolicy; signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];

    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const subscribeManager = vi.fn((l: () => void) => { managerListeners.add(l); return () => { managerListeners.delete(l); }; });
    const subscribeEditing = vi.fn((l: () => void) => { editingListeners.add(l); return () => { editingListeners.delete(l); }; });

    const makeDeps = (): RulesDialogDeps => ({
      scopeKey: () => currentScope,
      subscribeScopeKey,
      manager: () => (currentManager ? { ...currentManager } : null),
      subscribeManager,
      editing: () => (currentEditing ? { ...currentEditing } : null),
      subscribeEditing,
      listPolicies: (manager, signal) => {
        const gate = deferred<InboxPolicy[]>();
        loadCalls.push({ manager, signal, gate });
        return gate.promise;
      },
      removePolicy: (policy, signal) => {
        const gate = deferred<void>();
        removeCalls.push({ policy, signal, gate });
        return gate.promise;
      },
      openPolicyDialog: openEdit,
      notify,
      onError,
    });

    await act(async () => root.render(<StrictMode><RulesDialog onClose={() => {}} deps={makeDeps()} /></StrictMode>));
    // StrictMode runs effect twice; aborting first and keeping last.
    const initialLoad = loadCalls.at(-1)!;
    expect(initialLoad.manager).toBeUndefined();
    await act(async () => {
      initialLoad.gate.resolve([POLICY_A]);
      await Promise.resolve();
    });
    expect(document.querySelector('[data-policy="p1"]')?.textContent).toContain("Alpha Chat");

    // Re-rendering with fresh inline arrow getters must not churn subscriptions or reload.
    const loadCountBeforeRerender = loadCalls.length;
    const scopeSubs = subscribeScopeKey.mock.calls.length;
    const mgrSubs = subscribeManager.mock.calls.length;
    const editSubs = subscribeEditing.mock.calls.length;
    await act(async () => root.render(<StrictMode><RulesDialog onClose={() => {}} deps={makeDeps()} /></StrictMode>));
    expect(loadCalls).toHaveLength(loadCountBeforeRerender);
    expect(subscribeScopeKey).toHaveBeenCalledTimes(scopeSubs);
    expect(subscribeManager).toHaveBeenCalledTimes(mgrSubs);
    expect(subscribeEditing).toHaveBeenCalledTimes(editSubs);

    // Edit delegates to controlled openPolicyDialog.
    await act(async () => { button(t("inbox-policydialog.edit"))!.click(); });
    expect(openEdit).toHaveBeenCalledWith({ option: POLICY_A, source: POLICY_A.source, policy: POLICY_A });

    // Start remove, then switch to editing=TARGET_A -> hides dialog, aborts remove, fences stale resolve.
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(removeCalls).toHaveLength(1);
    currentEditing = TARGET_A;
    await act(async () => { editingListeners.forEach((l) => l()); });
    expect(activeDialog()).toBeNull();
    expect(removeCalls[0].signal.aborted).toBe(true);
    await act(async () => {
      removeCalls[0].gate.resolve();
      await Promise.resolve();
    });
    expect(notify).not.toHaveBeenCalled();

    // Closing editing reloads cleanly; switch to per-manager mode (MANAGER_1 online, then MANAGER_2 offline error).
    currentEditing = null;
    currentManager = MANAGER_1;
    await act(async () => {
      editingListeners.forEach((l) => l());
      managerListeners.forEach((l) => l());
    });
    const m1Load = loadCalls.at(-1)!;
    expect(m1Load.manager).toBe("m-1");
    await act(async () => {
      m1Load.gate.resolve([POLICY_A]);
      await Promise.resolve();
    });
    expect(document.querySelector('[data-rules-manager="m-1"]')?.textContent).toContain("Alpha Chat");

    // Switch to offline MANAGER_2 -> error displays offline copy, not generic failure.
    currentManager = MANAGER_2;
    await act(async () => { managerListeners.forEach((l) => l()); });
    const m2Load = loadCalls.at(-1)!;
    expect(m2Load.manager).toBe("m-2");
    await act(async () => {
      m2Load.gate.reject(new Error("unreachable"));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-rules-manager="m-2"]')?.textContent).toContain(t("inbox-policydialog.rules_offline"));

    // Synchronous ABA manager burst m-2 -> m-1 -> m-2 aborts in-flight load and ignores stale resolve.
    currentManager = MANAGER_1;
    await act(async () => { managerListeners.forEach((l) => l()); });
    const preAbaLoad = loadCalls.at(-1)!;
    await act(async () => {
      currentManager = MANAGER_2;
      managerListeners.forEach((l) => l());
      currentManager = MANAGER_1;
      managerListeners.forEach((l) => l());
    });
    expect(preAbaLoad.signal.aborted).toBe(true);
    await act(async () => {
      preAbaLoad.gate.resolve([POLICY_B]);
      await Promise.resolve();
    });
    expect(document.querySelector('[data-policy="p2"]')).toBeNull();

    // Scope switch aborts active load and unmount aborts active remove.
    const postAbaLoad = loadCalls.at(-1)!;
    currentScope = "s2";
    await act(async () => { scopeListeners.forEach((l) => l()); });
    expect(postAbaLoad.signal.aborted).toBe(true);

    const s2Load = loadCalls.at(-1)!;
    await act(async () => {
      s2Load.gate.resolve([POLICY_A]);
      await Promise.resolve();
    });
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(removeCalls).toHaveLength(2);
    await act(async () => root.render(null));
    expect(removeCalls[1].signal.aborted).toBe(true);
    await act(async () => {
      removeCalls[1].gate.reject(new Error("unmounted remove"));
      await Promise.resolve();
    });
    expect(notify).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed RulesDialog list and in-flight remove intact across an abandoned concurrent transition", async () => {
    const suspendGate = deferred<void>();
    const removeGate = deferred<void>();
    const notify = vi.fn();
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
          <RulesDialog
            onClose={() => {}}
            deps={{
              scopeKey: state.scope,
              manager: null,
              editing: null,
              listPolicies: () => [POLICY_A],
              removePolicy: (_p, signal) => {
                capturedSignal = signal;
                return removeGate.promise;
              },
              openPolicyDialog: vi.fn(),
              notify,
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    expect(document.querySelector('[data-policy="p1"]')).not.toBeNull();
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(capturedSignal!.aborted).toBe(false);

    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);

    await act(async () => setHarness({ scope: "s1", block: false }));
    await act(async () => {
      removeGate.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-policy="p1"]')).toBeNull();
    expect(notify).toHaveBeenCalledWith(t("inbox-policydialog.removed", { name: POLICY_A.name }), "ok");
    expectNoDefaultSingletons();
  });

  it("recovers busy via try/finally on sync throw, async reject, and throwing notify/onError in RulesDialog", async () => {
    const notify = vi.fn(() => { throw new Error("notify crash"); });
    const onError = vi.fn(() => { throw new Error("onError crash"); });
    let listShouldFail = true;
    let removeMode: "sync" | "async" | "ok" = "sync";

    await act(async () => root.render(
      <RulesDialog
        onClose={() => {}}
        deps={{
          scopeKey: "s1",
          manager: null,
          editing: null,
          listPolicies: () => (listShouldFail ? Promise.reject(new Error("load boom")) : Promise.resolve([POLICY_A])),
          removePolicy: () => {
            if (removeMode === "sync") throw new Error("sync rm");
            if (removeMode === "async") return Promise.reject(new Error("async rm"));
            return Promise.resolve();
          },
          openPolicyDialog: vi.fn(),
          notify,
          formatError: (e) => `r:${e instanceof Error ? e.message : String(e)}`,
          onError,
        }}
      />,
    ));

    // Initial load failure -> Retry recovers.
    expect(activeDialog()?.textContent).toContain("r:load boom");
    listShouldFail = false;
    await act(async () => { button(t("inbox-policydialog.retry"))!.click(); });
    expect(document.querySelector('[data-policy="p1"]')).not.toBeNull();

    // Sync throw remove -> releases lock, reports error.
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(button(t("inbox-policydialog.remove"))?.getAttribute("aria-busy")).toBeNull();

    // Async reject remove -> releases busy in finally even when notify/onError throw.
    removeMode = "async";
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(button(t("inbox-policydialog.remove"))?.getAttribute("aria-busy")).toBeNull();

    // Retry succeeds and removes row from list.
    removeMode = "ok";
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(document.querySelector('[data-policy="p1"]')).toBeNull();
    expectNoDefaultSingletons();
  });

  it("preserves backward-compatible default singleton behavior for PolicyDialogHost and RulesDialog when deps is omitted", async () => {
    mocks.listInboxPolicies.mockResolvedValue([POLICY_A]);
    mocks.saveInboxPolicy.mockResolvedValue(POLICY_A);
    mocks.removeInboxPolicy.mockResolvedValue(undefined);

    await act(async () => root.render(<PolicyDialogHost />));
    expect(activeDialog()).toBeNull();

    await act(async () => openPolicyDialog(TARGET_A));
    expect(activeDialog()).not.toBeNull();
    await act(async () => { button(t("inbox-policydialog.save"))!.click(); });
    expect(mocks.saveInboxPolicy).toHaveBeenCalledTimes(1);
    expect(activeDialog()).toBeNull();

    await act(async () => root.render(<RulesDialog onClose={() => {}} />));
    expect(mocks.useScope).toHaveBeenCalled();
    expect(mocks.listInboxPolicies).toHaveBeenCalledWith();
    expect(document.querySelector('[data-policy="p1"]')).not.toBeNull();
    await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
    expect(mocks.removeInboxPolicy).toHaveBeenCalledWith(POLICY_A);
    expect(mocks.toast).toHaveBeenCalledWith(t("inbox-policydialog.removed", { name: POLICY_A.name }), "ok");
  });

  it("still shows default removed and remove_failed toasts when RulesDialog closes while removeInboxPolicy is in flight", async () => {
    for (const outcome of ["ok", "fail"] as const) {
      mocks.listInboxPolicies.mockReset();
      mocks.removeInboxPolicy.mockReset();
      mocks.toast.mockReset();
      mocks.scopeManager = null;

      mocks.listInboxPolicies.mockResolvedValue([POLICY_A]);
      const pending = deferred<void>();
      mocks.removeInboxPolicy.mockReturnValueOnce(pending.promise);
      const onClose = vi.fn();

      await act(async () => root.render(<RulesDialog onClose={onClose} />));
      await act(async () => {});

      await act(async () => { button(t("inbox-policydialog.remove"))!.click(); });
      expect(mocks.removeInboxPolicy).toHaveBeenCalledWith(POLICY_A);

      // Unmount RulesDialog while the non-abortable default removal is still in flight.
      await act(async () => root.render(null));

      if (outcome === "ok") {
        await act(async () => {
          pending.resolve(undefined);
          await pending.promise;
        });
        expect(mocks.toast).toHaveBeenCalledWith(t("inbox-policydialog.removed", { name: POLICY_A.name }), "ok");
      } else {
        await act(async () => {
          pending.reject(new Error("delete failed"));
          await pending.promise.catch(() => {});
        });
        expect(mocks.toast).toHaveBeenCalledWith(t("inbox-policydialog.remove_failed", { error: "delete failed" }), "error");
      }
    }
  });
});
