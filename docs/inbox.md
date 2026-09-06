# Inbox (PRD-02 §F5)

The omnichannel conversation view: WhatsApp / email / SMS threads in one list,
filterable by status, channel, and the "unknown contacts" queue (§F5.4), with
AI-drafted replies a rep reviews before they go out (§F5.9).

## What's live vs. simulated

Live Twilio (WhatsApp/SMS) inbound is **not configured** — PRD-02 lists messaging
as partly deferred. So:

| Direction | WhatsApp / SMS | Email |
|---|---|---|
| **Inbound** | Channel simulator only (`POST /api/inbox/simulate`, §F5.11) or `npm run seed-inbox` | same |
| **Outbound** | Recorded only — nothing leaves the building | **Real send via Resend** when `RESEND_API_KEY` is set |

`messages.external_id` tells the two apart: set = a provider accepted it, `null` =
simulated. The UI badges it accordingly.

## Pieces

| File | Role |
|---|---|
| `lib/inbox-db.ts` | Reads (list / thread / counts), inbound recording, the `held → sent`/`failed` draft state machine, E.164 resolution, 24h session-window helper. Pure helpers stay importable without a DB. |
| `lib/inbox-draft.ts` | §F5.9/§F5.10 — AI reply + intent tag via OpenRouter, logged to `ai_logs` (`feature = 'inbox.draft'`). Deterministic fallback when no key. |
| `lib/messaging.ts` | `deliverOutbound` — Resend REST for email, record-only otherwise. |
| `lib/inbox-input.ts` | Pure request validation for the simulator route. |
| `app/api/inbox/simulate/route.ts` | POST inbound (+ optional auto-draft) · GET list / thread. Rate-limited. |
| `app/inbox/actions.ts` | Server actions: approve (delivers, then `held → sent`, stamps `ai_edited_pct`), reject (`held → failed` + reason), status. |
| `app/inbox/page.tsx` + `components/inbox/*` | Three-pane surface: list · thread with inline `DraftReview` · `ChannelSimulator`. |

## Draft review

An AI draft is an outbound `messages` row with `status = 'held'` and
`held_reason = 'awaiting_approval'`. The rep edits it in place, then:

- **Approve** → `deliverOutbound` runs, message flips to `sent`, `ai_edited_pct`
  is stored (Levenshtein of the edit).
- **Reject** → message goes to `failed`, `held_reason = 'rejected: <why>'`.

## Not done

§F5.6 (hard session-window enforcement on free-form sends) and §F5.7 (consent
gating) are surfaced as warnings in the compose UI but not enforced. Flows and
campaigns (§F6) remain deferred.
