// One controlled presence check for both task cards and the task panel. A cache miss starts no timers and no retries.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { credentialOwner, subscribeCredentialOwner } from "../../lib/api";
import { getState, refreshTodosControlled, subscribeTodoRevision, todoRevision, useStore, type State, type TodoRefreshResult } from "../../lib/store";
import type { Todo } from "../../lib/todos";
import { useShownOffline, type ShownOffline } from "../ManagerParts";

export type TodoPresenceStatus = "no-id" | "present" | "checking" | "unavailable" | "gone";

type Outcome = { result?: TodoRefreshResult };
type Entry = { id: string; invalidated: boolean; promise: Promise<Outcome> };
type Completion = { id: string; entry: Entry; result?: TodoRefreshResult; gone: boolean; revoked: boolean };

// Components sharing an id share only this one miss segment. Entry identity prevents an old completion deleting a new one.
const inFlight = new Map<string, Entry>();
// Static rendering has no localStorage. Hydration switches to the real credentialOwner snapshot and subscription.
const serverCredentialOwner = () => "server";

function healthy(state: State, offline: ShownOffline | null): boolean {
  return state.todosLoaded && !state.todosError && state.todosSupported && state.conn === "online" && !offline &&
    !state.closedLoading && !state.closedError &&
    !Object.values(state.closedCursors).some((cursor) => cursor.has_more && Boolean(cursor.next_cursor));
}

function startEntry(id: string): Entry {
  const entry: Entry = { id, invalidated: false, promise: Promise.resolve({}) };
  entry.promise = (async (): Promise<Outcome> => {
    try {
      return { result: await refreshTodosControlled() };
    } catch {
      // An unexpected rejection is unavailable too, never deletion evidence.
      return {};
    } finally {
      if (inFlight.get(id) === entry) inFlight.delete(id);
    }
  })();
  return entry;
}

export function useTodoPresence(todoId: string | undefined): { status: TodoPresenceStatus; todo?: Todo } {
  // Only a fresh to-do answer, putTodo(), dropTodo(), or reset() advances this version. It redraws even when an
  // empty-array replacement or 304 leaves every selected field equal; unrelated global writes do not reach this hook.
  useSyncExternalStore(subscribeTodoRevision, todoRevision, todoRevision);
  // Credential writes and other tabs' storage events do not pass through store.set(). Their explicit subscription
  // immediately revokes a displayed proof without using the old Promise to revive it if the credential later returns.
  useSyncExternalStore(subscribeCredentialOwner, credentialOwner, serverCredentialOwner);
  const todos = useStore((state) => state.todos);
  useStore((state) => ({
    conn: state.conn,
    loaded: state.todosLoaded,
    error: state.todosError,
    supported: state.todosSupported,
    cursors: state.closedCursors,
    closedLoading: state.closedLoading,
    closedError: state.closedError,
  }));
  const offline = useShownOffline();
  const todo = todoId ? todos.find((row) => row.id === todoId) : undefined;
  const present = Boolean(todo);
  const [completion, setCompletion] = useState<Completion | null>(null);

  const mounted = useRef(false);
  const generation = useRef(0);
  const currentId = useRef(todoId);
  const offlineNow = useRef(offline);
  const effectId = useRef<string | undefined>(undefined);
  const seenIds = useRef(new Set<string>());
  currentId.current = todoId;
  offlineNow.current = offline;

  useEffect(() => {
    const ownGeneration = ++generation.current;
    mounted.current = true;
    const cleanup = () => {
      if (generation.current !== ownGeneration) return;
      mounted.current = false;
      generation.current++;
    };
    const id = todoId;
    const previousId = effectId.current;
    effectId.current = id;
    if (!id) {
      setCompletion(null);
      return cleanup;
    }

    const returningToOldId = seenIds.current.has(id) && previousId !== id;
    seenIds.current.add(id);
    // Effects can run after another update: read the latest list before deciding whether a request is needed.
    if (getState().todos.some((row) => row.id === id)) {
      const old = inFlight.get(id);
      if (old) {
        old.invalidated = true;
        if (inFlight.get(id) === old) inFlight.delete(id);
      }
      setCompletion(null);
      return cleanup;
    }

    let entry = inFlight.get(id);
    // A→B→A is a new local generation, not permission for the first A Promise to decide the new A view.
    if (entry && (entry.invalidated || returningToOldId)) {
      entry.invalidated = true;
      if (inFlight.get(id) === entry) inFlight.delete(id);
      entry = undefined;
    }
    if (!entry) {
      entry = startEntry(id);
      inFlight.set(id, entry);
    }
    const joined = entry;
    setCompletion(null);
    void joined.promise.then((outcome) => {
      if (!mounted.current || generation.current !== ownGeneration || currentId.current !== id) return;
      // Promise fulfillment is not applied evidence. Check the result first, then read the latest store and manager.
      const latest = getState();
      const result = outcome.result;
      const gone = !joined.invalidated && result?.kind === "applied" && result.current() &&
        !latest.todos.some((row) => row.id === id) && healthy(latest, offlineNow.current);
      setCompletion({ id, entry: joined, result, gone, revoked: false });
    });
    return cleanup;
  }, [todoId, present]);

  // An established proof has one lifetime in this miss segment. Once a committed unhealthy render revokes it, later
  // recovery cannot recreate gone from the same Promise. Only a new mount or observed present→miss replaces it.
  useEffect(() => {
    if (!completion || completion.id !== todoId || !completion.gone || completion.revoked || todo) return;
    const current = !completion.entry.invalidated && completion.result?.kind === "applied" && completion.result.current();
    if (current && healthy(getState(), offlineNow.current)) return;
    setCompletion((latest) => latest === completion ? { ...latest, revoked: true } : latest);
  });

  let status: TodoPresenceStatus;
  if (!todoId) status = "no-id";
  else if (todo) status = "present";
  else if (!completion || completion.id !== todoId) status = "checking";
  else if (completion.gone && !completion.revoked && !completion.entry.invalidated && completion.result?.kind === "applied" && completion.result.current() && healthy(getState(), offline)) status = "gone";
  else status = "unavailable";
  return { status, todo };
}
