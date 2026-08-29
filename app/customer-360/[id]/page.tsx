import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getCustomerConsents,
  getCustomerProfile,
  getCustomerTimeline,
} from '../../../lib/queries';
import {
  churnRiskColor,
  consentStatusColor,
  formatChannel,
  formatConsentStatus,
  formatDate,
  formatDateTime,
  formatINR,
  formatSegment,
  fullName,
  initials,
  relativeTime,
} from '../../../lib/format';

export const dynamic = 'force-dynamic';

const TIMELINE_TAG_STYLE: Record<string, string> = {
  ORDER: 'border-[#c3cff0] bg-[#f5f7fd] text-accent-blue',
  CONSENT: 'border-hairline bg-secondary text-ink-soft',
  VIEW: 'border-hairline bg-secondary text-ink-soft',
  CART: 'border-[#cfe4d8] bg-[#eef6f1] text-good',
  CHK: 'border-[#c3cff0] bg-[#f5f7fd] text-accent-blue',
  DROP: 'border-[#f0ddd7] bg-[#fbf1ee] text-bad',
  PAGE: 'border-hairline bg-secondary text-ink-soft',
};

function timelineTagClass(tag: string) {
  return TIMELINE_TAG_STYLE[tag] ?? 'border-hairline bg-secondary text-ink-soft';
}

export default async function Customer360Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [profile, consents, timeline] = await Promise.all([
    getCustomerProfile(id),
    getCustomerConsents(id),
    getCustomerTimeline(id),
  ]);

  if (!profile) notFound();

  const name = fullName(profile.firstName, profile.lastName);
  const orderEntries = timeline.filter((e) => e.kind === 'order').length;
  const eventEntries = timeline.filter((e) => e.kind === 'event').length;

  return (
    <div className="px-4.5 py-3.5 pb-7">
      <div className="mb-3 flex items-center gap-2.5">
        <Link
          href="/customers"
          className="rounded border border-hairline bg-card px-2.5 py-1 text-[11.5px] text-ink-soft hover:bg-secondary"
        >
          ← Customers
        </Link>
        <div className="font-mono text-[10.5px] text-muted-foreground">
          CUSTOMER 360 · {profile.id.slice(0, 8)}
        </div>
      </div>

      <div className="grid grid-cols-[300px_1fr] items-start gap-3">
        {/* Left: profile + scores + consent */}
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-hairline bg-card p-3.5">
            <div className="mb-2.5 flex items-center gap-2.5">
              <div className="flex h-9.5 w-9.5 flex-none items-center justify-center rounded-full bg-secondary text-[14px] font-semibold text-ink-soft">
                {initials(profile.firstName, profile.lastName)}
              </div>
              <div className="min-w-0">
                <div className="text-[15px] font-semibold">{name}</div>
                <div className="font-mono text-[10.5px] text-muted-foreground">
                  {profile.city ?? '—'} · since {formatDate(profile.createdAt)}
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 text-[11.5px]">
              <div className="flex">
                <span className="w-20 text-muted-foreground">Phone</span>
                <span className="font-mono">{profile.phoneE164 ?? '—'}</span>
              </div>
              <div className="flex">
                <span className="w-20 text-muted-foreground">Email</span>
                <span className="truncate font-mono text-[10.5px]">{profile.email ?? '—'}</span>
              </div>
              <div className="flex">
                <span className="w-20 text-muted-foreground">Orders</span>
                <span className="font-mono">{profile.orderCount}</span>
              </div>
              <div className="flex">
                <span className="w-20 text-muted-foreground">Lifetime</span>
                <span className="font-mono">{formatINR(profile.lifetimeValue)}</span>
              </div>
              <div className="flex">
                <span className="w-20 text-muted-foreground">AOV</span>
                <span className="font-mono">{formatINR(profile.aov)}</span>
              </div>
              <div className="flex items-center">
                <span className="w-20 text-muted-foreground">Segment</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10.5px] font-medium text-ink-soft">
                  {formatSegment(profile.segment)}
                </span>
              </div>
              <div className="flex">
                <span className="w-20 text-muted-foreground">RFM</span>
                <span className="font-mono">
                  R{profile.rfmR ?? '—'} F{profile.rfmF ?? '—'} M{profile.rfmM ?? '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Scores — every number sits next to its reason */}
          <div className="rounded-md border border-hairline bg-card">
            <div className="flex items-center border-b border-[#eeece7] px-3 py-2.5">
              <div className="text-[13px] font-semibold">Scores</div>
              <div className="flex-1" />
              <div className="font-mono text-[9.5px] text-muted-foreground">
                {profile.computedAt ? `RECOMPUTED ${formatDate(profile.computedAt)}` : 'NOT SCORED'}
              </div>
            </div>
            <div className="px-3 pb-1">
              <div className="border-b border-[#f2f0ec] py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 text-[11.5px] text-ink-soft">Churn risk</span>
                  <span className={`font-mono text-[17px] font-medium ${churnRiskColor(profile.churnRisk)}`}>
                    {profile.churnRisk ?? '—'}
                  </span>
                </div>
                {profile.churnRisk != null && (
                  <div className="my-1.5 h-1.25 overflow-hidden rounded bg-secondary">
                    <div
                      className="h-1.25 bg-accent-blue"
                      style={{ width: `${profile.churnRisk}%` }}
                    />
                  </div>
                )}
                {profile.churnReason && (
                  <div className="flex gap-1.5">
                    <span className="font-mono text-[9px] text-muted-foreground">WHY</span>
                    <span className="text-[11px] leading-relaxed text-ink-soft">{profile.churnReason}</span>
                  </div>
                )}
              </div>
              <div className="border-b border-[#f2f0ec] py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 text-[11.5px] text-ink-soft">Predicted LTV</span>
                  <span className="font-mono text-[17px] font-medium">{formatINR(profile.predictedLtv)}</span>
                </div>
                {profile.ltvReason && (
                  <div className="mt-1.5 flex gap-1.5">
                    <span className="font-mono text-[9px] text-muted-foreground">WHY</span>
                    <span className="text-[11px] leading-relaxed text-ink-soft">{profile.ltvReason}</span>
                  </div>
                )}
              </div>
              <div className="py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 text-[11.5px] text-ink-soft">Next order</span>
                  <span className="font-mono text-[17px] font-medium">{formatDate(profile.nextOrderDate)}</span>
                </div>
                {profile.nextOrderReason && (
                  <div className="mt-1.5 flex gap-1.5">
                    <span className="font-mono text-[9px] text-muted-foreground">WHY</span>
                    <span className="text-[11px] leading-relaxed text-ink-soft">{profile.nextOrderReason}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Consent & reachability */}
          <div className="rounded-md border border-hairline bg-card">
            <div className="border-b border-[#eeece7] px-3 py-2.5 text-[13px] font-semibold">
              Consent &amp; reachability
            </div>
            <div className="flex flex-col gap-2 px-3 py-2.5">
              {consents.length === 0 && (
                <div className="text-[11px] text-muted-foreground">No consent records on file.</div>
              )}
              {consents.map((c) => (
                <div key={c.channel} className="flex items-center gap-2 text-[11.5px]">
                  <span
                    className={`h-1.5 w-1.5 flex-none rounded-full ${
                      c.status === 'opted_in'
                        ? 'bg-good'
                        : c.status === 'opted_out'
                          ? 'bg-bad'
                          : 'bg-muted-foreground'
                    }`}
                  />
                  <span className="flex-1">{formatChannel(c.channel)}</span>
                  <span className={`font-mono text-[9.5px] ${consentStatusColor(c.status)}`}>
                    {formatConsentStatus(c.status).toUpperCase()} · {formatDate(c.updatedAt)}
                  </span>
                </div>
              ))}
              <div className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                Consent is stored per channel. No messaging channel is live yet (§F5 is blocked
                on Twilio), so reachability here reflects consent state only, not send history.
              </div>
            </div>
          </div>
        </div>

        {/* Right: unified timeline */}
        <div className="rounded-md border border-hairline bg-card">
          <div className="sticky top-0 z-10 flex items-center gap-2 rounded-t-md border-b border-[#eeece7] bg-card px-3 py-2.5">
            <div className="text-[13px] font-semibold">Unified timeline</div>
            <div className="flex-1" />
            <div className="font-mono text-[10px] text-muted-foreground">
              {orderEntries} orders · {eventEntries} events · {consents.length} consent record
              {consents.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="px-3 pb-3.5">
            {timeline.length === 0 && (
              <div className="py-6 text-center text-[11.5px] text-muted-foreground">
                No activity on file for this customer yet.
              </div>
            )}
            {timeline.map((e, i) => (
              <div key={`${e.kind}-${e.occurredAt}-${i}`} className="flex gap-2.5 py-1.75">
                <div className="flex w-8.5 flex-none flex-col items-center gap-1">
                  <div
                    className={`w-8.5 rounded border py-0.5 text-center font-mono text-[9px] font-semibold ${timelineTagClass(e.tag)}`}
                  >
                    {e.tag}
                  </div>
                  <div className="w-px flex-1 bg-[#f2f0ec]" />
                </div>
                <div className="min-w-0 flex-1 rounded border border-[#f2f0ec] bg-[#fbfaf8] px-2.5 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12.5px] font-semibold">{e.title}</span>
                    <div className="flex-1" />
                    <span
                      className="font-mono text-[9.5px] text-muted-foreground"
                      title={formatDateTime(e.occurredAt)}
                    >
                      {relativeTime(e.occurredAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">{e.body}</div>
                  {e.meta && e.meta.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {e.meta.map((m, mi) => (
                        <span
                          key={mi}
                          className="rounded border border-hairline bg-card px-1.5 py-0.5 font-mono text-[9.5px] text-ink-soft"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
