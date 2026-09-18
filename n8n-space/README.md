# Cadence CRM — automation layer

The event-driven half of Cadence CRM, running as [n8n](https://n8n.io) workflows
in a container. The Next.js app still serves requests, renders pages and runs
the Ask Cadence agent; everything here is the part that fires on a schedule or
on an inbound webhook.

Currently deployed **locally via Docker**. See `SETUP.md` to run it, and
"Hosting" below for why it is not on a free PaaS.

## The five workflows

| Workflow | Trigger | What it shows |
|---|---|---|
| `01-shopify-order-ingest` | Webhook | Event ingestion — HMAC verify, transform, idempotent upsert |
| `02-nightly-score-recompute` | Schedule (02:30 IST) | Batch automation on a timer, with a coverage check |
| `03-room-completion-outreach` | Schedule (09:00 IST) | Branching + an external send |
| `04-ask-cadence-agent` | Webhook (Chat Trigger) | The AI agent itself, running natively in n8n |
| `05-inbox-reply-draft` | Webhook | A single structured LLM call — the *other* AI shape, deliberately not an agent |

Workflow 03 reads `v_room_completion`, finds customers whose attach window is
about to close on a room they have started but not finished, branches on
whether the attach rate justifies an automated send, and drafts a message
naming the specific missing piece.

Workflow 04 is Ask Cadence rebuilt as an n8n **AI Agent** node — same model
(`openai/gpt-5-mini` via OpenRouter) and the exact same 21K-character system
prompt as `lib/agent/prompt.ts:agentSystemPrompt()` (extracted verbatim via
`tsx`, not retyped), calling a Postgres Tool node (`run_sql`) against the same
`cadence_agent` read-only role the real app uses. Test it with:

```bash
curl -X POST http://localhost:5678/webhook/<webhookId>/chat \
  -H "Content-Type: application/json" \
  -d '{"chatInput": "which customers are most likely to churn?", "sessionId": "test-1", "action": "sendMessage"}'
```

(webhookId is on the "Chat webhook" node — see SETUP.md.) Two things worth
knowing if you touch this workflow:

- **Use the webhook trigger, not a Manual Chat Trigger.** The Manual Chat
  Trigger's test path depends on an undocumented websocket session handshake
  that failed even through a real typed message in the editor's chat panel —
  its own `trigger()` function literally always emits `{}` regardless of what
  was typed; the actual chat input is supposed to be injected by a separate,
  more fragile mechanism. The webhook-mode Chat Trigger's handler is just
  `{ json: bodyData }` — whatever JSON you POST becomes `$json` — so it's
  directly testable with curl, same as every other node in this project.
- **OpenRouter's default `maxTokens: -1` requests the model's full 65,536-token
  ceiling**, which this account's credit can't cover ("Payment required...
  can only afford 12684"). Capped at 2048 on the OpenRouter Chat Model node —
  more than enough for a 1-3 sentence answer.
- **Editing an active workflow doesn't take effect until you cycle it.** n8n
  snapshots a workflow's webhook definition at activation time; a plain PATCH
  to an already-active workflow's node parameters (e.g. the maxTokens fix
  above) is silently ignored by the live webhook until you deactivate and
  reactivate.
- **Don't end a chat-mode chain on a side-effect or reshaping node.** With
  `responseMode: lastNode` (the default), whichever node the engine finishes
  LAST becomes the HTTP response verbatim — n8n's own chatTrigger metadata
  warns explicitly against terminating on a Data Table insert, HTTP Request,
  or similar, since its output isn't a chat reply and breaks anything
  expecting `{ output, intermediateSteps }` (i.e. `lib/agent/ask-via-n8n.ts`).
  The chain here is `Ask Cadence → Log & pass through → Respond to Webhook`,
  added purely so a demo shows a visible step after the Agent finishes; "Log &
  pass through" only echoes `$json` (plus a timestamp) and the trigger's
  `options.responseMode` is explicitly `responseNode`, not the implicit
  default — so the actual HTTP response is still the Agent's exact shape.

It's currently active on this running instance so its webhook URL works right
now. Like 01-03, it still imports **inactive** on a fresh boot (the same
`--activeState=fromJson` limitation applies) — activate it once after import,
same as the others. It's a good one to activate by default once you do: it's
a read-only demo endpoint with no external side effects (no writes, no
emails).

**The real Cadence CRM frontend can route through workflow 04**, not just
curl. `app/api/agent/route.ts` checks `AGENT_VIA_N8N_WEBHOOK` in `.env.local`
— when set, asking a question in the actual Ask Cadence UI at `/ask` executes
through n8n and shows up live in its Executions tab, instead of running
in-process. See `lib/agent/ask-via-n8n.ts` for exactly what's reconstructed
(SQL, columns, rows, all matching the UI's real contract) and what's honestly
lost over this path (conversation memory, sql-guard.ts, real token/cost
numbers). Unset by default; it's a demo toggle, not the production path.

Workflow 05 is the Inbox's reply-drafting AI, rebuilt as an n8n **Basic LLM
Chain + Structured Output Parser** — deliberately NOT the AI Agent node,
because the real feature (`lib/inbox-draft.ts:generateReplyDraft`) is one
single-shot structured call (system + user prompt → `{intent, reply}`), not
an agentic loop. No tool calls, no database access from inside the model
call — the order-history context is built in Next.js exactly as the real
function builds it, then passed to n8n as a plain field. Same
`AGENT_VIA_N8N_WEBHOOK`-style toggle: set `INBOX_DRAFT_VIA_N8N_WEBHOOK` in
`.env.local` and the Inbox's channel simulator routes through it (see
`lib/inbox-draft-via-n8n.ts`). Test directly:

```bash
curl -X POST http://localhost:5678/webhook/inbox-draft \
  -H "Content-Type: application/json" \
  -d '{"channel":"whatsapp","customerName":"Ananya R.","orderContext":"Recent orders:\n- #4821 (paid): Aravalli Sofa","inboundBody":"When will my sofa arrive?"}'
```

One n8n gotcha specific to the Structured Output Parser node: `schemaType`
and its schema field are paired, and picking the wrong pair silently falls
back to the node's own placeholder example schema (`{state, cities}`) instead
of erroring — `fromJson` pairs with `jsonSchemaExample` (infers a shape from
an example object, no enum support); `manual` pairs with `inputSchema` (a
real JSON Schema, enums included). This workflow uses `manual` +
`inputSchema`, needed because `intent` has to be constrained to the four
`INTENT_TAGS` values.

## Credentials

Nothing is committed. The workflows import with their Postgres and HTTP nodes
unattached — n8n keeps credentials in its own encrypted database, so they
cannot live in git. Create them once in the editor:

| Credential | Used by | Source |
|---|---|---|
| Postgres (agent) | 02, 03, 04 | read-only `cadence_agent` role |
| Postgres (writer) | 01 | write role |
| Header Auth | 03 | `Authorization: Bearer <RESEND_API_KEY>` |
| OpenRouter | 04, 05 | `OPENROUTER_API_KEY` — same key and model (`openai/gpt-5-mini`) as `lib/agent/model.ts` (shared credential, reused across both workflows) |

The two Postgres roles are deliberately separate. `cadence_agent` can `SELECT`
from five views and nothing else, runs read-only with a 5s statement timeout,
and is the actual security boundary for anything query-shaped — the same role
behind the Ask Cadence agent (see `lib/agent/sql-guard.ts`). Only the ingest
workflow gets write access.

## Design: stateless by construction

The container rebuilds its own state on every boot — `entrypoint.sh` provisions
the owner account from env vars and re-imports the workflows from the image.
That was originally forced by a host with no persistent disk, and it was kept
because it is simply better: what you get is always exactly what is committed
here, never leftover state from an earlier session.

Re-import is an **upsert**, not an insert — each workflow file carries a stable
top-level `id`. Without that, every restart on a host that does have a volume
adds another copy of all three.

Workflows import **deactivated**. Activate them in the editor. (`--activeState=fromJson`
looks like the fix for this and is not: it is rejected outside queue/multi-main
mode and fails the entire import, leaving you with an empty editor and a clean
log.)

**Anything you build in the editor is not in git.** Export it (Workflow →
Download) into `workflows/` to keep it — a rebuild will otherwise overwrite it.

## Hosting

Measured, not assumed:

| Host | Verdict |
|---|---|
| **Local Docker** | ✅ Works. Currently in use. |
| Hugging Face Spaces | ❌ Docker Spaces need HF PRO ($9/mo); only static Spaces are free. |
| Render Free | ❌ 512 MB. n8n OOMs — `Ineffective mark-compacts near heap limit`, exit 139. Also spins down after 15 min idle, so schedule triggers never fire. |
| Render `1c-2g` | ✅ 2 GB, ~$25/mo. |
| Oracle Cloud Always Free | ✅ Free permanently, always-on, up to 24 GB. Most setup effort. |

n8n 2.39.7 needs **~1 GB**; it boots at 1 GB and settles around 500 MB idle.
Anything at or below 512 MB dies during startup.
