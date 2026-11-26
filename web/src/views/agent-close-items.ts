// Pure Archive / Close menu item builders shared by ChatView's header menu and AgentMenus.tsx, kept separate from
// AgentMenus.tsx so ChatView's first screen does not pull in AgentRowMenu, NodeMenu, or MarkSeenDialog.
import { errorText } from "../lib/api";
import { appArchiveDeps, archiveAgent, archiveOffers, closeOffer } from "../lib/agent-archives";
import { closeAgentAction } from "../lib/close-agent";
import type { Session } from "../lib/types";
import type { MenuItem } from "../ui/atoms";
import { t } from "../i18n";

export type NoticeTone = "ok" | "error" | "info";

export interface ArchiveCloseActions {
  onArchive?: (s: Session) => void | Promise<void>;
  onCloseAgent?: (s: Session) => void;
  onNotice?: (message: string, tone: NoticeTone) => void;
}

export const isPromiseLike = (v: unknown): v is PromiseLike<unknown> =>
  Boolean(v) && typeof (v as PromiseLike<unknown>).then === "function";

export function runControlled(fn: () => void | Promise<void>, onNotice?: (message: string, tone: NoticeTone) => void) {
  try {
    const res = fn();
    if (isPromiseLike(res)) void Promise.resolve(res).catch((e) => { onNotice?.(errorText(e), "error"); });
  } catch (e) {
    onNotice?.(errorText(e), "error");
  }
}

/** "Archive" and "Close…" after a hairline (#7125). Archive (lib/agent-archives.ts) only hides the agent, so a busy one
 *  shows it disabled, saying what to wait for. Close… (lib/close-agent.ts) asks, then archives and closes an agent that
 *  is not busy, and says what closing interrupts before it closes a busy one. The chat's ⋯ offers the same. */
export function archiveCloseItems(s: Session, features: readonly string[], actions?: ArchiveCloseActions): MenuItem[] {
  const archive = archiveOffers(s, features).archive;
  const items: MenuItem[] = [
    ...(archive !== "no"
      ? [{
          key: "archive",
          label: t("agentmenus.archive"),
          icon: "archive" as const,
          disabled: archive === "busy",
          detail: archive === "busy" ? t("agentmenus.archive_busy") : undefined,
          onSelect: () => {
            if (archive !== "busy") {
              if (actions?.onArchive) runControlled(() => actions.onArchive!(s), actions.onNotice);
              else void archiveAgent(s, false, appArchiveDeps);
            }
          },
        }]
      : []),
    ...closeItems(s, features, actions?.onCloseAgent),
  ];
  return items.map((it, i) => (i === 0 ? { ...it, divider: true } : it));
}

/** "Close…" alone: an archived chat's ⋯ has it under Restore while its agent is still open on the computer. */
export function closeItems(s: Session, features: readonly string[], onCloseAgent?: (s: Session) => void): MenuItem[] {
  if (onCloseAgent) {
    const offer = closeOffer(s, features);
    if (offer === "no") return [];
    return [{
      key: "close",
      label: t("agentmenus.close"),
      icon: "x" as const,
      danger: true,
      ...(offer === "busy" ? { disabled: true, detail: t("agentmenus.close_busy"), onSelect: () => {} } : { onSelect: () => onCloseAgent(s) }),
    }];
  }
  const close = closeAgentAction(s, features);
  return close ? [{ key: "close", label: t("agentmenus.close"), icon: "x" as const, danger: true, ...close }] : [];
}
