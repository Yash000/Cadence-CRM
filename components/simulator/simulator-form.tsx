'use client';

import { useState } from 'react';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { eventTypeTag, formatEventType } from '../../lib/format';
import type { SimulatorCustomerOption } from '../../lib/queries';
import type { RecentEvent } from '../../lib/events-db';
import { TRACKED_EVENT_TYPES, type TrackedEventType } from '../../lib/events';

const DEFAULT_PAYLOADS: Record<TrackedEventType, Record<string, unknown>> = {
  page_view: { template: 'index', url: 'https://rasaya-dev.myshopify.com/', title: 'Rasaya' },
  product_view: {
    id: 'gid://shopify/Product/1',
    title: 'Rosemary Scalp Serum',
    handle: 'rosemary-scalp-serum',
    price: '899.00',
  },
  add_to_cart: { source: 'product-form', title: 'Rosemary Scalp Serum', sku: 'RSY-SS-050', qty: 1, price: 899 },
  checkout_started: { source: 'storefront', items: 2, value: '1548.00' },
};

function newSessionId(): string {
  return `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

interface SendResult {
  ok: boolean;
  message: string;
}

export function SimulatorForm({
  customers,
  initialEvents,
}: {
  customers: SimulatorCustomerOption[];
  initialEvents: RecentEvent[];
}) {
  const [type, setType] = useState<TrackedEventType>('page_view');
  const [customerId, setCustomerId] = useState<string>('');
  const [sessionId, setSessionId] = useState(newSessionId);
  const [payloadText, setPayloadText] = useState(() =>
    JSON.stringify(DEFAULT_PAYLOADS.page_view, null, 2),
  );
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [events, setEvents] = useState(initialEvents);

  function onTypeChange(next: TrackedEventType) {
    setType(next);
    setPayloadText(JSON.stringify(DEFAULT_PAYLOADS[next], null, 2));
  }

  async function refreshEvents() {
    try {
      const res = await fetch('/api/events?limit=20');
      const body = (await res.json()) as { ok: boolean; events?: RecentEvent[] };
      if (body.ok && body.events) setEvents(body.events);
    } catch {
      // best-effort refresh; the send result already told the user what happened
    }
  }

  async function onSend() {
    setSending(true);
    setResult(null);

    let payload: unknown;
    try {
      payload = payloadText.trim() === '' ? {} : JSON.parse(payloadText);
    } catch {
      setResult({ ok: false, message: 'Payload is not valid JSON.' });
      setSending(false);
      return;
    }

    const selected = customers.find((c) => c.id === customerId);

    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cadence-source': 'simulator' },
        body: JSON.stringify({
          type,
          session_id: sessionId,
          customer_id: selected ? selected.shopifyCustomerId : null,
          payload,
        }),
      });
      const body = (await res.json()) as { ok: boolean; id?: string; error?: string };
      if (res.ok && body.ok) {
        setResult({ ok: true, message: `Recorded — events.id = ${body.id}` });
        await refreshEvents();
      } else {
        setResult({ ok: false, message: body.error ?? `Request failed (${res.status})` });
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-4 grid grid-cols-[360px_1fr] gap-3.5">
      <Card className="p-3.5">
        <div className="mb-2 text-[12px] font-semibold">Send a simulated event</div>

        <label className="mb-2 block text-[11px] text-muted-foreground">
          Event type
          <select
            className="mt-1 w-full rounded-md border border-hairline bg-background px-2 py-1.5 text-[12px]"
            value={type}
            onChange={(e) => onTypeChange(e.target.value as TrackedEventType)}
          >
            {TRACKED_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {formatEventType(t)} ({t})
              </option>
            ))}
          </select>
        </label>

        <label className="mb-2 block text-[11px] text-muted-foreground">
          Customer (optional — resolved by Shopify customer id, same as the real snippet)
          <select
            className="mt-1 w-full rounded-md border border-hairline bg-background px-2 py-1.5 text-[12px]"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">Anonymous visitor</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} (#{c.shopifyCustomerId})
              </option>
            ))}
          </select>
        </label>

        <label className="mb-2 block text-[11px] text-muted-foreground">
          Session id
          <div className="mt-1 flex gap-1.5">
            <input
              className="w-full rounded-md border border-hairline bg-background px-2 py-1.5 font-mono text-[11px]"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setSessionId(newSessionId())}>
              New
            </Button>
          </div>
        </label>

        <label className="mb-2 block text-[11px] text-muted-foreground">
          Payload (JSON)
          <textarea
            className="mt-1 h-32 w-full rounded-md border border-hairline bg-background px-2 py-1.5 font-mono text-[11px]"
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            spellCheck={false}
          />
        </label>

        <Button type="button" onClick={onSend} disabled={sending} className="w-full">
          {sending ? 'Sending…' : 'Send event'}
        </Button>

        {result && (
          <div
            className={`mt-2 rounded-md border px-2 py-1.5 text-[11px] ${
              result.ok
                ? 'border-[#cfe4d8] bg-[#eef6f1] text-good'
                : 'border-[#f0ddd7] bg-[#fbf1ee] text-bad'
            }`}
          >
            {result.message}
          </div>
        )}
      </Card>

      <Card className="p-3.5">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[12px] font-semibold">Recently landed in `events`</div>
          <Button type="button" variant="ghost" size="xs" onClick={refreshEvents}>
            Refresh
          </Button>
        </div>
        {events.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">No events yet — send one on the left.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {events.map((e) => (
              <div
                key={e.id}
                className="flex items-start gap-2 rounded-md border border-hairline bg-secondary/30 px-2 py-1.5 text-[11px]"
              >
                <span className="mt-0.5 rounded border border-hairline bg-card px-1 font-mono text-[9.5px] text-muted-foreground">
                  {eventTypeTag(e.type)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{formatEventType(e.type)}</div>
                  <div className="truncate text-muted-foreground">
                    {e.customerId ? `customer ${e.customerId.slice(0, 8)}` : 'anonymous'} ·{' '}
                    {e.sessionId ?? 'no session'} · {new Date(e.occurredAt).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
