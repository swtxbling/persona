// Streaming Markdown in chunks (ported from cindy's streamingMarkdownChunks): the text is cut at top-level blank lines,
// so the chunks before the last are sealed and keep their parse and DOM (React.memo); only the growing last one is
// parsed again at each update.

export interface Chunk {
  /** Where it starts in the text: its React key and its fade state's key. */
  start: number;
  content: string;
}

export interface Fence {
  marker: string;
  length: number;
  /** Blockquote containers around this fence; list markers only affect its opener. */
  quoteDepth?: number;
  /** Prefix required when streaming repair closes this fence while it remains inside its containers. */
  closingPrefix?: string;
}

export interface FenceRun extends Fence {
  rest: string;
}

// A line that continues the block above it: indented, a list item (also one with no text yet, a "2." or "-" alone on
// its line, which is still the list's next item) or a quote.
const continues = (line: string) => /^[\t ]/.test(line) || /^(?:[-+*]|\d{1,9}[.)])(?:[\t ]|$)/.test(line) || line.startsWith(">");

// The growing last line may still become a list item (a "2" before its "."): no cut before it until it says (#1966).
const mayContinue = (line: string) => /^(?:[-+*]|\d{1,9}[.)]?)$/.test(line);

/** A code fence line (``` or ~~~, up to 3 spaces in): its character, length and what follows it. */
export function fenceRun(line: string): FenceRun | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  return m ? { marker: m[1][0], length: m[1].length, rest: m[2] } : null;
}

const QUOTE_PREFIX_RE = /^ {0,3}>[ \t]?/;
const LIST_PREFIX_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/;

/** A fence opener that may sit on a list item or inside blockquote containers. */
function openingFenceRun(line: string): FenceRun | null {
  let rest = line;
  let quoteDepth = 0;
  let closingPrefix = "";
  while (true) {
    const quote = QUOTE_PREFIX_RE.exec(rest);
    if (quote) {
      quoteDepth += 1;
      closingPrefix += quote[0];
      rest = rest.slice(quote[0].length);
      continue;
    }
    const list = LIST_PREFIX_RE.exec(rest);
    if (!list) break;
    closingPrefix += " ".repeat(list[0].length);
    rest = rest.slice(list[0].length);
  }
  const run = fenceRun(rest);
  return run ? { ...run, quoteDepth, closingPrefix } : null;
}

/** Find a fence line without treating container-looking content as a closer for an already-open top-level fence. */
export function scanFenceRun(line: string, fence: Fence | null): FenceRun | null {
  if (!fence) return openingFenceRun(line);
  let rest = line;
  for (let i = 0; i < (fence.quoteDepth ?? 0); i += 1) {
    const quote = QUOTE_PREFIX_RE.exec(rest);
    if (!quote) return null;
    rest = rest.slice(quote[0].length);
  }
  return fenceRun(rest);
}

/** Whether a fence line closes the open fence `f`. */
export const closes = (f: Fence, run: { marker: string; length: number; rest: string }) => run.marker === f.marker && run.length >= f.length && !run.rest.trim();

// CommonMark link reference definitions (including footnotes [^id]:), with optional blockquote / list container
// prefixes and multiline labels (no blank line inside [...]).
const REF_DEF_RE = /^[ \t]*(?:>[ \t]*|(?:[-+*]|\d{1,9}[.)])[ \t]+)*\[(?:\\[\s\S]|[^\]\\\r\n]|\r?\n(?![ \t]*(?:>[ \t]*)*(?:\r?\n|$)))+\]:/m;

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

/** Return the index after one complete image, or -1 when this is not the parser's complete image syntax. */
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

/** A line holding only one or more Markdown images separated by whitespace (inline url or <url>, optional title). */
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

/** Whether `md` contains a link or footnote reference definition outside fenced code blocks. */
function hasReferenceDefinition(md: string): boolean {
  if (!md.includes("]:")) return false;
  const outside: string[] = [];
  let fence: Fence | null = null;
  for (let start = 0; start <= md.length; ) {
    const nl = md.indexOf("\n", start);
    const end = nl < 0 ? md.length : nl;
    const line = md.slice(start, end).replace(/\r$/, "");
    const run = scanFenceRun(line, fence);
    if (run) {
      fence = !fence ? run : closes(fence, run) ? null : fence;
      // Leave a blank separator where fences sit so lines before and after cannot merge into a multiline label.
      outside.push("");
    } else if (!fence) {
      outside.push(line);
    }
    if (nl < 0) break;
    start = nl + 1;
  }
  const text = outside.join("\n");
  return text.includes("]:") && REF_DEF_RE.test(text);
}

/**
 * Text whose parts depend on each other across blocks stays one chunk: reference definitions ([x]: url, used above
 * them), HTML blocks. (cindy also keeps several headings together for their ids; headings here have none.)
 */
function needsWholeDocument(md: string): boolean {
  return (
    hasReferenceDefinition(md) ||
    /^ {0,3}<(?:!--|\?|!\[CDATA\[|![A-Za-z]|\/?[A-Za-z][A-Za-z0-9-]*(?:[\t />]|$))/m.test(md)
  );
}

/**
 * The sealed top-level blocks and the growing tail. A cut is a blank line outside code fences and $$ blocks whose next
 * non-blank line starts a new top-level block (not an indented, list, quote, or image-run continuation).
 */
export function splitChunks(md: string): Chunk[] {
  if ((!md.includes("\n\n") && !md.includes("\r\n\r\n")) || needsWholeDocument(md)) return [{ start: 0, content: md }];
  const cuts: number[] = [];
  let pending: number | null = null;
  let fence: Fence | null = null;
  let math = false;
  let prevNonBlank = "";
  for (let start = 0; start <= md.length; ) {
    const nl = md.indexOf("\n", start);
    const end = nl < 0 ? md.length : nl;
    const line = md.slice(start, end).replace(/\r$/, "");
    if (pending !== null && line.trim()) {
      const keepImages = isImageOnlyLine(prevNonBlank) && isImageOnlyLine(line);
      if (!continues(line) && !(nl < 0 && mayContinue(line)) && !keepImages) cuts.push(pending);
      pending = null;
    }
    const run = scanFenceRun(line, fence);
    if (run) {
      fence = !fence ? run : closes(fence, run) ? null : fence;
      prevNonBlank = "";
    }
    // (one still open is \$\$ here: normalizeMath escapes a $$ until its closing one is written)
    else if (!fence && /^ {0,3}(?:\$\$|\\\$\\\$)[\t ]*$/.test(line)) {
      math = !math;
      prevNonBlank = "";
    }
    // a \[ … \] block still being written: normalizeMath makes it $$ … $$ only once its \] is there
    else if (!fence && /^ {0,3}\\\[[\t ]*$/.test(line)) {
      math = true;
      prevNonBlank = "";
    } else if (!fence && /^ {0,3}\\\][\t ]*$/.test(line)) {
      math = false;
      prevNonBlank = "";
    } else if (fence || math) {
      prevNonBlank = "";
    } else if (line.trim()) {
      prevNonBlank = line;
    }
    if (!fence && !math && !line.trim() && nl >= 0) pending = nl + 1;
    if (nl < 0) break;
    start = nl + 1;
  }
  if (!cuts.length) return [{ start: 0, content: md }];
  const out: Chunk[] = [];
  let at = 0;
  for (const c of cuts) {
    if (c <= at || c > md.length) continue;
    out.push({ start: at, content: md.slice(at, c) });
    at = c;
  }
  out.push({ start: at, content: md.slice(at) });
  return out;
}
