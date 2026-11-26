// @vitest-environment jsdom
// Controlled MainChatAgentNotice bypasses store/session-models singletons, caches fresh-object/array getters via
// sameValue, preserves render purity across abandoned concurrent renders, fences readLaunchers & onNewMain across
// scopeKey/session.machine_id/session.session_id/isMain/ABA/unmount, recovers via try/finally, and preserves default
// trailing-read useRevisionReread parity when deps is omitted.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { AssistantLaunchers } from "../../lib/session-models";
import type { Session } from "../../lib/types";
import type { MainChatAgentNoticeDeps, MainChatAgentNoticeViewProps } from "./MainChatAgentNotice";

const mocks = vi.hoisted(() => ({
  assistant: { machine_id: "hub", main: "c1", launcher: "claude", conversations: [] } as { machine_id: string; main?: string; launcher?: string; conversations: unknown[] } | null,
  features: ["assistant_model_pick"] as string[],
  launchersInfo: undefined as AssistantLaunchers | undefined,
  launchersRead: undefined as Promise<void> | undefined,
  useStore: vi.fn(),
  useModelLists: vi.fn(),
  assistantLaunchers: vi.fn(),
  readAssistantLaunchers: vi.fn(),
  useRevisionReread: vi.fn(),
}));

vi.mock("../../lib/store", async (original) => ({
  ...(await original<typeof import("../../lib/store")>()),
  useStore: (select: (s: { assistant: typeof mocks.assistant; features: string[] }) => unknown) => {
    mocks.useStore();
    return select({ assistant: mocks.assistant, features: mocks.features });
  },
}));

vi.mock("../../lib/session-models", async (original) => {
  const actual = await original<typeof import("../../lib/session-models")>();
  return {
    ...actual,
    useModelLists: () => {
      mocks.useModelLists();
      return 0;
    },
    assistantLaunchers: (mid: string) => {
      mocks.assistantLaunchers(mid);
      return { info: mocks.launchersInfo, read: mocks.launchersRead };
    },
    readAssistantLaunchers: (mid: string, opts?: { again?: boolean }) => mocks.readAssistantLaunchers(mid, opts),
    useRevisionReread: (s: Session | undefined, enabled: boolean, read: () => void | (() => void)) => {
      mocks.useRevisionReread(s, enabled);
      return actual.useRevisionReread(s, enabled, read);
    },
  };
});

const { MainChatAgentNotice, MainChatAgentNoticeView } = await import("./MainChatAgentNotice");

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const MISMATCH_INFO: AssistantLaunchers = {
  launchers: [
    { name: "claude", source: "builtin" },
    { name: "codex", source: "builtin", agent: "codex" },
  ],
  def: { provider: "claude" },
  unavailable: [],
};

const SAME_KIND_INFO: AssistantLaunchers = {
  launchers: [
    { name: "codex", source: "builtin", agent: "codex" },
    { name: "codex-alt", source: "zshrc", agent: "codex" },
  ],
  def: { provider: "codex-alt" },
  unavailable: [],
};

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  machine_id: "hub",
  session_id: "c1",
  title: "",
  cwd: "/",
  assistant: true,
  status: "idle",
  state: "idle",
  agent: "codex",
  launcher: "codex",
  model: "gpt-5.5",
  rev: 1,
  ...overrides,
}) as Session;

const expectNoDefaultSingletons = () => {
  expect(mocks.useStore).not.toHaveBeenCalled();
  expect(mocks.useModelLists).not.toHaveBeenCalled();
  expect(mocks.assistantLaunchers).not.toHaveBeenCalled();
  expect(mocks.readAssistantLaunchers).not.toHaveBeenCalled();
  expect(mocks.useRevisionReread).not.toHaveBeenCalled();
};

const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });

let host: HTMLDivElement;
let root: Root;

const notice = () => host.querySelector<HTMLElement>("[data-main-chat-agent-notice]");
const newMainButton = () =>
  [...(notice()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === t("assistant-assistantchat.new_main_ellipsis"));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.assistant = { machine_id: "hub", main: "c1", launcher: "claude", conversations: [] };
  mocks.features = ["assistant_model_pick"];
  mocks.launchersInfo = MISMATCH_INFO;
  mocks.launchersRead = undefined;
  mocks.useStore.mockReset();
  mocks.useModelLists.mockReset();
  mocks.assistantLaunchers.mockReset();
  mocks.readAssistantLaunchers.mockReset();
  mocks.useRevisionReread.mockReset();
  mocks.readAssistantLaunchers.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("MainChatAgentNoticeView (pure presentation)", () => {
  it("renders mismatch labels, optional button, and busy state without touching singletons", async () => {
    const onNewMain = vi.fn();

    await act(async () => root.render(
      <MainChatAgentNoticeView configuredLabel="Claude" actualLabel="Codex" onNewMain={onNewMain} busy={false} />,
    ));
    expect(notice()?.getAttribute("role")).toBe("status");
    expect(notice()?.textContent).toContain("Claude");
    expect(notice()?.textContent).toContain("Codex");
    expect(newMainButton()?.className).toContain("touch-hit");
    expect(newMainButton()?.disabled).toBe(false);

    await act(async () => { newMainButton()!.click(); });
    expect(onNewMain).toHaveBeenCalledTimes(1);

    await act(async () => root.render(
      <MainChatAgentNoticeView configuredLabel="Claude" actualLabel="Codex" onNewMain={onNewMain} busy />,
    ));
    expect(newMainButton()?.disabled).toBe(true);
    expect(newMainButton()?.getAttribute("aria-busy")).toBe("true");

    await act(async () => root.render(
      <MainChatAgentNoticeView configuredLabel="Claude" actualLabel="Codex" />,
    ));
    expect(newMainButton()).toBeUndefined();
    expectNoDefaultSingletons();
  });
});

describe("MainChatAgentNotice controlled mode, snapshot caching, fencing, and error recovery", () => {
  it("bypasses all default singletons, caches fresh-object getters via sameValue, and preserves DOM identity across direct-to-subscribed switch", async () => {
    const listeners = new Set<() => void>();
    let subCount = 0;
    const subscribe = (l: () => void) => {
      subCount += 1;
      listeners.add(l);
      return () => { listeners.delete(l); };
    };
    let info: AssistantLaunchers = MISMATCH_INFO;
    let kept = true;
    let infoReads = 0;
    const onNewMainDep = vi.fn();
    const propOnNewMain = vi.fn();
    const session = makeSession();

    // Direct controlled mode (without readLaunchers -> zero readAssistantLaunchers calls).
    await act(async () => root.render(
      <StrictMode>
        <MainChatAgentNotice
          session={session}
          isMain
          onNewMain={propOnNewMain}
          deps={{
            scopeKey: "s1",
            assistant: { launcher: "claude" },
            kept,
            launchersInfo: info,
            onNewMain: onNewMainDep,
          }}
        />
      </StrictMode>,
    ));
    const initialNotice = notice()!;
    expect(initialNotice).not.toBeNull();
    expect(initialNotice.textContent).toContain("claude");
    expect(initialNotice.textContent).toContain("codex");
    expectNoDefaultSingletons();

    // Switch in-place to fresh-object/array getters + shared subscribe on the same scope.
    const makeGetterDeps = (): MainChatAgentNoticeDeps => ({
      scopeKey: () => "s1",
      assistant: () => ({ launcher: "claude" }),
      kept: () => kept,
      launchersInfo: () => {
        infoReads += 1;
        return {
          launchers: info.launchers.map((l) => ({ ...l })),
          def: info.def ? { ...info.def } : info.def,
          unavailable: [...info.unavailable],
        };
      },
      subscribe,
      onNewMain: onNewMainDep,
    });
    await act(async () => root.render(
      <StrictMode>
        <MainChatAgentNotice session={session} isMain onNewMain={propOnNewMain} deps={makeGetterDeps()} />
      </StrictMode>,
    ));
    expect(notice()).toBe(initialNotice);
    expect(infoReads).toBeLessThan(20);

    // Inline arrow getters on re-render must not churn subscriptions.
    const subsAfterAttach = subCount;
    await act(async () => root.render(
      <StrictMode>
        <MainChatAgentNotice session={session} isMain onNewMain={propOnNewMain} deps={makeGetterDeps()} />
      </StrictMode>,
    ));
    expect(subCount).toBe(subsAfterAttach);

    // Identical re-emission does not loop.
    await act(async () => { listeners.forEach((l) => l()); });
    expect(infoReads).toBeLessThan(30);

    // Controlled deps.onNewMain overrides prop onNewMain.
    await act(async () => { newMainButton()!.click(); });
    expect(onNewMainDep).toHaveBeenCalledTimes(1);
    expect(propOnNewMain).not.toHaveBeenCalled();

    // Switching launchersInfo to same-kind hides notice cleanly.
    info = SAME_KIND_INFO;
    await act(async () => { listeners.forEach((l) => l()); });
    expect(notice()).toBeNull();
    expectNoDefaultSingletons();
  });

  it("fences controlled readLaunchers (including revision/trailing reads) and async onNewMain across scopeKey, ABA, machine_id, session_id, isMain, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    let currentScope = "s1";
    const readCalls: Array<{ mid: string; signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];
    const newMainCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }> = [];
    const onError = vi.fn();
    let holdSamePromise = false;
    let activeReadPromise: Promise<void> | undefined;

    const makeDeps = (): MainChatAgentNoticeDeps => ({
      scopeKey: () => currentScope,
      subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
      assistant: { launcher: "claude" },
      kept: true,
      launchersInfo: MISMATCH_INFO,
      readLaunchers: (mid, { signal }) => {
        if (holdSamePromise && activeReadPromise) {
          readCalls.push({ mid, signal, gate: readCalls.at(-1)!.gate });
          return activeReadPromise;
        }
        const gate = deferred<void>();
        activeReadPromise = gate.promise.finally(() => {
          if (activeReadPromise === gate.promise) activeReadPromise = undefined;
        });
        readCalls.push({ mid, signal, gate });
        return activeReadPromise;
      },
      onNewMain: (signal) => {
        const gate = deferred<void>();
        newMainCalls.push({ signal, gate });
        return gate.promise;
      },
      onError,
    });

    // Mount starts initial readLaunchers; rev bump while coalesced pending read schedules trailing read.
    holdSamePromise = true;
    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ rev: 1 })} isMain deps={makeDeps()} />));
    expect(readCalls).toHaveLength(1);
    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ rev: 2 })} isMain deps={makeDeps()} />));
    expect(readCalls).toHaveLength(2);

    // Start async onNewMain and verify single-flight guard.
    await act(async () => { newMainButton()!.click(); });
    await act(async () => { newMainButton()!.click(); });
    expect(newMainCalls).toHaveLength(1);
    expect(newMainButton()?.disabled).toBe(true);

    // Synchronous ABA burst on scopeKey aborts both readLaunchers and onNewMain, cancels trailing read, and clears busy.
    holdSamePromise = false;
    await act(async () => {
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
      currentScope = "s1";
      scopeListeners.forEach((l) => l());
    });
    expect(readCalls[0].signal.aborted).toBe(true);
    expect(newMainCalls[0].signal.aborted).toBe(true);
    expect(newMainButton()?.disabled).toBe(false);
    const readsAfterAba = readCalls.length;
    await act(async () => {
      readCalls[0].gate.resolve();
      newMainCalls[0].gate.reject(new Error("late after ABA"));
      await flush();
    });
    // Trailing read from aborted epoch must NOT fire and late error must be discarded.
    expect(readCalls).toHaveLength(readsAfterAba);
    expect(onError).not.toHaveBeenCalled();

    // Switching session.machine_id aborts in-flight read and action.
    await act(async () => { newMainButton()!.click(); });
    const prevRead = readCalls.at(-1)!;
    const prevAction = newMainCalls.at(-1)!;
    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ machine_id: "hub-2", rev: 2 })} isMain deps={makeDeps()} />));
    expect(prevRead.signal.aborted).toBe(true);
    expect(prevAction.signal.aborted).toBe(true);
    expect(readCalls.at(-1)!.mid).toBe("hub-2");

    // Switching session.session_id aborts in-flight read and action.
    await act(async () => { newMainButton()!.click(); });
    const readBeforeSid = readCalls.at(-1)!;
    const actionBeforeSid = newMainCalls.at(-1)!;
    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ machine_id: "hub-2", session_id: "c2", rev: 2 })} isMain deps={makeDeps()} />));
    expect(readBeforeSid.signal.aborted).toBe(true);
    expect(actionBeforeSid.signal.aborted).toBe(true);

    // Toggling isMain false aborts in-flight read and action and hides notice.
    await act(async () => { newMainButton()!.click(); });
    const readBeforeMainOff = readCalls.at(-1)!;
    const actionBeforeMainOff = newMainCalls.at(-1)!;
    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ machine_id: "hub-2", session_id: "c2", rev: 2 })} isMain={false} deps={makeDeps()} />));
    expect(readBeforeMainOff.signal.aborted).toBe(true);
    expect(actionBeforeMainOff.signal.aborted).toBe(true);
    expect(notice()).toBeNull();

    // Re-enable isMain, start action, unmount -> aborts and discards late rejections.
    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ machine_id: "hub-2", session_id: "c2", rev: 2 })} isMain deps={makeDeps()} />));
    await act(async () => { newMainButton()!.click(); });
    const finalRead = readCalls.at(-1)!;
    const finalAction = newMainCalls.at(-1)!;
    await act(async () => root.render(null));
    expect(finalRead.signal.aborted).toBe(true);
    expect(finalAction.signal.aborted).toBe(true);
    await act(async () => {
      finalRead.gate.reject(new Error("late read error"));
      finalAction.gate.reject(new Error("late action error"));
      await flush();
    });
    expect(onError).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed scope and in-flight readLaunchers/onNewMain intact across an abandoned concurrent transition render", async () => {
    const suspendGate = deferred<void>();
    const readGate = deferred<void>();
    const newMainGate = deferred<void>();
    let readSignal: AbortSignal | null = null;
    let actionSignal: AbortSignal | null = null;
    const renderedScopes: string[] = [];

    function SuspendIf({ block }: { block: boolean }) {
      if (block) throw suspendGate.promise;
      return null;
    }

    const session = makeSession();
    let setHarness!: (next: { scope: string; block: boolean }) => void;
    function Harness() {
      const [state, setState] = useState({ scope: "s1", block: false });
      setHarness = setState;
      renderedScopes.push(state.scope);
      return (
        <Suspense fallback={<div data-fallback />}>
          <MainChatAgentNotice
            session={session}
            isMain
            deps={{
              scopeKey: state.scope,
              assistant: { launcher: "claude" },
              kept: true,
              launchersInfo: MISMATCH_INFO,
              readLaunchers: (_mid, { signal }) => {
                readSignal = signal;
                return readGate.promise;
              },
              onNewMain: (signal) => {
                actionSignal = signal;
                return newMainGate.promise;
              },
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => { newMainButton()!.click(); });
    expect(readSignal!.aborted).toBe(false);
    expect(actionSignal!.aborted).toBe(false);
    expect(newMainButton()?.disabled).toBe(true);

    // Suspended transition to s2 must NOT abort s1's in-flight read or action.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(readSignal!.aborted).toBe(false);
    expect(actionSignal!.aborted).toBe(false);

    // Revert back to s1 and resolve -> clears busy cleanly.
    await act(async () => setHarness({ scope: "s1", block: false }));
    await act(async () => {
      readGate.resolve();
      newMainGate.resolve();
      await flush();
    });
    expect(newMainButton()?.disabled).toBe(false);
    expectNoDefaultSingletons();
  });

  it("recovers via try/finally on sync throws and async rejections in readLaunchers and onNewMain and supports renderView", async () => {
    let actionMode: "sync-throw" | "async-reject" | "ok" = "sync-throw";
    let readMode: "sync-throw" | "async-reject" = "sync-throw";
    const errors: unknown[] = [];
    let latestView!: MainChatAgentNoticeViewProps;

    const makeDeps = (): MainChatAgentNoticeDeps => ({
      scopeKey: "s1",
      assistant: { launcher: "claude" },
      kept: true,
      launchersInfo: MISMATCH_INFO,
      readLaunchers: () => {
        if (readMode === "sync-throw") throw new Error("sync read failed");
        return Promise.reject(new Error("async read failed"));
      },
      onNewMain: () => {
        if (actionMode === "sync-throw") throw new Error("sync new-main failed");
        if (actionMode === "async-reject") return Promise.reject(new Error("async new-main failed"));
        return Promise.resolve();
      },
      onError: (err) => {
        errors.push(err);
        throw new Error("observer crashed");
      },
      renderView: (props) => {
        latestView = props;
        return <div data-custom-notice data-busy={String(props.busy)}>{props.configuredLabel} vs {props.actualLabel}</div>;
      },
    });

    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ rev: 1 })} isMain deps={makeDeps()} />));
    await flush();
    expect(errors).toHaveLength(1);
    expect(host.querySelector("[data-custom-notice]")?.textContent).toBe("claude vs codex");

    // Async readLaunchers rejection on revision bump reports error cleanly.
    readMode = "async-reject";
    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ rev: 2 })} isMain deps={makeDeps()} />));
    await flush();
    expect(errors).toHaveLength(2);

    // Sync throw on onNewMain releases lock/busy.
    await act(async () => { latestView.onNewMain!(); });
    expect(errors).toHaveLength(3);
    expect(latestView.busy).toBe(false);

    // Async rejection on onNewMain releases lock/busy.
    actionMode = "async-reject";
    await act(async () => { latestView.onNewMain!(); await flush(); });
    expect(errors).toHaveLength(4);
    expect(latestView.busy).toBe(false);

    // Subsequent retry succeeds.
    actionMode = "ok";
    await act(async () => { latestView.onNewMain!(); await flush(); });
    expect(errors).toHaveLength(4);
    expect(latestView.busy).toBe(false);
    expectNoDefaultSingletons();
  });

  it("preserves default singletons and trailing-read useRevisionReread parity when deps is omitted", async () => {
    const firstGate = deferred<void>();
    mocks.launchersInfo = undefined;
    mocks.readAssistantLaunchers.mockImplementation(() => {
      if (!mocks.launchersRead) mocks.launchersRead = firstGate.promise;
      return mocks.launchersRead;
    });
    const onNewMain = vi.fn();

    // First mount with info still unloaded (mismatch is null -> bridge stays mounted).
    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ rev: 1 })} isMain onNewMain={onNewMain} />));
    expect(mocks.useStore).toHaveBeenCalled();
    expect(mocks.useModelLists).toHaveBeenCalled();
    expect(mocks.assistantLaunchers).toHaveBeenCalledWith("hub");
    expect(mocks.useRevisionReread).toHaveBeenCalled();
    expect(mocks.readAssistantLaunchers).toHaveBeenCalledTimes(1);
    expect(notice()).toBeNull();

    // Info loads AND revision bumps while firstGate is still pending -> schedules trailing read without remounting bridge.
    mocks.launchersInfo = MISMATCH_INFO;
    await act(async () => root.render(<MainChatAgentNotice session={makeSession({ rev: 2 })} isMain onNewMain={onNewMain} />));
    expect(notice()).not.toBeNull();
    expect(mocks.readAssistantLaunchers).toHaveBeenCalledTimes(2);

    // Resolving firstGate fires the trailing read.
    mocks.launchersRead = undefined;
    mocks.readAssistantLaunchers.mockResolvedValue(undefined);
    await act(async () => {
      firstGate.resolve();
      await flush();
    });
    expect(mocks.readAssistantLaunchers).toHaveBeenCalledTimes(3);

    await act(async () => { newMainButton()!.click(); });
    expect(onNewMain).toHaveBeenCalledTimes(1);
  });
});
