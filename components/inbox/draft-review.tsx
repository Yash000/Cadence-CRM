'use client';

// §F5.9 — the rep edits the AI draft, then approves or rejects it. Approve
// delivers (really, for email via Resend; recorded-only for WhatsApp/SMS) and
// flips the message to `sent`; reject marks it `failed` with a reason.
import { useActionState, useState } from 'react';
import { Pill } from '../ui/pill';
import {
  approveDraftAction,
  rejectDraftAction,
  type ActionState,
} from '../../app/inbox/actions';

const INITIAL: ActionState = { ok: false, message: '' };

export function DraftReview({
  messageId,
  initialBody,
  sessionOpen,
  channel,
}: {
  messageId: string;
  initialBody: string;
  sessionOpen: boolean;
  channel: string;
}) {
  const [body, setBody] = useState(initialBody);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [approveState, approve, approvePending] = useActionState(approveDraftAction, INITIAL);
  const [rejectState, reject, rejectPending] = useActionState(rejectDraftAction, INITIAL);

  const outsideWindow = channel !== 'email' && !sessionOpen;

  return (
    <div className="surface-card border-l-2 border-l-ink p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-[22px] items-center rounded-full bg-brand-accent px-2.5 type-label text-white">
          AI draft
        </span>
        <span className="type-caption text-muted-foreground">awaiting your approval</span>
      </div>

      <textarea
        className="field-input h-28 w-full px-3 py-2 type-body-sm"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {body !== initialBody && (
        <p className="mt-1 type-caption text-faint">Edited — the change is recorded as ai_edited_pct.</p>
      )}

      {outsideWindow && (
        <p className="mt-2 rounded-sm bg-canvas-soft px-3 py-2 type-caption text-warn">
          Outside the 24-hour session window (§F5.6). A real WhatsApp send here would be
          rejected unless it used an approved template — this simulated approval records the
          message anyway so the flow stays demoable.
        </p>
      )}

      {!rejecting ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form action={approve}>
            <input type="hidden" name="messageId" value={messageId} />
            <input type="hidden" name="body" value={body} />
            <Pill size="sm" disabled={approvePending || rejectPending}>
              {approvePending ? 'Approving…' : channel === 'email' ? 'Approve & send' : 'Approve & record'}
            </Pill>
          </form>
          <Pill
            size="sm"
            variant="outline"
            onClick={() => setRejecting(true)}
            disabled={approvePending || rejectPending}
          >
            Reject
          </Pill>
        </div>
      ) : (
        <form action={reject} className="mt-3">
          <input type="hidden" name="messageId" value={messageId} />
          <input
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this draft wrong?"
            className="field-input h-9 w-full px-3 type-body-sm"
          />
          <div className="mt-2 flex gap-2">
            <Pill size="sm" variant="outline" disabled={rejectPending}>
              {rejectPending ? 'Rejecting…' : 'Confirm reject'}
            </Pill>
            <Pill size="sm" variant="soft" onClick={() => setRejecting(false)}>
              Cancel
            </Pill>
          </div>
        </form>
      )}

      {approveState.message && (
        <p className={`mt-2 type-caption ${approveState.ok ? 'text-good' : 'text-bad'}`}>
          {approveState.message}
        </p>
      )}
      {rejectState.message && (
        <p className={`mt-2 type-caption ${rejectState.ok ? 'text-good' : 'text-bad'}`}>
          {rejectState.message}
        </p>
      )}
    </div>
  );
}
