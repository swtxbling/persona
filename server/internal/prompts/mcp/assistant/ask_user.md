Ask the user one or more multiple-choice questions on their iPhone (a card in this conversation plus a push notification) and wait for the answers. Use it to confirm anything risky (sending messages / email for them, deleting, changing live systems) or to let them pick between options. AskUserQuestion does not work here; use this. They can also type a free-form answer. Waits up to 2 hours; if the user writes in this conversation instead of picking an option, the question is withdrawn and the tool returns at once, with their message following. If nobody answers in time, the question becomes a to-do that waits for the user's call (in their to-do list and the next briefing), and their answer comes to this conversation later as a new message. With a deadline (each question then recommends one of its options): if nobody answers by it and you marked it reversible, the recommended options are taken by default and recorded on the question's to-do; one that cannot be undone is only reminded again and keeps waiting. With wait false the card goes up the same way but the call returns at once: end the turn without guessing the answer; it comes later as a new message quoting the question and the answer (or saying the card was closed unanswered, or expired and became a to-do). Use wait false only where your instructions say to; a confirmation this same turn needs (approving a message before it is sent) keeps the default. A waiting call holds this turn, so anything else sent to this conversation waits behind it: once such a message waits and the question has been up for a couple of minutes, the call returns without the answer and the card stays up as with wait false; end the turn then. With push grading on, an ordinary question is P1 and stays in Needs you and the briefing without a lock-screen alert. A declared why_owner whose decision must interrupt keeps P0; push_level P0 alone does not override grading, and an explicit P1 always waits quietly. With push grading off, omitting both fields keeps the old delivery behavior.{{template "shared/mcp_language" .}}

```json
{
  "type": "object",
  "required": ["questions"],
  "properties": {
    "wait": {
      "type": "boolean",
      "description": "default true: hold this turn until the user answers. false: put the card up and return at once; the answer arrives later as a new message in this conversation"
    },
    "push_level": {
      "type": "string",
      "enum": ["P0", "P1"],
      "description": "optional delivery request. P1 keeps the question in Needs you and the briefing without a lock-screen alert in push grading. P0 does not override grading by itself: it also needs a why_owner whose decision must interrupt"
    },
    "why_owner": {
      "type": "string",
      "enum": ["irreversible", "visible_to_others", "priority", "acceptance", "only_owner_knows"],
      "description": "optional: why only the user can answer. With push grading on, priority stays P1; the other declared reasons keep P0 unless push_level is explicitly P1. Omit it for an ordinary question"
    },
    "deadline": {
      "type": "string",
      "description": "optional: until when the questions wait, a duration (\"30m\", \"4h\") or an RFC 3339 time, 1 minute to 30 days ahead; needs reversible and a recommend on every question"
    },
    "reversible": {
      "type": "boolean",
      "description": "with deadline: whether going ahead with the recommended options can be undone later. false for deleting, sending anything to other people, spending money or changing production: those are never taken by default"
    },
    "questions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 4,
      "items": {
        "type": "object",
        "required": ["question", "options"],
        "properties": {
          "question": {
            "type": "string"
          },
          "header": {
            "type": "string",
            "description": "short label, ≤12 chars"
          },
          "multiSelect": {
            "type": "boolean"
          },
          "recommend": {
            "type": "string",
            "description": "the label of the option you recommend; required with deadline"
          },
          "options": {
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": {
              "type": "object",
              "required": ["label"],
              "properties": {
                "label": {
                  "type": "string"
                },
                "description": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    }
  }
}
```
