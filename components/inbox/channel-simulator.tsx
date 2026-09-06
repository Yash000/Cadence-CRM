'use client';

// PRD-02 §F5.11 — the in-app fake WhatsApp / email / SMS client. Posts the same
// shape the real Twilio/Resend inbound webhook would, to /api/inbox/simulate,
// then refreshes the server-rendered Inbox so the new thread appears.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pill } from '../ui/pill';
import type { InboxCustomerOption } from '../../lib/inbox-db';

const CHANNELS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
] as const;

const SAMPLES = [
  'Hi, where is my order? It was meant to arrive last week.',
  'The dining chair arrived with a cracked leg. I want a replacement.',
  'Do you have the Jaipur dhurrie rug in a larger size?',
  'I need to change the delivery address for my order.',
];

export function ChannelSimulator({ customers }: { customers: InboxCustomerOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]['value']>('whatsapp');
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '');
  const [body, setBody] = useState(SAMPLES[0]);
  const [autoDraft, setAutoDraft] = useState(true);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const selected = customers.find((c) => c.id === customerId);
  const canSend =
    body.trim() !== '' &&
    (channel === 'email' ? !!selected?.email : !!selected?.phoneE164) &&
    !pending;

  function send() {
    setResult(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/inbox/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel,
            customer_id: customerId || null,
            body,
            auto_draft: autoDraft,
          }),
        });
        const data = (await res.json()) as {
          ok: boolean;
          conversationId?: string;
          matched?: boolean;
          error?: string;
        };
        if (res.ok && data.ok) {
          setResult({
            ok: true,
            text: `Delivered${autoDraft ? ' — AI draft is awaiting approval' : ''}.`,
          });
          if (data.conversationId) {
            router.push(`/inbox?c=${data.conversationId}`);
          }
          router.refresh();
        } else {
          setResult({ ok: false, text: data.error ?? `Request failed (${res.status})` });
        }
      } catch (err) {
        setResult({ ok: false, text: err instanceof Error ? err.message : 'Network error' });
      }
    });
  }

  return (
    <div className="surface-soft p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="type-title">Channel simulator</span>
        <span className="inline-flex h-[22px] items-center rounded-full bg-canvas px-2 type-caption text-warn">
          Simulator
        </span>
      </div>
      <p className="mb-3 type-caption text-muted-foreground">
        No live Twilio/Resend inbound. Posts the same JSON an inbound webhook would to{' '}
        <code className="text-ink">/api/inbox/simulate</code> — PRD-02 §F5.11.
      </p>

      <div className="flex flex-wrap gap-1.5">
        {CHANNELS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setChannel(c.value)}
            className={`inline-flex h-7 items-center rounded-full px-3 type-caption font-medium ${
              channel === c.value ? 'bg-ink text-paper' : 'bg-canvas-soft text-ink-soft'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <label className="mt-3 block type-caption text-muted-foreground">
        Pose as customer
        <select
          className="field-input mt-1 h-9 w-full px-3 type-body-sm"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
        >
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {channel === 'email'
                ? c.email
                  ? ` · ${c.email}`
                  : ' · no email'
                : c.phoneE164
                  ? ` · ${c.phoneE164}`
                  : ' · no phone'}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-3 block type-caption text-muted-foreground">
        Inbound message
        <textarea
          className="field-input mt-1 h-20 w-full px-3 py-2 type-body-sm"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {SAMPLES.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setBody(s)}
            className="inline-flex h-6 items-center rounded-full bg-canvas-soft px-2.5 type-caption text-faint hover:text-ink"
          >
            sample {i + 1}
          </button>
        ))}
      </div>

      <label className="mt-3 flex items-center gap-2 type-caption text-muted-foreground">
        <input
          type="checkbox"
          checked={autoDraft}
          onChange={(e) => setAutoDraft(e.target.checked)}
        />
        Generate an AI reply draft (held for approval) — §F5.9
      </label>

      <Pill onClick={send} disabled={!canSend} className="mt-3 w-full">
        {pending ? 'Sending…' : 'Send inbound message'}
      </Pill>

      {result && (
        <div
          className={`mt-3 rounded-sm bg-canvas px-3 py-2 type-caption ${
            result.ok ? 'text-good' : 'text-bad'
          }`}
        >
          {result.text}
        </div>
      )}
    </div>
  );
}
