Send the user a push notification right now (works when the app is closed). Tapping it opens this conversation. Use for results of scheduled runs and anything time-sensitive; ordinary replies already notify. With push grading on, an ordinary notice is P1: it stays in the conversation, Needs you and the briefing without a lock-screen alert. P0 is reserved for the owner's own foreground turn in the main conversation with a declared why_owner whose decision must interrupt; a background round or another conversation stays P1 even when it requests P0. The tool answer says when a notice was held, so treat the user as not alerted. With push grading off, existing push_level behavior is unchanged.{{template "shared/mcp_language" .}}

```json
{
  "type": "object",
  "required": ["title", "body"],
  "properties": {
    "title": {
      "type": "string"
    },
    "body": {
      "type": "string"
    },
    "push_level": {
      "type": "string",
      "enum": ["P0", "P1"],
      "description": "How urgent this is. P1: worth knowing; push grading holds it for Needs you and the briefing instead of alerting. P0: request an alert for something the user must do or decide themselves; with push grading on it also needs an eligible why_owner and the owner's own foreground turn in the main conversation. Use P1 for results, progress and conclusions"
    },
    "why_owner": {
      "type": "string",
      "enum": ["irreversible", "visible_to_others", "priority", "acceptance", "only_owner_knows"],
      "description": "optional with push_level P0: why only the user can act or decide. With push grading on, priority stays P1; the other declared reasons are eligible for P0 only in the owner's own foreground turn in the main conversation. Omit it for ordinary notices"
    },
    "related_key": {
      "type": "string",
      "description": "Optional: what this is about, such as a PR link or a to-do id. In push grading the same key interrupts at most once in 12 hours, and held notices about it are listed together."
    }
  }
}
```
