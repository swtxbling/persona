// @vitest-environment jsdom
// Controlled ComposeDialog tests: pure ComposeDialogView, singleton & module-map bypass, getter snapshot stability,
// direct-to-subscribed transitions, render purity across abandoned concurrent renders, owner-keyed draft retention &
// pending-restore ownership, scope/manager/draftKey/ABA/unmount fencing, sync throw & async reject try/finally recovery,
// and default fallback parity.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { MailAccount } from "../../lib/inbox";
import type { ComposeDraft } from "../../lib/mail";
import type { ComposeDialogDeps, ComposeDraftStore } from "./ComposeDialog";

const mocks = vi.hoisted(() => ({
  itemManager: "default-ctx-manager" as string | undefined,
  rosterDefault: "roster-default",
  useItemManager: vi.fn(),
  defaultManager: vi.fn(),
  sendMail: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/manager-choice", async (original) => {
  const real = await original<typeof import("../../lib/manager-choice")>();
  return {
    ...real,
    useItemManager: () => {
      mocks.useItemManager();
      return mocks.itemManager;
    },
    defaultManager: () => {
      mocks.defaultManager();
      return mocks.rosterDefault;
    },
  };
});

vi.mock("../../lib/mail", async (original) => {
  const real = await original<typeof import("../../lib/mail")>();
  return {
    ...real,
    sendMail: (draft: ComposeDraft, manager?: string) => mocks.sendMail(draft, manager),
  };
});

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  toast: (message: string, tone?: string) => mocks.toast(message, tone),
}));

const { ComposeDialog, ComposeDialogView } = await import("./ComposeDialog");

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const ACCOUNTS: MailAccount[] = [
  { id: "acc-1", name: "Primary", email: "primary@example.com" },
  { id: "acc-2", email: "secondary@example.com" },
];

const INITIAL: ComposeDraft = {
  accountID: "acc-1",
  to: "alice@example.com",
  cc: "",
  bcc: "",
  subject: "Initial subject",
  body: "Initial body",
};

const REPLY_INITIAL: ComposeDraft = {
  ...INITIAL,
  subject: "Re: Thread",
  inReplyTo: "<msg-1@example.com>",
  references: ["<msg-1@example.com>"],
};

const expectNoDefaultSingletons = () => {
  expect(mocks.useItemManager).not.toHaveBeenCalled();
  expect(mocks.defaultManager).not.toHaveBeenCalled();
  expect(mocks.sendMail).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
};

const activeDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const field = (name: "from" | "to" | "cc" | "bcc" | "subject" | "body") =>
  document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[aria-label="${t(`inbox-composedialog.${name}`)}"]`,
  )!;
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);

const setField = async (name: Parameters<typeof field>[0], value: string) => {
  const el = field(name);
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};

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
  mocks.itemManager = "default-ctx-manager";
  mocks.rosterDefault = "roster-default";
  mocks.useItemManager.mockReset();
  mocks.defaultManager.mockReset();
  mocks.sendMail.mockReset();
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

describe("Pure ComposeDialogView and renderView override", () => {
  it("renders ComposeDialogView directly and routes change/send/cancel/dismiss without touching singletons", async () => {
    const onChange = vi.fn();
    const onSend = vi.fn();
    const onCancel = vi.fn();
    const onDismiss = vi.fn();

    await act(async () => root.render(
      <ComposeDialogView
        title="Custom compose"
        draft={INITIAL}
        accounts={ACCOUNTS}
        sending={false}
        canSend
        error="Delivery warning"
        onChange={onChange}
        onSend={onSend}
        onCancel={onCancel}
        onDismiss={onDismiss}
      />,
    ));

    expect(activeDialog()?.textContent).toContain("Custom compose");
    expect(activeDialog()?.querySelector('[role="alert"]')?.textContent).toBe("Delivery warning");

    await setField("body", "Updated text");
    expect(onChange).toHaveBeenCalledWith({ body: "Updated text" });

    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(onSend).toHaveBeenCalledTimes(1);

    await act(async () => { button(t("common.cancel"))!.click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("supports custom renderView without mounting default singletons", async () => {
    const draftStore = new Map<string, ComposeDraft>();
    const rendered = vi.fn((props: Parameters<NonNullable<ComposeDialogDeps["renderView"]>>[0]) => (
      <div data-custom-compose>{props.title}:{props.draft.subject}</div>
    ));

    await act(async () => root.render(
      <ComposeDialog
        draftKey="custom-1"
        initial={REPLY_INITIAL}
        accounts={ACCOUNTS}
        onClose={() => {}}
        deps={{
          scopeKey: "s1",
          manager: "m-1",
          defaultManager: "d-1",
          draftStore,
          sendMail: vi.fn(),
          notify: vi.fn(),
          renderView: rendered,
        }}
      />,
    ));

    expect(host.querySelector("[data-custom-compose]")?.textContent).toBe(`${t("inbox-composedialog.title_reply")}:${REPLY_INITIAL.subject}`);
    expect(rendered).toHaveBeenCalled();
    expectNoDefaultSingletons();
  });
});

describe("Controlled ComposeDialog snapshot stability, bridge transitions, and isolated draft ownership", () => {
  it("preserves typed draft on direct-to-subscribed transitions and never churns subscriptions on inline arrow getters", async () => {
    const scopeListeners = new Set<() => void>();
    const managerListeners = new Set<() => void>();
    const draftStore = new Map<string, ComposeDraft>();
    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const subscribeManager = vi.fn((l: () => void) => { managerListeners.add(l); return () => { managerListeners.delete(l); }; });

    await act(async () => root.render(
      <StrictMode>
        <ComposeDialog
          draftKey="new"
          initial={INITIAL}
          accounts={ACCOUNTS}
          onClose={() => {}}
          deps={{
            scopeKey: "s1",
            manager: "m-1",
            defaultManager: "d-1",
            draftStore,
            sendMail: vi.fn(),
            notify: vi.fn(),
          }}
        />
      </StrictMode>,
    ));

    await setField("body", "Typed before bridge switch");
    expect(field("body").value).toBe("Typed before bridge switch");

    const renderSubscribed = () => root.render(
      <StrictMode>
        <ComposeDialog
          draftKey="new"
          initial={INITIAL}
          accounts={ACCOUNTS}
          onClose={() => {}}
          deps={{
            scopeKey: () => "s1",
            subscribeScopeKey,
            manager: () => "m-1",
            subscribeManager,
            defaultManager: () => "d-1",
            draftStore,
            sendMail: vi.fn(),
            notify: vi.fn(),
          }}
        />
      </StrictMode>,
    );

    await act(async () => renderSubscribed());
    expect(field("body").value).toBe("Typed before bridge switch");

    const scopeSubs = subscribeScopeKey.mock.calls.length;
    const managerSubs = subscribeManager.mock.calls.length;
    await act(async () => renderSubscribed());
    await act(async () => renderSubscribed());
    expect(subscribeScopeKey).toHaveBeenCalledTimes(scopeSubs);
    expect(subscribeManager).toHaveBeenCalledTimes(managerSubs);
    expectNoDefaultSingletons();
  });

  it("isolates draftStore and pending-restore ownership from module-level maps across cancel, dismiss, unmount, and failed send", async () => {
    const storeA: ComposeDraftStore & Map<string, ComposeDraft> = new Map();
    const storeB = new Map<string, ComposeDraft>();
    const onClose = vi.fn();

    // 1) Controlled edit + Escape dismiss retains in storeA only (not storeB or module-level kept).
    await act(async () => root.render(
      <ComposeDialog
        draftKey="shared-key"
        initial={INITIAL}
        accounts={ACCOUNTS}
        onClose={onClose}
        deps={{
          manager: "m-1",
          defaultManager: "d-1",
          draftStore: storeA,
          sendMail: vi.fn(),
          notify: vi.fn(),
        }}
      />,
    ));
    await setField("body", "Retained in storeA");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(storeA.size).toBe(1);
    expect(storeB.size).toBe(0);

    // Opening with storeB sees fresh INITIAL (proving isolation).
    await act(async () => root.render(null));
    await act(async () => root.render(
      <ComposeDialog
        draftKey="shared-key"
        initial={INITIAL}
        accounts={ACCOUNTS}
        onClose={onClose}
        deps={{
          manager: "m-1",
          defaultManager: "d-1",
          draftStore: storeB,
          sendMail: vi.fn(),
          notify: vi.fn(),
        }}
      />,
    ));
    expect(field("body").value).toBe(INITIAL.body);

    // 2) Reopen with storeA -> loads retained draft -> Cancel drops it.
    await act(async () => root.render(null));
    await act(async () => root.render(
      <ComposeDialog
        draftKey="shared-key"
        initial={INITIAL}
        accounts={ACCOUNTS}
        onClose={onClose}
        deps={{
          manager: "m-1",
          defaultManager: "d-1",
          draftStore: storeA,
          sendMail: vi.fn(),
          notify: vi.fn(),
        }}
      />,
    ));
    expect(field("body").value).toBe("Retained in storeA");
    await act(async () => { button(t("common.cancel"))!.click(); });
    expect(storeA.size).toBe(0);

    // 3) Failed offscreen send restores draft only if no newer opening took ownership.
    const send1 = deferred<void>();
    await act(async () => root.render(null));
    await act(async () => root.render(
      <ComposeDialog
        draftKey="shared-key"
        initial={INITIAL}
        accounts={ACCOUNTS}
        onClose={onClose}
        deps={{
          manager: "m-1",
          defaultManager: "d-1",
          draftStore: storeA,
          sendMail: () => send1.promise,
          notify: vi.fn(),
        }}
      />,
    ));
    await setField("body", "Offscreen fail draft 1");
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(storeA.size).toBe(0);
    await act(async () => root.render(null));
    await act(async () => {
      send1.reject(new Error("offline"));
      await Promise.resolve();
    });
    expect([...storeA.values()][0]?.body).toBe("Offscreen fail draft 1");

    // 4) Newer opening takes ownership before older send fails -> older failure must NOT overwrite newer draft/Cancel.
    const send2 = deferred<void>();
    await act(async () => root.render(
      <ComposeDialog
        draftKey="shared-key"
        initial={INITIAL}
        accounts={ACCOUNTS}
        onClose={onClose}
        deps={{
          manager: "m-1",
          defaultManager: "d-1",
          draftStore: storeA,
          sendMail: () => send2.promise,
          notify: vi.fn(),
        }}
      />,
    ));
    expect(field("body").value).toBe("Offscreen fail draft 1");
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    await act(async () => root.render(null));

    // Reopen before send2 rejects, and Cancel it.
    await act(async () => root.render(
      <ComposeDialog
        draftKey="shared-key"
        initial={INITIAL}
        accounts={ACCOUNTS}
        onClose={onClose}
        deps={{
          manager: "m-1",
          defaultManager: "d-1",
          draftStore: storeA,
          sendMail: vi.fn(),
          notify: vi.fn(),
        }}
      />,
    ));
    expect(field("body").value).toBe(INITIAL.body);
    await act(async () => { button(t("common.cancel"))!.click(); });
    await act(async () => root.render(null));

    // Now send2 rejects: must NOT restore into storeA.
    await act(async () => {
      send2.reject(new Error("late failure"));
      await Promise.resolve();
    });
    expect(storeA.size).toBe(0);
    expectNoDefaultSingletons();
  });

  it("treats controlled manager: undefined as controlled without calling useItemManager", async () => {
    const sendSpy = vi.fn(() => Promise.resolve());
    const notify = vi.fn();
    const onClose = vi.fn();
    await act(async () => root.render(
      <ComposeDialog
        draftKey="new"
        initial={INITIAL}
        accounts={ACCOUNTS}
        onClose={onClose}
        deps={{
          manager: undefined,
          defaultManager: "custom-default",
          draftStore: new Map(),
          sendMail: sendSpy,
          notify,
        }}
      />,
    ));

    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(sendSpy).toHaveBeenCalledWith(INITIAL, undefined, expect.any(AbortSignal));
    expect(notify).toHaveBeenCalledWith(t("inbox-composedialog.sent"), "ok");
    expect(onClose).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });
});

describe("Cross-scope, manager, draftKey, ABA, render-purity, and try/finally recovery", () => {
  it("aborts and fences in-flight sendMail across scope switch, ABA burst, manager switch, draftKey change, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    const managerListeners = new Set<() => void>();
    const draftStore = new Map<string, ComposeDraft>();
    let currentScope = "s1";
    let currentManager: string | undefined = "m-1";
    let currentDraftKey = "reply:1";
    const notify = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const sends: Array<{ draft: ComposeDraft; manager: string | undefined; signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];

    const renderControlled = () => root.render(
      <ComposeDialog
        draftKey={currentDraftKey}
        initial={INITIAL}
        accounts={ACCOUNTS}
        onClose={onClose}
        deps={{
          scopeKey: () => currentScope,
          subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
          manager: () => currentManager,
          subscribeManager: (l) => { managerListeners.add(l); return () => { managerListeners.delete(l); }; },
          defaultManager: "d-1",
          draftStore,
          sendMail: (draft, manager, signal) => {
            const gate = deferred<void>();
            sends.push({ draft, manager, signal, gate });
            return gate.promise;
          },
          notify,
          onError,
        }}
      />,
    );

    await act(async () => renderControlled());

    // 1) Start send in s1, then switch scope s1 -> s2.
    await setField("body", "Draft in s1");
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(sends).toHaveLength(1);
    expect(sends[0].signal.aborted).toBe(false);

    currentScope = "s2";
    await act(async () => { scopeListeners.forEach((l) => l()); });
    expect(sends[0].signal.aborted).toBe(true);
    expect(field("body").value).toBe(INITIAL.body);

    await act(async () => {
      sends[0].gate.resolve();
      await Promise.resolve();
    });
    expect(notify).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 2) Start send in s2, fire synchronous ABA scope burst s2 -> s3 -> s2.
    await setField("body", "Draft in s2 before ABA");
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(sends).toHaveLength(2);

    await act(async () => {
      currentScope = "s3";
      scopeListeners.forEach((l) => l());
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
    });
    expect(sends[1].signal.aborted).toBe(true);
    expect(field("body").value).toBe(INITIAL.body);

    // Late rejection from pre-ABA send must not restore over the active opening or show alert/onError.
    await act(async () => {
      sends[1].gate.reject(new Error("stale ABA failure"));
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();
    expect(activeDialog()?.querySelector('[role="alert"]')).toBeNull();
    expect(field("body").value).toBe(INITIAL.body);

    // 3) Start send under m-1, fire synchronous ABA manager burst m-1 -> m-2 -> m-1.
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(sends).toHaveLength(3);
    await act(async () => {
      currentManager = "m-2";
      managerListeners.forEach((l) => l());
      currentManager = "m-1";
      managerListeners.forEach((l) => l());
    });
    expect(sends[2].signal.aborted).toBe(true);
    await act(async () => {
      sends[2].gate.resolve();
      await Promise.resolve();
    });
    expect(notify).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 4) Change draftKey while sending -> aborts and fences previous send.
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(sends).toHaveLength(4);
    currentDraftKey = "reply:2";
    await act(async () => renderControlled());
    expect(sends[3].signal.aborted).toBe(true);
    await act(async () => {
      sends[3].gate.resolve();
      await Promise.resolve();
    });
    expect(notify).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 5) Unmount while sending aborts signal and fences late success.
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(sends).toHaveLength(5);
    await act(async () => root.render(null));
    expect(sends[4].signal.aborted).toBe(true);
    await act(async () => {
      sends[4].gate.resolve();
      await Promise.resolve();
    });
    expect(notify).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed draft and in-flight sendMail intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const sendGate = deferred<void>();
    const draftStore = new Map<string, ComposeDraft>();
    const notify = vi.fn();
    const onClose = vi.fn();
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
          <ComposeDialog
            draftKey="concurrent"
            initial={INITIAL}
            accounts={ACCOUNTS}
            onClose={onClose}
            deps={{
              scopeKey: state.scope,
              manager: "m-1",
              defaultManager: "d-1",
              draftStore,
              sendMail: (_d, _m, signal) => {
                capturedSignal = signal;
                return sendGate.promise;
              },
              notify,
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await setField("body", "Committed draft");
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(capturedSignal!.aborted).toBe(false);
    expect(button(t("inbox-composedialog.send"))?.getAttribute("aria-busy")).toBe("true");

    // Suspended concurrent transition to s2 must not abort s1's sendMail or corrupt committed state.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);
    expect(field("body").value).toBe("Committed draft");

    // Abandon transition back to s1; resolving sendGate completes cleanly.
    await act(async () => setHarness({ scope: "s1", block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => {
      sendGate.resolve();
      await Promise.resolve();
    });
    expect(notify).toHaveBeenCalledWith(t("inbox-composedialog.sent"), "ok");
    expect(onClose).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("releases sendLock and busy via try/finally on sync throw, async reject, and throwing notify/onClose/onError", async () => {
    const draftStore = new Map<string, ComposeDraft>();
    const notify = vi.fn(() => { throw new Error("notify boom"); });
    const onClose = vi.fn(() => { throw new Error("close boom"); });
    const onError = vi.fn(() => { throw new Error("onError boom"); });
    let mode: "sync-throw" | "async-reject" | "ok" = "sync-throw";
    const sendSpy = vi.fn(() => {
      if (mode === "sync-throw") throw new Error("sync boom");
      if (mode === "async-reject") return Promise.reject(new Error("async boom"));
      return Promise.resolve();
    });

    await act(async () => root.render(
      <ComposeDialog
        draftKey="recovery"
        initial={INITIAL}
        accounts={ACCOUNTS}
        onClose={onClose}
        deps={{
          scopeKey: "s1",
          manager: "m-1",
          defaultManager: "d-1",
          draftStore,
          sendMail: sendSpy,
          notify,
          formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
          onError,
        }}
      />,
    ));

    // Sync throw: releases lock, surfaces formatted error, calls onError (which throws without breaking recovery).
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(activeDialog()?.querySelector('[role="alert"]')?.textContent).toBe(t("inbox-composedialog.send_failed", { error: "fmt:sync boom" }));
    expect(button(t("inbox-composedialog.send"))?.getAttribute("aria-busy")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);

    // Async reject: releases lock and busy in finally, allows retry.
    mode = "async-reject";
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(activeDialog()?.querySelector('[role="alert"]')?.textContent).toBe(t("inbox-composedialog.send_failed", { error: "fmt:async boom" }));
    expect(button(t("inbox-composedialog.send"))?.getAttribute("aria-busy")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(2);

    // Success with throwing notify and throwing onClose: still clears busy and does not surface send_failed.
    mode = "ok";
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(activeDialog()?.querySelector('[role="alert"]')).toBeNull();
    expect(button(t("inbox-composedialog.send"))?.getAttribute("aria-busy")).toBeNull();
    expectNoDefaultSingletons();
  });

  it("preserves backward-compatible default manager, sendMail, and toast behavior when deps is omitted", async () => {
    mocks.sendMail.mockResolvedValue(undefined);
    const onClose = vi.fn();
    mocks.itemManager = undefined;
    await act(async () => root.render(
      <ComposeDialog draftKey="default-mode-implicit" initial={INITIAL} accounts={ACCOUNTS} onClose={onClose} />,
    ));

    expect(mocks.useItemManager).toHaveBeenCalled();
    expect(mocks.defaultManager).toHaveBeenCalled();
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(mocks.sendMail).toHaveBeenCalledWith(INITIAL, undefined);
    expect(mocks.toast).toHaveBeenCalledWith(t("inbox-composedialog.sent"), "ok");
    expect(onClose).toHaveBeenCalledTimes(1);

    mocks.itemManager = "default-ctx-manager";
    await act(async () => root.render(
      <ComposeDialog draftKey="default-mode-explicit" initial={INITIAL} accounts={ACCOUNTS} onClose={onClose} />,
    ));
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(mocks.sendMail).toHaveBeenCalledWith(INITIAL, "default-ctx-manager");
  });

  it("still shows the default Sent toast if Cancel, Esc, or unmount happens while default sendMail is in flight", async () => {
    for (const closeVia of ["cancel", "esc", "unmount"] as const) {
      mocks.sendMail.mockReset();
      mocks.toast.mockReset();
      mocks.itemManager = undefined;
      const pending = deferred<void>();
      mocks.sendMail.mockReturnValueOnce(pending.promise);
      const onClose = vi.fn();

      await act(async () => root.render(
        <ComposeDialog
          draftKey={`default-mid-send-${closeVia}`}
          initial={INITIAL}
          accounts={ACCOUNTS}
          onClose={onClose}
        />,
      ));

      await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
      expect(mocks.sendMail).toHaveBeenCalledTimes(1);

      if (closeVia === "cancel") {
        await act(async () => { button(t("common.cancel"))!.click(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        await act(async () => root.render(null));
      } else if (closeVia === "esc") {
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        await act(async () => root.render(null));
      } else {
        await act(async () => root.render(null));
      }

      await act(async () => {
        pending.resolve(undefined);
        await pending.promise;
      });
      expect(mocks.toast).toHaveBeenCalledWith(t("inbox-composedialog.sent"), "ok");
      if (closeVia !== "unmount") expect(onClose).toHaveBeenCalledTimes(1);
      else expect(onClose).not.toHaveBeenCalled();
    }
  });

  it("restores the unsent draft when default sendMail fails after Cancel closed the dialog mid-send", async () => {
    mocks.sendMail.mockReset();
    mocks.toast.mockReset();
    mocks.itemManager = undefined;
    const pending = deferred<void>();
    mocks.sendMail.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();

    await act(async () => root.render(
      <ComposeDialog draftKey="default-cancel-fail-restore" initial={INITIAL} accounts={ACCOUNTS} onClose={onClose} />,
    ));

    const bodyEl = activeDialog()!.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(bodyEl, "Probe body");
      bodyEl.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button(t("inbox-composedialog.send"))!.click(); });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);

    await act(async () => { button(t("common.cancel"))!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));

    await act(async () => {
      pending.reject(new Error("smtp down"));
      await pending.promise.catch(() => {});
    });

    // Reopen the same draftKey: the unsent text must be restored rather than lost.
    await act(async () => root.render(
      <ComposeDialog draftKey="default-cancel-fail-restore" initial={INITIAL} accounts={ACCOUNTS} onClose={onClose} />,
    ));
    const reopenedBody = (activeDialog()!.querySelector("textarea") as HTMLTextAreaElement).value;
    expect(reopenedBody).toBe("Probe body");
    // Drop the restored draft via Cancel when idle so module state stays clean.
    await act(async () => { button(t("common.cancel"))!.click(); });
    await act(async () => root.render(null));
  });
});
