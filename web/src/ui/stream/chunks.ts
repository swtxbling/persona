// Streaming Markdown in chunks: ReactMarkdown's own parser identifies complete blocks, and only boundaries between
// them can become cuts. Sealed chunks keep their source-offset React keys and DOM; only the growing tail is parsed again.

import { parseMarkdown, walkMarkdown, type MarkdownNode, type MarkdownRoot } from "./syntax";

export interface Chunk {
  /** Where it starts in the text: its React key and its fade state's key. */
  start: number;
  content: string;
}

// Preserve the existing streaming guards around a next line that can continue the preceding container or become a list
// item. These guards only reject parser-block boundaries; they no longer classify fences or images themselves.
const continues = (line: string) => /^[\t ]/.test(line) || /^(?:[-+*]|\d{1,9}[.)])(?:[\t ]|$)/.test(line) || line.startsWith(">");
const mayContinue = (line: string) => /^(?:[-+*]|\d{1,9}[.)]?)$/.test(line);
const HTML_BLOCK = /^ {0,3}<(?:!--|\?|!\[CDATA\[|![A-Za-z]|\/?[A-Za-z][A-Za-z0-9-]*(?:[\t />]|$))/m;

function hasReferenceDefinition(tree: MarkdownRoot): boolean {
  let found = false;
  walkMarkdown(tree, (node) => {
    if (node.type === "definition" || node.type === "footnoteDefinition") found = true;
  });
  return found;
}

/** Whether a complete paragraph starts or ends with one or more images, ignoring whitespace between inline nodes. */
function imageRunAtEdge(node: MarkdownNode, edge: "start" | "end"): boolean {
  if (node.type !== "paragraph" || !node.children?.length) return false;
  const children = edge === "start" ? node.children : [...node.children].reverse();
  let images = 0;
  for (const child of children) {
    if (child.type === "image") {
      images += 1;
      continue;
    }
    if (child.type === "text" && !child.value?.trim()) continue;
    break;
  }
  return images > 0;
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

/** Math that is still streaming is not yet a parser math node. Track only that tail guard, excluding real code lines. */
function mathOpenByLine(source: string, tree: MarkdownRoot): Map<number, boolean> {
  const codeLines: [number, number][] = [];
  walkMarkdown(tree, (node) => {
    const start = node.position?.start;
    const end = node.position?.end;
    if (node.type === "code" && start?.offset !== undefined && end && /^(`{3,}|~{3,})/.test(source.slice(start.offset))) {
      codeLines.push([start.line, end.line]);
    }
  });

  const states = new Map<number, boolean>();
  let math = false;
  let lineNumber = 1;
  for (let start = 0; start <= source.length; lineNumber += 1) {
    states.set(start, math);
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    const line = source.slice(start, end).replace(/\r$/, "");
    if (!codeLines.some(([from, to]) => from <= lineNumber && lineNumber <= to)) {
      if (/^ {0,3}(?:\$\$|\\\$\\\$)[\t ]*$/.test(line)) math = !math;
      else if (/^ {0,3}\\\[[\t ]*$/.test(line)) math = true;
      else if (/^ {0,3}\\\][\t ]*$/.test(line)) math = false;
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return states;
}

/**
 * A cut is a blank-line boundary between two complete parser root blocks. List/quote/math/code contents never become
 * candidates, and complete multiline image paragraphs remain available to the gallery plugin in one parser root.
 */
function cutBefore(source: string, previous: MarkdownNode, next: MarkdownNode, mathOpen: Map<number, boolean>): number | null {
  const previousEnd = previous.position?.end.offset;
  const nextStart = next.position?.start.offset;
  if (previousEnd === undefined || nextStart === undefined) return null;
  const cut = lineStart(source, nextStart);
  if (cut <= 0 || cut >= source.length || !/\n[\t ]*\r?\n/.test(source.slice(previousEnd, cut)) || mathOpen.get(cut)) return null;

  const rest = source.slice(cut);
  const nextLine = rest.split("\n", 1)[0].replace(/\r$/, "");
  if (continues(nextLine)) return null;
  if (!rest.includes("\n") && mayContinue(nextLine)) return null;
  if (imageRunAtEdge(previous, "end") && imageRunAtEdge(next, "start")) return null;
  return cut;
}

/** Text with cross-block references, footnotes, or HTML stays in one parser root. */
function needsWholeDocument(source: string, tree: MarkdownRoot): boolean {
  return hasReferenceDefinition(tree) || HTML_BLOCK.test(source);
}

export function splitChunks(source: string): Chunk[] {
  if ((!source.includes("\n\n") && !source.includes("\r\n\r\n")) || HTML_BLOCK.test(source)) {
    return [{ start: 0, content: source }];
  }

  const tree = parseMarkdown(source);
  if (needsWholeDocument(source, tree)) return [{ start: 0, content: source }];

  const cuts: number[] = [];
  const blocks = tree.children ?? [];
  const mathOpen = mathOpenByLine(source, tree);
  for (let i = 1; i < blocks.length; i += 1) {
    const cut = cutBefore(source, blocks[i - 1], blocks[i], mathOpen);
    if (cut !== null) cuts.push(cut);
  }
  if (!cuts.length) return [{ start: 0, content: source }];

  const chunks: Chunk[] = [];
  let at = 0;
  for (const cut of cuts) {
    if (cut <= at || cut > source.length) continue;
    chunks.push({ start: at, content: source.slice(at, cut) });
    at = cut;
  }
  chunks.push({ start: at, content: source.slice(at) });
  return chunks;
}
