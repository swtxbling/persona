// @vitest-environment jsdom
// Controlled NodePrompt bypasses lib/node-ask singletons, caches fresh-object getter snapshots without subscription
// churn, preserves render purity across abandoned concurrent transitions, fences draft and async/throwing answers
// across scope switches, ask switches, synchronous ABA bursts, and unmount, recovers via try/finally, and keeps defaults.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import type { ConfirmNodeAsk, NodeAsk, NodePromptDeps, TextNodeAsk } from "./NodePrompt";

const mocks = vi.hoisted(() => ({
  getAsk: vi.fn<() => NodeAsk | null>(),
  subscribeAsk: vi.fn<(listener: () => void) => () => void>(),
  answerAsk: vi.fn<() => void>(),
}));

vi.mock("../lib/node-ask", async (original) => {
  const real = await original<typeof import("../lib/node-ask")>();
  return {
    ...real,
    getAsk: () => {
      mocks.getAsk();
      return real.getAsk();
    },
    subscribeAsk: (listener: () => void) => {
      mocks.subscribeAsk(listener);
      return real.subscribeAsk(listener);
    },
    answerAsk: () => {
      mocks.answerAsk();
      real.answerAsk();
    },
  };
});

const { askConfirm, askText } = await import("../lib/node-ask");
const { ConfirmAskView, NodePrompt, NodePromptView, TextAskView } = await import("./NodePrompt");

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

const expectNoDefaultSingletons = () => {
  expect(mocks.getAsk).not.toHaveBeenCalled();
  expect(mocks.subscribeAsk).not.toHaveBeenCalled();
  expect(mocks.answerAsk).not.toHaveBeenCalled();
};

const makeTextAsk = (patch: Partial<TextNodeAsk> = {}): TextNodeAsk => ({
  kind: "text",
  title: "Rename pane",
  label: "Pane name",
  value: "build",
  resolve: vi.fn(),
  ...patch,
});

const makeConfirmAsk = (patch: Partial<ConfirmNodeAsk> = {}): ConfirmNodeAsk => ({
  kind: "confirm",
  title: "Close pane",
  body: "Stop the running shell?",
  label: "Close",
  resolve: vi.fn(),
  ...patch,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  mocks.getAsk.mockReset();
  mocks.subscribeAsk.mockReset();
  mocks.answerAsk.mockReset();
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

describe("Pure presentational NodePrompt views", () => {
  it("renders NodePromptView, TextAskView, and ConfirmAskView without touching node-ask singletons", async () => {
    const onTextChange = vi.fn();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    await act(async () => root.render(
      <NodePromptView
        ask={null}
        text=""
        onTextChange={onTextChange}
        onSubmitText={onSubmit}
        onCancelText={onCancel}
        onConfirm={onConfirm}
        onCancelConfirm={onCancel}
      />,
    ));
    expect(activeDialog()).toBeNull();

    // Unchanged value keeps Save disabled.
    const textAsk = makeTextAsk();
    await act(async () => root.render(
      <TextAskView
        ask={textAsk}
        text="build"
        onTextChange={onTextChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    ));
    expect(activeDialog()?.textContent).toContain("Rename pane");
    expect(activeDialog()?.textContent).toContain("Pane name");
    expect(findButton(activeDialog()!, t("common.save"))?.disabled).toBe(true);

    // Changed value enables Save and submits trimmed value.
    await act(async () => root.render(
      <TextAskView
        ask={textAsk}
        text="  tests  "
        onTextChange={onTextChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    ));
    expect(findButton(activeDialog()!, t("common.save"))?.disabled).toBe(false);
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    expect(onSubmit).toHaveBeenCalledWith("tests");

    // Busy disables Cancel, marks Save aria-busy, and blocks form submit.
    await act(async () => root.render(
      <TextAskView
        ask={textAsk}
        text="tests"
        busy
        onTextChange={onTextChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    ));
    expect(findButton(activeDialog()!, t("common.cancel"))?.disabled).toBe(true);
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      activeDialog()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // ConfirmAskView renders body and danger action button.
    const confirmAsk = makeConfirmAsk();
    await act(async () => root.render(
      <ConfirmAskView ask={confirmAsk} onConfirm={onConfirm} onCancel={onCancel} />,
    ));
    expect(activeDialog()?.textContent).toContain("Close pane");
    expect(activeDialog()?.textContent).toContain("Stop the running shell?");
    await act(async () => { findButton(activeDialog()!, "Close")!.click(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => { findButton(activeDialog()!, t("common.cancel"))!.click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });
});

describe("NodePrompt controlled deps, snapshot caching, bridge switch, and renderView", () => {
  it("bypasses singletons, caches fresh-object getters without subscription churn, and preserves draft across bridge switches", async () => {
    const scopeListeners = new Set<() => void>();
    const askListeners = new Set<() => void>();
    const textAsk = makeTextAsk();
    let liveAsk: NodeAsk | null = textAsk;
    let reads = 0;

    // Start in direct controlled mode.
    await act(async () => root.render(
      <StrictMode>
        <NodePrompt deps={{ scopeKey: "s1", ask: textAsk }} />
      </StrictMode>,
    ));
    await setInput(activeDialog()!.querySelector("input")!, "edited-pane");
    expect(activeDialog()!.querySelector("input")!.value).toBe("edited-pane");

    // Switch in-place to fresh-object getter + subscribe on the same scope and ask.
    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const subscribeAsk = vi.fn((l: () => void) => { askListeners.add(l); return () => { askListeners.delete(l); }; });
    const renderSubscribed = () => root.render(
      <StrictMode>
        <NodePrompt
          deps={{
            scopeKey: () => "s1",
            subscribeScopeKey,
            ask: () => {
              reads += 1;
              return liveAsk ? { ...liveAsk } : null;
            },
            subscribeAsk,
          }}
        />
      </StrictMode>,
    );

    await act(async () => renderSubscribed());
    expect(activeDialog()!.querySelector("input")!.value).toBe("edited-pane");
    expect(reads).toBeLessThan(20);

    // Equal re-emissions and inline getter re-renders never loop or churn subscriptions.
    const scopeSubCount = subscribeScopeKey.mock.calls.length;
    const askSubCount = subscribeAsk.mock.calls.length;
    await act(async () => { askListeners.forEach((l) => l()); });
    await act(async () => renderSubscribed());
    await act(async () => renderSubscribed());
    expect(subscribeScopeKey).toHaveBeenCalledTimes(scopeSubCount);
    expect(subscribeAsk).toHaveBeenCalledTimes(askSubCount);
    expect(activeDialog()!.querySelector("input")!.value).toBe("edited-pane");

    // Switching ask to confirm updates immediately.
    const confirmAsk = makeConfirmAsk();
    liveAsk = confirmAsk;
    await act(async () => { askListeners.forEach((l) => l()); });
    expect(activeDialog()?.textContent).toContain("Stop the running shell?");

    // Custom renderView seam works cleanly.
    await act(async () => root.render(
      <NodePrompt
        deps={{
          scopeKey: "s1",
          ask: textAsk,
          renderView: (props) => <div data-custom-prompt={`${props.ask?.kind}:${props.text}`} />,
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-prompt]")?.getAttribute("data-custom-prompt")).toBe("text:build");
    expectNoDefaultSingletons();
  });
});

describe("NodePrompt async fencing, ABA bursts, render purity, error recovery, and default fallback", () => {
  it("fences draft and async answerAsk / ask.resolve across scope switches, ask switches, synchronous ABA bursts, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    const askListeners = new Set<() => void>();
    let currentScope = "s1";
    const resolveA = vi.fn();
    const resolveB = vi.fn();
    const askA = makeTextAsk({ title: "Rename A", value: "alpha", resolve: resolveA });
    const askB = makeTextAsk({ title: "Rename B", value: "beta", resolve: resolveB });
    let liveAsk: NodeAsk | null = askA;
    const onError = vi.fn();
    const answerCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];

    const makeDeps = (): NodePromptDeps => ({
      scopeKey: () => currentScope,
      subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
      ask: () => (liveAsk ? { ...liveAsk } : null),
      subscribeAsk: (l) => { askListeners.add(l); return () => { askListeners.delete(l); }; },
      answerAsk: (_ask, _answer, signal) => {
        const gate = deferred<void>();
        answerCalls.push({ signal, gate });
        return gate.promise;
      },
      onError,
    });

    await act(async () => root.render(<NodePrompt deps={makeDeps()} />));
    await setInput(activeDialog()!.querySelector("input")!, "alpha-edited");

    // 1) Single-flight guard prevents duplicate submissions.
    await act(async () => {
      findButton(activeDialog()!, t("common.save"))!.click();
      findButton(activeDialog()!, t("common.save"))!.click();
    });
    expect(answerCalls).toHaveLength(1);
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBe("true");

    // 2) Synchronous ABA burst askA -> askB -> askA aborts in-flight answer, resets draft, and discards stale settle.
    await act(async () => {
      liveAsk = askB;
      askListeners.forEach((l) => l());
      liveAsk = askA;
      askListeners.forEach((l) => l());
    });
    expect(answerCalls[0].signal.aborted).toBe(true);
    expect(activeDialog()!.querySelector("input")!.value).toBe("alpha");
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBeNull();
    await act(async () => { answerCalls[0].gate.resolve(); });
    await flush();
    expect(resolveA).not.toHaveBeenCalled();

    // 3) Synchronous ABA burst askA -> null -> askA also aborts and resets draft.
    await setInput(activeDialog()!.querySelector("input")!, "alpha-2");
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    expect(answerCalls).toHaveLength(2);
    await act(async () => {
      liveAsk = null;
      askListeners.forEach((l) => l());
      liveAsk = askA;
      askListeners.forEach((l) => l());
    });
    expect(answerCalls[1].signal.aborted).toBe(true);
    expect(activeDialog()!.querySelector("input")!.value).toBe("alpha");
    await act(async () => { answerCalls[1].gate.reject(new Error("stale null ABA")); });
    await flush();
    expect(onError).not.toHaveBeenCalled();

    // 4) Synchronous scopeKey ABA burst (s1 -> s2 -> s1) aborts in-flight answer and resets draft.
    await setInput(activeDialog()!.querySelector("input")!, "alpha-3");
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    expect(answerCalls).toHaveLength(3);
    await act(async () => {
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
      currentScope = "s1";
      scopeListeners.forEach((l) => l());
    });
    expect(answerCalls[2].signal.aborted).toBe(true);
    expect(activeDialog()!.querySelector("input")!.value).toBe("alpha");
    await act(async () => { answerCalls[2].gate.reject(new Error("stale scope ABA")); });
    await flush();
    expect(onError).not.toHaveBeenCalled();

    // 5) Async ask.resolve (with sync answerAsk that leaves ask open) is fenced across ask ABA and unmount.
    const resolveGate = deferred<void>();
    const asyncResolveAsk = makeTextAsk({
      title: "Async resolve",
      value: "gamma",
      resolve: (() => resolveGate.promise) as TextNodeAsk["resolve"],
    });
    liveAsk = asyncResolveAsk;
    await act(async () => root.render(
      <NodePrompt
        deps={{
          scopeKey: () => currentScope,
          subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
          ask: () => (liveAsk ? { ...liveAsk } : null),
          subscribeAsk: (l) => { askListeners.add(l); return () => { askListeners.delete(l); }; },
          answerAsk: vi.fn(),
          onError,
        }}
      />,
    ));
    await setInput(activeDialog()!.querySelector("input")!, "gamma-2");
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      liveAsk = null;
      askListeners.forEach((l) => l());
      liveAsk = asyncResolveAsk;
      askListeners.forEach((l) => l());
    });
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBeNull();
    expect(activeDialog()!.querySelector("input")!.value).toBe("gamma");
    await act(async () => { resolveGate.reject(new Error("stale async resolve")); });
    await flush();
    expect(onError).not.toHaveBeenCalled();

    // 6) Unmount aborts in-flight answer and fences late resolve/reject.
    liveAsk = askA;
    await act(async () => root.render(<NodePrompt deps={makeDeps()} />));
    await setInput(activeDialog()!.querySelector("input")!, "alpha-4");
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    expect(answerCalls).toHaveLength(4);
    await act(async () => root.render(null));
    expect(answerCalls[3].signal.aborted).toBe(true);
    await act(async () => { answerCalls[3].gate.resolve(); });
    await flush();
    expect(resolveA).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed draft and in-flight answerAsk intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const answerGate = deferred<void>();
    const resolveA = vi.fn();
    const askA = makeTextAsk({ title: "Rename A", value: "alpha", resolve: resolveA });
    const askB = makeTextAsk({ title: "Rename B", value: "beta", resolve: vi.fn() });
    let capturedSignal: AbortSignal | null = null;
    const renderedScopes: string[] = [];

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    let setHarness!: (next: { scope: string; ask: NodeAsk; block: boolean }) => void;
    function Harness() {
      const [state, setState] = useState<{ scope: string; ask: NodeAsk; block: boolean }>({ scope: "s1", ask: askA, block: false });
      setHarness = setState;
      renderedScopes.push(state.scope);
      return (
        <Suspense fallback={<div data-fallback />}>
          <NodePrompt
            deps={{
              scopeKey: state.scope,
              ask: state.ask,
              answerAsk: (_ask, _answer, signal) => {
                capturedSignal = signal;
                return answerGate.promise;
              },
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await setInput(activeDialog()!.querySelector("input")!, "alpha-kept");
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBe("true");

    // Suspended transition to s2 / askB must not abort committed s1 / askA work.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", ask: askB, block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);
    expect(activeDialog()!.querySelector("input")!.value).toBe("alpha-kept");

    // Abandon transition back to s1; resolving answerGate invokes askA.resolve cleanly.
    await act(async () => setHarness({ scope: "s1", ask: askA, block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => { answerGate.resolve(); });
    await flush();
    expect(resolveA).toHaveBeenCalledWith("alpha-kept");
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBeNull();
    expectNoDefaultSingletons();
  });

  it("recovers busy via try/finally on sync throws and async rejections of answerAsk and ask.resolve (including throwing onError)", async () => {
    let answerMode: "syncThrow" | "asyncReject" | "ok" = "syncThrow";
    let resolveMode: "syncThrow" | "asyncReject" | "ok" = "syncThrow";
    const resolved: Array<string | null> = [];
    const seenErrors: unknown[] = [];

    const textAsk = makeTextAsk({
      value: "alpha",
      resolve: ((v: string | null) => {
        if (resolveMode === "syncThrow") throw new Error("resolve sync boom");
        if (resolveMode === "asyncReject") return Promise.reject(new Error("resolve async boom"));
        resolved.push(v);
      }) as TextNodeAsk["resolve"],
    });

    const onError = vi.fn((err: unknown) => {
      seenErrors.push(err);
      throw new Error("observer crashed");
    });

    await act(async () => root.render(
      <NodePrompt
        deps={{
          scopeKey: "s1",
          ask: textAsk,
          answerAsk: () => {
            if (answerMode === "syncThrow") throw new Error("answer sync boom");
            if (answerMode === "asyncReject") return Promise.reject(new Error("answer async boom"));
          },
          onError,
        }}
      />,
    ));

    await setInput(activeDialog()!.querySelector("input")!, "alpha-next");

    // 1) Sync throw from answerAsk preserves draft and does not call resolve.
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    expect(seenErrors).toHaveLength(1);
    expect(resolved).toEqual([]);
    expect(activeDialog()!.querySelector("input")!.value).toBe("alpha-next");
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBeNull();

    // 2) Async reject from answerAsk with throwing onError releases busy via try/finally.
    answerMode = "asyncReject";
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    await flush();
    expect(seenErrors).toHaveLength(2);
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBeNull();
    expect(activeDialog()!.querySelector("input")!.value).toBe("alpha-next");

    // 3) Sync throw from ask.resolve is reported and keeps retryable state.
    answerMode = "ok";
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    expect(seenErrors).toHaveLength(3);
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBeNull();

    // 4) Async reject from ask.resolve releases busy via try/finally despite throwing onError.
    resolveMode = "asyncReject";
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    await flush();
    expect(seenErrors).toHaveLength(4);
    expect(findButton(activeDialog()!, t("common.save"))?.getAttribute("aria-busy")).toBeNull();

    // 5) Retry succeeds cleanly.
    resolveMode = "ok";
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    await flush();
    expect(resolved).toEqual(["alpha-next"]);
    expectNoDefaultSingletons();
  });

  it("preserves 100% backward-compatible default node-ask behavior when deps is omitted", async () => {
    await act(async () => root.render(<NodePrompt />));
    expect(mocks.subscribeAsk).toHaveBeenCalled();
    expect(mocks.getAsk).toHaveBeenCalled();
    expect(activeDialog()).toBeNull();

    // Text ask: edit and save resolves with trimmed text and closes.
    let textPromise!: Promise<string | null>;
    await act(async () => {
      textPromise = askText("Rename pane", "Name", "build");
    });
    expect(activeDialog()?.textContent).toContain("Rename pane");
    await setInput(activeDialog()!.querySelector("input")!, "  release  ");
    await act(async () => { findButton(activeDialog()!, t("common.save"))!.click(); });
    expect(await textPromise).toBe("release");
    expect(mocks.answerAsk).toHaveBeenCalledTimes(1);
    expect(activeDialog()).toBeNull();

    // Confirm ask: confirm resolves true, cancel resolves false.
    let confirmPromise!: Promise<boolean>;
    await act(async () => {
      confirmPromise = askConfirm("Close pane", "Stop this terminal?", "Close");
    });
    expect(activeDialog()?.textContent).toContain("Stop this terminal?");
    await act(async () => { findButton(activeDialog()!, "Close")!.click(); });
    expect(await confirmPromise).toBe(true);
    expect(mocks.answerAsk).toHaveBeenCalledTimes(2);
    expect(activeDialog()).toBeNull();

    let cancelPromise!: Promise<boolean>;
    await act(async () => {
      cancelPromise = askConfirm("Close pane", "Stop this terminal?", "Close");
    });
    await act(async () => { findButton(activeDialog()!, t("common.cancel"))!.click(); });
    expect(await cancelPromise).toBe(false);
    expect(activeDialog()).toBeNull();
  });
});
