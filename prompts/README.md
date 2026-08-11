# Projects

Each file in this folder is one project — one prompt with its own output shape.
They appear in the **Project** dropdown at the top of the app and are shared with
everyone who uses the deployed site.

## Adding a project

Create `prompts/<id>.md`. The filename (minus `.md`) becomes the project id.

    {
      "name": "Support Ticket Triage",
      "description": "Routes an inbound ticket and drafts a first reply.",
      "roles": { "user": "Requester", "agent": "Agent" },
      "schema": { ...JSON Schema for the model's output... },
      "display": {
        "headline": "queue",
        "reason": "summary",
        "message": "reply",
        "badges": ["urgency"],
        "limits": { "summary": 120, "reply": 300 }
      }
    }
    ---
    Your prompt text goes here, using {{conversation_so_far}},
    {{new_lead_message}} and {{issue_summary}}.

Everything above the `---` is optional JSON config; everything below is the prompt.
A file with no JSON header and no `---` works too — it is just treated as prompt text.

| Config key | What it does |
|---|---|
| `name` | Label in the project dropdown |
| `description` | Subtitle under the header |
| `default` | `true` on the project the app opens with |
| `roles` | Renames "Customer"/"Expert" throughout the UI |
| `schema` | JSON Schema. Present = the model's output is schema-enforced. Omit it and the app just parses whatever JSON comes back. |
| `display.headline` | Field shown as the big chip |
| `display.reason` | Field shown after "Why:" |
| `display.message` | Field offered as the draft to accept and send |
| `display.badges` | Fields shown as small pills |
| `display.fields` | Extra fields to show as rows |
| `display.limits` | `{ "field": maxChars }` — adds a character-count check in the QA rail |

Every `display` key is optional; without them the app guesses from the field
names and falls back to listing whatever the model returned.

## Placeholders

These names are interchangeable in your prompt text:

- conversation: `{{conversation_so_far}}` `{{conversation}}` `{{transcript}}` `{{chat_history}}` `{{history}}` `{{thread}}` `{{messages}}`
- latest message: `{{new_lead_message}}` `{{latest_message}}` `{{last_message}}` `{{new_message}}` `{{customer_message}}` `{{user_message}}` `{{input}}`
- background: `{{issue_summary}}` `{{summary}}` `{{intake}}` `{{context}}` `{{background}}`

## Drafting without deploying

Use **＋** in the header to create a project in your browser only, iterate on it,
then hit **↓** to download it as a `.md` file. Drop that file in this folder and
commit it to share it with everyone else.
