// @vitest-environment jsdom
// Controlled InboxExtensionBody bypasses ExtensionUI, lib/back-close, and lib/api.errorText singletons,
// resets fallback/source/wide/retry state across scopeKey, item.id, and place changes (including ABA switches),
// preserves render purity across abandoned concurrent transitions, and keeps default fallbacks compatible.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "../../lib/inbox";
import type { UIPlace } from "../../lib/extension-ui";
import type { InboxExtensionBodyDeps, InboxExtensionRenderProps } from "./InboxExtensionBody";

const mocks = vi.hoisted(() => ({
  useCloseOnBack: vi.fn(),
  extensionUI: vi.fn(),
  errorText: vi.fn((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`),
}));

vi.mock("../../lib/back-close", async (original) => ({
  ...(await original<typeof import("../../lib/back-close")>()),
  useCloseOnBack: (...args: unknown[]) => mocks.useCloseOnBack(...args),
}));
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  errorText: (e: unknown) => mocks.errorText(e),
}));
vi.mock("../settings/ExtensionView", () => ({
  ExtensionUI: (props: Record<string, unknown>) => {
    mocks.extensionUI(props);
    return <div data-default-extension-ui={`${String(props.extension)}/${String(props.ui)}`} />;
  },
}));

const { ApiError } = await import("../../lib/api");
const { fallbackOf, InboxExtensionBody, InboxExtensionBodyView } = await import("./InboxExtensionBody");
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

const makeItem = (id: string, patch: Partial<InboxItem> = {}): InboxItem => ({
  id,
  source: "examplechat",
  kind: "dm",
  account: "examplechat",
  account_name: "Example Chat",
  title: `Item ${id}`,
  preview: `Preview ${id}`,
  count: 1,
  tier: "action",
  version: "v1",
  ...patch,
});

const makePlace = (extension = "example-chat", id = "event", patch: Partial<UIPlace> = {}): UIPlace => ({
  extension,
  extension_name: "Example Chat",
  id,
  title: "Event",
  placement: "inbox_item",
  size: "full",
  connector: "examplechat",
  ...patch,
});

let host: HTMLDivElement;
let root: Root;

const container = () => host.querySelector<HTMLElement>("[data-extension-inbox-container]");
const sourceBar = () => host.querySelector<HTMLElement>("[data-inbox-source]");
const retryButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(
  (b) => b.textContent?.trim() === t("inbox-inboxextensionbody.retry"),
) ?? null;

const expectNoDefaultSingletons = () => {
  expect(mocks.useCloseOnBack).not.toHaveBeenCalled();
  expect(mocks.extensionUI).not.toHaveBeenCalled();
  expect(mocks.errorText).not.toHaveBeenCalled();
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n("en");
  vi.clearAllMocks();
  mocks.errorText.mockImplementation((e: unknown) => `default-err:${e instanceof Error ? e.message : String(e)}`);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("InboxExtensionBodyView (pure presentation)", () => {
  it("renders extension, wide, source overlay, quiet fallback, and error+retry states without touching singletons", async () => {
    const place = makePlace();
    const onRetry = vi.fn();
    const onCloseSource = vi.fn();

    await act(async () => root.render(
      <InboxExtensionBodyView
        place={place}
        fallback=""
        source={false}
        wide={false}
        own={() => <p data-own>own body</p>}
        extensionContent={<div data-ext>ext body</div>}
        onRetry={onRetry}
        onCloseSource={onCloseSource}
      />,
    ));
    expect(host.querySelector("[data-ext]")?.textContent).toBe("ext body");
    expect(host.querySelector("[data-own]")).toBeNull();
    expect(container()?.className).toContain("max-w-[760px]");

    await act(async () => root.render(
      <InboxExtensionBodyView
        place={place}
        fallback=""
        source
        wide
        own={() => <p data-own>own body</p>}
        extensionContent={<div data-ext>ext body</div>}
        onRetry={onRetry}
        onCloseSource={onCloseSource}
      />,
    ));
    expect(sourceBar()).not.toBeNull();
    expect(host.querySelector("[data-own]")?.textContent).toBe("own body");
    expect(host.querySelector("[data-extension-inbox]")?.className).toContain("hidden");
    expect(container()?.className).toContain("max-w-[1680px]");
    await act(async () => sourceBar()!.querySelector("button")!.click());
    expect(onCloseSource).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <InboxExtensionBodyView
        place={place}
        fallback={{ error: "crash" }}
        source={false}
        wide={false}
        own={() => <p data-own>own body</p>}
        onRetry={onRetry}
        onCloseSource={onCloseSource}
      />,
    ));
    expect(host.querySelector("[role=status]")?.textContent).toContain("crash");
    expect(host.querySelector("[data-own]")).not.toBeNull();
    await act(async () => retryButton()!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <InboxExtensionBodyView
        place={place}
        fallback={{ quiet: true }}
        source={false}
        wide={false}
        own={() => <p data-own>own body</p>}
        onRetry={onRetry}
        onCloseSource={onCloseSource}
      />,
    ));
    expect(host.querySelector("[role=status]")).toBeNull();
    expect(host.querySelector("[data-own]")?.textContent).toBe("own body");
    expectNoDefaultSingletons();
  });
});

describe("InboxExtensionBody controlled deps, ABA resets, render purity, and default fallback", () => {
  it("bypasses ExtensionUI, lib/back-close, and errorText via renderExtension, useCloseOnBack / onBackCloseRegister, formatError, and renderView", async () => {
    const item = makeItem("examplechat:1", { manager: "m-1", version: "v3" });
    const place = makePlace();
    const onOwn = vi.fn();
    let lastExtProps!: InboxExtensionRenderProps;
    const backHookCalls: Array<{ open: boolean; onClose: () => void }> = [];
    const customBackHook = vi.fn((open: boolean, onClose: () => void) => {
      backHookCalls.push({ open, onClose });
    });
    const formatError = vi.fn((e: unknown) => `custom:${e instanceof Error ? e.message : String(e)}`);

    await act(async () => root.render(
      <StrictMode>
        <InboxExtensionBody
          item={item}
          place={place}
          own={() => <p data-own>own body</p>}
          onOwn={onOwn}
          deps={{
            useCloseOnBack: customBackHook,
            formatError,
            renderExtension: (props) => {
              lastExtProps = props;
              return <div data-controlled-ext={`${props.extension}/${props.ui}:${props.retryCount}`} />;
            },
          }}
        />
      </StrictMode>,
    ));

    expect(host.querySelector("[data-controlled-ext]")?.getAttribute("data-controlled-ext")).toBe("example-chat/event:0");
    expect(lastExtProps.context).toEqual({ item: "examplechat:1" });
    expect(lastExtProps.manager).toBe("m-1");
    expect(lastExtProps.revision).toBe("v3");
    expect(onOwn).toHaveBeenLastCalledWith(false);

    // Open source -> controlled useCloseOnBack sees open=true; invoking its onClose closes source.
    await act(async () => lastExtProps.onOpenSource());
    expect(sourceBar()).not.toBeNull();
    expect(onOwn).toHaveBeenLastCalledWith(true);
    expect(backHookCalls.at(-1)?.open).toBe(true);

    await act(async () => backHookCalls.at(-1)!.onClose());
    expect(sourceBar()).toBeNull();
    expect(onOwn).toHaveBeenLastCalledWith(false);

    // Failure uses controlled formatError (and handles throwing formatError cleanly without calling errorText); retry bumps retryCount.
    await act(async () => lastExtProps.onFailed(new Error("plugin boom")));
    expect(formatError).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[role=status]")?.textContent).toContain("custom:plugin boom");
    expect(onOwn).toHaveBeenLastCalledWith(true);

    await act(async () => retryButton()!.click());
    expect(host.querySelector("[data-controlled-ext]")?.getAttribute("data-controlled-ext")).toBe("example-chat/event:1");
    expect(onOwn).toHaveBeenLastCalledWith(false);

    // Throwing formatError falls back to default localized message without invoking errorText singleton.
    formatError.mockImplementationOnce(() => { throw new Error("fmt crash"); });
    await act(async () => lastExtProps.onFailed(new Error("ignored")));
    expect(host.querySelector("[role=status]")?.textContent).toContain(t("inbox-inboxextensionbody.error"));

    // Imperative onBackCloseRegister works and cleans up on close/unmount without calling lib/back-close.
    const cleanup = vi.fn();
    let registeredClose: (() => void) | null = null;
    const onBackCloseRegister = vi.fn((cb: () => void) => {
      registeredClose = cb;
      return cleanup;
    });
    await act(async () => root.render(
      <InboxExtensionBody
        item={makeItem("examplechat:2")}
        place={place}
        own={() => <p data-own>own body</p>}
        deps={{
          onBackCloseRegister,
          formatError,
          renderExtension: (props) => {
            lastExtProps = props;
            return <div data-controlled-ext={props.retryKey} />;
          },
        }}
      />,
    ));
    expect(onBackCloseRegister).not.toHaveBeenCalled();
    await act(async () => lastExtProps.onOpenSource());
    expect(onBackCloseRegister).toHaveBeenCalledTimes(1);
    await act(async () => registeredClose!());
    expect(sourceBar()).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);

    // Custom renderView seam works cleanly.
    await act(async () => root.render(
      <InboxExtensionBody
        item={item}
        place={place}
        own={() => null}
        deps={{
          useCloseOnBack: customBackHook,
          renderExtension: () => <span />,
          renderView: (p) => <div data-custom-ext-view={`${p.place.id}|${String(p.source)}|${String(p.wide)}`} />,
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-ext-view]")?.getAttribute("data-custom-ext-view")).toBe("event|false|false");
    expectNoDefaultSingletons();
  });

  it("resets fallback, source, wide, and retry counter across scopeKey, item.id, and place ABA switches and fences stale callbacks without subscription churn", async () => {
    const scopeBox = createExternalBox("s1");
    const itemA = makeItem("item:a");
    const itemB = makeItem("item:b");
    const placeA = makePlace("ext-a", "ui-a");
    const placeB = makePlace("ext-b", "ui-b");
    let currentExtProps!: InboxExtensionRenderProps;
    let registeredBack: (() => void) | null = null;
    const backCleanup = vi.fn();
    const onBackCloseRegister = vi.fn((cb: () => void) => {
      registeredBack = cb;
      return backCleanup;
    });

    const makeDeps = (): InboxExtensionBodyDeps => ({
      scopeKey: () => scopeBox.get(),
      subscribeScopeKey: scopeBox.subscribe,
      onBackCloseRegister,
      formatError: (e) => (e instanceof Error ? e.message : String(e)),
      renderExtension: (props) => {
        currentExtProps = props;
        return <div data-retry-count={String(props.retryCount)} data-retry-key={props.retryKey} />;
      },
    });

    await act(async () => root.render(<StrictMode><InboxExtensionBody item={itemA} place={placeA} own={() => <p>own</p>} deps={makeDeps()} /></StrictMode>));
    const subsAfterMount = scopeBox.subscribeCount;
    await act(async () => scopeBox.notify());
    expect(scopeBox.subscribeCount).toBe(subsAfterMount);

    // Build up dirty state on (s1, itemA, placeA): wide=true, retryCount=1, source=true.
    const extPropsEpoch1 = currentExtProps;
    await act(async () => extPropsEpoch1.onFailed(new Error("boom")));
    await act(async () => retryButton()!.click());
    expect(host.querySelector("[data-retry-count]")?.getAttribute("data-retry-count")).toBe("1");
    const extPropsAfterRetry = currentExtProps;
    await act(async () => extPropsAfterRetry.onWide(true));
    await act(async () => extPropsAfterRetry.onOpenSource());
    expect(container()?.className).toContain("max-w-[1680px]");
    expect(sourceBar()).not.toBeNull();
    const staleBack = registeredBack!;

    // 1. Item ABA switch (itemA -> itemB -> itemA) resets source, wide, fallback, and retryCount back to 0.
    await act(async () => root.render(<StrictMode><InboxExtensionBody item={itemB} place={placeA} own={() => <p>own</p>} deps={makeDeps()} /></StrictMode>));
    expect(backCleanup).toHaveBeenCalledTimes(1);
    expect(sourceBar()).toBeNull();
    expect(container()?.className).toContain("max-w-[760px]");
    expect(host.querySelector("[data-retry-count]")?.getAttribute("data-retry-count")).toBe("0");

    await act(async () => root.render(<StrictMode><InboxExtensionBody item={itemA} place={placeA} own={() => <p>own</p>} deps={makeDeps()} /></StrictMode>));
    expect(sourceBar()).toBeNull();
    expect(container()?.className).toContain("max-w-[760px]");
    expect(host.querySelector("[data-retry-count]")?.getAttribute("data-retry-count")).toBe("0");
    expect(scopeBox.subscribeCount).toBe(subsAfterMount);

    // Stale callbacks from epoch 1 must be fenced even after ABA returns to itemA!
    await act(async () => {
      extPropsAfterRetry.onWide(true);
      extPropsAfterRetry.onOpenSource();
      extPropsAfterRetry.onFailed(new Error("stale fail"));
      extPropsAfterRetry.onMissing();
    });
    expect(container()?.className).toContain("max-w-[760px]");
    expect(sourceBar()).toBeNull();
    expect(host.querySelector("[role=status]")).toBeNull();
    expect(host.querySelector("[data-retry-count]")).not.toBeNull();

    // Opening source in the new epoch is not closed by staleBack from epoch 1.
    await act(async () => currentExtProps.onOpenSource());
    expect(sourceBar()).not.toBeNull();
    await act(async () => staleBack());
    expect(sourceBar()).not.toBeNull();

    // 2. Place ABA switch (placeA -> placeB -> placeA) resets quiet fallback and retry state.
    await act(async () => currentExtProps.onUnsupported());
    expect(host.querySelector("[data-extension-inbox]")).toBeNull();
    await act(async () => root.render(<StrictMode><InboxExtensionBody item={itemA} place={placeB} own={() => <p>own</p>} deps={makeDeps()} /></StrictMode>));
    expect(host.querySelector("[data-extension-inbox]")?.getAttribute("data-extension-inbox")).toBe("ext-b/ui-b");
    await act(async () => root.render(<StrictMode><InboxExtensionBody item={itemA} place={placeA} own={() => <p>own</p>} deps={makeDeps()} /></StrictMode>));
    expect(host.querySelector("[data-extension-inbox]")?.getAttribute("data-extension-inbox")).toBe("ext-a/ui-a");

    // 3. Synchronous ABA burst on scopeKey (s1 -> s2 -> s1) resets wide, source, retryCount, and fences prior callbacks.
    await act(async () => currentExtProps.onFailed(new Error("err")));
    await act(async () => retryButton()!.click());
    const preBurstProps = currentExtProps;
    await act(async () => preBurstProps.onWide(true));
    await act(async () => preBurstProps.onOpenSource());
    expect(host.querySelector("[data-retry-count]")?.getAttribute("data-retry-count")).toBe("1");
    expect(sourceBar()).not.toBeNull();

    await act(async () => {
      scopeBox.set("s2");
      scopeBox.set("s1");
    });
    expect(sourceBar()).toBeNull();
    expect(container()?.className).toContain("max-w-[760px]");
    expect(host.querySelector("[data-retry-count]")?.getAttribute("data-retry-count")).toBe("0");

    await act(async () => preBurstProps.onFailed(new Error("stale burst error")));
    expect(host.querySelector("[role=status]")).toBeNull();
    expectNoDefaultSingletons();
  });

  it("keeps committed source, wide, and retry state intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const itemA = makeItem("item:c1");
    const place = makePlace();
    let latestExtProps!: InboxExtensionRenderProps;
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
          <InboxExtensionBody
            item={itemA}
            place={place}
            own={() => <p data-own>own</p>}
            deps={{
              scopeKey: state.scope,
              onBackCloseRegister: () => () => {},
              renderExtension: (props) => {
                latestExtProps = props;
                return <div data-retry-count={String(props.retryCount)} />;
              },
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => latestExtProps.onWide(true));
    await act(async () => latestExtProps.onOpenSource());
    expect(container()?.className).toContain("max-w-[1680px]");
    expect(sourceBar()).not.toBeNull();

    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(container()?.className).toContain("max-w-[1680px]");
    expect(sourceBar()).not.toBeNull();

    await act(async () => setHarness({ scope: "s1", block: false }));
    expect(container()?.className).toContain("max-w-[1680px]");
    expect(sourceBar()).not.toBeNull();
    expectNoDefaultSingletons();
  });

  it("preserves default ExtensionUI, useCloseOnBack, and errorText fallbacks when deps are omitted", async () => {
    const item = makeItem("examplechat:default", { manager: "m-2", version: "v9" });
    const place = makePlace();

    await act(async () => root.render(<InboxExtensionBody item={item} place={place} own={() => <p data-own>own</p>} />));
    expect(mocks.extensionUI).toHaveBeenCalledTimes(1);
    expect(mocks.useCloseOnBack).toHaveBeenCalledWith(false, expect.any(Function), false, 1);
    expect(host.querySelector("[data-default-extension-ui]")?.getAttribute("data-default-extension-ui")).toBe("example-chat/event");

    const passedProps = mocks.extensionUI.mock.calls[0][0] as { onFailed: (e: unknown) => void };
    await act(async () => passedProps.onFailed(new Error("boom")));
    expect(mocks.errorText).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[role=status]")?.textContent).toContain("default-err:boom");

    expect(fallbackOf(new ApiError(403, "denied", { code: "forbidden" }))).toEqual({ quiet: true });
    expect(fallbackOf(new ApiError(404, "missing", { code: "not_found" }))).toEqual({ quiet: true });
  });
});
