// @vitest-environment jsdom
// Deterministic regression tests for LazyAgentOverlays: on-demand loading, close-before-resolve,
// chunk load error boundary recovery & retry, and rapid target-switch (ABA) fencing.
import { act, useState, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerAsk, askConfirm, askText, getAsk } from "../lib/node-ask";
import type { Session } from "../lib/types";
import type { MarkSeenDialogProps } from "./AgentMenus";
import { createLazyMarkSeenDialog, createLazyMenuOverlay, createLazyNodePrompt } from "./LazyAgentOverlays";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const session = (id: string, title: string): Session => ({
  machine_id: "m1",
  session_id: id,
  title,
  cwd: "/code/app",
  status: "idle",
  state: "unread",
});

let host: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

beforeEach(() => {
  answerAsk();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  answerAsk();
  vi.restoreAllMocks();
});

describe("LazyMarkSeenDialog", () => {
  it("loads only on intent and renders when opened", async () => {
    const loader = vi.fn(async () => {
      const Stub: ComponentType<MarkSeenDialogProps> = ({ list, onClose }) =>
        list ? (
          <div data-testid="mark-seen" data-count={list.length}>
            <span>{list.map((s) => s.title).join(",")}</span>
            <button type="button" onClick={onClose}>close</button>
          </div>
        ) : null;
      return Stub;
    });
    const LazyDialog = createLazyMarkSeenDialog(loader);

    act(() => root.render(<LazyDialog list={null} onClose={() => {}} />));
    await flush();
    expect(loader).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="mark-seen"]')).toBeNull();

    const onClose = vi.fn();
    await act(async () => {
      root.render(<LazyDialog list={[session("s1", "Alpha")]} onClose={onClose} />);
    });
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="mark-seen"]')?.textContent).toContain("Alpha");

    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the dialog closed with no stale callbacks if closed before the chunk resolves", async () => {
    const gate = deferred<ComponentType<MarkSeenDialogProps>>();
    const mounted = vi.fn();
    const loader = vi.fn(() => gate.promise);
    const LazyDialog = createLazyMarkSeenDialog(loader);
    const onClose = vi.fn();
    const onDone = vi.fn();

    act(() => root.render(<LazyDialog list={[session("s1", "Alpha")]} onClose={onClose} onDone={onDone} />));
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);

    // Close before chunk resolves
    act(() => root.render(<LazyDialog list={null} onClose={onClose} onDone={onDone} />));
    await flush();

    // Now resolve chunk
    const Stub: ComponentType<MarkSeenDialogProps> = ({ list }) => {
      mounted(list?.map((s) => s.session_id) ?? null);
      return list ? <div data-testid="mark-seen">opened</div> : null;
    };
    await act(async () => {
      gate.resolve(Stub);
      await gate.promise;
    });
    await flush();

    expect(mounted).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="mark-seen"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("catches chunk load errors, resets open state cleanly, and recovers on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempt = 0;
    const loader = vi.fn(async (): Promise<ComponentType<MarkSeenDialogProps>> => {
      attempt += 1;
      if (attempt === 1) throw new Error("Failed to fetch dynamically imported module");
      return ({ list }) => (list ? <div data-testid="mark-seen">recovered:{list[0]?.title}</div> : null);
    });
    const LazyDialog = createLazyMarkSeenDialog(loader);

    function Host() {
      const [list, setList] = useState<Session[] | null>(null);
      return (
        <div data-testid="host-shell">
          <button type="button" data-open onClick={() => setList([session("s1", "RetryTarget")])}>open</button>
          <span data-open-state>{list ? "open" : "closed"}</span>
          <LazyDialog list={list} onClose={() => setList(null)} />
        </div>
      );
    }

    act(() => root.render(<Host />));
    await flush();

    // First attempt fails -> error boundary catches it and resets open state cleanly without crashing Host.
    act(() => host.querySelector<HTMLButtonElement>("[data-open]")!.click());
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="host-shell"]')).not.toBeNull();
    expect(host.querySelector("[data-open-state]")?.textContent).toBe("closed");
    expect(host.querySelector('[data-testid="mark-seen"]')).toBeNull();

    // Second attempt retries and succeeds.
    act(() => host.querySelector<HTMLButtonElement>("[data-open]")!.click());
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-open-state]")?.textContent).toBe("open");
    expect(host.querySelector('[data-testid="mark-seen"]')?.textContent).toBe("recovered:RetryTarget");
  });

  it("renders only the latest target and fences stale callbacks across A -> B -> A switches", async () => {
    const capturedClosers: Array<{ label: string; close: () => void; done?: () => void }> = [];
    const gate = deferred<ComponentType<MarkSeenDialogProps>>();
    const LazyDialog = createLazyMarkSeenDialog(() => gate.promise);

    const a = [session("a", "TargetA")];
    const b = [session("b", "TargetB")];
    const onClose = vi.fn();
    const onDone = vi.fn();

    act(() => root.render(<LazyDialog list={a} onClose={onClose} onDone={onDone} />));
    await flush();
    act(() => root.render(<LazyDialog list={b} onClose={onClose} onDone={onDone} />));
    await flush();
    act(() => root.render(<LazyDialog list={a} onClose={onClose} onDone={onDone} />));
    await flush();

    const Stub: ComponentType<MarkSeenDialogProps> = ({ list, onClose: close, onDone: done }) => {
      if (list) capturedClosers.push({ label: list[0]!.title!, close, done });
      return list ? <div data-testid="mark-seen">{list[0]?.title}</div> : null;
    };

    await act(async () => {
      gate.resolve(Stub);
      await gate.promise;
    });
    await flush();

    expect(host.querySelector('[data-testid="mark-seen"]')?.textContent).toBe("TargetA");
    expect(capturedClosers.length).toBe(1);
    const staleCloseFromA1 = capturedClosers[0]!.close;
    const staleDoneFromA1 = capturedClosers[0]!.done!;

    // Switch to B while mounted: the older A callback must be fenced out.
    act(() => root.render(<LazyDialog list={b} onClose={onClose} onDone={onDone} />));
    await flush();
    expect(host.querySelector('[data-testid="mark-seen"]')?.textContent).toBe("TargetB");

    act(() => {
      staleCloseFromA1();
      staleDoneFromA1();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    // Latest B callback works.
    const activeCloseB = capturedClosers[capturedClosers.length - 1]!.close;
    act(() => activeCloseB());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("createLazyMenuOverlay", () => {
  type MenuProps = { id: string; label: string; onClose: () => void };

  it("handles open, close-before-resolve, error recovery, and ABA callback fencing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const closers = new Map<string, () => void>();
    let attempt = 0;
    const gate = deferred<ComponentType<MenuProps>>();
    const loader = vi.fn((): Promise<ComponentType<MenuProps>> => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("chunk failed"));
      return gate.promise;
    });
    const LazyMenu = createLazyMenuOverlay<MenuProps>(loader, (p) => p.id);

    function Host() {
      const [menu, setMenu] = useState<{ id: string; label: string } | null>(null);
      return (
        <div data-testid="menu-host">
          <button type="button" data-open-a onClick={() => setMenu({ id: "a", label: "MenuA" })}>openA</button>
          <button type="button" data-open-b onClick={() => setMenu({ id: "b", label: "MenuB" })}>openB</button>
          <button type="button" data-close onClick={() => setMenu(null)}>close</button>
          <span data-state>{menu ? menu.id : "closed"}</span>
          {menu && <LazyMenu id={menu.id} label={menu.label} onClose={() => setMenu(null)} />}
        </div>
      );
    }

    act(() => root.render(<Host />));
    await flush();
    expect(loader).not.toHaveBeenCalled();

    // Attempt 1 fails -> boundary resets state to closed cleanly
    act(() => host.querySelector<HTMLButtonElement>("[data-open-a]")!.click());
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-state]")?.textContent).toBe("closed");

    // Attempt 2 starts loading, then closes before resolve -> stays closed after resolve
    act(() => host.querySelector<HTMLButtonElement>("[data-open-a]")!.click());
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    act(() => host.querySelector<HTMLButtonElement>("[data-close]")!.click());
    await flush();

    const Stub: ComponentType<MenuProps> = ({ id, label, onClose }) => {
      closers.set(`${id}:${closers.size}`, onClose);
      return <div data-testid="lazy-menu">{label}</div>;
    };
    await act(async () => {
      gate.resolve(Stub);
      await gate.promise;
    });
    await flush();
    expect(host.querySelector('[data-testid="lazy-menu"]')).toBeNull();
    expect(host.querySelector("[data-state]")?.textContent).toBe("closed");

    // Open A, switch to B, verify stale closer from A does not close B
    act(() => host.querySelector<HTMLButtonElement>("[data-open-a]")!.click());
    await flush();
    expect(host.querySelector('[data-testid="lazy-menu"]')?.textContent).toBe("MenuA");
    const closerA = [...closers.values()][0]!;

    act(() => host.querySelector<HTMLButtonElement>("[data-open-b]")!.click());
    await flush();
    expect(host.querySelector('[data-testid="lazy-menu"]')?.textContent).toBe("MenuB");

    act(() => closerA());
    await flush();
    expect(host.querySelector("[data-state]")?.textContent).toBe("b");

    const closerB = [...closers.values()][closers.size - 1]!;
    act(() => closerB());
    await flush();
    expect(host.querySelector("[data-state]")?.textContent).toBe("closed");
  });
});

describe("createLazyNodePrompt", () => {
  it("loads only when prompted, cancels cleanly on chunk failure, and recovers on next prompt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let attempt = 0;
    const loader = vi.fn(async (): Promise<ComponentType<Record<string, never>>> => {
      attempt += 1;
      if (attempt === 1) throw new Error("chunk failed");
      return function PromptStub() {
        const current = getAsk();
        return current ? <div data-testid="node-prompt">{current.title}</div> : null;
      };
    });
    const LazyPrompt = createLazyNodePrompt(loader);

    act(() => root.render(<div data-testid="prompt-host"><LazyPrompt /></div>));
    await flush();
    expect(loader).not.toHaveBeenCalled();

    // First ask fails chunk load -> promise resolves null, ask state clears, host stays intact.
    let firstAnswer: string | null | undefined;
    act(() => {
      void askText("Rename node", "Name", "old").then((v) => {
        firstAnswer = v;
      });
    });
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(firstAnswer).toBeNull();
    expect(getAsk()).toBeNull();
    expect(host.querySelector('[data-testid="prompt-host"]')).not.toBeNull();

    // Second ask retries chunk load and renders cleanly.
    let secondPromise!: Promise<boolean>;
    act(() => {
      secondPromise = askConfirm("Close pane", "Really close?", "Close");
    });
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="node-prompt"]')?.textContent).toBe("Close pane");

    // Clean up pending promise
    act(() => {
      const current = getAsk();
      if (current?.kind === "confirm") current.resolve(false);
      answerAsk();
    });
    await expect(secondPromise).resolves.toBe(false);
  });
});
