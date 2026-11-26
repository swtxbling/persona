import { describe, expect, it } from "vitest";
import { runStep } from "./run-step";
import { blockOrder, exchangeSteps, insideFold, mergeItems, segments, sortItems, withoutFolded } from "./turns";
import type { Item } from "./types";

const item = (id: string, seq: number, kind: Item["kind"], extra: Partial<Item> = {}): Item => ({
  id,
  seq,
  role: kind === "tool_result" ? "user" : "assistant",
  kind,
  ...extra,
});

describe("AGY non-numeric block ordering and fold bounds", () => {
  it("orders numeric and named AGY block suffixes deterministically on the same seq", () => {
    const unordered: Item[] = [
      item("9@h#zeta", 9, "notice", { text: "z" }),
      item("9@h#turn_duration", 9, "notice", { text: "d" }),
      item("9@h#tool10", 9, "tool_use", { tool_name: "Bash", tool_use_id: "c10" }),
      item("9@h#media1", 9, "image"),
      item("9@h#tool2", 9, "tool_use", { tool_name: "Bash", tool_use_id: "c2" }),
      item("9@h#text", 9, "text", { text: "narration" }),
      item("9@h#alpha", 9, "notice", { text: "a" }),
      item("9@h#media0", 9, "image"),
      item("9@h#tool0", 9, "tool_use", { tool_name: "Read", tool_use_id: "c0" }),
      item("9@h#thinking", 9, "thinking", { text: "thought" }),
      item("9@h#0", 9, "text", { text: "num0" }),
      item("9@h#-1", 9, "notice", { text: "wake" }),
      item("9@h#tool1", 9, "tool_use", { tool_name: "Grep", tool_use_id: "c1" }),
    ];

    expect(sortItems(unordered).map((i) => i.id)).toEqual([
      "9@h#-1",
      "9@h#0",
      "9@h#thinking",
      "9@h#text",
      "9@h#tool0",
      "9@h#tool1",
      "9@h#tool2",
      "9@h#tool10",
      "9@h#media0",
      "9@h#media1",
      "9@h#turn_duration",
      "9@h#alpha",
      "9@h#zeta",
    ]);
    // Absent suffix matches #0 so fold bounds without #0 keep CC/Codex parity.
    expect(blockOrder({ id: "9", seq: 9 }, { id: "9#0", seq: 9 })).toBe(0);
  });

  it("includes AGY items at through_seq#thinking inside single-step and multi-step folds while excluding #text", () => {
    const singleFold = item("fold:7@0011223344#thinking", 7, "fold", {
      fold: { items: 1, tools: 0, thoughts: 1, through_seq: 7, through_id: "7@0011223344#thinking" },
    });
    const singleThought = item("7@0011223344#thinking", 7, "thinking", { text: "SINGLE_STEP_FOLD_THOUGHT" });
    const singleAnswer = item("7@0011223344#text", 7, "text", { text: "Final answer on same seq" });

    expect(insideFold(singleThought, singleFold)).toBe(true);
    expect(insideFold(singleAnswer, singleFold)).toBe(false);

    const expandedSingle = mergeItems([singleFold, singleAnswer], [singleThought]);
    expect(expandedSingle.map((i) => i.id)).toEqual(["7@0011223344#thinking", "7@0011223344#text"]);

    const refoldedSingle = mergeItems(withoutFolded(expandedSingle, [singleFold]), [singleFold]);
    expect(refoldedSingle.map((i) => i.id)).toEqual(["fold:7@0011223344#thinking", "7@0011223344#text"]);

    const multiFold = item("fold:2@aa#thinking", 2, "fold", {
      fold: { items: 4, tools: 2, thoughts: 2, through_seq: 5, through_id: "5@ee#thinking" },
    });
    const lastThought = item("5@ee#thinking", 5, "thinking", { text: "TURN1_LAST_FOLD_THOUGHT" });
    const turnAnswer = item("5@ee#text", 5, "text", { text: "TURN1_ANSWER" });

    expect(insideFold(lastThought, multiFold)).toBe(true);
    expect(insideFold(turnAnswer, multiFold)).toBe(false);
  });

  it("keeps same-seq AGY narration before #tool0 in exchangeSteps", () => {
    const items: Item[] = [
      { id: "14@u#0", seq: 14, role: "user", kind: "text", text: "Check status" },
      item("15@p#thinking", 15, "thinking", { text: "Planning" }),
      item("15@p#text", 15, "text", { text: "Running git status now." }),
      item("15@p#tool0", 15, "tool_use", { tool_name: "Bash", tool_use_id: "c15", tool_input: { command: "git status" } }),
    ];
    const [seg] = segments(items);
    expect(exchangeSteps(seg).map((s) => s.id)).toEqual(["15@p#thinking", "15@p#text", "15@p#tool0"]);
  });

  it("reports accurate live runStep for same-seq AGY #thinking -> #text -> #tool0", () => {
    const user: Item = { id: "14@u#0", seq: 14, role: "user", kind: "text", text: "Stream answer" };
    const thinking = item("15@p#thinking", 15, "thinking", { text: "Analyzing" });
    const text = item("15@p#text", 15, "text", { text: "Streaming prose" });
    const tool = item("15@p#tool0", 15, "tool_use", { tool_name: "Bash", tool_use_id: "c15", tool_input: { command: "pwd" } });
    const res = item("16@r#0", 16, "tool_result", { tool_use_id: "c15", text: "/tmp" });

    expect(runStep(segments([user, thinking, text]).at(-1), false)).toEqual({ kind: "text" });
    expect(runStep(segments([user, thinking, text, tool]).at(-1), false)).toEqual({ kind: "tool", tool: "Bash" });
    expect(runStep(segments([user, thinking, text, tool, res]).at(-1), false)).toEqual({ kind: "after" });
  });
});
