// @vitest-environment jsdom
// A word that finished fading writes nothing to the page at its animationend (#2905): with a reply streaming, each such
// write cost a style and layout pass per word. It is settled on the timeline, and its chunk's next render drops the class.
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Element } from "hast";
import type { PluggableList } from "unified";
import { expect, it } from "vitest";
import { FadeListItem, FadeSpan } from "./FadeSpan";
import { StreamChunk } from "./Chunk";
import { createWordFadeState } from "./wordFade";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ended = (el: HTMLElement, animationName: string) => el.dispatchEvent(Object.assign(new Event("animationend", { bubbles: true }), { animationName }));

it("settles a word and a list dot at animationend without touching them; the next render drops the class and marker", () => {
  const fade = createWordFadeState();
  const node = (key: string) => ({ type: "element", tagName: "span", properties: { dataWfKey: key }, children: [] }) as Element;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const draw = () =>
    act(() =>
      root.render(
        <ul>
          <FadeListItem node={node("wf-0")} fade={fade} {...{ "data-stream-marker": true }}>
            <FadeSpan node={node("wf-0")} fade={fade} className="stream-word">
              word
            </FadeSpan>
          </FadeListItem>
        </ul>,
      ),
    );
  draw();
  const li = host.querySelector("li")!;
  const span = host.querySelector("span")!;
  act(() => {
    ended(span, "stream-word-in");
    ended(li, "stream-marker-in");
  });
  expect(fade.timeline.settled.has("wf-0")).toBe(true);
  expect(span.className).toBe("stream-word");
  expect(li.hasAttribute("data-stream-marker")).toBe(true);
  draw();
  expect(span.hasAttribute("class")).toBe(false);
  expect(li.hasAttribute("data-stream-marker")).toBe(false);
  act(() => root.unmount());
  host.remove();
});

it("keeps a list-contained code block mounted when streaming fades into plain Markdown", () => {
  const fade = createWordFadeState();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const content = "- ```js\n  const example = 1;\n  ```";
  const remarkPlugins: PluggableList = [];
  const rehypePlugins: PluggableList = [];
  const components = {};
  const urlTransform = (url: string) => url;
  const draw = (streaming: boolean) =>
    act(() =>
      root.render(
        <StreamChunk
          start={0}
          content={content}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
          urlTransform={urlTransform}
          fade={streaming ? fade : null}
          plain={!streaming}
          wholeDocument={false}
        />,
      ),
    );
  draw(true);
  const pre = host.querySelector("pre");
  expect(pre).not.toBeNull();
  draw(false);
  expect(host.querySelector("pre")).toBe(pre);
  expect(pre?.isConnected).toBe(true);
  act(() => root.unmount());
  host.remove();
});
