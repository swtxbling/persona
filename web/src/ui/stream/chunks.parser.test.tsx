import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import remarkGfmParse from "../remark-gfm-parse";
import { splitChunks } from "./chunks";
import { repairStreamingMarkdown as repair } from "./repair";

const REFERENCE = "[spec]: https://example.com/spec";
const DEEP_LIST = `See [docs][spec].\n\nMiddle paragraph.\n\n123. \`\`\`js\n     const x = 1;\n     \`\`\`\n\n${REFERENCE}`;
const ENDED_QUOTE = `See [docs][spec].\n\nMiddle paragraph.\n\n> \`\`\`js\n> const x = 1;\n\n${REFERENCE}`;
const INVALID_BACKTICK = `See [docs][spec].\n\nMiddle paragraph.\n\n\`\`\`js\`invalid\n\n${REFERENCE}`;
const MULTILINE_TITLE = '![a](https://example.com/a.png\n"First picture")\n\n![b](https://example.com/b.png)';

function parserHtml(source: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfmParse, remarkMath] }, source))
    .replace(/<link rel="preload" as="image"[^>]*\/>/g, "")
    .replace(/>\s+</g, "><");
}

function chunkedParserHtml(source: string): string {
  return splitChunks(source).map((chunk) => parserHtml(chunk.content)).join("");
}

function expectWholeDocument(source: string): void {
  expect(splitChunks(source)).toEqual([{ start: 0, content: source }]);
  expect(chunkedParserHtml(source)).toBe(parserHtml(source));
  expect(repair(source)).toBe(source);
}

describe("parser-backed complete-block classification", () => {
  it("B1-R4-list-indent: resolves a definition after an ordered-list fence with container indentation", () => {
    expect(parserHtml(DEEP_LIST)).toContain('<a href="https://example.com/spec">docs</a>');
    expect(parserHtml(DEEP_LIST).match(/<pre>/g)).toHaveLength(1);
    expectWholeDocument(DEEP_LIST);
  });

  it("B1-R4-container-end: resolves a definition after implicit blockquote termination without repairing a new fence", () => {
    expect(parserHtml(ENDED_QUOTE)).toContain('<a href="https://example.com/spec">docs</a>');
    expect(parserHtml(ENDED_QUOTE).match(/<pre>/g)).toHaveLength(1);
    expectWholeDocument(ENDED_QUOTE);
  });

  it("B1-R4-invalid-fence: treats a backtick in backtick info as text and resolves the following definition", () => {
    expect(parserHtml(INVALID_BACKTICK)).toContain('<a href="https://example.com/spec">docs</a>');
    expect(parserHtml(INVALID_BACKTICK)).not.toContain("<pre>");
    expectWholeDocument(INVALID_BACKTICK);
  });

  it("B5-R4-multiline-image: keeps a complete multiline-title image paragraph with the next image", () => {
    expect(parserHtml(MULTILINE_TITLE).match(/<img/g)).toHaveLength(2);
    expect(parserHtml(MULTILINE_TITLE)).toContain('title="First picture"');
    expectWholeDocument(MULTILINE_TITLE);
  });

  it.each([
    [
      "nested ordered list",
      `See [docs][spec].\n\nMiddle paragraph.\n\n- outer\n\n  123. \`\`\`js\n       const x = 1;\n       \`\`\`\n\n${REFERENCE}`,
    ],
    [
      "implicit list termination",
      `See [docs][spec].\n\nMiddle paragraph.\n\n- item\n\n  \`\`\`js\n  const x = 1;\n\n${REFERENCE}`,
    ],
    [
      "explicit nested quote termination",
      `See [docs][spec].\n\nMiddle paragraph.\n\n> - \`\`\`js\n>   const x = 1;\n>   \`\`\`\n\n${REFERENCE}`,
    ],
    [
      "valid tilde info containing a backtick",
      `See [docs][spec].\n\nMiddle paragraph.\n\n~~~js\`info\n[spec]: https://example.com/not-the-definition\n~~~\n\n${REFERENCE}`,
    ],
  ])("keeps the parser's definition across %s", (_name, source) => {
    expect(parserHtml(source)).toContain('<a href="https://example.com/spec">docs</a>');
    expectWholeDocument(source);
  });

  it.each([
    ["multiline label", "![first\nlabel](https://example.com/a.png)\n\n![b](https://example.com/b.png)"],
    ["multiline destination", "![a](\nhttps://example.com/a.png\n)\n\n![b](https://example.com/b.png)"],
    ["multiline single-quoted title", "![a](https://example.com/a.png\n'First picture')\n\n![b](https://example.com/b.png)"],
    ["multiline parenthesized title", "![a](https://example.com/a.png\n(First picture))\n\n![b](https://example.com/b.png)"],
  ])("keeps parser-supported %s image runs together", (_name, source) => {
    expect(parserHtml(source).match(/<img/g)).toHaveLength(2);
    expectWholeDocument(source);
  });

  it("keeps prose around a trailing and leading image run in the same complete paragraphs", () => {
    const source = "**Kitchen**\n![a](https://example.com/a.png)\n\n![b](https://example.com/b.png)\nIt has a washer.";
    expect(parserHtml(source).match(/<img/g)).toHaveLength(2);
    expectWholeDocument(source);
  });

  it("does not merge ordinary or malformed image-text paragraphs", () => {
    const examples = [
      "![a](https://example.com/a.png) trailing\n\n![b](https://example.com/b.png)",
      "![a](https://example.com/a.png\n\n![b](https://example.com/b.png)",
      "![a](https://example.com/a(1.png)\n\n![b](https://example.com/b.png)",
      "![a](<https://example.com/a.png)\n\n![b](https://example.com/b.png)",
    ];
    for (const source of examples) {
      expect(splitChunks(source), source).toHaveLength(2);
      expect(chunkedParserHtml(source), source).toBe(parserHtml(source));
    }
  });

  it("ignores fake definitions in real top-level and container fences while sealing surrounding blocks", () => {
    const fences = [
      "```md\n[spec]: https://example.com/not-a-definition\n```",
      "123. ```md\n     [spec]: https://example.com/not-a-definition\n     ```",
      "> ~~~md`info\n> [spec]: https://example.com/not-a-definition\n> ~~~",
    ];
    for (const fence of fences) {
      const source = `Intro.\n\n${fence}\n\nClosing.`;
      expect(parserHtml(source)).not.toContain("<a ");
      const expected = fence.startsWith("```")
        ? ["Intro.\n\n", `${fence}\n\n`, "Closing."]
        : [`Intro.\n\n${fence}\n\n`, "Closing."];
      expect(splitChunks(source).map((chunk) => chunk.content), fence).toEqual(expected);
      expect(chunkedParserHtml(source), fence).toBe(parserHtml(source));
      expect(repair(source), fence).toBe(source);
    }
  });

  it("repairs only genuinely open parser-confirmed container fences", () => {
    expect(repair("123. ```js\n     const x = 1;")).toBe("123. ```js\n     const x = 1;\n     ```");
    expect(repair("> - ```js\n>   const x = 1;")).toBe("> - ```js\n>   const x = 1;\n>   ```");
    expect(repair("> - ```js\n>   const x = 1;\n>   ```")).toBe("> - ```js\n>   const x = 1;\n>   ```");
    expect(repair("~~~js`info\nconst x = 1;")).toBe("~~~js`info\nconst x = 1;\n~~~");
  });
});
