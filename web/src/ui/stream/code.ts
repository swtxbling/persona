// Lightweight block-code analysis shared by math/link normalization and the streaming hot paths. Unlike the retired
// R4 fence scanner, this tracks list content indentation, implicit container termination, and invalid backtick info.

export const QUOTES = /^(?:[ \t]*>)*(?:(?<=>)[ \t])?/;
const FENCE = /^((?:[ \t]*>)*(?:(?<=>)[ \t])?)([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?[ \t]*)(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
const INDENTED = /^( {4}|\t)/;
const LIST_MARKER = /[-*+]|\d{1,9}[.)]/;

const quoteDepth = (line: string) => (QUOTES.exec(line)![0].match(/>/g) ?? []).length;
const continuation = (prefix: string) => prefix.replace(LIST_MARKER, (marker) => " ".repeat(marker.length));

export function unquote(line: string, depth: number): string {
  for (let k = 0; k < depth; k++) {
    const match = /^[ \t]*>[ \t]?/.exec(line);
    if (!match) break;
    line = line.slice(match[0].length);
  }
  return line;
}

export interface FenceInfo {
  marker: string;
  closingPrefix: string;
  closed: boolean;
}

export interface CodeRange {
  start: number;
  end: number;
  fence?: FenceInfo;
}

interface OpenFence {
  start: number;
  depth: number;
  indent: number;
  marker: string;
  closingPrefix: string;
}

interface CodeCheckpoint {
  blank: boolean;
  inList: boolean;
  open: OpenFence | null;
  rangeCount: number;
  textPartCount: number;
  textStart: number;
  hasText: boolean;
}

export interface CodeAnalysis {
  /** The exact alternating text/code array historically returned by splitCode, when requested. */
  parts: string[];
  /** Raw text outside block code, without spending time on inline-code parsing in streaming hot paths. */
  textParts: string[];
  /** Block-code source ranges, including indented code; inline code spans are not ranges. */
  ranges: CodeRange[];
  /** Reused by fast chunking so it does not split and offset every line a second time. */
  lines: string[];
  offsets: number[];
  source?: string;
  checkpoints?: CodeCheckpoint[];
}

const ANALYSIS_CACHE = new Map<string, CodeAnalysis>();

/** Fenced and indented code (plus inline code in parts), with source offsets for streaming classification. */
function closesFence(line: string, marker: string): boolean {
  let i = 0;
  while (line[i] === " " || line[i] === "\t") i += 1;
  const markerChar = marker[0];
  let count = 0;
  while (line[i] === markerChar) {
    count += 1;
    i += 1;
  }
  if (count < marker.length) return false;
  while (line[i] === " " || line[i] === "\t" || line[i] === "\r" || line[i] === "\n") i += 1;
  return i === line.length;
}

function indentation(line: string): number {
  let i = 0;
  while (line[i] === " " || line[i] === "\t") i += 1;
  return i;
}

/** One-pass hot-path analysis; the compatibility path below remains unchanged for splitCode's inline-code parts. */
function previousAnalysis(md: string): CodeAnalysis | undefined {
  const candidates = [...ANALYSIS_CACHE.values()];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i];
    if (!candidate.source || !candidate.checkpoints || md.length <= candidate.source.length || !md.startsWith(candidate.source)) continue;
    if (candidate.checkpoints[candidate.lines.length - 1]) return candidate;
  }
  return undefined;
}

/** Incremental hot-path analysis; the compatibility path below remains unchanged for splitCode's inline-code parts. */
export function analyzeCode(md: string): CodeAnalysis {
  const cached = ANALYSIS_CACHE.get(md);
  if (cached) return cached;
  const previous = previousAnalysis(md);
  const parts: string[] = [];
  let ranges: CodeRange[] = [];
  let textParts: string[] = [];
  let lines: string[];
  let offsets: number[];
  let checkpoints: CodeCheckpoint[];
  let first = 0;
  let blank = true;
  let inList = false;
  let open: OpenFence | null = null;
  let text = "";
  let textStart = 0;

  if (previous) {
    first = previous.lines.length - 1;
    const checkpoint = previous.checkpoints![first];
    lines = previous.lines.slice(0, first);
    const added = md.slice(previous.offsets[first]).split(/(?<=\n)/);
    lines.push(...added);
    offsets = previous.offsets.slice(0, first);
    let offset = previous.offsets[first];
    for (const line of added) {
      offsets.push(offset);
      offset += line.length;
    }
    ranges = previous.ranges.slice(0, checkpoint.rangeCount);
    textParts = previous.textParts.slice(0, checkpoint.textPartCount);
    checkpoints = previous.checkpoints!.slice(0, first);
    blank = checkpoint.blank;
    inList = checkpoint.inList;
    open = checkpoint.open;
    text = checkpoint.hasText ? md.slice(checkpoint.textStart, previous.offsets[first]) : "";
    textStart = checkpoint.textStart;
  } else {
    lines = md.split(/(?<=\n)/);
    offsets = [];
    checkpoints = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length;
    }
  }

  const flush = () => {
    if (text) textParts.push(text);
    text = "";
  };
  for (let i = first; i < lines.length; ) {
    checkpoints[i] = {
      blank,
      inList,
      open,
      rangeCount: ranges.length,
      textPartCount: textParts.length,
      textStart: text ? textStart : offsets[i],
      hasText: Boolean(text),
    };
    const line = lines[i];
    if (open) {
      const withoutNewline = line.replace(/\n$/, "");
      const endsContainer = open.depth > 0 && quoteDepth(withoutNewline) < open.depth;
      const rest = open.depth > 0 ? unquote(withoutNewline, open.depth) : withoutNewline;
      const lessIndented = open.indent > 0 && rest.trim() && indentation(rest) < open.indent;
      if (endsContainer || lessIndented) {
        ranges.push({
          start: open.start,
          end: offsets[i],
          fence: { marker: open.marker, closingPrefix: open.closingPrefix, closed: false },
        });
        open = null;
        blank = false;
        // Process the terminating line again as ordinary text or as a new block opener.
      } else {
        if (closesFence(rest, open.marker)) {
          ranges.push({
            start: open.start,
            end: offsets[i] + line.length,
            fence: { marker: open.marker, closingPrefix: open.closingPrefix, closed: true },
          });
          open = null;
          blank = false;
          i += 1;
        } else {
          i += 1;
        }
        continue;
      }
    }

    if (line.trim() && !/^[ \t]/.test(line)) inList = LIST_ITEM.test(line) || (inList && !blank);
    const fence = line.includes("`") || line.includes("~") ? FENCE.exec(line) : null;
    if (fence && !(fence[3][0] === "`" && line.slice(fence[0].length).includes("`"))) {
      flush();
      open = {
        start: offsets[i],
        depth: quoteDepth(fence[1]),
        indent: inList || LIST_ITEM.test(line) ? fence[2].length : 0,
        marker: fence[3],
        closingPrefix: continuation(`${fence[1]}${fence[2]}`),
      };
      blank = false;
      i += 1;
      continue;
    }
    if (blank && !inList && INDENTED.test(line) && line.trim()) {
      let j = i;
      while (j < lines.length && (INDENTED.test(lines[j]) || !lines[j].trim())) j++;
      while (j > i && !lines[j - 1].trim()) j--;
      flush();
      ranges.push({ start: offsets[i], end: offsets[j] ?? md.length });
      i = j;
      continue;
    }
    blank = !line.trim();
    if (!text) textStart = offsets[i];
    text += line;
    i += 1;
  }
  if (open) {
    ranges.push({
      start: open.start,
      end: md.length,
      fence: { marker: open.marker, closingPrefix: open.closingPrefix, closed: false },
    });
  }
  flush();
  const analysis = { parts, textParts, ranges, lines, offsets, source: md, checkpoints };
  ANALYSIS_CACHE.set(md, analysis);
  if (ANALYSIS_CACHE.size > 4) ANALYSIS_CACHE.delete(ANALYSIS_CACHE.keys().next().value!);
  return analysis;
}

export function splitCode(md: string): string[] {
  const analysis = analyzeCode(md);
  const parts = [""];
  const add = (s: string, code: boolean) => {
    if (parts.length % 2 === 0 === code) parts[parts.length - 1] += s;
    else parts.push(s);
  };
  const addText = (text: string) => {
    for (let i = 0; i < text.length; ) {
      const j = text.indexOf("`", i);
      if (j !== i) {
        const end = j < 0 ? text.length : j;
        add(text.slice(i, end), false);
        i = end;
        continue;
      }
      const n = /^`+/.exec(text.slice(i))![0].length;
      const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, "g");
      close.lastIndex = i + n;
      const match = close.exec(text);
      add(text.slice(i, match ? match.index + n : i + n), !!match);
      i = match ? match.index + n : i + n;
    }
  };
  let at = 0;
  for (const range of analysis.ranges) {
    addText(md.slice(at, range.start));
    add(md.slice(range.start, range.end), true);
    at = range.end;
  }
  addText(md.slice(at));
  return parts;
}

/** Blank block-code characters while preserving every line ending and source offset. */
export function maskCodeRanges(md: string, ranges: CodeRange[], fencedOnly = false): string {
  const pieces: string[] = [];
  let at = 0;
  for (const range of ranges) {
    if (fencedOnly && !range.fence) continue;
    pieces.push(md.slice(at, range.start));
    pieces.push(md.slice(range.start, range.end).replace(/[^\n\r]/g, " "));
    at = range.end;
  }
  pieces.push(md.slice(at));
  return pieces.join("");
}
