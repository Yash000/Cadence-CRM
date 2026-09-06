'use server';

// Draft review + conversation triage actions for the Inbox (PRD-02 §F5.9).
//
// Approve: deliver the (possibly rep-edited) draft — really, via Resend, for
// email; recorded-only for WhatsApp/SMS while Twilio is unconfigured — then
// flip the message to `sent` and stamp ai_edited_pct. Reject: mark it `failed`
// with the rep's reason. Both revalidate the Inbox so the server-rendered
// thread reflects the new state on the next paint.
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index';
import {
  approveDraft,
  rejectDraft,
  setConversationStatus,
  DraftStateError,
  type ConvStatus,
} from '../../lib/inbox-db';
import { deliverOutbound } from '../../lib/messaging';

export interface ActionState {
  ok: boolean;
  message: string;
}

async function draftTarget(messageId: string) {
  const { messages, conversations, customers } = schema;
  const [row] = await db
    .select({
      channel: conversations.channel,
      email: customers.email,
      phoneE164: customers.phoneE164,
      summary: conversations.summary,
      intentTag: conversations.intentTag,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(customers, eq(customers.id, conversations.customerId))
    .where(eq(messages.id, messageId))
    .limit(1);
  return row ?? null;
}

export async function approveDraftAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const messageId = String(formData.get('messageId') ?? '');
  const finalBody = String(formData.get('body') ?? '');
  if (!messageId) return { ok: false, message: 'Missing draft id.' };

  const target = await draftTarget(messageId);
  if (!target) return { ok: false, message: 'That draft no longer exists.' };

  const delivery = await deliverOutbound({
    channel: target.channel as 'whatsapp' | 'email' | 'sms',
    body: finalBody,
    toEmail: target.email,
    toPhone: target.phoneE164,
    subject: target.intentTag ? `Re: your HomeStyle ${target.intentTag.replace('_', ' ')}` : null,
  });

  if (delivery.error) {
    return { ok: false, message: `Send failed: ${delivery.error}. Draft left awaiting approval.` };
  }

  try {
    const result = await approveDraft({
      messageId,
      finalBody,
      externalId: delivery.externalId,
    });
    revalidatePath('/inbox');
    const how = result.simulated
      ? target.channel === 'email'
        ? 'recorded (no Resend sender configured)'
        : `recorded — ${target.channel} send is simulated while Twilio is unconfigured`
      : `sent via Resend (${delivery.externalId})`;
    const edited =
      result.aiEditedPct != null && result.aiEditedPct > 0
        ? ` · ${result.aiEditedPct}% edited before send`
        : '';
    return { ok: true, message: `Approved and ${how}.${edited}` };
  } catch (err) {
    if (err instanceof DraftStateError) return { ok: false, message: err.message };
    throw err;
  }
}

export async function rejectDraftAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const messageId = String(formData.get('messageId') ?? '');
  const reason = String(formData.get('reason') ?? '');
  if (!messageId) return { ok: false, message: 'Missing draft id.' };
  try {
    await rejectDraft(messageId, reason);
    revalidatePath('/inbox');
    return { ok: true, message: 'Draft rejected.' };
  } catch (err) {
    if (err instanceof DraftStateError) return { ok: false, message: err.message };
    throw err;
  }
}

const STATUSES: ConvStatus[] = ['open', 'pending', 'resolved', 'snoozed'];

export async function setStatusAction(formData: FormData): Promise<void> {
  const conversationId = String(formData.get('conversationId') ?? '');
  const status = String(formData.get('status') ?? '') as ConvStatus;
  if (!conversationId || !STATUSES.includes(status)) return;
  await setConversationStatus(conversationId, status);
  revalidatePath('/inbox');
}
