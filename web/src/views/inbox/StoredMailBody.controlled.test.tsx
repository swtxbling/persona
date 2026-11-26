// @vitest-environment jsdom
// Controlled StoredMailBody bypasses api, translateMail, useTranslatePrefs, and clock singletons,
// caches getter translatePrefs without subscription churn, preserves render purity across abandoned concurrent renders,
// aborts and fences item + translation fetches across scopeKey, item, version, manager, prefs.target, ABA bursts,
// and unmount, recovers cleanly via try/finally, and keeps default fallbacks compatible.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "../../lib/inbox";
import type { MailTranslation, TranslatePrefs } from "../../lib/translate";
import type { StoredMailBodyDeps } from "./StoredMailBody";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  clock: vi.fn((iso?: string) => `default-clock:${iso ?? ""}`),
  translateMail: vi.fn(),
  useTranslatePrefs: vi.fn(),
}));

vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  api: (...args: unknown[]) => mocks.api(...args),
}));
vi.mock("../../lib/format", async (original) => ({
  ...(await original<typeof import("../../lib/format")>()),
  clock: (iso?: string) => mocks.clock(iso),
}));
vi.mock("../../lib/translate", async (original) => ({
  ...(await original<typeof import("../../lib/translate")>()),
  translateMail: (...args: unknown[]) => mocks.translateMail(...args),
  useTranslatePrefs: () => mocks.useTranslatePrefs(),
}));

const { StoredMailBody, StoredMailBodyView } = await import("./StoredMailBody");
const { itemPath, itemRequest } = await import("../../lib/inbox");
const { initI18n, t } = await import("../../i18n");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createExternalBox<T>(initial: T) {
  let current = initial;
  const listeners = new Set<() => void>();
  let subscribeCount = 0;
  return {
    get: () => current,
    set: (next: T) => {
      current = next;
      listeners.forEach((l) => l());
    },
    notify: () => {
      listeners.forEach((l) => l());
    },
    subscribe: (listener: () => void) => {
      subscribeCount += 1;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get subscribeCount() {
      return subscribeCount;
    },
  };
}

const makeMailItem = (id: string, patch: Partial<InboxItem> = {}): InboxItem => ({
  id,
  source: "mail",
  kind: "mail",
  account: "acct-1",
  account_name: "me@example.com",
  title: `Subject ${id}`,
  sender: "Ana",
  preview: `Preview ${id}`,
  count: 1,
  tier: "action",
  updated_at: "2026-11-20T09:00:00Z",
  version: "v1",
  mail: {
    account_id: "acct-1",
    mailbox: "INBOX",
    uids: [101],
    from: { name: "Ana", email: "ana@example.com" },
  },
  ...patch,
});

const makePrefs = (patch: Partial<TranslatePrefs> = {}): TranslatePrefs => ({
  enabled: false,
  target: "zh-Hans",
  mail: true,
  chats: [],
  ...patch,
});

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
const storedText = () => host.querySelector("[data-mail-stored-text]")?.textContent ?? "";
const noticeEl = () => host.querySelector("[data-mail-off-notice]");
const toggleButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(
  (b) => b.textContent?.trim() === t("inbox-inboxbodies.show_original") || b.textContent?.trim() === t("inbox-inboxbodies.show_translation"),
) ?? null;

const expectNoDefaultSingletons = () => {
  expect(mocks.api).not.toHaveBeenCalled();
  expect(mocks.clock).not.toHaveBeenCalled();
  expect(mocks.translateMail).not.toHaveBeenCalled();
  expect(mocks.useTranslatePrefs).not.toHaveBeenCalled();
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n("en");
  vi.clearAllMocks();
  mocks.clock.mockImplementation((iso?: string) => `default-clock:${iso ?? ""}`);
  mocks.useTranslatePrefs.mockReturnValue(makePrefs());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("StoredMailBodyView (pure presentation)", () => {
  it("renders loading, stored text, translation toggle, onLatest, and clipping notice without touching singletons", async () => {
    const onToggleOriginal = vi.fn();
    const onLatest = vi.fn();

    await act(async () => root.render(
      <StoredMailBodyView
        body={{ kind: "loading" }}
        from="Ana <ana@example.com>"
        dateText="09:00"
        translation={null}
        targetLanguage="zh-Hans"
        showOriginal={false}
        onToggleOriginal={onToggleOriginal}
      />,
    ));
    expect(host.textContent).toContain(t("inbox-inboxbodies.reading_mail"));
    expect(host.querySelector("[data-mail-body='stored']")).toBeNull();

    await act(async () => root.render(
      <StoredMailBodyView
        body={{ kind: "stored", text: "Original body", clipping: "clipped" }}
        from="Ana <ana@example.com>"
        dateText="09:00"
        translation={{ subject: "Subj", text: "Translated body" }}
        targetLanguage="en"
        showOriginal={false}
        onToggleOriginal={onToggleOriginal}
        onLatest={onLatest}
      />,
    ));
    expect(host.querySelector("[data-mail-body='stored']")).not.toBeNull();
    expect(host.querySelector("dl")?.textContent).toContain("Ana <ana@example.com>");
    expect(host.querySelector("dl")?.textContent).toContain("09:00");
    expect(storedText()).toBe("Translated body");
    expect(noticeEl()?.getAttribute("data-mail-stored-clipping")).toBe("clipped");
    expect(noticeEl()?.textContent).toBe(t("inbox-inboxbodies.mail_off_stored_clipped"));

    await act(async () => toggleButton()!.click());
    expect(onToggleOriginal).toHaveBeenCalledTimes(1);

    const latestBtn = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === t("inbox-inboxbodies.latest"))!;
    await act(async () => latestBtn.click());
    expect(onLatest).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <StoredMailBodyView
        body={{ kind: "stored", text: "Original body", clipping: "whole" }}
        from="Ana <ana@example.com>"
        dateText="09:00"
        translation={{ subject: "Subj", text: "Translated body" }}
        targetLanguage="en"
        showOriginal
        onToggleOriginal={onToggleOriginal}
      />,
    ));
    expect(storedText()).toBe("Original body");
    expect(noticeEl()?.getAttribute("data-mail-stored-clipping")).toBe("whole");
    expectNoDefaultSingletons();
  });
});

describe("StoredMailBody controlled deps, snapshot caching, fencing, and error recovery", () => {
  it("bypasses singletons, caches getter translatePrefs without subscription churn, and supports renderView", async () => {
    const prefsBox = createExternalBox(makePrefs({ enabled: true, target: "zh-Hans" }));
    let prefsReads = 0;
    const item = makeMailItem("mail:1", {
      translations: { "zh-Hans": { subject: "S", preview: "P" } },
    });
    const readItem = vi.fn(async (_it: InboxItem, _signal: AbortSignal) => ({
      ...item,
      context: "Stored body text",
      mail_body_truncated: false,
    }));
    const translateMail = vi.fn(async (): Promise<MailTranslation> => ({
      subject: "S",
      text: "Translated stored text",
    }));
    const formatClock = vi.fn((iso: string) => `fmt:${iso}`);

    const makeDeps = (): StoredMailBodyDeps => ({
      translatePrefs: () => {
        prefsReads += 1;
        const cur = prefsBox.get();
        return { ...cur, chats: cur.chats.map((c) => ({ ...c })) };
      },
      subscribeTranslatePrefs: prefsBox.subscribe,
      readItem,
      translateMail,
      formatClock,
    });

    await act(async () => root.render(<StrictMode><StoredMailBody item={item} deps={makeDeps()} /></StrictMode>));
    await flush();

    expect(storedText()).toBe("Translated stored text");
    expect(host.querySelector("dl")?.textContent).toContain("fmt:2026-11-20T09:00:00Z");
    expect(noticeEl()?.getAttribute("data-mail-stored-clipping")).toBe("whole");

    const subsAfterMount = prefsBox.subscribeCount;
    // Unchanged fresh object emission causes zero re-renders or re-subscriptions.
    await act(async () => prefsBox.notify());
    expect(prefsReads).toBeLessThan(30);
    expect(prefsBox.subscribeCount).toBe(subsAfterMount);

    // Inline getter re-render does not churn subscriptions or refetch.
    const itemCalls = readItem.mock.calls.length;
    const transCalls = translateMail.mock.calls.length;
    await act(async () => root.render(<StrictMode><StoredMailBody item={item} deps={makeDeps()} /></StrictMode>));
    expect(prefsBox.subscribeCount).toBe(subsAfterMount);
    expect(readItem.mock.calls.length).toBe(itemCalls);
    expect(translateMail.mock.calls.length).toBe(transCalls);

    // Toggle to original and back.
    await act(async () => toggleButton()!.click());
    expect(storedText()).toBe("Stored body text");
    await act(async () => toggleButton()!.click());
    expect(storedText()).toBe("Translated stored text");

    // Custom renderView seam works cleanly.
    await act(async () => root.render(
      <StoredMailBody
        item={item}
        deps={{
          ...makeDeps(),
          renderView: (p) => <div data-custom-stored={`${p.body.kind}|${p.dateText}`} />,
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-stored]")?.getAttribute("data-custom-stored")).toBe("stored|fmt:2026-11-20T09:00:00Z");
    expectNoDefaultSingletons();
  });

  it("aborts and fences both item and translation fetches across item ABA (A -> B -> A), version/manager switches, scopeKey ABA bursts, target ABA bursts, and unmount", async () => {
    const scopeBox = createExternalBox("s1");
    const prefsBox = createExternalBox(makePrefs({ enabled: true, target: "zh-Hans" }));
    const itemCalls: Array<{ id: string; signal: AbortSignal; gate: ReturnType<typeof deferred<InboxItem>> }> = [];
    const transCalls: Array<{ target: string; uid: number; signal: AbortSignal; gate: ReturnType<typeof deferred<MailTranslation>> }> = [];
    const onError = vi.fn();

    const itemA = makeMailItem("mail:A", {
      preview: "Preview A",
      mail: { account_id: "acct-1", mailbox: "INBOX", uids: [1], from: { name: "Ana", email: "ana@example.com" } },
      translations: {
        "zh-Hans": { subject: "SA", preview: "PA" },
        ja: { subject: "SA-ja", preview: "PA-ja" },
      },
    });
    const itemB = makeMailItem("mail:B", {
      preview: "Preview B",
      mail: { account_id: "acct-1", mailbox: "INBOX", uids: [2], from: { name: "Bo", email: "bo@example.com" } },
      translations: { "zh-Hans": { subject: "SB", preview: "PB" } },
    });

    const deps: StoredMailBodyDeps = {
      scopeKey: () => scopeBox.get(),
      subscribeScopeKey: scopeBox.subscribe,
      translatePrefs: () => prefsBox.get(),
      subscribeTranslatePrefs: prefsBox.subscribe,
      readItem: (it, signal) => {
        const gate = deferred<InboxItem>();
        itemCalls.push({ id: it.id, signal, gate });
        return gate.promise;
      },
      translateMail: (_acct, uid, _mb, target, _mgr, signal) => {
        const gate = deferred<MailTranslation>();
        transCalls.push({ target, uid, signal, gate });
        return gate.promise;
      },
      formatClock: () => "09:00",
      onError,
    };

    // 1. Item ABA: itemA -> itemB -> itemA while itemA's first item + translation fetches are pending.
    await act(async () => root.render(<StoredMailBody item={itemA} deps={deps} />));
    expect(itemCalls).toHaveLength(1);
    expect(transCalls).toHaveLength(1);
    const firstItemCall = itemCalls[0];
    const firstTransCall = transCalls[0];

    await act(async () => root.render(<StoredMailBody item={itemB} deps={deps} />));
    expect(firstItemCall.signal.aborted).toBe(true);
    expect(firstTransCall.signal.aborted).toBe(true);
    expect(itemCalls).toHaveLength(2);
    expect(transCalls).toHaveLength(2);

    await act(async () => root.render(<StoredMailBody item={itemA} deps={deps} />));
    expect(itemCalls[1].signal.aborted).toBe(true);
    expect(transCalls[1].signal.aborted).toBe(true);
    expect(itemCalls).toHaveLength(3);
    expect(transCalls).toHaveLength(3);

    // Late resolution of first itemA + first translation must NOT poison second visit to itemA.
    await act(async () => {
      firstItemCall.gate.resolve({ ...itemA, context: "STALE A BODY", mail_body_truncated: true });
      firstTransCall.gate.resolve({ subject: "STALE", text: "STALE A TRANS" });
      await Promise.resolve();
    });
    await flush();
    expect(host.textContent).toContain(t("inbox-inboxbodies.reading_mail"));
    expect(storedText()).toBe("");

    // Current visit to itemA resolves cleanly.
    await act(async () => {
      itemCalls[2].gate.resolve({ ...itemA, context: "FRESH A BODY", mail_body_truncated: false });
      transCalls[2].gate.resolve({ subject: "FRESH", text: "FRESH A TRANS" });
      await Promise.resolve();
    });
    await flush();
    expect(storedText()).toBe("FRESH A TRANS");

    // 2. Synchronous ABA burst on prefs.target ("zh-Hans" -> "ja" -> "zh-Hans"): resets translation + showOriginal, aborts previous, refetches.
    await act(async () => toggleButton()!.click());
    expect(storedText()).toBe("FRESH A BODY");
    const transBeforeBurst = transCalls.length;
    await act(async () => {
      prefsBox.set(makePrefs({ enabled: true, target: "ja" }));
      prefsBox.set(makePrefs({ enabled: true, target: "zh-Hans" }));
    });
    expect(transCalls.length).toBe(transBeforeBurst + 1);
    expect(toggleButton()).toBeNull();
    const afterBurstTrans = transCalls.at(-1)!;
    await act(async () => {
      afterBurstTrans.gate.resolve({ subject: "BURST", text: "POST BURST TRANS" });
      await Promise.resolve();
    });
    await flush();
    expect(storedText()).toBe("POST BURST TRANS");

    // 3. Synchronous ABA burst on scopeKey (s1 -> s2 -> s1) aborts in-flight item + translation fetches and discards late rejections.
    await act(async () => root.render(<StoredMailBody item={{ ...itemA, version: "v2" }} deps={deps} />));
    const v2ItemCall = itemCalls.at(-1)!;
    await act(async () => {
      scopeBox.set("s2");
      scopeBox.set("s1");
    });
    expect(v2ItemCall.signal.aborted).toBe(true);
    await act(async () => {
      v2ItemCall.gate.reject(new Error("stale scope item error"));
      await Promise.resolve();
    });
    await flush();
    expect(onError).not.toHaveBeenCalled();

    // 4. Unmount aborts active item + translation fetches and ignores late failures.
    const activeItem = itemCalls.at(-1)!;
    const activeTrans = transCalls.at(-1)!;
    await act(async () => root.render(null));
    expect(activeItem.signal.aborted).toBe(true);
    expect(activeTrans.signal.aborted).toBe(true);
    await act(async () => {
      activeItem.gate.reject(new Error("after unmount item"));
      activeTrans.gate.reject(new Error("after unmount trans"));
      await Promise.resolve();
    });
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("recovers cleanly when readItem or translateMail throws or rejects (even when onError throws)", async () => {
    const onError = vi.fn(() => { throw new Error("observer boom"); });
    const item = makeMailItem("mail:err", {
      preview: "List fallback preview",
      translations: { "zh-Hans": { subject: "S", preview: "P" } },
    });

    // Async rejections fall back to preview with clipping="unknown" and stay quiet on missing translation.
    await act(async () => root.render(
      <StoredMailBody
        item={item}
        deps={{
          translatePrefs: makePrefs({ enabled: true, target: "zh-Hans" }),
          readItem: async () => { throw new Error("HTTP 503"); },
          translateMail: async () => { throw new Error("gone"); },
          formatClock: () => "10:15",
          onError,
        }}
      />,
    ));
    await flush();
    expect(storedText()).toBe("List fallback preview");
    expect(noticeEl()?.getAttribute("data-mail-stored-clipping")).toBe("unknown");
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "item");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "translation");

    // Synchronous throws also fall back cleanly.
    onError.mockClear();
    await act(async () => root.render(
      <StoredMailBody
        item={makeMailItem("mail:sync-err", {
          preview: "Sync fallback preview",
          translations: { "zh-Hans": { subject: "S", preview: "P" } },
        })}
        deps={{
          translatePrefs: makePrefs({ enabled: true, target: "zh-Hans" }),
          readItem: () => { throw new Error("sync item fail"); },
          translateMail: () => { throw new Error("sync trans fail"); },
          formatClock: () => "10:16",
          onError,
        }}
      />,
    ));
    await flush();
    expect(storedText()).toBe("Sync fallback preview");
    expect(noticeEl()?.getAttribute("data-mail-stored-clipping")).toBe("unknown");
    expect(onError).toHaveBeenCalledTimes(2);
    expectNoDefaultSingletons();
  });

  it("keeps committed item and translation fetches intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const itemGate = deferred<InboxItem>();
    const transGate = deferred<MailTranslation>();
    let itemSignal: AbortSignal | null = null;
    let transSignal: AbortSignal | null = null;
    const itemA = makeMailItem("mail:c1", {
      translations: { "zh-Hans": { subject: "S", preview: "P" } },
    });
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
          <StoredMailBody
            item={itemA}
            deps={{
              scopeKey: state.scope,
              translatePrefs: makePrefs({ enabled: true, target: "zh-Hans" }),
              readItem: (_it, signal) => {
                itemSignal = signal;
                return itemGate.promise;
              },
              translateMail: (_a, _u, _m, _t, _mgr, signal) => {
                transSignal = signal;
                return transGate.promise;
              },
              formatClock: () => "09:00",
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    expect(itemSignal).not.toBeNull();
    expect(transSignal).not.toBeNull();
    expect(itemSignal!.aborted).toBe(false);
    expect(transSignal!.aborted).toBe(false);

    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(itemSignal!.aborted).toBe(false);
    expect(transSignal!.aborted).toBe(false);

    await act(async () => setHarness({ scope: "s1", block: false }));
    await act(async () => {
      itemGate.resolve({ ...itemA, context: "Committed body", mail_body_truncated: false });
      transGate.resolve({ subject: "S", text: "Committed translation" });
      await Promise.resolve();
    });
    await flush();
    expect(storedText()).toBe("Committed translation");
    expectNoDefaultSingletons();
  });

  it("preserves default api, translateMail, useTranslatePrefs, and clock fallbacks when deps are omitted", async () => {
    const item = makeMailItem("mail:default", {
      manager: "m-2",
      translations: { "zh-Hans": { subject: "S", preview: "P" } },
    });
    mocks.useTranslatePrefs.mockReturnValue(makePrefs({ enabled: true, target: "zh-Hans" }));
    mocks.api.mockResolvedValueOnce({ ...item, context: "Default hub body", mail_body_truncated: false });
    mocks.translateMail.mockResolvedValueOnce({ subject: "S", text: "Default hub translation" });

    await act(async () => root.render(<StoredMailBody item={item} />));
    await flush();

    expect(mocks.useTranslatePrefs).toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledWith(
      itemPath(item.id),
      expect.objectContaining({ headers: itemRequest(item), signal: expect.any(AbortSignal) }),
    );
    expect(mocks.translateMail).toHaveBeenCalledWith("acct-1", 101, "INBOX", "zh-Hans", "m-2");
    expect(mocks.clock).toHaveBeenCalledWith(item.updated_at);
    expect(storedText()).toBe("Default hub translation");
    expect(host.querySelector("dl")?.textContent).toContain(`default-clock:${item.updated_at}`);
  });
});
