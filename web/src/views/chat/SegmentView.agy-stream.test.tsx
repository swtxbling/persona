// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTaskIndex } from "../../lib/tasks";
import { segments } from "../../lib/turns";
import type { Item } from "../../lib/types";
import { ChatContext, type ChatContextValue } from "./chat-context";

const markdownCalls = vi.hoisted(() => [] as { text: string; streaming?: boolean }[]);
const extraMounts = vi.hoisted(() => ({ files: 0, ports: 0 }));

vi.mock("../../ui/Markdown", async (load) => {
  const real = await load<typeof import("../../ui/Markdown")>();
  const { createElement } = await import("react");
  return {
    ...real,
    Markdown: (p: ComponentProps<typeof real.Markdown>) => {
      markdownCalls.push({ text: p.text, streaming: p.streaming });
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

function renderAgyLive(text: string, live: boolean) {
  const items: Item[] = [
    { id: "14@u#0", seq: 14, role: "user", kind: "text", text: "Write the fix", ts: "2026-11-26T00:00:00Z" },
    { id: "15@p#thinking", seq: 15, role: "assistant", kind: "thinking", text: "Planning", ts: "2026-11-26T00:00:01Z" },
    { id: "15@p#text", seq: 15, role: "assistant", kind: "text", text, ts: "2026-11-26T00:00:02Z" },
  ];
  const [seg] = segments(items);
  act(() => {
    root.render(
      <ChatContext.Provider value={ctx}>
        <SegmentView seg={seg} live={live} mid="m" sid="s" expandFold={async () => {}} />
      </ChatContext.Provider>,
    );
  });
}

describe("SegmentView AGY in-place live text streaming", () => {
  it("streams in-place AGY text incrementally via StreamChunk, keeps <pre> mounted, and gates reply probes until settle", () => {
    const chunk0 = "Intro paragraph.\n\n```ts\nconst a = 1;";
    const chunk1 = "Intro paragraph.\n\n```ts\nconst a = 1;\nconst b = 2;\n```";
    const chunk2 = `${chunk1}\n\nClosing paragraph.`;

    renderAgyLive(chunk0, true);
    expect(markdownCalls.at(-1)?.streaming).toBe(true);
    expect(host.querySelector("[data-answer]")?.getAttribute("data-answer")).toBe("true");
    expect(extraMounts.files).toBe(0);
    expect(extraMounts.ports).toBe(0);

    const introP = host.querySelector("[data-answer] p");
    const preEl = host.querySelector("[data-answer] pre");
    expect(introP).not.toBeNull();
    expect(preEl).not.toBeNull();

    // Track destructive <pre> removals across in-place updates and settle.
    let preRemoved = 0;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes) {
          if (n instanceof Element && (n.matches("pre, .code-block") || n.querySelector("pre, .code-block"))) {
            preRemoved++;
          }
        }
      }
    });
    mo.observe(host, { childList: true, subtree: true });

    renderAgyLive(chunk1, true);
    expect(markdownCalls.at(-1)?.streaming).toBe(true);
    expect(host.querySelector("[data-answer] p")).toBe(introP);
    expect(host.querySelector("[data-answer] pre")).toBe(preEl);

    renderAgyLive(chunk2, true);
    expect(host.querySelector("[data-answer] p")).toBe(introP);
    expect(host.querySelector("[data-answer] pre")).toBe(preEl);
    expect(extraMounts.files).toBe(0);
    expect(extraMounts.ports).toBe(0);

    // Settle the turn (live: true -> false): retainParser preserves DOM and reply probes mount.
    renderAgyLive(chunk2, false);
    mo.disconnect();
    expect(markdownCalls.at(-1)?.streaming).toBeUndefined();
    expect(preRemoved).toBe(0);
    expect(extraMounts.files).toBeGreaterThan(0);
    expect(extraMounts.ports).toBeGreaterThan(0);
  });
});
