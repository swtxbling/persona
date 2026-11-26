// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTextThrottle, throttleInterval, THROTTLE_BASE_MS, THROTTLE_MAX_MS, useThrottledText, type ThrottleClock } from "./throttle";

describe("throttleInterval", () => {
  it("grows with the text and stops at 400 ms", () => {
    expect(throttleInterval("x")).toBe(THROTTLE_BASE_MS);
    expect(throttleInterval("x".repeat(4_001))).toBe(66);
    expect(throttleInterval("x".repeat(12_000))).toBe(66);
    expect(throttleInterval("x".repeat(12_001))).toBe(125);
    expect(throttleInterval("x".repeat(32_001))).toBe(175);
    expect(throttleInterval("x".repeat(400_000))).toBe(THROTTLE_MAX_MS);
  });

  it("goes at the page's pace: 33 ms in front, 100 ms unfocused, 200 ms hidden (#5602)", () => {
    expect(throttleInterval("x", "front")).toBe(33);
    expect(throttleInterval("x", "unfocused")).toBe(100);
    expect(throttleInterval("x", "hidden")).toBe(200);
    // a long text's own interval when it is longer
    expect(throttleInterval("x".repeat(12_001), "unfocused")).toBe(125);
    expect(throttleInterval("x".repeat(400_000), "hidden")).toBe(THROTTLE_MAX_MS);
  });
});

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  const clock: ThrottleClock = {
    now: () => now,
    setTimeout: (f, ms) => (timers.set(++id, { at: now + ms, f }), id),
    clearTimeout: (i) => void timers.delete(i),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [i, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(i);
        t.f();
      }
    }
  };
  return { clock, advance, pending: () => timers.size };
}

describe("createTextThrottle", () => {
  it("emits the first value at once, then at most once per interval, the latest one", () => {
    const out: string[] = [];
    const c = fakeClock();
    const t = createTextThrottle((s) => out.push(s), c.clock);
    t.push("a");
    expect(out).toEqual(["a"]);
    c.advance(10);
    t.push("ab");
    c.advance(10);
    t.push("abc");
    expect(out).toEqual(["a"]);
    c.advance(13); // 33 ms after "a"
    expect(out).toEqual(["a", "abc"]);
    c.advance(100);
    expect(out).toEqual(["a", "abc"]);
  });

  it("waits longer while the tab is hidden", () => {
    const out: string[] = [];
    const c = fakeClock();
    let pace: "front" | "hidden" = "hidden";
    const t = createTextThrottle((s) => out.push(s), { ...c.clock, pace: () => pace });
    t.push("a");
    c.advance(100);
    t.push("ab");
    c.advance(50);
    expect(out).toEqual(["a"]); // 150 ms: not yet at 200
    c.advance(50);
    expect(out).toEqual(["a", "ab"]);
    pace = "front";
    c.advance(40);
    t.push("abc");
    expect(out).toEqual(["a", "ab", "abc"]);
  });

  it("never drops the last value", () => {
    const out: string[] = [];
    const c = fakeClock();
    const t = createTextThrottle((s) => out.push(s), c.clock);
    t.push("a");
    c.advance(10);
    t.push("ab");
    c.advance(500);
    expect(out.at(-1)).toBe("ab");
  });

  it("flush emits at once and drops what was pending; the next stream starts at once", () => {
    const out: string[] = [];
    const c = fakeClock();
    const t = createTextThrottle((s) => out.push(s), c.clock);
    t.push("a");
    c.advance(10);
    t.push("ab");
    t.flush("");
    expect(out).toEqual(["a", ""]);
    expect(c.pending()).toBe(0);
    c.advance(10);
    t.push("new");
    expect(out.at(-1)).toBe("new");
  });

  it("cancel drops what was pending, and the next stream starts at once", () => {
    const out: string[] = [];
    const c = fakeClock();
    const t = createTextThrottle((s) => out.push(s), c.clock);
    t.push("a");
    t.push("ab");
    t.cancel();
    c.advance(500);
    expect(out).toEqual(["a"]);
    t.push("x");
    c.advance(1);
    t.cancel();
    t.push("y");
    expect(out).toEqual(["a", "x", "y"]);
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useThrottledText", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  function Probe({ value, enabled, sourceKey }: { value: string; enabled: boolean; sourceKey?: string }) {
    const shown = useThrottledText(value, enabled, sourceKey);
    return createElement("div", { "data-key": sourceKey ?? "" }, shown);
  }

  it("resets throttle immediately when sourceKey changes while still throttling same-key updates", () => {
    const draw = (value: string, enabled: boolean, sourceKey?: string) =>
      act(() => root.render(createElement(Probe, { value, enabled, sourceKey })));

    draw("Previous narration", true, "15@a#text");
    expect(host.textContent).toBe("Previous narration");

    // Same-key update within throttle interval stays throttled until the interval elapses.
    act(() => vi.advanceTimersByTime(10));
    draw("Previous narration extended", true, "15@a#text");
    expect(host.textContent).toBe("Previous narration");

    // Distinct sourceKey within the same throttle window renders the new item immediately and cancels the old pending timer.
    draw("New reply", true, "16@b#text");
    expect(host.firstElementChild?.getAttribute("data-key")).toBe("16@b#text");
    expect(host.textContent).toBe("New reply");

    // Same-key update on the new item still throttles normally.
    act(() => vi.advanceTimersByTime(10));
    draw("New reply extended", true, "16@b#text");
    expect(host.textContent).toBe("New reply");

    // Once the throttle window elapses, the new item's pending update lands (never the canceled old item's text).
    act(() => vi.advanceTimersByTime(300));
    expect(host.textContent).toBe("New reply extended");
  });

  it("keeps backwards-compatible throttling when sourceKey is omitted", () => {
    const draw = (value: string, enabled: boolean) =>
      act(() => root.render(createElement(Probe, { value, enabled })));

    draw("Delta 1", true);
    expect(host.textContent).toBe("Delta 1");

    act(() => vi.advanceTimersByTime(10));
    draw("Delta 2", true);
    expect(host.textContent).toBe("Delta 1");

    act(() => vi.advanceTimersByTime(300));
    expect(host.textContent).toBe("Delta 2");

    draw("Final", false);
    expect(host.textContent).toBe("Final");
  });
});
