// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Item } from "../../lib/types";
import { forgetExpanded } from "./expanded";
import { ThinkingRow } from "./ThinkingRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let observeCount = 0;
let disconnectCount = 0;

beforeEach(() => {
  forgetExpanded();
  observeCount = 0;
  disconnectCount = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        observeCount++;
      }
      unobserve() {}
      disconnect() {
        disconnectCount++;
      }
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const thought = (text: string): Item => ({
  id: "15@liveplan#thinking",
  seq: 15,
  role: "assistant",
  kind: "thinking",
  text,
});

describe("ThinkingRow ResizeObserver stability during streaming thoughts", () => {
  it("skips ResizeObserver completely across multi-line streaming chunks", () => {
    let text = "**Live AGY Thought**\nLine 1: Analyzing streaming pipeline...";
    act(() => root.render(<ThinkingRow item={thought(text)} scope="m/s:" />));
    for (let i = 2; i <= 11; i++) {
      text += `\nLine ${i}: Streaming chunk ${i}`;
      act(() => root.render(<ThinkingRow item={thought(text)} scope="m/s:" />));
    }
    expect(observeCount).toBe(0);
    expect(disconnectCount).toBe(0);
    const trigger = host.querySelector<HTMLElement>('[data-thinking="words"] > [role="button"]');
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });

  it("reuses one ResizeObserver across single-line streaming updates and disconnects once multi-line", () => {
    let text = "Single line chunk 1";
    act(() => root.render(<ThinkingRow item={thought(text)} scope="m/s:" />));
    expect(observeCount).toBe(1);
    expect(disconnectCount).toBe(0);

    for (let i = 2; i <= 5; i++) {
      text += ` chunk ${i}`;
      act(() => root.render(<ThinkingRow item={thought(text)} scope="m/s:" />));
    }
    expect(observeCount).toBe(1);
    expect(disconnectCount).toBe(0);

    act(() => root.render(<ThinkingRow item={thought(`${text}\nSecond line`)} scope="m/s:" />));
    expect(observeCount).toBe(1);
    expect(disconnectCount).toBe(1);
  });

  it("attaches ResizeObserver when transitioning from empty text to single-line text", () => {
    act(() => root.render(<ThinkingRow item={thought("   ")} scope="m/s:" />));
    expect(observeCount).toBe(0);
    act(() => root.render(<ThinkingRow item={thought("Now visible single line")} scope="m/s:" />));
    expect(observeCount).toBe(1);
    expect(disconnectCount).toBe(0);
  });
});
