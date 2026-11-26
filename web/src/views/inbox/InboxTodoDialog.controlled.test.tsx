// @vitest-environment jsdom
// Controlled TodoDialogHost and TodoDialog bypass module-global opening state and inbox-actions singletons,
// support deterministic pickerStart/now injection, cache getter snapshots without subscription churn,
// preserve render purity across abandoned concurrent transitions, fence cross-scope / items ABA / unmount races,
// recover busy cleanly via try/finally, and keep default fallbacks compatible.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "../../lib/inbox";
import type { DueChoice } from "../../lib/inbox-actions";
import type { TodoDialogDeps, TodoDialogHostDeps, TodoDialogOpening } from "./InboxTodoDialog";

const mocks = vi.hoisted(() => ({
  addTodos: vi.fn(),
  fromLocalMoment: vi.fn(),
  pickerStart: vi.fn(),
  realFromLocalMoment: null as null | ((v: string) => Date | null),
  realPickerStart: null as null | ((now?: Date) => string),
}));

vi.mock("../../lib/inbox-actions", async (original) => {
  const real = await original<typeof import("../../lib/inbox-actions")>();
  mocks.realFromLocalMoment = real.fromLocalMoment;
  mocks.realPickerStart = real.pickerStart;
  return {
    ...real,
    addTodos: (...args: Parameters<typeof real.addTodos>) => mocks.addTodos(...args),
    fromLocalMoment: (v: string) => mocks.fromLocalMoment(v),
    pickerStart: (...args: Parameters<typeof real.pickerStart>) => mocks.pickerStart(...args),
  };
});

const {
  openTodoDialog,
  TodoDialog,
  TodoDialogHost,
  TodoDialogHostView,
  TodoDialogView,
} = await import("./InboxTodoDialog");
const { initI18n, t } = await import("../../i18n");

function deferred<T = number>() {
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
    get listenerCount() {
      return listeners.size;
    },
  };
}

const makeItem = (id: string, patch: Partial<InboxItem> = {}): InboxItem => ({
  id,
  source: "example",
  kind: "dm",
  account: "example-acct",
  account_name: "Example",
  title: `Item ${id}`,
  preview: `Preview ${id}`,
  count: 1,
  tier: "action",
  version: `v-${id}`,
  ...patch,
});

const FIXED_PICKER = "2026-05-10T14:30";
const FIXED_EPOCH_MS = Date.UTC(2026, 4, 10, 14, 10, 0);

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
const radioButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-todo-due] [role="radio"]')];
const radioByLabel = (label: string) => radioButtons().find((b) => b.textContent?.trim() === label)!;
const buttonByLabel = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const dateInput = () => document.querySelector<HTMLInputElement>("[data-todo-at]");

const expectNoDefaultSingletons = () => {
  expect(mocks.addTodos).not.toHaveBeenCalled();
  expect(mocks.fromLocalMoment).not.toHaveBeenCalled();
  expect(mocks.pickerStart).not.toHaveBeenCalled();
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initI18n("en");
  vi.clearAllMocks();
  mocks.fromLocalMoment.mockImplementation((v: string) => mocks.realFromLocalMoment!(v));
  mocks.pickerStart.mockImplementation((d?: Date) => mocks.realPickerStart!(d));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  // Drain any module-global opening left by a default-fallback test.
  const cleanupHost = document.createElement("div");
  document.body.append(cleanupHost);
  const cleanupRoot = createRoot(cleanupHost);
  act(() => cleanupRoot.render(<TodoDialogHost />));
  const cancel = buttonByLabel(t("common.cancel"));
  if (cancel) act(() => cancel.click());
  act(() => cleanupRoot.unmount());
  cleanupHost.remove();
});

describe("TodoDialogView & TodoDialogHostView (pure presentation)", () => {
  it("renders choices, picker input, ARIA state, busy/disabled buttons, and invokes callbacks without touching singletons", async () => {
    const onPickChange = vi.fn();
    const onAtChange = vi.fn();
    const onSubmit = vi.fn();
    const onClose = vi.fn();

    await act(async () => root.render(
      <TodoDialogView
        count={2}
        pick="today"
        at={FIXED_PICKER}
        busy={false}
        canSubmit
        onPickChange={onPickChange}
        onAtChange={onAtChange}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    ));

    expect(document.querySelector("[data-todo-due]")?.getAttribute("aria-label")).toBe(t("inbox-inboxlist.todo_due"));
    expect(radioByLabel(t("inbox-inboxlist.todo_today")).getAttribute("aria-checked")).toBe("true");
    expect(dateInput()).toBeNull();

    await act(async () => radioByLabel(t("inbox-inboxlist.todo_pick")).click());
    expect(onPickChange).toHaveBeenCalledWith("at");

    await act(async () => buttonByLabel(t("inbox-inboxlist.todo_add")).click());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => buttonByLabel(t("common.cancel")).click());
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <TodoDialogView
        count={2}
        pick="at"
        at=""
        busy
        canSubmit={false}
        onPickChange={onPickChange}
        onAtChange={onAtChange}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    ));
    expect(dateInput()).not.toBeNull();
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).disabled).toBe(true);
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).getAttribute("aria-busy")).toBe("true");

    await act(async () => root.render(<TodoDialogHostView opening={null} onClose={onClose} />));
    expect(document.querySelector("[data-todo-due]")).toBeNull();
    expectNoDefaultSingletons();
  });
});

describe("TodoDialog controlled deps, clock determinism, fencing, and error recovery", () => {
  it("bypasses inbox-actions singletons with deterministic pickerStart, now, fromLocalMoment, and addTodos", async () => {
    const parsedDate = new Date(FIXED_EPOCH_MS);
    const parseMoment = vi.fn((v: string) => (v === FIXED_PICKER ? parsedDate : null));
    const addFn = vi.fn(async (_items: InboxItem[], _due: DueChoice, _signal: AbortSignal) => 1);
    const onDone = vi.fn();
    const onClose = vi.fn();
    const itemA = makeItem("a");

    await act(async () => root.render(
      <StrictMode>
        <TodoDialog
          items={[itemA]}
          onDone={onDone}
          onClose={onClose}
          deps={{
            pickerStart: () => FIXED_PICKER,
            fromLocalMoment: parseMoment,
            addTodos: addFn,
          }}
        />
      </StrictMode>,
    ));

    await act(async () => radioByLabel(t("inbox-inboxlist.todo_pick")).click());
    expect(dateInput()?.value).toBe(FIXED_PICKER);
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).disabled).toBe(false);

    await act(async () => buttonByLabel(t("inbox-inboxlist.todo_add")).click());
    await flush();
    expect(addFn).toHaveBeenCalledTimes(1);
    expect(addFn.mock.calls[0][0]).toEqual([itemA]);
    expect(addFn.mock.calls[0][1]).toEqual({ kind: "at", at: parsedDate });
    expect(addFn.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();

    // `now` computes pickerStart deterministically via realPickerStart(new Date(now)) without reading wall clock.
    mocks.pickerStart.mockClear();
    const expectedFromNow = mocks.realPickerStart!(new Date(FIXED_EPOCH_MS));
    await act(async () => root.render(
      <TodoDialog
        items={[makeItem("b")]}
        onClose={vi.fn()}
        deps={{
          now: () => FIXED_EPOCH_MS,
          fromLocalMoment: parseMoment,
          addTodos: addFn,
        }}
      />,
    ));
    await act(async () => radioByLabel(t("inbox-inboxlist.todo_pick")).click());
    expect(dateInput()?.value).toBe(expectedFromNow);
    expect(mocks.pickerStart).toHaveBeenCalledWith(new Date(FIXED_EPOCH_MS));
  });

  it("enforces single-flight busy guard, recovers cleanly via try/finally on reject/throw (even when onError throws), and fences items ABA, scope ABA, and unmount", async () => {
    const scopeBox = createExternalBox("s1");
    const calls: Array<{ items: InboxItem[]; signal: AbortSignal; gate: ReturnType<typeof deferred<number>> }> = [];
    const onDone = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    const itemA = makeItem("a");
    const itemB = makeItem("b");

    const makeDeps = (extra?: Partial<TodoDialogDeps>): TodoDialogDeps => ({
      scopeKey: () => scopeBox.get(),
      subscribeScopeKey: scopeBox.subscribe,
      pickerStart: FIXED_PICKER,
      fromLocalMoment: () => new Date(FIXED_EPOCH_MS),
      addTodos: (items, _due, signal) => {
        const gate = deferred<number>();
        calls.push({ items, signal, gate });
        return gate.promise;
      },
      onError,
      ...extra,
    });

    await act(async () => root.render(<TodoDialog items={[itemA]} onDone={onDone} onClose={onClose} deps={makeDeps()} />));

    // Synchronous double-click admits only one addTodos call.
    await act(async () => {
      buttonByLabel(t("inbox-inboxlist.todo_add")).click();
      buttonByLabel(t("inbox-inboxlist.todo_add")).click();
    });
    expect(calls).toHaveLength(1);
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).disabled).toBe(true);
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).getAttribute("aria-busy")).toBe("true");

    // Async rejection in active scope reports error (even if onError throws) and releases busy via try/finally without calling onDone/onClose.
    onError.mockImplementationOnce(() => { throw new Error("observer failure"); });
    await act(async () => {
      calls[0].gate.reject(new Error("add failed"));
      await Promise.resolve();
    });
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).disabled).toBe(false);

    // Items ABA switch ([a] -> [b] -> [a]): aborts first request, resets pick/busy, and ignores late resolve/reject.
    await act(async () => radioByLabel(t("inbox-inboxlist.todo_none")).click());
    expect(radioByLabel(t("inbox-inboxlist.todo_none")).getAttribute("aria-checked")).toBe("true");
    await act(async () => buttonByLabel(t("inbox-inboxlist.todo_add")).click());
    expect(calls).toHaveLength(2);
    expect(calls[1].signal.aborted).toBe(false);

    await act(async () => root.render(<TodoDialog items={[itemB]} onDone={onDone} onClose={onClose} deps={makeDeps()} />));
    expect(calls[1].signal.aborted).toBe(true);
    expect(radioByLabel(t("inbox-inboxlist.todo_today")).getAttribute("aria-checked")).toBe("true");
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).disabled).toBe(false);

    await act(async () => root.render(<TodoDialog items={[itemA]} onDone={onDone} onClose={onClose} deps={makeDeps()} />));
    await act(async () => {
      calls[1].gate.resolve(1);
      await Promise.resolve();
    });
    await flush();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Synchronous ABA burst on scopeKey (s1 -> s2 -> s1) aborts in-flight add and discards its late rejection.
    await act(async () => buttonByLabel(t("inbox-inboxlist.todo_add")).click());
    expect(calls).toHaveLength(3);
    await act(async () => {
      scopeBox.set("s2");
      scopeBox.set("s1");
    });
    expect(calls[2].signal.aborted).toBe(true);
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).disabled).toBe(false);
    await act(async () => {
      calls[2].gate.reject(new Error("stale scope reject"));
      await Promise.resolve();
    });
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);

    // Synchronous throw in addTodos reports error without sticking busy, and retry succeeds.
    let shouldThrow = true;
    const syncErrors: unknown[] = [];
    const syncClose = vi.fn();
    const syncDone = vi.fn();
    await act(async () => root.render(
      <TodoDialog
        items={[itemA]}
        onDone={syncDone}
        onClose={syncClose}
        deps={{
          pickerStart: FIXED_PICKER,
          fromLocalMoment: () => new Date(FIXED_EPOCH_MS),
          addTodos: () => {
            if (shouldThrow) throw new Error("sync boom");
            return 0;
          },
          onError: (e) => { syncErrors.push(e); },
        }}
      />,
    ));
    await act(async () => buttonByLabel(t("inbox-inboxlist.todo_add")).click());
    expect(syncErrors).toHaveLength(1);
    expect(syncDone).not.toHaveBeenCalled();
    expect(syncClose).not.toHaveBeenCalled();
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).disabled).toBe(false);

    shouldThrow = false;
    await act(async () => buttonByLabel(t("inbox-inboxlist.todo_add")).click());
    expect(syncDone).not.toHaveBeenCalled(); // count === 0 skips onDone, still closes
    expect(syncClose).toHaveBeenCalledTimes(1);

    // Unmount aborts active request and prevents stale onDone/onClose.
    await act(async () => root.render(<TodoDialog items={[itemA]} onDone={onDone} onClose={onClose} deps={makeDeps()} />));
    await act(async () => buttonByLabel(t("inbox-inboxlist.todo_add")).click());
    const last = calls.at(-1)!;
    await act(async () => root.render(null));
    expect(last.signal.aborted).toBe(true);
    await act(async () => {
      last.gate.resolve(1);
      await Promise.resolve();
    });
    await flush();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed scope and in-flight addTodos intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const addGate = deferred<number>();
    let capturedSignal: AbortSignal | null = null;
    const onDone = vi.fn();
    const onClose = vi.fn();
    const renderedScopes: string[] = [];
    const itemA = makeItem("a");

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
          <TodoDialog
            items={[itemA]}
            onDone={onDone}
            onClose={onClose}
            deps={{
              scopeKey: state.scope,
              pickerStart: FIXED_PICKER,
              fromLocalMoment: () => new Date(FIXED_EPOCH_MS),
              addTodos: (_items, _due, signal) => {
                capturedSignal = signal;
                return addGate.promise;
              },
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => buttonByLabel(t("inbox-inboxlist.todo_add")).click());
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    expect(buttonByLabel(t("inbox-inboxlist.todo_add")).disabled).toBe(true);

    // Suspended transition to s2 must NOT abort s1's in-flight request.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);

    // Abandon transition back to s1; resolving addGate completes cleanly.
    await act(async () => setHarness({ scope: "s1", block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => {
      addGate.resolve(1);
      await Promise.resolve();
    });
    await flush();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });
});

describe("TodoDialogHost controlled deps, snapshot caching, renderView, and default fallback", () => {
  it("bypasses module-global opening, caches structurally equal getter snapshots with zero subscription churn, and fences host close across scopes", async () => {
    const itemA = makeItem("a");
    const doneA = vi.fn();
    const openingBox = createExternalBox<TodoDialogOpening | null>({ items: [itemA], done: doneA });
    const scopeBox = createExternalBox("s1");
    const closeFn = vi.fn();
    const addFn = vi.fn(async () => 1);
    let openingReads = 0;

    // Return fresh structurally identical opening objects on every snapshot read.
    const makeHostDeps = (): TodoDialogHostDeps => ({
      scopeKey: () => scopeBox.get(),
      subscribeScopeKey: scopeBox.subscribe,
      opening: () => {
        openingReads += 1;
        const cur = openingBox.get();
        return cur ? { items: cur.items.map((it) => ({ ...it })), done: cur.done } : null;
      },
      subscribeOpening: openingBox.subscribe,
      close: closeFn,
      dialogDeps: {
        pickerStart: FIXED_PICKER,
        fromLocalMoment: () => new Date(FIXED_EPOCH_MS),
        addTodos: addFn,
      },
    });

    await act(async () => root.render(<StrictMode><TodoDialogHost deps={makeHostDeps()} /></StrictMode>));
    expect(document.querySelector("[data-todo-due]")).not.toBeNull();
    const subsAfterMount = openingBox.subscribeCount;
    const scopeSubsAfterMount = scopeBox.subscribeCount;

    // Emitting unchanged semantic values must not loop or churn subscriptions.
    await act(async () => openingBox.notify());
    expect(openingReads).toBeLessThan(30);
    expect(openingBox.subscribeCount).toBe(subsAfterMount);
    expect(scopeBox.subscribeCount).toBe(scopeSubsAfterMount);

    // Module-global openTodoDialog must not affect controlled host.
    await act(async () => openTodoDialog([makeItem("global-ignored")]));
    expect(document.querySelector("[data-todo-due]")).not.toBeNull();

    // Closing via Cancel invokes controlled close callback.
    await act(async () => buttonByLabel(t("common.cancel")).click());
    expect(closeFn).toHaveBeenCalledTimes(1);

    // Re-render with fresh inline getters does not churn subscriptions.
    await act(async () => root.render(<StrictMode><TodoDialogHost deps={makeHostDeps()} /></StrictMode>));
    expect(openingBox.subscribeCount).toBe(subsAfterMount);
    expect(scopeBox.subscribeCount).toBe(scopeSubsAfterMount);

    // Custom renderView receives host props and fences stale onClose after scope switch.
    let capturedClose: (() => void) | null = null;
    const closeFenced = vi.fn();
    await act(async () => root.render(
      <TodoDialogHost
        deps={{
          scopeKey: () => scopeBox.get(),
          subscribeScopeKey: scopeBox.subscribe,
          opening: { items: [itemA] },
          close: closeFenced,
          renderView: (p) => {
            capturedClose = p.onClose;
            return <div data-custom-host={p.dialogKey ?? "none"} />;
          },
        }}
      />,
    ));
    const staleClose = capturedClose!;
    await act(async () => scopeBox.set("s2"));
    await act(async () => staleClose());
    expect(closeFenced).not.toHaveBeenCalled();

    // Active scope close works.
    await act(async () => capturedClose!());
    expect(closeFenced).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("preserves default module-global opening and inbox-actions fallbacks when deps are omitted", async () => {
    const itemA = makeItem("default-a");
    const done = vi.fn();
    const relativeMs = Date.now() + 30 * 60_000;
    const relativePicker = mocks.realPickerStart!(new Date(relativeMs));
    mocks.pickerStart.mockReturnValue(relativePicker);
    mocks.addTodos.mockResolvedValueOnce(1);

    await act(async () => root.render(<TodoDialogHost />));
    expect(document.querySelector("[data-todo-due]")).toBeNull();

    await act(async () => openTodoDialog([itemA], done));
    expect(document.querySelector("[data-todo-due]")).not.toBeNull();
    expect(mocks.pickerStart).toHaveBeenCalledTimes(1);
    expect(mocks.fromLocalMoment).toHaveBeenCalledWith(relativePicker);

    await act(async () => radioByLabel(t("inbox-inboxlist.todo_pick")).click());
    expect(dateInput()?.value).toBe(relativePicker);

    await act(async () => buttonByLabel(t("inbox-inboxlist.todo_add")).click());
    await flush();

    expect(mocks.addTodos).toHaveBeenCalledTimes(1);
    expect(mocks.addTodos.mock.calls[0][0]).toEqual([itemA]);
    expect(mocks.addTodos.mock.calls[0][1]).toEqual({ kind: "at", at: mocks.realFromLocalMoment!(relativePicker) });
    expect(done).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-todo-due]")).toBeNull();
  });
});
