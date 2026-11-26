// Reversible Archive action shared by Persona conversation headers (AssistantChat.tsx) and ConversationMenu.tsx,
// kept separate so the first screen does not pull in ConversationMenu's leader/delete dialogs or its full namespace.
import { api, enc, errorText } from "../lib/api";
import { sessionTitle } from "../lib/format";
import { refreshAssistant } from "../lib/store";
import type { Session } from "../lib/types";
import { toast, type MenuItem, type ToastAction } from "../ui/atoms";
import { t } from "../i18n";

export interface ConversationArchiveDeps {
  archive: (s: Session) => Promise<unknown>;
  unarchive: (s: Session) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  notify: (text: string, tone: "ok" | "error", action?: ToastAction) => void;
}

const defaultArchiveDeps: ConversationArchiveDeps = {
  archive: (s) => api(`/assistant/conversations/${enc(s.session_id)}/archive`, { method: "POST", json: {} }),
  unarchive: (s) => api(`/assistant/conversations/${enc(s.session_id)}/unarchive`, { method: "POST", json: {} }),
  refresh: () => refreshAssistant(),
  notify: (text, tone, action) => toast(text, tone, action),
};

const reread = (deps: ConversationArchiveDeps) => void deps.refresh().catch(() => {});

async function undoArchive(s: Session, title: string, deps: ConversationArchiveDeps) {
  try {
    await deps.unarchive(s);
    deps.notify(t("conversation-menu.unarchived", { title }), "ok");
  } catch (e) {
    deps.notify(t("conversation-menu.undo_failed", { error: errorText(e) }), "error");
  }
  reread(deps);
}

/** Archive is the same reversible action in a sidebar row and the open conversation's title menu (#6565). */
export function conversationArchiveItem(s: Session, deps: ConversationArchiveDeps = defaultArchiveDeps): MenuItem {
  const title = sessionTitle(s);
  return {
    key: "archive",
    label: t("conversation-menu.archive"),
    icon: "archive",
    onSelect: async () => {
      try {
        await deps.archive(s);
        deps.notify(t("conversation-menu.archived", { title }), "ok", { label: t("conversation-menu.undo"), run: () => void undoArchive(s, title, deps) });
      } catch (e) {
        deps.notify(errorText(e), "error");
      }
      reread(deps);
    },
  };
}
