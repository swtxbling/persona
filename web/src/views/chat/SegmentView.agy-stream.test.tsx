// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTaskIndex } from "../../lib/tasks";
import { segments } from "../../lib/turns";
import type { Item } from "../../lib/types";
import { ChatContext, type ChatContextValue } from "./chat-context";

const markdownCalls = vi.hoisted(() => [] as { text: string; streaming?: boolean; streamKey?: string }[]);
const extraMounts = vi.hoisted(() => ({ files: 0, ports: 0 }));

vi.mock("../../ui/Markdown", async (load) => {
  const real = await load<typeof import("../../ui/Markdown")>();
  const { createElement } = await import("react");
  return {
    ...real,
    Markdown: (p: ComponentProps<typeof real.Markdown>) => {
      markdownCalls.push({ text: p.text, streaming: p.streaming, streamKey: p.streamKey });
      return createElement(real.Markdown, p);
    },
  };
});

vi.mock("./LazyFileCards", () => ({
  LazyFileCards: () => null,
  LazyReplyFiles: () => {
    extraMounts.files++;
    return null;
  },
}));

vi.mock("./LazyTurnExtras", () => ({
  LazyTurnChanges: () => null,
  LazyTurnImages: () => null,
  LazyReplyPorts: () => {
    extraMounts.ports++;
    return null;
  },
}));

const { SegmentView } = await import("./SegmentView");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctx: ChatContextValue = { tasks: emptyTaskIndex(), subagents: [], scope: "m/s:" };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  markdownCalls.length = 0;
  extraMounts.files = 0;
  extraMounts.ports = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderItems(items: Item[], live: boolean) {
  const [seg] = segments(items);
  act(() => {
    root.render(
      <ChatContext.Provider value={ctx}>
        <SegmentView seg={seg} live={live} mid="m" sid="s" expandFold={async () => {}} />
      </ChatContext.Provider>,
    );
  });
}

function renderAgyLive(text: string, live: boolean) {
  renderItems(
    [
      { id: "14@u#0", seq: 14, role: "user", kind: "text", text: "Write the fix", ts: "2026-11-26T00:00:00Z" },
      { id: "15@p#thinking", seq: 15, role: "assistant", kind: "thinking", text: "Planning", ts: "2026-11-26T00:00:01Z" },
      { id: "15@p#text", seq: 15, role: "assistant", kind: "text", text, ts: "2026-11-26T00:00:02Z" },
    ],
    live,
  );
}

describe("SegmentView AGY in-place live text streaming", () => {
  it("streams in-place AGY text incrementally via StreamChunk, preserves <pre> DOM identity across settle, and gates reply probes until settle", async () => {
    const chunk0 = "Intro paragraph.\n\n```ts\nconst a = 1;";
    const chunk1 = "Intro paragraph.\n\n```ts\nconst a = 1;\nconst b = 2;\n```";
    const chunk2 = `${chunk1}\n\nClosing paragraph.`;

    renderAgyLive(chunk0, true);
    expect(markdownCalls.at(-1)?.streaming).toBe(true);
    expect(host.querySelector("[data-answer]")?.getAttribute("data-answer")).toBe("true");
    expect(extraMounts.files).toBe(0);
    expect(extraMounts.ports).toBe(0);

    const introP = host.querySelector("[data-answer] p");
    const initialPre = host.querySelector("[data-answer] pre");
    expect(introP).not.toBeNull();
    expect(initialPre).not.toBeNull();

    // Track destructive <pre> removals across in-place updates and settlement.
    let preRemoved = 0;
    const countRemovals = (muts: MutationRecord[]) => {
      for (const m of muts) {
        for (const n of m.removedNodes) {
          if (n instanceof Element && (n.matches("pre, .code-block") || n.querySelector("pre, .code-block"))) {
            preRemoved++;
          }
        }
      }
    };
    const mo = new MutationObserver(countRemovals);
    mo.observe(host, { childList: true, subtree: true });

    renderAgyLive(chunk1, true);
    countRemovals(mo.takeRecords());
    await Promise.resolve();
    expect(markdownCalls.at(-1)?.streaming).toBe(true);
    expect(host.querySelector("[data-answer] p")).toBe(introP);
    expect(host.querySelector("[data-answer] pre")).toBe(initialPre);
    expect(initialPre?.isConnected).toBe(true);
    expect(preRemoved).toBe(0);

    renderAgyLive(chunk2, true);
    countRemovals(mo.takeRecords());
    await Promise.resolve();
    expect(host.querySelector("[data-answer] p")).toBe(introP);
    expect(host.querySelector("[data-answer] pre")).toBe(initialPre);
    expect(initialPre?.isConnected).toBe(true);
    expect(preRemoved).toBe(0);
    expect(extraMounts.files).toBe(0);
    expect(extraMounts.ports).toBe(0);

    // Settle the turn (live: true -> false): keep chunk keys mounted so <pre> survives, and mount reply probes.
    renderAgyLive(chunk2, false);
    countRemovals(mo.takeRecords());
    await Promise.resolve();
    mo.disconnect();
    expect(markdownCalls.at(-1)?.streaming).toBeUndefined();
    expect(preRemoved).toBe(0);
    expect(host.querySelector("[data-answer] p")).toBe(introP);
    expect(host.querySelector("[data-answer] pre")).toBe(initialPre);
    expect(initialPre?.isConnected).toBe(true);
    expect(extraMounts.files).toBeGreaterThan(0);
    expect(extraMounts.ports).toBeGreaterThan(0);
  });

  it("resolves cross-block reference links and footnotes after settlement", () => {
    const md = [
      "See the [specification][spec] and note[^1].",
      "",
      "Middle paragraph.",
      "",
      "[spec]: https://example.com/spec",
      "[^1]: Footnote explanation.",
    ].join("\n");

    renderAgyLive(md, true);
    renderAgyLive(md, false);

    const link = host.querySelector<HTMLAnchorElement>('[data-answer] a[href="https://example.com/spec"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("specification");
    expect(host.querySelector("[data-answer]")?.textContent).toContain("Footnote explanation.");
  });

  it("flushes streaming throttle immediately when LatestAnswer switches to a distinct persisted item ID", () => {
    vi.useFakeTimers();
    try {
      const baseUser: Item = { id: "14@u#0", seq: 14, role: "user", kind: "text", text: "Run checks", ts: "2026-11-26T00:00:00Z" };
      const first: Item = { id: "15@a#text", seq: 15, role: "assistant", kind: "text", text: "Previous narration", ts: "2026-11-26T00:00:01Z" };
      const second: Item = { id: "16@b#text", seq: 16, role: "assistant", kind: "text", text: "New reply", ts: "2026-11-26T00:00:02Z" };

      renderItems([baseUser, first], true);
      const ans1 = host.querySelector("[data-latest-text] [data-answer]");
      expect(ans1?.getAttribute("data-items")).toBe("15@a#text");
      expect(ans1?.textContent).toContain("Previous narration");

      // Within the same throttle interval, replace latest persisted item with a distinct item ID.
      renderItems([baseUser, first, second], true);
      const ans2 = host.querySelector("[data-latest-text] [data-answer]");
      expect(ans2?.getAttribute("data-items")).toBe("16@b#text");
      expect(ans2?.textContent).toContain("New reply");
      expect(ans2?.textContent).not.toContain("Previous narration");
    } finally {
      vi.useRealTimers();
    }
  });
});
