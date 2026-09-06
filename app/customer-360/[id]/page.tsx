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
import { RescoreButton } from '../../../components/customer/rescore-button';
import { Tag, pillVariants } from '../../../components/ui/pill';

export const dynamic = 'force-dynamic';

// Timeline markers are stadium chips on the canvas-soft tint. Only the text
// carries a semantic hue — the tinted fills the previous design used (pale
// blue, pale green, pale pink) are exactly the colored surfaces DESIGN.md
// rules out.
const TIMELINE_TAG_TEXT: Record<string, string> = {
  ORDER: 'text-ink',
  CONSENT: 'text-ink-soft',
  VIEW: 'text-ink-soft',
  CART: 'text-good',
  CHK: 'text-ink',
  DROP: 'text-bad',
  PAGE: 'text-ink-soft',
};

function timelineTagClass(tag: string) {
  return TIMELINE_TAG_TEXT[tag] ?? 'text-ink-soft';
}

function ScoreRow({
  label,
  value,
  valueClass,
  reason,
  bar,
}: {
  label: string;
  value: string;
  valueClass?: string;
  reason?: string | null;
  bar?: number | null;
}) {
  return (
    <div className="row-divider py-4 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="flex-1 type-body-sm text-ink-soft">{label}</span>
        <span className={`type-heading-4 ${valueClass ?? ''}`}>{value}</span>
      </div>
      {bar != null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-field">
          <div className="h-1.5 rounded-full bg-ink" style={{ width: `${bar}%` }} />
        </div>
      )}
      {reason && (
        <div className="mt-2.5 flex gap-2 type-caption">
          <span className="shrink-0 text-faint">Why</span>
          <span className="text-muted-foreground">{reason}</span>
        </div>
      )}
    </div>
  );
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

  const facts: { label: string; value: React.ReactNode }[] = [
    { label: 'Phone', value: profile.phoneE164 ?? '—' },
    {
      label: 'Email',
      value: <span className="block truncate">{profile.email ?? '—'}</span>,
    },
    { label: 'Orders', value: profile.orderCount },
    { label: 'Lifetime', value: formatINR(profile.lifetimeValue) },
    { label: 'AOV', value: formatINR(profile.aov) },
    { label: 'Segment', value: <Tag>{formatSegment(profile.segment)}</Tag> },
    {
      label: 'RFM',
      value: `R${profile.rfmR ?? '—'} F${profile.rfmF ?? '—'} M${profile.rfmM ?? '—'}`,
    },
  ];

  return (
    <div className="px-6 pb-12">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/customers" className={pillVariants({ variant: 'soft', size: 'sm' })}>
          ← Customers
        </Link>
        <div className="type-caption text-faint">Customer 360 · {profile.id.slice(0, 8)}</div>
      </div>

      <div className="grid grid-cols-[340px_1fr] items-start gap-4">
        {/* Left: profile + scores + consent */}
        <div className="flex flex-col gap-4">
          <div className="surface-card p-5">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex size-11 flex-none items-center justify-center rounded-full bg-canvas-soft type-body font-semibold text-ink-soft">
                {initials(profile.firstName, profile.lastName)}
              </div>
              <div className="min-w-0">
                <div className="truncate type-title">{name}</div>
                <div className="type-caption text-faint">
                  {profile.city ?? '—'} · since {formatDate(profile.createdAt)}
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-2.5 type-body-sm">
              {facts.map((f) => (
                <div key={f.label} className="flex items-center gap-3">
                  <span className="w-20 flex-none type-caption text-muted-foreground">
                    {f.label}
                  </span>
                  <span className="min-w-0 flex-1 text-ink">{f.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Scores — every number sits next to its reason */}
          <div className="surface-card">
            <div className="row-divider flex items-center gap-3 px-5 py-4">
              <div className="type-title">Scores</div>
              <div className="flex-1" />
              <div className="type-caption text-faint">
                {profile.computedAt
                  ? `Recomputed ${formatDate(profile.computedAt)}`
                  : 'Not scored'}
              </div>
              <RescoreButton customerId={profile.id} />
            </div>
            <div className="px-5">
              <ScoreRow
                label="Churn risk"
                value={String(profile.churnRisk ?? '—')}
                valueClass={churnRiskColor(profile.churnRisk)}
                bar={profile.churnRisk}
                reason={profile.churnReason}
              />
              <ScoreRow
                label="Predicted LTV"
                value={formatINR(profile.predictedLtv)}
                reason={profile.ltvReason}
              />
              <ScoreRow
                label="Next order"
                value={formatDate(profile.nextOrderDate)}
                reason={profile.nextOrderReason}
              />
            </div>
          </div>

          {/* Consent & reachability */}
          <div className="surface-card">
            <div className="row-divider px-5 py-4 type-title">Consent &amp; reachability</div>
            <div className="flex flex-col gap-3 px-5 py-4">
              {consents.length === 0 && (
                <div className="type-body-sm text-muted-foreground">
                  No consent records on file.
                </div>
              )}
              {consents.map((c) => (
                <div key={c.channel} className="flex items-center gap-2.5 type-body-sm">
                  <span
                    className={`size-1.5 flex-none rounded-full ${
                      c.status === 'opted_in'
                        ? 'bg-good'
                        : c.status === 'opted_out'
                          ? 'bg-bad'
                          : 'bg-faint'
                    }`}
                  />
                  <span className="flex-1">{formatChannel(c.channel)}</span>
                  <span className={`type-caption ${consentStatusColor(c.status)}`}>
                    {formatConsentStatus(c.status)} · {formatDate(c.updatedAt)}
                  </span>
                </div>
              ))}
              <div className="mt-1 type-caption text-muted-foreground">
                Consent is stored per channel. No messaging channel is live yet (§F5 is blocked on
                Twilio), so reachability here reflects consent state only, not send history.
              </div>
            </div>
          </div>
        </div>

        {/* Right: unified timeline */}
        <div className="surface-card">
          <div className="row-divider sticky top-0 z-10 flex items-center gap-3 rounded-t-md bg-canvas px-5 py-4">
            <div className="type-title">Unified timeline</div>
            <div className="flex-1" />
            <div className="type-caption text-faint">
              {orderEntries} orders · {eventEntries} events · {consents.length} consent record
              {consents.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="px-5 py-3">
            {timeline.length === 0 && (
              <div className="py-10 text-center type-body-sm text-muted-foreground">
                No activity on file for this customer yet.
              </div>
            )}
            {timeline.map((e, i) => (
              <div key={`${e.kind}-${e.occurredAt}-${i}`} className="flex gap-3 py-1.5">
                <div className="flex w-14 flex-none flex-col items-center gap-1.5">
                  <span
                    className={`inline-flex h-[22px] w-full items-center justify-center rounded-full bg-canvas-soft type-caption font-semibold ${timelineTagClass(e.tag)}`}
                  >
                    {e.tag}
                  </span>
                  <span className="w-px flex-1 bg-hairline-soft" />
                </div>
                <div className="min-w-0 flex-1 rounded-sm bg-canvas-soft px-4 py-3">
                  <div className="flex items-baseline gap-3">
                    <span className="type-body-sm font-semibold">{e.title}</span>
                    <div className="flex-1" />
                    <span className="type-caption text-faint" title={formatDateTime(e.occurredAt)}>
                      {relativeTime(e.occurredAt)}
                    </span>
                  </div>
                  <div className="mt-1 type-body-sm text-ink-soft">{e.body}</div>
                  {e.meta && e.meta.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {e.meta.map((m, mi) => (
                        <span
                          key={mi}
                          className="inline-flex h-[22px] items-center rounded-full bg-canvas px-2.5 type-caption text-ink-soft"
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
