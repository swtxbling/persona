// @vitest-environment jsdom
// A task id without a cached row is not deletion evidence. These cases control every /todos response explicitly.
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } } as unknown as typeof IntersectionObserver;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});

import { t } from "../../i18n";
import { setToken } from "../../lib/api";
import { getFeedState, type FeedItem, type TaskPlan } from "../../lib/feed";
import { chooseManager, resetManagerChoice } from "../../lib/manager-choice";
import { setRoster, type ManagerList } from "../../lib/managers";
import { applyCompleteSessions, dropTodo, getState, putTodo, refreshTodos, reset, setOutbox, setPushGrading, type Conn } from "../../lib/store";
import type { Todo } from "../../lib/todos";
import type { Session } from "../../lib/types";
import { HandoffCard, type Handoff } from "./Handoff";
import { TaskPanel } from "./TaskPanel";
import { FeedLineView } from "./Tasks";
import { useTodoPresence } from "./use-todo-presence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Target = "handoff" | "panel";
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const at = "2026-11-27T08:00:00Z";
const todo = (id: string, extra: Partial<Todo> = {}): Todo => ({ id, title: `Task ${id}`, origin: "example-conversation", created_at: at, updated_at: at, ...extra });
const agent: Session = { machine_id: "example-computer", session_id: "example-agent", title: "Example Agent", cwd: "/example", state: "working", status: "working", updated_at: at } as Session;
const linked = (id: string): Todo => todo(id, { agents: [{ machine_id: agent.machine_id, session_id: agent.session_id, title: agent.title, linked_at: at }] });

let host: HTMLDivElement;
let root: Root;
let mounted = false;
let reads: Deferred<Response>[];
let sequence = 0;
let rosterAnswer: ManagerList;

const oneManager: ManagerList = { default: "assistant", managers: [{ id: "assistant", name: "Assistant", online: true }] };
const twoManagers = (online: boolean): ManagerList => ({
  default: "assistant",
  managers: [
    { id: "assistant", name: "Assistant", online: true },
    { id: "away", name: "Away", online, last_seen: at },
  ],
});

function seed(patch: Record<string, unknown>) {
  Object.assign(getState() as unknown as Record<string, unknown>, patch);
}

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

async function draw(ui: ReactNode) {
  if (!mounted) {
    root = createRoot(host);
    mounted = true;
  }
  await act(async () => { root.render(ui); });
  await flush();
}

async function unmount() {
  if (!mounted) return;
  await act(async () => { root.unmount(); });
  mounted = false;
}

function handoff(id: string, known = false): Handoff {
  return { key: `handoff-${id}`, title: `Task ${id}`, wake: "created", todoId: id, todo: known ? id : undefined, ended: known ? undefined : true };
}

function view(target: Target, id: string, known = false): ReactNode {
  return target === "handoff"
    ? <HandoffCard handoff={handoff(id, known)} />
    : <TaskPanel todoId={id} onClose={() => {}} />;
}

function PresenceProbe({ id, label, onRender }: { id?: string; label: string; onRender: () => void }) {
  onRender();
  const { status } = useTodoPresence(id);
  return <span data-presence-probe={label}>{status}</span>;
}

async function drawTarget(target: Target, id: string, known = false) {
  await draw(view(target, id, known));
}

async function remount(target: Target, id: string) {
  await unmount();
  await drawTarget(target, id);
}

function goneText(target: Target) {
  return t(target === "handoff" ? "assistant-tasks.handoff_gone" : "assistant-taskpanel.gone");
}

function expectNoGone(target: Target) {
  expect(host.textContent ?? "").not.toContain(goneText(target));
}

function expectGone(target: Target) {
  expect(host.textContent ?? "").toContain(goneText(target));
}

function expectPresence(target: Target, status: "checking" | "unavailable" | "gone") {
  const attribute = target === "handoff" ? "data-handoff-presence" : "data-taskpanel-presence";
  expect(host.querySelector(`[${attribute}]`)?.getAttribute(attribute)).toBe(status);
  const copy = status === "gone" ? goneText(target) : t(target === "handoff" ? `assistant-tasks.${status}` : `assistant-taskpanel.${status}`);
  expect(host.textContent ?? "").toContain(copy);
  if (status !== "gone") expectNoGone(target);
}

function expectPresent(target: Target, id: string, title = `Task ${id}`) {
  expectNoGone(target);
  expect(host.textContent ?? "").toContain(title);
  expect(host.textContent ?? "").not.toContain(t(target === "handoff" ? "assistant-tasks.checking" : "assistant-taskpanel.checking"));
  expect(host.textContent ?? "").not.toContain(t(target === "handoff" ? "assistant-tasks.unavailable" : "assistant-taskpanel.unavailable"));
}

async function resolveRead(index: number, todos: Todo[], init?: ResponseInit) {
  expect(reads[index], `controlled /todos read ${index}`).toBeDefined();
  await act(async () => {
    reads[index]!.resolve(Response.json({ todos }, init));
    await Promise.resolve();
  });
  await flush();
}

async function respondRead(index: number, response: Response) {
  expect(reads[index], `controlled /todos read ${index}`).toBeDefined();
  await act(async () => {
    reads[index]!.resolve(response);
    await Promise.resolve();
  });
  await flush();
}

function installPlan(id: string): FeedItem {
  const plan: TaskPlan = {
    id: `plan-${id}`, conversation: "example-conversation", state: "started", created_at: at,
    tasks: [{ title: `Task ${id}`, prompt: "Synthetic task", cwd: "/example", machine: "example-computer", todo_id: id }],
  };
  getFeedState().plans[plan.id] = plan;
  return { id: `event-${id}`, conversation: plan.conversation, at, kind: "plan", ref: plan.id };
}

async function drawPlan(target: Target, id: string) {
  const item = installPlan(id);
  await draw(target === "handoff"
    ? <div data-chat-scroll><FeedLineView item={item} simplified /></div>
    : <TaskPanel todoId={id} onClose={() => {}} />);
}

async function chooseAway(online: boolean) {
  rosterAnswer = twoManagers(online);
  await act(async () => {
    setRoster(rosterAnswer);
    chooseManager("away");
  });
  await flush();
}

async function setConn(conn: Conn, target: Target, id: string) {
  seed({ conn });
  await drawTarget(target, id);
}

function mutate(kind: "put" | "drop" | "reset", id: string) {
  if (kind === "put") putTodo(todo(id, { title: "Newer local write" }));
  else if (kind === "drop") dropTodo(id);
  else reset();
}

beforeEach(() => {
  reset();
  resetManagerChoice();
  setRoster(null);
  rosterAnswer = oneManager;
  reads = [];
  sequence = 0;
  seed({
    conn: "online", todos: [], todosLoaded: true, todosSupported: true, todosError: null,
    closedCursors: {}, closedLoading: false, closedError: null,
    sessions: {}, sessionSummaries: [], taskRows: {}, interactions: [], answered: {},
  });
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const path = new URL(String(input), "http://hub").pathname;
    if (path.endsWith("/todos")) {
      const read = deferred<Response>();
      reads.push(read);
      return read.promise;
    }
    if (path.endsWith("/managers")) return Promise.resolve(Response.json(rosterAnswer));
    if (path.endsWith("/launchers")) return Promise.resolve(Response.json({ launchers: [] }));
    return Promise.resolve(Response.json({}));
  }));
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await unmount();
  setToken("");
  host.remove();
  resetManagerChoice();
  setRoster(null);
  reset();
  for (const id of Object.keys(getFeedState().plans)) delete getFeedState().plans[id];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each<Target>(["handoff", "panel"])("%s controlled cache-miss recheck", (target) => {
  it("keeps a plan that arrived before its list row pending, then restores the task", async () => {
    const id = `plan-first-${target}-${sequence++}`;
    if (target === "handoff") await act(async () => applyCompleteSessions([agent]));
    await drawPlan(target, id);
    expectPresence(target, "checking");
    expect(reads).toHaveLength(1);
    await resolveRead(0, [target === "handoff" ? linked(id) : todo(id)]);
    expectPresent(target, id, target === "handoff" ? "Example Agent" : undefined);
    if (target === "handoff") expect(host.textContent ?? "").toContain("Example Agent");
    expect(reads).toHaveLength(1);
  });

  it("recovers a transient miss without inventing a second request", async () => {
    const id = `recover-${target}-${sequence++}`;
    await drawTarget(target, id);
    expectPresence(target, "checking");
    await resolveRead(0, [todo(id)]);
    expectPresent(target, id);
    await drawTarget(target, id, true);
    expect(reads).toHaveLength(1);
  });

  it("shows gone only after an applied, current, healthy answer still lacks the id", async () => {
    const id = `deleted-${target}-${sequence++}`;
    await drawTarget(target, id);
    expectPresence(target, "checking");
    expectNoGone(target);
    await resolveRead(0, []);
    expectPresence(target, "gone");
    if (target === "handoff") expect(host.querySelector("[data-handoff-card]")?.tagName).toBe("DIV");
    await drawTarget(target, id);
    expectGone(target);
    expect(reads).toHaveLength(1);
  });

  it("keeps an exhausted closed cursor eligible for the true-deletion control", async () => {
    const id = `closed-exhausted-${target}-${sequence++}`;
    seed({ closedCursors: { assistant: { has_more: false, next_cursor: "" } } });
    await drawTarget(target, id);
    await resolveRead(0, []);
    expectGone(target);
  });

  it.each([
    ["active cursor", { closedCursors: { assistant: { has_more: true, next_cursor: "older" } } }, { closedCursors: {} }],
    ["closed loading", { closedLoading: true }, { closedLoading: false }],
    ["closed error", { closedError: "Synthetic history failure" }, { closedError: null }],
  ])("latches revocation through %s recovery without another automatic request", async (name, patch, recovery) => {
    const id = `closed-revoked-${target}-${sequence++}`;
    if (name === "active cursor") {
      // First prove that a cursor already active at completion cannot create gone, even when later cleared.
      seed(patch);
      await drawTarget(target, id);
      await resolveRead(0, []);
      expectPresence(target, "unavailable");
      seed(recovery);
      await drawTarget(target, id);
      expectPresence(target, "unavailable");
      expect(reads).toHaveLength(1);

      // A genuinely new mount may establish gone. Once that gone is revoked, recovery still cannot revive it.
      await remount(target, id);
      await resolveRead(1, []);
      expectGone(target);
    } else {
      await drawTarget(target, id);
      await resolveRead(0, []);
      expectGone(target);
    }
    seed(patch);
    await drawTarget(target, id);
    expectPresence(target, "unavailable");
    seed(recovery);
    await drawTarget(target, id);
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(name === "active cursor" ? 2 : 1);
  });

  it("turns a rejected read into unavailable without an unhandled rejection", async () => {
    const id = `rejected-${target}-${sequence++}`;
    await drawTarget(target, id);
    await act(async () => {
      reads[0]!.reject(new Error("Synthetic network failure"));
      await Promise.resolve();
    });
    await flush();
    expectPresence(target, "unavailable");
    expect(getState().todosError).not.toBeNull();
    expect(reads).toHaveLength(1);
  });

  it("turns an HTTP 500 into unavailable, not deletion", async () => {
    const id = `error-${target}-${sequence++}`;
    await drawTarget(target, id);
    await respondRead(0, Response.json({ error: "Synthetic server failure" }, { status: 500 }));
    expectPresence(target, "unavailable");
    expect(getState().todosError).not.toBeNull();
  });

  it("turns an unsupported 404 into unavailable even though todosError is clear", async () => {
    const id = `unsupported-${target}-${sequence++}`;
    await drawTarget(target, id);
    await respondRead(0, Response.json({ error: "Not supported" }, { status: 404 }));
    expectPresence(target, "unavailable");
    expect(getState().todosSupported).toBe(false);
    expect(getState().todosError).toBeNull();
    expect(reads).toHaveLength(1);
  });

  it("does not promote an answer completed while the current assistant was offline", async () => {
    const id = `manager-offline-before-${target}-${sequence++}`;
    await chooseAway(true);
    await drawTarget(target, id);
    await chooseAway(false);
    await resolveRead(0, []);
    expectPresence(target, "unavailable");
    await chooseAway(true);
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(1);
  });

  it("revokes gone when the current assistant later goes offline", async () => {
    const id = `manager-offline-after-${target}-${sequence++}`;
    await chooseAway(true);
    await drawTarget(target, id);
    await resolveRead(0, []);
    expectGone(target);
    await chooseAway(false);
    expectPresence(target, "unavailable");
    await chooseAway(true);
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(1);
  });

  it.each<Conn>(["offline", "connecting"])("guards both completion and sustained rendering when hub conn is %s", async (conn) => {
    const id = `hub-${conn}-${target}-${sequence++}`;
    await drawTarget(target, id);
    await setConn(conn, target, id);
    await resolveRead(0, []);
    expectPresence(target, "unavailable");
    await setConn("online", target, id);
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(1);

    await remount(target, id);
    expect(reads).toHaveLength(2);
    await resolveRead(1, []);
    expectGone(target);
    await setConn(conn, target, id);
    expectPresence(target, "unavailable");
    await setConn("online", target, id);
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(2);
  });

  it("keeps a controlled answer stale when a newer missing-id answer applied first", async () => {
    const id = `stale-missing-${target}-${sequence++}`;
    await drawTarget(target, id);
    const newer = refreshTodos();
    await flush();
    expect(reads).toHaveLength(2);
    await resolveRead(1, []);
    await newer;
    await resolveRead(0, []);
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(2);
    await drawTarget(target, id);
    expect(reads).toHaveLength(2);
  });

  it("revokes an old proof when a newer 304 answer applies without replacing the list", async () => {
    const id = `not-modified-${target}-${sequence++}`;
    await drawTarget(target, id);
    await resolveRead(0, [], { headers: { ETag: 'W/"t1-presence"' } });
    expectGone(target);
    const newer = refreshTodos();
    await flush();
    expect(reads).toHaveLength(2);
    await respondRead(1, new Response(null, { status: 304, headers: { ETag: 'W/"t1-presence"' } }));
    await newer;
    expectPresence(target, "unavailable");
    await drawTarget(target, id);
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(2);
  });

  it("keeps a newer answer containing the id present when the old missing-id answer lands", async () => {
    const id = `stale-present-${target}-${sequence++}`;
    await drawTarget(target, id);
    const newer = refreshTodos();
    await flush();
    await resolveRead(1, [todo(id)]);
    await newer;
    expectPresent(target, id);
    await resolveRead(0, []);
    expectPresent(target, id);
    expect(reads).toHaveLength(2);
  });

  it.each(["put", "drop", "reset"] as const)("invalidates a pending proof by %s without retrying", async (kind) => {
    const id = `${kind}-pending-${target}-${sequence++}`;
    await drawTarget(target, id);
    await act(async () => mutate(kind, id));
    await flush();
    await resolveRead(0, []);
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(1);
    if (kind === "reset") expect(getState()).toMatchObject({ conn: "connecting", todosLoaded: false });
  });

  it.each(["put", "drop", "reset"] as const)("revokes an established gone proof by %s without retrying", async (kind) => {
    const id = `${kind}-after-${target}-${sequence++}`;
    await drawTarget(target, id);
    await resolveRead(0, []);
    expectGone(target);
    await act(async () => mutate(kind, id));
    await flush();
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(1);
  });

  it.each(["same-tab", "cross-tab"] as const)("revokes an established gone proof immediately after a %s credential change", async (kind) => {
    const id = `credential-${kind}-${target}-${sequence++}`;
    setToken(`credential-before-${id}`);
    await drawTarget(target, id);
    await resolveRead(0, []);
    expectGone(target);
    await act(async () => {
      if (kind === "same-tab") setToken(`credential-after-${id}`);
      else {
        localStorage.setItem("persona.token", `credential-after-${id}`);
        window.dispatchEvent(new StorageEvent("storage", { key: "persona.token" }));
      }
      await Promise.resolve();
    });
    await flush();
    expectPresence(target, "unavailable");
    await drawTarget(target, id);
    expectPresence(target, "unavailable");
    expect(reads).toHaveLength(1);
  });

  it("allows a new recheck only after an observed present-to-miss transition", async () => {
    const id = `new-segment-${target}-${sequence++}`;
    seed({ todos: [todo(id)] });
    await drawTarget(target, id, true);
    expectPresent(target, id);
    expect(reads).toHaveLength(0);
    await act(async () => dropTodo(id));
    await flush();
    expectPresence(target, "checking");
    expect(reads).toHaveLength(1);
    await resolveRead(0, [todo(id)]);
    expectPresent(target, id);
    await act(async () => dropTodo(id));
    await flush();
    expect(reads).toHaveLength(2);
    await resolveRead(1, []);
    expectGone(target);
    await drawTarget(target, id);
    expect(reads).toHaveLength(2);
  });

  it("fences ABA so only the new A request can decide the new A view", async () => {
    const a = `aba-a-${target}-${sequence++}`;
    const b = `aba-b-${target}-${sequence++}`;
    await drawTarget(target, a);
    await drawTarget(target, b);
    await drawTarget(target, a);
    expect(reads).toHaveLength(3);
    await resolveRead(0, []);
    expectPresence(target, "checking");
    expectNoGone(target);
    await resolveRead(1, []);
    expectPresence(target, "checking");
    await resolveRead(2, []);
    expectGone(target);
    expect(reads).toHaveLength(3);
  });

  it.each(["resolve", "reject"] as const)("does not write after unmount on late %s", async (outcome) => {
    const id = `unmount-${outcome}-${target}-${sequence++}`;
    const errors = vi.spyOn(console, "error");
    await drawTarget(target, id);
    await unmount();
    await act(async () => {
      if (outcome === "resolve") reads[0]!.resolve(Response.json({ todos: [] }));
      else reads[0]!.reject(new Error("Synthetic late failure"));
      await Promise.resolve();
    });
    await flush();
    const lifecycleWarnings = errors.mock.calls.filter((call) => call.some((part) => /unmounted|unmount|not mounted/i.test(String(part))));
    expect(lifecycleWarnings).toEqual([]);
    expect(host.textContent ?? "").toBe("");
    expect(reads).toHaveLength(1);
  });

  it("does not start polling on re-renders, health changes, or virtual time", async () => {
    vi.useFakeTimers();
    const id = `no-poll-${target}-${sequence++}`;
    await drawTarget(target, id);
    await drawTarget(target, id);
    seed({ closedLoading: true });
    await drawTarget(target, id);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expectNoGone(target);
    expect(reads).toHaveLength(1);
    await respondRead(0, Response.json({ error: "Synthetic timeout" }, { status: 503 }));
    expectPresence(target, "unavailable");
    await drawTarget(target, id);
    expect(reads).toHaveLength(1);
  });

  it("makes no request for an already present task", async () => {
    const id = `already-present-${target}-${sequence++}`;
    seed({ todos: [todo(id)] });
    await drawTarget(target, id, true);
    expectPresent(target, id);
    expect(reads).toHaveLength(0);
  });
});

describe("shared presence admissions", () => {
  it("deduplicates StrictMode Handoff and TaskPanel misses for the same id", async () => {
    const id = "shared-strict-mode";
    await draw(<StrictMode><HandoffCard handoff={handoff(id)} /><TaskPanel todoId={id} onClose={() => {}} /></StrictMode>);
    expect(reads).toHaveLength(1);
    expectPresence("handoff", "checking");
    expectPresence("panel", "checking");
    await resolveRead(0, []);
    expectPresence("handoff", "gone");
    expectPresence("panel", "gone");
    expect(reads).toHaveLength(1);
  });

  it("does not conflate different ids", async () => {
    const a = "shared-a";
    const b = "shared-b";
    await draw(<StrictMode><TaskPanel todoId={a} onClose={() => {}} /><TaskPanel todoId={b} onClose={() => {}} /></StrictMode>);
    expect(reads).toHaveLength(2);
    await resolveRead(0, [todo(a), todo(b)]);
    await resolveRead(1, [todo(a), todo(b)]);
    expectPresent("panel", a);
    expectPresent("panel", b);
    expect(reads).toHaveLength(2);
  });

  it("keeps the surviving panel attached when its Handoff peer unmounts", async () => {
    const id = "shared-unmount";
    await draw(<StrictMode><HandoffCard handoff={handoff(id)} /><TaskPanel todoId={id} onClose={() => {}} /></StrictMode>);
    expect(reads).toHaveLength(1);
    await draw(<StrictMode><TaskPanel todoId={id} onClose={() => {}} /></StrictMode>);
    await resolveRead(0, [todo(id)]);
    expectPresent("panel", id);
    expect(reads).toHaveLength(1);
  });

  it("does not redraw present, no-id, or miss consumers for unrelated store writes", async () => {
    const presentId = "render-count-present";
    const missId = "render-count-miss";
    seed({ todos: [todo(presentId)] });
    const counts = { present: 0, "no-id": 0, miss: 0 };
    await draw(<>
      <PresenceProbe id={presentId} label="present" onRender={() => { counts.present++; }} />
      <PresenceProbe label="no-id" onRender={() => { counts["no-id"]++; }} />
      <PresenceProbe id={missId} label="miss" onRender={() => { counts.miss++; }} />
    </>);
    await resolveRead(0, [todo(presentId)]);
    expect(host.querySelector('[data-presence-probe="present"]')?.textContent).toBe("present");
    expect(host.querySelector('[data-presence-probe="no-id"]')?.textContent).toBe("no-id");
    expect(host.querySelector('[data-presence-probe="miss"]')?.textContent).toBe("gone");

    const unrelatedWrites: Array<[string, () => void]> = [
      ["sessions", () => applyCompleteSessions([{ ...agent, title: "Unrelated session update" }])],
      ["machines", () => applyCompleteSessions([], [], { machines: [] })],
      ["interactions", () => applyCompleteSessions([], [], { interactions: [] })],
      ["outbox", () => setOutbox("presence-render-unrelated", [])],
      ["other state", () => setPushGrading(true)],
    ];
    for (const [name, write] of unrelatedWrites) {
      const before = { ...counts };
      await act(async () => { write(); await Promise.resolve(); });
      await flush();
      expect(counts, `unrelated ${name} write`).toEqual(before);
    }
    expect(reads).toHaveLength(1);
  });

  it("keeps a Handoff without an id on its existing starting state", async () => {
    await draw(<HandoffCard handoff={{ key: "without-id", title: "No id", wake: "created" }} />);
    expect(host.textContent ?? "").toContain(t("assistant-tasks.starting_agent"));
    expect(host.textContent ?? "").not.toContain(t("assistant-tasks.handoff_gone"));
    expect(reads).toHaveLength(0);
  });

  it("keeps planned failure ahead of presence copy", async () => {
    await draw(<HandoffCard handoff={{ key: "failed", title: "Failed task", wake: "created", failure: "Synthetic start failure" }} />);
    expect(host.querySelector("[data-handoff-failure]")).not.toBeNull();
    expect(host.textContent ?? "").not.toContain(t("assistant-tasks.handoff_gone"));
    expect(reads).toHaveLength(0);
  });
});
