// Outbound delivery (PRD-02 §F5.1 / §F5.2).
//
// Email is REAL: if RESEND_API_KEY is set, an approved email draft is actually
// sent through Resend's REST API (no SDK — one fetch). WhatsApp and SMS are
// SIMULATED: the Twilio Sandbox is not configured (PRD-02 Deferred), so those
// approvals are recorded but nothing leaves the building. The return shape is
// the same either way; `simulated` and `externalId` tell the caller (and, via
// messages.external_id, the UI) which happened.
//
// The default From is Resend's shared onboarding@resend.dev sender, which works
// with no verified domain but only delivers to the Resend account owner's own
// address — fine for a demo, swap RESEND_FROM for a verified domain in prod.

export interface DeliverInput {
  channel: 'whatsapp' | 'email' | 'sms';
  body: string;
  toEmail?: string | null;
  toPhone?: string | null;
  subject?: string | null;
}

export interface DeliverResult {
  simulated: boolean;
  externalId: string | null;
  error: string | null;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export async function deliverOutbound(input: DeliverInput): Promise<DeliverResult> {
  if (input.channel === 'email') {
    const key = process.env.RESEND_API_KEY;
    if (key && input.toEmail) {
      try {
        const res = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM ?? 'HomeStyle Care <onboarding@resend.dev>',
            to: [input.toEmail],
            subject: input.subject?.trim() || 'HomeStyle Furniture',
            text: input.body,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
        if (!res.ok) {
          return { simulated: false, externalId: null, error: data.message ?? `Resend ${res.status}` };
        }
        return { simulated: false, externalId: data.id ?? null, error: null };
      } catch (err) {
        return {
          simulated: false,
          externalId: null,
          error: err instanceof Error ? err.message : 'network error',
        };
      }
    }
    // No key / no address — fall through to simulated.
  }

  // WhatsApp, SMS, or email without a configured sender: record only.
  return { simulated: true, externalId: null, error: null };
}
