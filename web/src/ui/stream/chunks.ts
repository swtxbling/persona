// Streaming Markdown in chunks: ReactMarkdown's own parser identifies complete blocks, and only boundaries between
// them can become cuts. Sealed chunks keep their source-offset React keys and DOM; only the growing tail is parsed again.

import { parseMarkdown, walkMarkdown, type MarkdownNode, type MarkdownRoot } from "./syntax";
import { analyzeCode, type CodeAnalysis } from "./code";

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

function splitChunksParser(source: string): Chunk[] {
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

const IMAGE_SPACE_RE = /[ \t]/;
const ESCAPABLE_PUNCTUATION_RE = /[!-/:-@[-`{-~]/;
const skipImageSpace = (line: string, i: number) => {
  while (i < line.length && IMAGE_SPACE_RE.test(line[i])) i += 1;
  return i;
};
const escapesNext = (line: string, i: number) =>
  line[i] === "\\" && i + 1 < line.length && ESCAPABLE_PUNCTUATION_RE.test(line[i + 1]);

function scanImageTitle(line: string, start: number): number {
  const open = line[start];
  const close = open === "(" ? ")" : open;
  if (open !== '"' && open !== "'" && open !== "(") return -1;
  let i = start + 1;
  while (i < line.length) {
    if (escapesNext(line, i)) {
      i += 2;
      continue;
    }
    if (open === "(" && line[i] === "(") return -1;
    if (line[i] === close) return i + 1;
    i += 1;
  }
  return -1;
}

/** Single-line image recognition for the fast path; any multiline paragraph goes through the parser instead. */
function scanImage(line: string, start: number): number {
  const len = line.length;
  let i = start;
  if (line[i] !== "!" || line[i + 1] !== "[") return -1;
  i += 2;
  let bracketDepth = 1;
  while (i < len) {
    if (escapesNext(line, i)) {
      i += 2;
      continue;
    }
    if (line[i] === "[") bracketDepth += 1;
    if (line[i] === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        i += 1;
        break;
      }
    }
    i += 1;
  }
  if (bracketDepth !== 0 || line[i] !== "(") return -1;
  i = skipImageSpace(line, i + 1);
  if (i >= len) return -1;

  if (line[i] === "<") {
    i += 1;
    while (i < len) {
      if (escapesNext(line, i)) {
        i += 2;
        continue;
      }
      if (line[i] === "<") return -1;
      if (line[i] === ">") break;
      i += 1;
    }
    if (i >= len) return -1;
    i += 1;
  } else {
    let parenthesisDepth = 0;
    while (i < len) {
      if (escapesNext(line, i)) {
        i += 2;
        continue;
      }
      if (IMAGE_SPACE_RE.test(line[i])) break;
      if (line[i] === "(") {
        parenthesisDepth += 1;
      } else if (line[i] === ")") {
        if (parenthesisDepth === 0) break;
        parenthesisDepth -= 1;
      } else if (line.charCodeAt(i) <= 0x1f || line.charCodeAt(i) === 0x7f) {
        return -1;
      }
      i += 1;
    }
    if (i >= len || parenthesisDepth > 0) return -1;
  }

  const beforeWhitespace = i;
  i = skipImageSpace(line, i);
  if (line[i] === ")") return i + 1;
  if (i === beforeWhitespace) return -1;
  const titleEnd = scanImageTitle(line, i);
  if (titleEnd < 0) return -1;
  i = skipImageSpace(line, titleEnd);
  return line[i] === ")" ? i + 1 : -1;
}

function isImageOnlyLine(line: string): boolean {
  let i = skipImageSpace(line, 0);
  let images = 0;
  while (i < line.length) {
    const end = scanImage(line, i);
    if (end < 0) return false;
    images += 1;
    i = skipImageSpace(line, end);
  }
  return images > 0;
}

interface FastChunkCheckpoint {
  pending: number | null;
  math: boolean;
  prevNonBlank: string;
  rangeIndex: number;
  cutCount: number;
}

interface FastChunkAnalysis {
  source: string;
  chunks: Chunk[];
  cuts: number[];
  checkpoints: FastChunkCheckpoint[];
}

const FAST_CHUNK_CACHE = new Map<string, FastChunkAnalysis>();

function previousFastChunks(source: string): FastChunkAnalysis | undefined {
  const candidates = [...FAST_CHUNK_CACHE.values()];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i];
    if (source.length > candidate.source.length && source.startsWith(candidate.source) && candidate.checkpoints.at(-1)) return candidate;
  }
  return undefined;
}

/** Fast blank-line chunking with complete block-code ranges, never with the retired R4 fence state machine. */
function splitChunksFast(source: string, analysis: CodeAnalysis): Chunk[] {
  const exact = FAST_CHUNK_CACHE.get(source);
  if (exact) return exact.chunks;
  const previous = previousFastChunks(source);
  const { ranges, lines, offsets } = analysis;
  let cuts: number[] = [];
  let pending: number | null = null;
  let math = false;
  let prevNonBlank = "";
  let rangeIndex = 0;
  let first = 0;
  let checkpoints: FastChunkCheckpoint[] = [];
  if (previous) {
    // The previous analysis and this one share their unchanged line prefix. Reprocess only its former growing line.
    const previousLineCount = previous.checkpoints.length;
    first = previousLineCount - 1;
    const checkpoint = previous.checkpoints[first];
    checkpoints = previous.checkpoints.slice(0, first);
    pending = checkpoint.pending;
    math = checkpoint.math;
    prevNonBlank = checkpoint.prevNonBlank;
    rangeIndex = checkpoint.rangeIndex;
    cuts = previous.cuts.slice(0, checkpoint.cutCount);
  }

  for (let i = first; i < lines.length; i += 1) {
    checkpoints[i] = { pending, math, prevNonBlank, rangeIndex, cutCount: cuts.length };
    const start = offsets[i];
    const raw = lines[i];
    const hasNewline = raw.endsWith("\n");
    const nextOffset = offsets[i + 1] ?? source.length;
    const line = raw.replace(/\r?\n$/, "");
    while (rangeIndex < ranges.length && start >= ranges[rangeIndex].end) rangeIndex += 1;
    const range = ranges[rangeIndex];
    const inCode = range && start >= range.start && start < range.end;

    if (pending !== null && line.trim()) {
      const keepImages = isImageOnlyLine(prevNonBlank) && isImageOnlyLine(line);
      if (!continues(line) && !(!hasNewline && mayContinue(line)) && !keepImages) cuts.push(pending);
      pending = null;
    }
    if (inCode) {
      prevNonBlank = "";
    } else if (/^ {0,3}(?:\$\$|\\\$\\\$)[\t ]*$/.test(line)) {
      math = !math;
      prevNonBlank = "";
    } else if (/^ {0,3}\\\[[\t ]*$/.test(line)) {
      math = true;
      prevNonBlank = "";
    } else if (/^ {0,3}\\\][\t ]*$/.test(line)) {
      math = false;
      prevNonBlank = "";
    } else if (math) {
      prevNonBlank = "";
    } else if (line.trim()) {
      prevNonBlank = line;
    }
    if (!inCode && !math && !line.trim() && hasNewline) pending = nextOffset;
  }

  const chunks: Chunk[] = [];
  if (!cuts.length) chunks.push({ start: 0, content: source });
  else {
    let at = 0;
    for (const cut of cuts) {
      if (cut <= at || cut > source.length) continue;
      chunks.push({ start: at, content: source.slice(at, cut) });
      at = cut;
    }
    chunks.push({ start: at, content: source.slice(at) });
  }
  const state = { source, chunks, checkpoints, cuts };
  FAST_CHUNK_CACHE.set(source, state);
  if (FAST_CHUNK_CACHE.size > 4) FAST_CHUNK_CACHE.delete(FAST_CHUNK_CACHE.keys().next().value!);
  return chunks;
}

export function splitChunks(source: string): Chunk[] {
  if ((!source.includes("\n\n") && !source.includes("\r\n\r\n")) || HTML_BLOCK.test(source)) {
    return [{ start: 0, content: source }];
  }
  const analysis = analyzeCode(source);
  const possibleMultilineImage = analysis.textParts.some((text) => {
    if (!text.includes("![")) return false;
    return text.split(/\r?\n[\t ]*\r?\n/).some((paragraph) => {
      const complete = paragraph.trim();
      return complete.includes("![") && complete.includes("\n");
    });
  });
  if (analysis.textParts.some((part) => part.includes("]:")) || possibleMultilineImage) return splitChunksParser(source);
  return splitChunksFast(source, analysis);
}
