// Streaming Markdown made whole for the moment: an actually open code fence is closed, an unclosed ** / * at the end is
// closed, and a half-written image or link shows as its text. Fence decisions and container positions come from the same
// ReactMarkdown parser that renders the reply; a candidate closer is accepted only after the parser confirms it closes
// the original trailing code node rather than creating another block.

import { lastMarkdownBlock, parseMarkdown, walkMarkdown, type MarkdownNode, type MarkdownRoot } from "./syntax";
import { analyzeCode, maskCodeRanges } from "./code";

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function fenceMarker(source: string, node: MarkdownNode): string | null {
  const start = node.position?.start.offset;
  if (node.type !== "code" || start === undefined) return null;
  return /^(`{3,}|~{3,})/.exec(source.slice(start))?.[1] ?? null;
}

/** Blank list markers on the opener's own line; blockquote markers and indentation remain in the closing prefix. */
function closingPrefix(source: string, node: MarkdownNode, ancestors: MarkdownNode[]): string {
  const start = node.position?.start.offset;
  const startLine = node.position?.start.line;
  if (start === undefined || startLine === undefined) return "";
  const atLine = lineStart(source, start);
  const prefix = source.slice(atLine, start).split("");

  for (const ancestor of ancestors) {
    if (ancestor.type !== "listItem" || ancestor.position?.start.line !== startLine) continue;
    const itemStart = ancestor.position.start.offset;
    const first = ancestor.children?.[0];
    if (itemStart === undefined || first?.position?.start.line !== startLine) continue;
    const contentStart = first.position.start.offset;
    if (contentStart === undefined) continue;
    for (let i = itemStart - atLine; i < contentStart - atLine; i += 1) prefix[i] = " ";
  }
  return prefix.join("");
}

/** Return a parser-verified repair for the trailing open fence, or null when the source has none. */
function repairOpenFence(source: string, tree: MarkdownRoot): string | null {
  const { node, ancestors } = lastMarkdownBlock(tree);
  const marker = fenceMarker(source, node);
  const start = node.position?.start.offset;
  if (!marker || start === undefined) return null;

  const closer = `${closingPrefix(source, node, ancestors)}${marker}`;
  const candidate = source.endsWith("\n") ? source + closer : `${source}\n${closer}`;
  const parsed = lastMarkdownBlock(parseMarkdown(candidate)).node;
  const closesOriginal =
    parsed.type === "code" &&
    parsed.position?.start.offset === start &&
    parsed.position.end.offset === candidate.length &&
    fenceMarker(candidate, parsed) === marker;
  return closesOriginal ? candidate : null;
}

// Whether emphasis/code-span repair can see each source character. Complete fenced-code lines, including their
// container prefixes, are blanked by parser position instead of being rediscovered with a second fence scanner.
function outsideFences(source: string, tree: MarkdownRoot): string {
  const outside = source.split("");
  walkMarkdown(tree, (node) => {
    if (!fenceMarker(source, node)) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const from = lineStart(source, start);
    const newline = source.indexOf("\n", end);
    const to = newline < 0 ? source.length : newline;
    for (let i = from; i < to; i += 1) if (outside[i] !== "\r") outside[i] = " ";
  });
  return outside.join("");
}

function escaped(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

// A * that starts a list item: only spaces before it on its line, a space after it.
function bullet(text: string, i: number): boolean {
  if (text[i + 1] !== " " && text[i + 1] !== "\t") return false;
  for (let j = i - 1; j >= 0; j--) {
    if (text[j] === "\n") return true;
    if (text[j] !== " " && text[j] !== "\t") return false;
  }
  return true;
}

// Unescaped runs of exactly this delimiter: how many and where the last one is. A *** run pairs differently by
// context: then nothing is repaired.
function scan(text: string, delim: "**" | "*"): { count: number; last: number; mixed: boolean } {
  let count = 0;
  let last = -1;
  let mixed = false;
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "*" || escaped(text, i)) {
      i++;
      continue;
    }
    let end = i;
    while (text[end] === "*") end++;
    const len = end - i;
    if (len >= 3) mixed = true;
    else if ((delim === "**" && len === 2) || (delim === "*" && len === 1 && !bullet(text, i))) {
      count++;
      last = i;
    }
    i = end;
  }
  return { count, last, mixed };
}

// Closes the last opener only when what follows it is text on the same line (not space, not a backtick).
function balance(md: string, delim: "**" | "*"): string {
  if (!md.includes(delim)) return md;
  const { count, last, mixed } = scan(md, delim);
  if (mixed || count % 2 === 0 || last < 0) return md;
  const rest = md.slice(last + delim.length);
  if (!rest.trim() || rest.includes("\n") || rest.includes("`") || /^\s/.test(rest)) return md;
  return md + delim;
}

const TABLE_DIVIDER = /^ {0,3}\|?[\t ]*:?-{3,}:?[\t ]*(?:\|[\t ]*:?-{3,}:?[\t ]*)*\|?[\t ]*$/;

/** A table's last row still being written (no line end yet, under the table's divider): left out until it is whole, so
 *  the table does not grow a cell at a time and reflow its columns with every word (#5602). */
function holdHalfRow(md: string): string {
  if (md.endsWith("\n")) return md;
  const nl = md.lastIndexOf("\n");
  if (nl < 0 || !md.slice(nl + 1).trimStart().startsWith("|")) return md;
  const lines = md.slice(0, nl).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (TABLE_DIVIDER.test(l) && l.includes("|")) return md.slice(0, nl + 1);
    if (!l.startsWith("|")) return md;
  }
  return md;
}

function repairInlineMarkdown(md: string, outside: string): string {
  md = holdHalfRow(md);
  // half a code span: whatever * follows may be inside it
  let ticks = 0;
  for (let i = 0; i < outside.length; i++) if (outside[i] === "`" && !escaped(outside, i)) ticks++;
  if (ticks % 2) return md;
  let t = md;
  if (t.includes("![")) t = t.replace(/!\[([^\]\n]*)\]\([^)\n]*$/, "$1").replace(/!\[([^\]\n]*)$/, "$1");
  if (t.includes("](")) t = t.replace(/(^|[^!\\])\[([^\]\n]*)\]\([^)\n]*$/, "$1$2");
  return balance(balance(t, "**"), "*");
}

function repairWithParser(md: string): string {
  const tree = parseMarkdown(md);
  const repairedFence = repairOpenFence(md, tree);
  if (repairedFence) return repairedFence;
  return repairInlineMarkdown(md, outsideFences(md, tree));
}

export function repairStreamingMarkdown(md: string): string {
  if (!md) return md;
  const analysis = analyzeCode(md);
  // References retain the R5 parser-backed container and invalid-opener decisions. Ordinary streaming text uses the
  // cheaper block spans instead of constructing a complete remark processor for every incremental prefix.
  if (analysis.textParts.some((part) => part.includes("]:"))) return repairWithParser(md);

  const last = analysis.ranges.at(-1);
  if (last?.fence && !last.fence.closed && last.end === md.length) {
    const closer = `${last.fence.closingPrefix}${last.fence.marker}`;
    return md.endsWith("\n") ? md + closer : `${md}\n${closer}`;
  }
  return repairInlineMarkdown(md, maskCodeRanges(md, analysis.ranges, true));
}
