// One chunk of a streaming reply (ported from cindy's StreamingMarkdownChunk): memo keeps a sealed chunk's parse and
// DOM, so only the growing last one goes through Markdown again. With `fade` its words fade in on the message's
// timeline; `plain` (a block fading in once): the words already in are plain text.
import { createContext, memo, useContext, useMemo, type ComponentProps } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import type { PluggableList } from "unified";
import { FadeListItem, FadeSpan } from "./FadeSpan";
import { chunkState, rehypeStreamWordFade, type WordFadeState } from "./wordFade";

const StreamFadeContext = createContext<WordFadeState | null>(null);

// Keep these component types stable when streaming settles: replacing the list-item component would remount its code.
function StreamFadeSpan(props: Omit<ComponentProps<typeof FadeSpan>, "fade">) {
  return <FadeSpan {...props} fade={useContext(StreamFadeContext)} />;
}

function StreamFadeListItem(props: Omit<ComponentProps<typeof FadeListItem>, "fade">) {
  return <FadeListItem {...props} fade={useContext(StreamFadeContext)} />;
}

export const StreamChunk = memo(function StreamChunk({
  start,
  content,
  remarkPlugins,
  rehypePlugins,
  components,
  urlTransform,
  fade,
  plain = false,
  wholeDocument,
}: {
  start: number;
  content: string;
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  components: Components;
  urlTransform: UrlTransform;
  fade: WordFadeState | null;
  plain?: boolean;
  wholeDocument: boolean;
}) {
  const state = fade ? chunkState(fade, String(start), wholeDocument) : null;
  const plugins = useMemo<PluggableList>(() => (state ? [...rehypePlugins, [rehypeStreamWordFade, state, plain]] : rehypePlugins), [rehypePlugins, state, plain]);
  const fadeComponents = useMemo<Components>(() => ({ ...components, span: StreamFadeSpan, li: StreamFadeListItem }), [components]);
  return (
    <StreamFadeContext.Provider value={state}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={fadeComponents} urlTransform={urlTransform}>
        {content}
      </ReactMarkdown>
    </StreamFadeContext.Provider>
  );
});
