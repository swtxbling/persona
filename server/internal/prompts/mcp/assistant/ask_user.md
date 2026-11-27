Ask multiple-choice questions on the user's iPhone (a card in this conversation plus a push) and wait for answers; AskUserQuestion does not work here. Free-form answers are allowed. Default wait: up to 2 hours; if the user writes here, the question is withdrawn and their message follows. Unanswered questions become to-dos and answers arrive later. With a deadline, every question needs a recommendation: reversible ones take recommended defaults; irreversible ones only remind and wait. wait=false puts the card up and returns at once; end the turn without guessing. Use wait=false only when instructions allow; a confirmation this turn needs keeps waiting. A queued message may release a waiting call after a couple of minutes, leaving the card up. With push grading on, ordinary questions are P1 (Needs you and briefing, no lock-screen alert). P0 needs an interrupting why_owner; bare P0 cannot override grading, and explicit P1 wins. With grading off, omitting both fields keeps the old behavior.{{template "shared/mcp_language" .}}

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
      "description": "P1 keeps the question in Needs you and briefing without an alert in push grading. P0 also needs an interrupting why_owner; bare P0 cannot override grading"
    },
    "why_owner": {
      "type": "string",
      "enum": ["irreversible", "visible_to_others", "priority", "acceptance", "only_owner_knows"],
      "description": "Why only the user can answer. With push grading, priority stays P1; other declared reasons keep P0 unless push_level is explicitly P1. Omit for an ordinary question"
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
