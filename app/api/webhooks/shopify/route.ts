// Shopify webhook endpoint — PRD-02 §F1, PRD-01 §6.2/§6.3.
//
// The live-sync path. PRD-02's success criterion is a real order appearing in
// the CRM within 5 seconds of being placed, and Shopify retries any delivery
// it does not get a 2xx for within 5s — so the request path here is
// deliberately short: verify, log, respond, and do the database work in
// `after()`, once the response is already on the wire.
import { after, NextResponse } from 'next/server';
import {
  extractShopifyId,
  isSupportedTopic,
  parsePayload,
  verifyShopifyHmac,
  webhookLogPayload,
} from '../../../../lib/shopify-webhook';
import { logWebhook, markWebhookProcessed, processWebhook } from '../../../../lib/shopify-sync';

// Node runtime, not edge: HMAC uses node:crypto and the sync path uses the
// `pg` pool. Never cached — every delivery is a distinct write.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  // The RAW bytes, before any parsing. `arrayBuffer()` rather than `text()`
  // because the digest must be computed over exactly what Shopify sent:
  // JSON.parse -> JSON.stringify does not round-trip byte-identically, so a
  // digest over re-serialised JSON would reject every genuine delivery.
  const rawBody = Buffer.from(await request.arrayBuffer());

  const topicHeader = request.headers.get('x-shopify-topic');
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const secret = process.env.SHOPIFY_API_SECRET;

  // For a Shopify app, webhook signatures are computed with the app's client
  // secret (`shpss_…`), which lives in .env.local as SHOPIFY_API_SECRET.
  const hmacValid = verifyShopifyHmac(rawBody, hmacHeader, secret);

  const parsed = parsePayload(rawBody);
  const topic = topicHeader ?? 'unknown';
  const shopifyId = parsed.ok ? extractShopifyId(parsed.value) : null;

  let rejection: string | null = null;
  if (!secret) {
    rejection = 'SHOPIFY_API_SECRET is not set — cannot verify any delivery';
  } else if (!hmacValid) {
    rejection = 'hmac verification failed';
  } else if (!parsed.ok) {
    rejection = parsed.error;
  } else if (!isSupportedTopic(topic)) {
    rejection = `unsupported topic: ${topic}`;
  }

  // Log BEFORE processing (PRD-01 §6.3.4) — including for deliveries that
  // failed HMAC or will not parse. A rejected delivery is exactly the one
  // worth having a record of, and §F1.7's sync health page reads this table.
  let logId: string | null = null;
  try {
    logId = await logWebhook({
      topic,
      shopifyId,
      payload: webhookLogPayload(rawBody, parsed),
      hmacValid,
      error: rejection,
    });
  } catch (err) {
    // A logging failure must not swallow the delivery. Returning non-2xx here
    // makes Shopify retry, which is the right outcome: the database is the
    // thing that is unavailable, so the work genuinely has not been done.
    console.error('[shopify-webhook] failed to write webhook_log', err);
    return NextResponse.json(
      { ok: false, error: 'failed to record webhook' },
      { status: 503 },
    );
  }

  // §F1.2: reject unverified requests with 401.
  //
  // processed_at is stamped even though nothing was processed: this delivery is
  // finished with, not queued. §F1.7's sync health page reads unprocessed rows
  // as backlog, and leaving every rejected delivery at processed_at = NULL
  // would show a permanently growing pending count that never drains. The
  // rejection itself is not lost — it is in `error`, with hmac_valid = false.
  if (!hmacValid) {
    await markWebhookProcessed(logId, rejection);
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Verified but unusable. Answered 200, not 4xx, on purpose: the body is
  // signed by Shopify and will never become valid, so retrying it 19 times
  // over 48 hours would only produce noise. The row in webhook_log carries the
  // reason and can be replayed by hand.
  if (!parsed.ok || !isSupportedTopic(topic)) {
    await markWebhookProcessed(logId, rejection);
    return NextResponse.json({ ok: false, logId, error: rejection }, { status: 200 });
  }

  const payload = parsed.value;

  // §F1.3: return 200 within 5s, then do the real work. `after()` runs the
  // callback once the response has been sent, so the round trip Shopify times
  // is only the HMAC check plus one INSERT.
  after(async () => {
    try {
      await processWebhook(topic, payload);
      await markWebhookProcessed(logId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[shopify-webhook] processing failed for ${topic} ${shopifyId}`, err);
      try {
        await markWebhookProcessed(logId, message);
      } catch (logErr) {
        console.error('[shopify-webhook] failed to record processing error', logErr);
      }
    }
  });

  return NextResponse.json({ ok: true, logId, topic }, { status: 200 });
}

// Shopify only ever POSTs here. Anything else is a misconfiguration, and
// saying so is more useful than Next's default 405-with-no-body.
export function GET(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'this endpoint accepts POST from Shopify only' },
    { status: 405 },
  );
}
