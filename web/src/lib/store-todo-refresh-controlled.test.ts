// The controlled to-do refresh says whether its own answer was applied, rejected, unsupported, or already stale.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "./store";
import { setToken } from "./api";
import type { Todo } from "./todos";

type Kind = "applied" | "stale" | "rejected" | "unsupported";
type ControlledResult = { kind: Kind; current: () => boolean };
type ControlledStore = { refreshTodosControlled: (opts?: { coalesce?: boolean }) => Promise<ControlledResult> };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const { getState, refreshTodos, putTodo, dropTodo, reset } = store;
const controlled = (opts?: { coalesce?: boolean }) => (store as unknown as ControlledStore).refreshTodosControlled(opts);
const todo = (id: string, title = id): Todo => ({ id, title, created_at: "", updated_at: "" });
let reads: Deferred<Response>[];
let validators: (string | null)[];

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function resolveRead(index: number, todos: Todo[], headers: Record<string, string> = {}) {
  reads[index]!.resolve(Response.json({ todos }, { headers: { "Content-Type": "application/json", ...headers } }));
  await flush();
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

beforeEach(() => {
  reset();
  reads = [];
  validators = [];
  vi.stubGlobal("localStorage", storage());
  setToken("controlled-token");
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://hub").pathname;
    if (!path.endsWith("/todos")) return Promise.resolve(Response.json({}));
    validators.push(new Headers(init?.headers).get("If-None-Match"));
    const read = deferred<Response>();
    reads.push(read);
    return read.promise;
  }));
});

afterEach(() => {
  reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("refreshTodosControlled", () => {
  it("reports a fresh 200 as applied and keeps the existing list write behavior", async () => {
    const pending = controlled();
    await flush();
    await resolveRead(0, [todo("t1", "Fresh answer")], { ETag: 'W/"t1-fresh"' });
    const result = await pending;
    expect(result.kind).toBe("applied");
    expect(result.current()).toBe(true);
    expect(getState()).toMatchObject({ todosLoaded: true, todosSupported: true, todosError: null });
    expect(getState().todos.map((row) => row.title)).toEqual(["Fresh answer"]);
  });

  it("reports a valid 304 as applied while reusing the kept answer", async () => {
    const first = controlled();
    await flush();
    await resolveRead(0, [todo("t1", "Kept answer")], { ETag: 'W/"t1-kept"' });
    expect((await first).kind).toBe("applied");
    const list = getState().todos;

    const second = controlled();
    await flush();
    reads[1]!.resolve(new Response(null, { status: 304, headers: { ETag: 'W/"t1-kept"' } }));
    await flush();
    const result = await second;
    expect(result.kind).toBe("applied");
    expect(result.current()).toBe(true);
    expect(validators).toEqual([null, 'W/"t1-kept"']);
    expect(getState().todos).toBe(list);
  });

  it("reports a current non-404 failure as rejected", async () => {
    const pending = controlled();
    await flush();
    reads[0]!.resolve(Response.json({ error: "Synthetic failure" }, { status: 503 }));
    await flush();
    const result = await pending;
    expect(result.kind).toBe("rejected");
    expect(result.current()).toBe(true);
    expect(getState().todosError).not.toBeNull();
  });

  it("reports a current 404 as unsupported", async () => {
    const pending = controlled();
    await flush();
    reads[0]!.resolve(Response.json({ error: "Not supported" }, { status: 404 }));
    await flush();
    const result = await pending;
    expect(result.kind).toBe("unsupported");
    expect(result.current()).toBe(true);
    expect(getState()).toMatchObject({ todosSupported: false, todosLoaded: true, todosError: null });
  });

  it("marks the old controlled answer stale when the newer missing-id answer applies first", async () => {
    const older = controlled();
    await flush();
    const newer = refreshTodos();
    await flush();
    expect(reads).toHaveLength(2);
    await resolveRead(1, []);
    await expect(newer).resolves.toBeUndefined();
    const appliedList = getState().todos;
    await resolveRead(0, []);
    const result = await older;
    expect(result.kind).toBe("stale");
    expect(result.current()).toBe(false);
    expect(getState().todos).toBe(appliedList);
    expect(reads).toHaveLength(2);
  });

  it("keeps the newer answer containing the id when the old answer lacks it", async () => {
    const older = controlled();
    await flush();
    const newer = refreshTodos();
    await flush();
    await resolveRead(1, [todo("target")]);
    await newer;
    await resolveRead(0, []);
    const result = await older;
    expect(result.kind).toBe("stale");
    expect(result.current()).toBe(false);
    expect(getState().todos.map((row) => row.id)).toEqual(["target"]);
    expect(reads).toHaveLength(2);
  });

  it.each(["put", "drop", "reset"] as const)("marks a pending answer stale after %s", async (kind) => {
    const pending = controlled();
    await flush();
    if (kind === "put") putTodo(todo("target"));
    else if (kind === "drop") dropTodo("target");
    else reset();
    await resolveRead(0, []);
    const result = await pending;
    expect(result.kind).toBe("stale");
    expect(result.current()).toBe(false);
    expect(reads).toHaveLength(1);
    if (kind === "reset") expect(getState()).toMatchObject({ conn: "connecting", todosLoaded: false, todos: [] });
  });

  it.each(["put", "drop", "reset"] as const)("retires an already applied result after %s", async (kind) => {
    const pending = controlled();
    await flush();
    await resolveRead(0, []);
    const result = await pending;
    expect(result).toMatchObject({ kind: "applied" });
    expect(result.current()).toBe(true);
    if (kind === "put") putTodo(todo("target"));
    else if (kind === "drop") dropTodo("target");
    else reset();
    expect(result.current()).toBe(false);
    expect(reads).toHaveLength(1);
  });

  it("marks a pending answer stale when the credential owner changes", async () => {
    const pending = controlled();
    await flush();
    setToken("another-credential");
    await resolveRead(0, []);
    const result = await pending;
    expect(result.kind).toBe("stale");
    expect(result.current()).toBe(false);
    expect(reads).toHaveLength(1);
  });

  it("retires an applied result when the credential owner changes", async () => {
    const pending = controlled();
    await flush();
    await resolveRead(0, []);
    const result = await pending;
    expect(result.current()).toBe(true);
    setToken("another-credential");
    expect(result.current()).toBe(false);
  });

  it("retains refreshTodos as a Promise<void> compatibility wrapper", async () => {
    const pending = refreshTodos();
    await flush();
    await resolveRead(0, [todo("legacy")]);
    await expect(pending).resolves.toBeUndefined();
    expect(getState().todos.map((row) => row.id)).toEqual(["legacy"]);
    expect(reads).toHaveLength(1);
  });
});
