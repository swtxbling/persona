// @vitest-environment jsdom
// Controlled AgentArchives decouples useStore/useNow/listArchived/restoreAgent/router/toast singletons, caches
// fresh-array getters via sameValue, supports clock injection, resets query/rows/error/loading/restoring across
// scope switches & ABA bursts, locks per-key restore with try/finally recovery, preserves concurrent render purity,
// and keeps omitting deps 100% backward-compatible.
import { act, startTransition, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { Route } from "../../lib/router";
import type { Machine, Session } from "../../lib/types";
import type { AgentArchivesDeps } from "./AgentArchives";

const mocks = vi.hoisted(() => ({
  features: ["agent_session_archives"] as string[],
  machines: [{ id: "mac", name: "Studio", online: true }] as Machine[],
  storeListeners: new Set<() => void>(),
  useStore: vi.fn(),
  useNow: vi.fn(),
  listArchived: vi.fn(),
  noteArchivedList: vi.fn(),
  restoreAgent: vi.fn(),
  navigate: vi.fn(),
  onLinkClick: vi.fn(),
  href: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../lib/store", async (original) => {
  const real = await original<typeof import("../../lib/store")>();
  const { useSyncExternalStore } = await import("react");
  let cached: { features: string[]; machines: Machine[]; state: ReturnType<typeof real.getState> } | undefined;
  const snap = () => {
    if (!cached || cached.features !== mocks.features || cached.machines !== mocks.machines) {
      cached = {
        features: mocks.features,
        machines: mocks.machines,
        state: { ...real.getState(), features: mocks.features, machines: mocks.machines } as ReturnType<typeof real.getState>,
      };
    }
    return cached.state;
  };
  return {
    ...real,
    useStore: <T,>(select: (s: ReturnType<typeof real.getState>) => T): T => {
      mocks.useStore();
      return useSyncExternalStore(
        (l) => {
          mocks.storeListeners.add(l);
          return () => { mocks.storeListeners.delete(l); };
        },
        () => select(snap()),
      );
    },
  };
});

vi.mock("../../lib/agent-archives", async (original) => {
  const real = await original<typeof import("../../lib/agent-archives")>();
  return {
    ...real,
    listArchived: (signal?: AbortSignal) => mocks.listArchived(signal),
    noteArchivedList: (rows: Session[]) => mocks.noteArchivedList(rows),
    restoreAgent: (s: Session, deps: unknown) => mocks.restoreAgent(s, deps),
  };
});

vi.mock("../../lib/router", async (original) => {
  const real = await original<typeof import("../../lib/router")>();
  return {
    ...real,
    href: (route: Route) => {
      mocks.href(route);
      return real.href(route);
    },
    navigate: (to: Route | string) => mocks.navigate(to),
    onLinkClick: (e: unknown, route: Route) => mocks.onLinkClick(e, route),
  };
});

vi.mock("../../ui/atoms", async (original) => {
  const real = await original<typeof import("../../ui/atoms")>();
  return {
    ...real,
    useNow: (every?: number) => {
      mocks.useNow(every);
      return BASE_NOW;
    },
    toast: (msg: string, tone?: string) => mocks.toast(msg, tone),
  };
});

const { AgentArchives, AgentArchivesView, ArchivedRowView } = await import("./AgentArchives");

// Relative base clock (no hardcoded future wall-clock dates).
const BASE_NOW = 1_700_000_000_000;
const agoIso = (minutesAgo: number) => new Date(BASE_NOW - minutesAgo * 60_000).toISOString();

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const M1: Machine = { id: "mac", name: "Studio", online: true };
const makeSession = (sid: string, overrides: Partial<Session> = {}): Session => ({
  machine_id: "mac",
  session_id: sid,
  title: `Session ${sid}`,
  cwd: `/work/${sid}`,
  status: "offline",
  state: "offline",
  agent: "claude",
  archived: true,
  updated_at: agoIso(5),
  ...overrides,
} as Session);

const S1 = makeSession("a", { title: "Build fix", last_text: "All green" });
const S2 = makeSession("b", { title: "Release prep", agent: "codex", updated_at: agoIso(2) });

const expectNoDefaultSingletons = () => {
  expect(mocks.useStore).not.toHaveBeenCalled();
  expect(mocks.useNow).not.toHaveBeenCalled();
  expect(mocks.listArchived).not.toHaveBeenCalled();
  expect(mocks.noteArchivedList).not.toHaveBeenCalled();
  expect(mocks.restoreAgent).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.onLinkClick).not.toHaveBeenCalled();
  expect(mocks.href).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
};

const setInput = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await Promise.resolve(); });
  }
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({ matches: query.includes("min-width"), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  Object.values(mocks).forEach((v) => {
    if (typeof v === "function") v.mockReset();
  });
  mocks.storeListeners.clear();
  mocks.features = ["agent_session_archives"];
  mocks.machines = [M1];
  mocks.listArchived.mockResolvedValue([S2, S1]);
  mocks.restoreAgent.mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Pure presentational AgentArchives views", () => {
  it("renders AgentArchivesView and ArchivedRowView without touching singletons", async () => {
    const onRestore = vi.fn();
    const onBack = vi.fn();
    const onRefresh = vi.fn();
    const onLinkClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    const onQueryChange = vi.fn();

    await act(async () => root.render(
      <AgentArchivesView
        supported
        featuresKnown
        rows={[S1, S2]}
        hits={[S1]}
        machines={[M1]}
        query="Build"
        error=""
        loading={false}
        restoringKeys={new Set([`${S1.machine_id}/${S1.session_id}`])}
        now={BASE_NOW}
        href={(r) => `#route:${r.name}`}
        onLinkClick={onLinkClick}
        onToggleSidebar={() => {}}
        onBack={onBack}
        onRefresh={onRefresh}
        onQueryChange={onQueryChange}
        onRestore={onRestore}
      />,
    ));

    expect(host.querySelector("h1")?.textContent).toContain("2");
    const link = host.querySelector<HTMLAnchorElement>("[data-agent-archives] a")!;
    expect(link.getAttribute("href")).toBe("#route:session");
    await act(async () => link.click());
    expect(onLinkClick).toHaveBeenCalledTimes(1);

    const restoreBtn = host.querySelector<HTMLButtonElement>("[data-agent-archives] button")!;
    expect(restoreBtn.getAttribute("aria-busy")).toBe("true");
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("agents-archives.back")}"]`)!.click());
    expect(onBack).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("agents-archives.refresh")}"]`)!.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Direct ArchivedRowView works in isolation.
    await act(async () => root.render(
      <ArchivedRowView
        s={S2}
        now={BASE_NOW}
        machine="Studio"
        busy={false}
        href="#custom"
        onLinkClick={onLinkClick}
        onRestore={() => onRestore(S2)}
      />,
    ));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(onRestore).toHaveBeenCalledWith(S2);
    expectNoDefaultSingletons();
  });
});

describe("Controlled AgentArchives getter caching, clock injection, and direct-to-subscribed transitions", () => {
  it("bypasses useNow and useStore, caches fresh-array getters, updates clock via subscribeNow, and preserves query across direct-to-subscribed switch", async () => {
    const scopeListeners = new Set<() => void>();
    const machineListeners = new Set<() => void>();
    const nowListeners = new Set<() => void>();
    let currentNow = BASE_NOW;
    const listArchivedSpy = vi.fn(() => Promise.resolve([S1, S2]));

    await act(async () => root.render(
      <StrictMode>
        <AgentArchives
          onToggleSidebar={() => {}}
          deps={{
            scopeKey: "s1",
            supported: true,
            featuresKnown: true,
            machines: [M1],
            now: currentNow,
            listArchived: listArchivedSpy,
            restoreArchived: vi.fn(),
            href: (r) => `#${r.name}`,
            onLinkClick: (e) => e.preventDefault(),
            navigate: vi.fn(),
            notify: vi.fn(),
          }}
        />
      </StrictMode>,
    ));
    await flush();
    expect(host.querySelectorAll("[data-agent-archives] a")).toHaveLength(2);

    // Type a search query in direct mode.
    const input = host.querySelector<HTMLInputElement>("input")!;
    await setInput(input, "Build");
    expect(host.querySelectorAll("[data-agent-archives] a")).toHaveLength(1);
    const timeBefore = host.querySelector("[data-agent-archives] .tabular-nums")?.textContent;

    // Switch in-place from direct props to subscribed fresh-array getters on the same scope.
    const subscribeScopeKey = vi.fn((l: () => void) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; });
    const subscribeMachines = vi.fn((l: () => void) => { machineListeners.add(l); return () => { machineListeners.delete(l); }; });
    const subscribeNow = vi.fn((l: () => void) => { nowListeners.add(l); return () => { nowListeners.delete(l); }; });

    const renderSub = () => root.render(
      <StrictMode>
        <AgentArchives
          onToggleSidebar={() => {}}
          deps={{
            scopeKey: () => "s1",
            subscribeScopeKey,
            supported: () => true,
            featuresKnown: () => true,
            machines: () => [{ ...M1 }],
            subscribeMachines,
            now: () => currentNow,
            subscribeNow,
            listArchived: listArchivedSpy,
            restoreArchived: vi.fn(),
            href: (r) => `#${r.name}`,
            onLinkClick: (e) => e.preventDefault(),
            navigate: vi.fn(),
            notify: vi.fn(),
          }}
        />
      </StrictMode>,
    );

    const loadsBefore = listArchivedSpy.mock.calls.length;
    await act(async () => renderSub());
    // Same scope preserves query and loaded rows without reloading.
    expect(listArchivedSpy).toHaveBeenCalledTimes(loadsBefore);
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("Build");
    expect(host.querySelectorAll("[data-agent-archives] a")).toHaveLength(1);

    // Re-rendering with inline arrow getters does not churn subscriptions.
    const scopeSubs = subscribeScopeKey.mock.calls.length;
    const machSubs = subscribeMachines.mock.calls.length;
    const nowSubs = subscribeNow.mock.calls.length;
    await act(async () => renderSub());
    await act(async () => renderSub());
    expect(subscribeScopeKey).toHaveBeenCalledTimes(scopeSubs);
    expect(subscribeMachines).toHaveBeenCalledTimes(machSubs);
    expect(subscribeNow).toHaveBeenCalledTimes(nowSubs);

    // Advancing injected clock updates relative timestamps without calling useNow.
    currentNow = BASE_NOW + 2 * 60 * 60_000;
    await act(async () => { nowListeners.forEach((l) => l()); });
    const timeAfter = host.querySelector("[data-agent-archives] .tabular-nums")?.textContent;
    expect(timeAfter).not.toBe(timeBefore);
    expectNoDefaultSingletons();
  });

  it("supports unsupported hub state, controlled navigate on row links & back button, and renderView override", async () => {
    const listArchivedSpy = vi.fn();
    const navigated: Array<Route | string> = [];

    await act(async () => root.render(
      <AgentArchives
        onToggleSidebar={() => {}}
        deps={{
          supported: false,
          featuresKnown: true,
          machines: [M1],
          now: BASE_NOW,
          listArchived: listArchivedSpy,
          href: (r) => `#${r.name}`,
          navigate: (to) => { navigated.push(to); },
        }}
      />,
    ));
    expect(listArchivedSpy).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t("agents-archives.unsupported_title"));

    await act(async () => root.render(
      <AgentArchives
        onToggleSidebar={() => {}}
        deps={{
          supported: true,
          featuresKnown: true,
          machines: [M1],
          now: BASE_NOW,
          listArchived: () => [S1],
          href: (r) => `#${r.name}`,
          navigate: (to) => { navigated.push(to); },
        }}
      />,
    ));
    await act(async () => host.querySelector<HTMLAnchorElement>("[data-agent-archives] a")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("agents-archives.back")}"]`)!.click());
    expect(navigated).toEqual([
      { name: "session", mid: "mac", sid: "a" },
      { name: "agent-list" },
    ]);

    await act(async () => root.render(
      <AgentArchives
        onToggleSidebar={() => {}}
        deps={{
          supported: true,
          featuresKnown: true,
          machines: [M1],
          now: BASE_NOW,
          listArchived: () => [S1],
          href: () => "#x",
          renderView: (props) => <div data-custom-archives={props.hits.length} />,
        }}
      />,
    ));
    expect(host.querySelector("[data-custom-archives]")?.getAttribute("data-custom-archives")).toBe("1");
    expectNoDefaultSingletons();
  });
});

describe("Scope/ABA/unmount fencing, per-key restore locking, concurrent render purity, and try/finally recovery", () => {
  it("resets query/rows/error/loading/restoring and aborts in-flight load and restore across scope switches, ABA bursts, and unmount", async () => {
    const scopeListeners = new Set<() => void>();
    let currentScope = "s1";
    const notify = vi.fn();
    const onError = vi.fn();

    const loadCalls: Array<{ signal: AbortSignal; gate: ReturnType<typeof deferred<Session[]>> }> = [];
    const restoreCalls: Array<{ sid: string; signal: AbortSignal; gate: ReturnType<typeof deferred<boolean>> }> = [];

    const deps: AgentArchivesDeps = {
      scopeKey: () => currentScope,
      subscribeScopeKey: (l) => { scopeListeners.add(l); return () => { scopeListeners.delete(l); }; },
      supported: true,
      featuresKnown: true,
      machines: [M1],
      now: BASE_NOW,
      listArchived: (signal) => {
        const gate = deferred<Session[]>();
        loadCalls.push({ signal, gate });
        return gate.promise;
      },
      restoreArchived: (s, signal) => {
        const gate = deferred<boolean>();
        restoreCalls.push({ sid: s.session_id, signal, gate });
        return gate.promise;
      },
      href: (r) => `#${r.name}`,
      onLinkClick: (e) => e.preventDefault(),
      navigate: vi.fn(),
      notify,
      onError,
    };

    await act(async () => root.render(<AgentArchives onToggleSidebar={() => {}} deps={deps} />));
    expect(loadCalls).toHaveLength(1);
    loadCalls[0].gate.resolve([S1, S2]);
    await flush();

    // Type query, start restore on S1 (double-click locked per key) and S2 concurrently.
    await setInput(host.querySelector<HTMLInputElement>("input")!, "a");
    await setInput(host.querySelector<HTMLInputElement>("input")!, "");
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("[data-agent-archives] button")];
    await act(async () => buttons()[0].click());
    await act(async () => buttons()[0].click()); // per-key lock blocks duplicate restore for S1
    await act(async () => buttons()[1].click()); // S2 can still restore concurrently
    expect(restoreCalls.map((c) => c.sid)).toEqual(["a", "b"]);
    await setInput(host.querySelector<HTMLInputElement>("input")!, "Build");
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("Build");

    // Scope switch s1 -> s2 resets query/rows/restoring and aborts both restores.
    currentScope = "s2";
    await act(async () => { scopeListeners.forEach((l) => l()); });
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(host.querySelector("[data-agent-archives]")).toBeNull();
    expect(restoreCalls[0].signal.aborted).toBe(true);
    expect(restoreCalls[1].signal.aborted).toBe(true);
    expect(loadCalls).toHaveLength(2);

    // Stale rejections from s1 are ignored.
    restoreCalls[0].gate.reject(new Error("stale restore a"));
    restoreCalls[1].gate.resolve(true);
    await flush();
    expect(notify).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // Synchronous ABA burst s2 -> s3 -> s2 aborts s2's load and starts a fresh load.
    await act(async () => {
      currentScope = "s3";
      scopeListeners.forEach((l) => l());
      currentScope = "s2";
      scopeListeners.forEach((l) => l());
    });
    expect(loadCalls[1].signal.aborted).toBe(true);
    expect(loadCalls).toHaveLength(3);
    loadCalls[1].gate.reject(new Error("stale load s2"));
    await flush();
    expect(onError).not.toHaveBeenCalled();

    // Unmount aborts active load and ignores late rejection.
    await act(async () => root.render(null));
    expect(loadCalls[2].signal.aborted).toBe(true);
    loadCalls[2].gate.reject(new Error("unmounted load"));
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expectNoDefaultSingletons();
  });

  it("keeps committed query, rows, and in-flight restore intact when a concurrent transition render is abandoned", async () => {
    const suspendGate = deferred<void>();
    const restoreGate = deferred<boolean>();
    let restoreSignal: AbortSignal | null = null;
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
          <AgentArchives
            onToggleSidebar={() => {}}
            deps={{
              scopeKey: state.scope,
              supported: true,
              featuresKnown: true,
              machines: [M1],
              now: BASE_NOW,
              listArchived: () => [S1, S2],
              restoreArchived: (_s, signal) => {
                restoreSignal = signal;
                return restoreGate.promise;
              },
              href: (r) => `#${r.name}`,
              onLinkClick: (e) => e.preventDefault(),
              navigate: vi.fn(),
            }}
          />
          <SuspendIf block={state.block} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Harness />));
    await setInput(host.querySelector<HTMLInputElement>("input")!, "Build");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-agent-archives] button")!.click());
    expect(restoreSignal!.aborted).toBe(false);

    // Suspended concurrent transition to s2 must NOT abort s1's restore or clear s1's query.
    await act(async () => {
      startTransition(() => setHarness({ scope: "s2", block: true }));
    });
    expect(renderedScopes).toContain("s2");
    expect(restoreSignal!.aborted).toBe(false);
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("Build");

    // Abandon back to s1; resolving restoreGate removes S1 cleanly.
    await act(async () => setHarness({ scope: "s1", block: false }));
    restoreGate.resolve(true);
    await flush();
    expect(host.querySelectorAll("[data-agent-archives] a")).toHaveLength(0);
    expect(host.textContent).toContain(t("agents-archives.no_results", { query: "Build" }));
    expectNoDefaultSingletons();
  });

  it("releases loading and per-key restoring via try/finally on sync throws, async rejections, and false returns", async () => {
    const errors: string[] = [];
    const notify = vi.fn(() => { throw new Error("toast crash"); });
    let loadMode: "sync" | "async" | "ok" = "sync";
    let restoreMode: "sync" | "async" | "false" | "ok" = "sync";

    await act(async () => root.render(
      <AgentArchives
        onToggleSidebar={() => {}}
        deps={{
          supported: true,
          featuresKnown: true,
          machines: [M1],
          now: BASE_NOW,
          listArchived: () => {
            if (loadMode === "sync") throw new Error("load sync");
            if (loadMode === "async") return Promise.reject(new Error("load async"));
            return Promise.resolve([S1]);
          },
          restoreArchived: () => {
            if (restoreMode === "sync") throw new Error("restore sync");
            if (restoreMode === "async") return Promise.reject(new Error("restore async"));
            if (restoreMode === "false") return Promise.resolve(false);
            return Promise.resolve(true);
          },
          href: (r) => `#${r.name}`,
          onLinkClick: (e) => e.preventDefault(),
          notify,
          formatError: (e) => `fmt:${e instanceof Error ? e.message : String(e)}`,
          onError: (msg) => { errors.push(msg); },
        }}
      />,
    ));
    expect(host.textContent).toContain("fmt:load sync");

    const retryBtn = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === t("agents-archives.retry"))!;
    loadMode = "async";
    await act(async () => retryBtn().click());
    await flush();
    expect(host.textContent).toContain("fmt:load async");
    expect(retryBtn().getAttribute("aria-busy")).toBeNull();

    loadMode = "ok";
    await act(async () => retryBtn().click());
    await flush();
    expect(host.querySelectorAll("[data-agent-archives] a")).toHaveLength(1);

    const restoreBtn = () => host.querySelector<HTMLButtonElement>("[data-agent-archives] button")!;
    await act(async () => restoreBtn().click());
    expect(restoreBtn().getAttribute("aria-busy")).toBeNull();

    restoreMode = "async";
    await act(async () => restoreBtn().click());
    await flush();
    expect(restoreBtn().getAttribute("aria-busy")).toBeNull();
    expect(host.querySelectorAll("[data-agent-archives] a")).toHaveLength(1);

    restoreMode = "false";
    await act(async () => restoreBtn().click());
    await flush();
    expect(host.querySelectorAll("[data-agent-archives] a")).toHaveLength(1);

    restoreMode = "ok";
    await act(async () => restoreBtn().click());
    await flush();
    expect(host.querySelectorAll("[data-agent-archives] a")).toHaveLength(0);
    expect(errors).toEqual(["fmt:load sync", "fmt:load async", "fmt:restore sync", "fmt:restore async"]);
    expectNoDefaultSingletons();
  });

  it("preserves default useStore, useNow, listArchived, noteArchivedList, restoreAgent, and router behavior when deps is omitted", async () => {
    await act(async () => root.render(<AgentArchives onToggleSidebar={() => {}} />));
    await flush();
    expect(mocks.useStore).toHaveBeenCalled();
    expect(mocks.useNow).toHaveBeenCalledWith(60_000);
    expect(mocks.listArchived).toHaveBeenCalledTimes(1);
    expect(mocks.noteArchivedList).toHaveBeenCalledWith([S2, S1]);
    expect(mocks.href).toHaveBeenCalled();

    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("agents-archives.back")}"]`)!.click());
    expect(mocks.navigate).toHaveBeenCalledWith({ name: "agent-list" });

    await act(async () => host.querySelector<HTMLButtonElement>("[data-agent-archives] button")!.click());
    await flush();
    expect(mocks.restoreAgent).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("[data-agent-archives] a")).toHaveLength(1);
  });
});
