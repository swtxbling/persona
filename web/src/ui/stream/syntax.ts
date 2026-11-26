// Structural Markdown classification through ReactMarkdown's public synchronous parser pipeline. The capture plugin
// keeps the mdast tree and replaces it with an empty root, so classification does not build a second document React tree.
import ReactMarkdown from "react-markdown";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkMath from "remark-math";
import remarkGfm from "../remark-gfm-parse";

export interface MarkdownPoint {
  line: number;
  column: number;
  offset?: number;
}

export interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: {
    start: MarkdownPoint;
    end: MarkdownPoint;
  };
}

export interface MarkdownRoot extends MarkdownNode {
  children: MarkdownNode[];
}

/** Parse exactly the block syntax used by reply Markdown, without importing unified or remark-parse directly. */
export function parseMarkdown(source: string): MarkdownRoot {
  let captured: MarkdownRoot | undefined;
  const capture = () => (tree: MarkdownRoot) => {
    captured = tree;
    return { type: "root", children: [] } as MarkdownRoot;
  };
  ReactMarkdown({ children: source, remarkPlugins: [remarkGfm, remarkMath, remarkCjkFriendly, capture] });
  if (!captured) throw new Error("ReactMarkdown did not produce a syntax tree");
  return captured;
}

export function walkMarkdown(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkMarkdown(child, visit);
}

/** The last block leaf, excluding inline children, and the list/quote containers that hold it. */
export function lastMarkdownBlock(root: MarkdownRoot): { node: MarkdownNode; ancestors: MarkdownNode[] } {
  const containers = new Set(["root", "blockquote", "list", "listItem", "footnoteDefinition"]);
  const ancestors: MarkdownNode[] = [];
  let node: MarkdownNode = root;
  while (containers.has(node.type) && node.children?.length) {
    const next = node.children[node.children.length - 1];
    if (node.type !== "root") ancestors.push(node);
    node = next;
  }
  return { node, ancestors };
}
