// @vitest-environment jsdom
// Controlled ExpiredQuestion bypasses default feed/handoff/store/toast singletons, preserves render purity across
// abandoned concurrent renders, fences answer/later/openTask across scopeKey/todo.id/ask.asked_at/ABA/unmount,
// recovers via try/finally, and preserves default behavior when deps is omitted.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { decisionLaterKey } from "../../lib/assistant-entries";
import type { Todo, TodoAsk } from "../../lib/todos";
import type { Interaction } from "../../lib/types";
import type { ExpiredQuestionAcceptResult, ExpiredQuestionDeps, ExpiredQuestionViewProps } from "./ExpiredQuestion";

const mocks = vi.hoisted(() => ({
  acceptBrief: vi.fn(),
  later: vi.fn(),
  openTask: vi.fn(),
  refreshTodos: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/feed", async (original) => ({
  ...(await original<typeof import("../../lib/feed")>()),
  acceptBrief: (...args: unknown[]) => mocks.acceptBrief(...args),
  later: (...args: unknown[]) => mocks.later(...args),
}));

vi.mock("../../lib/handoff", async (original) => ({
  ...(await original<typeof import("../../lib/handoff")>()),
  openTask: (...args: unknown[]) => mocks.openTask(...args),
}));

vi.mock("../../lib/store", async (original) => ({
  ...(await original<typeof import("../../lib/store")>()),
  refreshTodos: (...args: unknown[]) => mocks.refreshTodos(...args),
}));

vi.mock("../../ui/atoms", async (original) => ({
  ...(await original<typeof import("../../ui/atoms")>()),
  toast: (...args: unknown[]) => mocks.toast(...args),
}));

const { ExpiredQuestion, ExpiredQuestionView } = await import("./ExpiredQuestion");

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const ASKED_AT_1 = "2026-01-10T08:00:00Z";
const ASKED_AT_2 = "2026-01-10T09:00:00Z";

const makeAsk = (askedAt = ASKED_AT_1): TodoAsk => ({
  outcome: "decide",
  verdict: "Needs input",
  asked_at: askedAt,
  questions: [
    {
      question: "Ship to canary first?",
      header: "Rollout",
      multi_select: false,
      options: [
        { label: "Canary", description: "10% first" },
        { label: "Everyone", description: "100% now" },
      ],
    },
  ],
});

const makeTodo = (id = "todo-1", ask = makeAsk()): Todo => ({
  id,
  title: `Task ${id}`,
  manager: "assistant",
  created_at: ASKED_AT_1,
  updated_at: ASKED_AT_1,
  ask,
});

const expectNoDefaultSingletons = () => {
  expect(mocks.acceptBrief).not.toHaveBeenCalled();
  expect(mocks.later).not.toHaveBeenCalled();
  expect(mocks.openTask).not.toHaveBeenCalled();
  expect(mocks.refreshTodos).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
};

const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });

let host: HTMLDivElement;
let root: Root;

const row = () => host.querySelector<HTMLElement>("[data-expired-question]");
const buttonNamed = (label: string) =>
  [...(row()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === label);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(mocks).forEach((fn) => fn.mockReset());
  mocks.acceptBrief.mockResolvedValue("accepted");
  mocks.refreshTodos.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("ExpiredQuestionView (pure presentation)", () => {
  it("renders QuestionCard or recorded confirmation, honors busy disabled buttons, and fires callbacks without touching singletons", async () => {
    const ask = makeAsk();
    const ix: Interaction = {
      id: `todo-1:${ask.asked_at}`,
      manager: "assistant",
      machine_id: "",
      session_id: "",
      kind: "question",
      tool_name: "ask_user",
      questions: ask.questions,
      created_at: ask.asked_at,
    };
    const onAnswer = vi.fn(async () => true);
    const onLater = vi.fn();
    const onOpenTask = vi.fn();

    await act(async () => root.render(
      <ExpiredQuestionView
        rowKey="task:todo-1"
        ix={ix}
        recorded={false}
        busy={false}
        onAnswer={onAnswer}
        onLater={onLater}
        onOpenTask={onOpenTask}
      />,
    ));

    expect(row()?.getAttribute("data-needs-row")).toBe("task:todo-1");
    expect(row()?.textContent).toContain("Ship to canary first?");
    expect(buttonNamed(t("assistant-task-actions.later"))?.disabled).toBe(false);
    expect(buttonNamed(t("assistant-decisionrow.another"))?.disabled).toBe(false);

    await act(async () => { buttonNamed(t("assistant-task-actions.later"))!.click(); });
    await act(async () => { buttonNamed(t("assistant-decisionrow.another"))!.click(); });
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(onOpenTask).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <ExpiredQuestionView
        rowKey="task:todo-1"
        ix={ix}
        recorded
        busy
        onAnswer={onAnswer}
        onLater={onLater}
        onOpenTask={onOpenTask}
      />,
    ));

    expect(row()?.textContent).toContain(t("assistant-decisionrow.answer_recorded"));
    expect(buttonNamed(t("assistant-task-actions.later"))?.disabled).toBe(true);
    expect(buttonNamed(t("assistant-decisionrow.another"))?.disabled).toBe(true);
    expectNoDefaultSingletons();
  });
});

describe("ExpiredQuestion controlled mode, fencing, render purity, and error recovery", () => {
  it("runs fully controlled with custom renderView, handles accepted/handled/later/openTask, and bypasses all default singletons", async () => {
    const ask = makeAsk();
    const todo = makeTodo("todo-1", ask);
    const acceptBriefDep = vi.fn<NonNullable<ExpiredQuestionDeps["acceptBrief"]>>();
    const refreshTodosDep = vi.fn<NonNullable<ExpiredQuestionDeps["refreshTodos"]>>();
    const laterDep = vi.fn<NonNullable<ExpiredQuestionDeps["later"]>>();
    const openTaskDep = vi.fn<NonNullable<ExpiredQuestionDeps["openTask"]>>();
    const notifyDep = vi.fn<NonNullable<ExpiredQuestionDeps["notify"]>>();
    let latestView!: ExpiredQuestionViewProps;

    const deps: ExpiredQuestionDeps = {
      scopeKey: "s1",
      acceptBrief: acceptBriefDep,
      refreshTodos: refreshTodosDep,
      later: laterDep,
      openTask: openTaskDep,
      notify: notifyDep,
      renderView: (props) => {
        latestView = props;
        return (
          <div data-custom-expired>
            <span data-recorded>{String(props.recorded)}</span>
            <span data-busy>{String(props.busy)}</span>
          </div>
        );
      },
    };

    await act(async () => root.render(<StrictMode><ExpiredQuestion todo={todo} ask={ask} rowKey="r1" deps={deps} /></StrictMode>));
    expect(latestView.rowKey).toBe("r1");
    expect(latestView.ix.id).toBe(`todo-1:${ASKED_AT_1}`);
    expect(latestView.recorded).toBe(false);

    // "handled" notifies and returns false without marking recorded.
    acceptBriefDep.mockResolvedValueOnce("handled");
    let ok = true;
    await act(async () => { ok = await latestView.onAnswer({ "Ship to canary first?": "Canary" }); });
    expect(ok).toBe(false);
    expect(refreshTodosDep).toHaveBeenCalledTimes(1);
    expect(notifyDep).toHaveBeenCalledWith(t("assistant-brief.handled"));
    expect(latestView.recorded).toBe(false);

    // "accepted" marks recorded and returns true.
    acceptBriefDep.mockResolvedValueOnce("accepted");
    await act(async () => { ok = await latestView.onAnswer({ "Ship to canary first?": "Canary" }); });
    expect(ok).toBe(true);
    expect(refreshTodosDep).toHaveBeenCalledTimes(2);
    expect(latestView.recorded).toBe(true);

    // Controlled later and openTask receive exact keys/ids.
    await act(async () => { latestView.onLater(); });
    await act(async () => { latestView.onOpenTask(); });
    expect(laterDep).toHaveBeenCalledWith(decisionLaterKey(todo), expect.any(AbortSignal));
    expect(openTaskDep).toHaveBeenCalledWith("todo-1", expect.any(AbortSignal));
    expectNoDefaultSingletons();
  });

  it("fences async answer/later/openTask across scopeKey, ABA bursts, todo.id, ask.asked_at, and unmount while resetting recorded/busy", async () => {
    const scopeListeners = new Set<() => void>();
    const subscribe = (l: () => void) => {
      scopeListeners.add(l);
      return () => { scopeListeners.delete(l); };
    };
    let currentScope = "s1";
    let latestView!: ExpiredQuestionViewProps;
    const answerCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<ExpiredQuestionAcceptResult>> }> = [];
    const laterCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];
    const openCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];
    const refreshTodosDep = vi.fn();
    const notifyDep = vi.fn();
    const onErrorDep = vi.fn();

    const makeDeps = (): ExpiredQuestionDeps => ({
      scopeKey: () => currentScope,
      subscribe,
      acceptBrief: (_todoId, _askedAt, _answer, signal) => {
        const gate = deferred<ExpiredQuestionAcceptResult>();
        answerCalls.push({ signal, gate });
        return gate.promise;
      },
      refreshTodos: refreshTodosDep,
      later: (_key, signal) => {
        const gate = deferred<void>();
        laterCalls.push({ signal, gate });
        return gate.promise;
      },
      openTask: (_id, signal) => {
        const gate = deferred<void>();
        openCalls.push({ signal, gate });
        return gate.promise;
      },
      notify: notifyDep,
      onError: onErrorDep,
      renderView: (props) => {
        latestView = props;
        return <div data-recorded={String(props.recorded)} data-busy={String(props.busy)} />;
      },
    });

    const ask1 = makeAsk(ASKED_AT_1);
    const todo1 = makeTodo("todo-1", ask1);
    await act(async () => root.render(<ExpiredQuestion todo={todo1} ask={ask1} deps={makeDeps()} />));

    // Start answer and verify single-flight ref-lock rejects concurrent calls.
    let pendingPromise!: Promise<boolean>;
    let duplicateResult = true;
    await act(async () => {
      pendingPromise = latestView.onAnswer({ q: "Canary" });
      duplicateResult = await latestView.onAnswer({ q: "Everyone" });
      latestView.onLater();
      latestView.onOpenTask();
    });
    expect(duplicateResult).toBe(false);
    expect(answerCalls).toHaveLength(1);
    expect(laterCalls).toHaveLength(0);
    expect(openCalls).toHaveLength(0);
    expect(latestView.busy).toBe(true);

    // Synchronous ABA burst on scopeKey (s1 -> s2 -> s1) via shared subscribe aborts and resets busy.
    await act(async () => {
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
      currentScope = "s1";
      scopeListeners.forEach((l) => l());
    });
    expect(answerCalls[0].signal.aborted).toBe(true);
    expect(latestView.busy).toBe(false);
    await act(async () => {
      answerCalls[0].gate.resolve("accepted");
      expect(await pendingPromise).toBe(false);
    });
    expect(latestView.recorded).toBe(false);
    expect(refreshTodosDep).not.toHaveBeenCalled();

    // Complete an answer to set recorded=true, then switch ask.asked_at -> recorded resets immediately.
    await act(async () => { pendingPromise = latestView.onAnswer({ q: "Canary" }); });
    await act(async () => {
      answerCalls[1].gate.resolve("accepted");
      expect(await pendingPromise).toBe(true);
    });
    expect(latestView.recorded).toBe(true);

    const ask2 = makeAsk(ASKED_AT_2);
    await act(async () => root.render(<ExpiredQuestion todo={makeTodo("todo-1", ask2)} ask={ask2} deps={makeDeps()} />));
    expect(latestView.recorded).toBe(false);

    // In-flight async later is aborted on todo.id switch and late rejection is discarded.
    await act(async () => { latestView.onLater(); });
    expect(laterCalls).toHaveLength(1);
    expect(latestView.busy).toBe(true);
    await act(async () => root.render(<ExpiredQuestion todo={makeTodo("todo-2", ask2)} ask={ask2} deps={makeDeps()} />));
    expect(laterCalls[0].signal.aborted).toBe(true);
    expect(latestView.busy).toBe(false);
    await act(async () => {
      laterCalls[0].gate.reject(new Error("stale later failure"));
      await Promise.resolve();
    });
    expect(notifyDep).not.toHaveBeenCalled();
    expect(onErrorDep).not.toHaveBeenCalled();

    // In-flight async openTask is aborted on unmount and late rejection is discarded.
    await act(async () => { latestView.onOpenTask(); });
    expect(openCalls).toHaveLength(1);
    await act(async () => root.render(null));
    expect(openCalls[0].signal.aborted).toBe(true);
    await act(async () => {
      openCalls[0].gate.reject(new Error("stale open failure"));
      await Promise.resolve();
    });
    expect(notifyDep).not.toHaveBeenCalled();
    expect(onErrorDep).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed scope and in-flight answer intact across an abandoned concurrent transition render", async () => {
    const suspendGate = deferred<void>();
    const answerGate = deferred<ExpiredQuestionAcceptResult>();
    let capturedSignal: AbortSignal | null = null;
    let latestView!: ExpiredQuestionViewProps;
    const renderedScopes: string[] = [];
    const refreshTodosDep = vi.fn();

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    const ask = makeAsk();
    const todo = makeTodo("todo-1", ask);
    let setHarness!: (next: { scope: string; block: boolean }) => void;

    function Harness() {
      const [state, setState] = useState({ scope: "s1", block: false });
      setHarness = setState;
      renderedScopes.push(state.scope);
      return (
        <Suspense fallback={<div data-fallback />}>
          <ExpiredQuestion
            todo={todo}
            ask={ask}
            deps={{
              scopeKey: state.scope,
              acceptBrief: (_id, _at, _ans, signal) => {
                capturedSignal = signal;
                return answerGate.promise;
              },
              refreshTodos: refreshTodosDep,
              later: vi.fn(),
              openTask: vi.fn(),
              notify: vi.fn(),
              renderView: (props) => {
                latestView = props;
                return <div data-recorded={String(props.recorded)} data-busy={String(props.busy)} />;
              },
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    let pending!: Promise<boolean>;
    await act(async () => { pending = latestView.onAnswer({ q: "Canary" }); });
    expect(capturedSignal!.aborted).toBe(false);
    expect(latestView.busy).toBe(true);

    // Suspended transition to s2 must NOT abort s1's in-flight answer or corrupt committed scope.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(capturedSignal!.aborted).toBe(false);

    // Revert back to s1 and resolve answer -> completes cleanly.
    await act(async () => setHarness({ scope: "s1", block: false }));
    expect(capturedSignal!.aborted).toBe(false);
    await act(async () => {
      answerGate.resolve("accepted");
      expect(await pending).toBe(true);
    });
    expect(latestView.recorded).toBe(true);
    expect(latestView.busy).toBe(false);
    expect(refreshTodosDep).toHaveBeenCalledTimes(1);
    expectNoDefaultSingletons();
  });

  it("releases busy and ref-lock via try/finally on sync throws and async rejections, even when formatError/notify/onError throw", async () => {
    const ask = makeAsk();
    const todo = makeTodo("todo-1", ask);
    let mode: "sync-throw" | "async-reject" | "ok" = "sync-throw";
    let latestView!: ExpiredQuestionViewProps;
    const seenErrors: string[] = [];

    await act(async () => root.render(
      <ExpiredQuestion
        todo={todo}
        ask={ask}
        deps={{
          scopeKey: "s1",
          acceptBrief: () => {
            if (mode === "sync-throw") throw new Error("sync accept failed");
            if (mode === "async-reject") return Promise.reject(new Error("async accept failed"));
            return Promise.resolve("accepted");
          },
          refreshTodos: () => Promise.resolve(),
          later: () => {
            if (mode === "sync-throw") throw new Error("sync later failed");
            return Promise.reject(new Error("async later failed"));
          },
          openTask: () => Promise.reject(new Error("async open failed")),
          formatError: (err) => {
            if (mode === "async-reject") throw new Error("formatter exploded");
            return `fmt:${err instanceof Error ? err.message : String(err)}`;
          },
          notify: () => {
            throw new Error("toast exploded");
          },
          onError: (msg) => {
            seenErrors.push(msg);
            throw new Error("observer exploded");
          },
          renderView: (props) => {
            latestView = props;
            return <div data-busy={String(props.busy)} data-recorded={String(props.recorded)} />;
          },
        }}
      />,
    ));

    // Sync throw on acceptBrief releases busy and lock.
    let res = true;
    await act(async () => { res = await latestView.onAnswer({ q: "Canary" }); });
    expect(res).toBe(false);
    expect(latestView.busy).toBe(false);
    expect(seenErrors.at(-1)).toBe("fmt:sync accept failed");

    // Sync throw on later releases lock.
    await act(async () => { latestView.onLater(); });
    expect(latestView.busy).toBe(false);
    expect(seenErrors.at(-1)).toBe("fmt:sync later failed");

    // Async rejection on acceptBrief with throwing formatter/notify/onError falls back to errorText and unlocks.
    mode = "async-reject";
    await act(async () => { res = await latestView.onAnswer({ q: "Canary" }); });
    expect(res).toBe(false);
    expect(latestView.busy).toBe(false);
    expect(seenErrors.at(-1)).toContain("async accept failed");

    // Async rejection on openTask unlocks cleanly.
    await act(async () => { latestView.onOpenTask(); await flush(); });
    expect(latestView.busy).toBe(false);
    expect(seenErrors.at(-1)).toContain("async open failed");

    // Retry succeeds after prior failures.
    mode = "ok";
    await act(async () => { res = await latestView.onAnswer({ q: "Canary" }); });
    expect(res).toBe(true);
    expect(latestView.recorded).toBe(true);
    expect(latestView.busy).toBe(false);
    expectNoDefaultSingletons();
  });

  it("preserves default singletons when deps is omitted", async () => {
    const ask = makeAsk();
    const todo = makeTodo("todo-1", ask);

    await act(async () => root.render(<ExpiredQuestion todo={todo} ask={ask} rowKey="task:todo-1" />));
    await act(async () => { buttonNamed(t("assistant-task-actions.later"))!.click(); });
    await act(async () => { buttonNamed(t("assistant-decisionrow.another"))!.click(); });
    expect(mocks.later).toHaveBeenCalledWith(decisionLaterKey(todo));
    expect(mocks.openTask).toHaveBeenCalledWith("todo-1");

    // Click an option in QuestionCard (single-select submits immediately).
    const canaryBtn = [...row()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Canary"))!;
    await act(async () => { canaryBtn.click(); await flush(); });
    expect(mocks.acceptBrief).toHaveBeenCalledWith("todo-1", ASKED_AT_1, { answers: { "Ship to canary first?": "Canary" } });
    expect(mocks.refreshTodos).toHaveBeenCalledTimes(1);
    expect(row()!.textContent).toContain(t("assistant-decisionrow.answer_recorded"));
  });
});
