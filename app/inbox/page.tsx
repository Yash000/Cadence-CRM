import Link from 'next/link';
import {
  getInboxCounts,
  getInboxCustomerSample,
  getThread,
  listConversations,
  type Channel,
  type ConvStatus,
} from '../../lib/inbox-db';
import { formatChannel, formatDateTime, initials, relativeTime } from '../../lib/format';
import { Tag, pillVariants } from '../../components/ui/pill';
import { ChannelSimulator } from '../../components/inbox/channel-simulator';
import { DraftReview } from '../../components/inbox/draft-review';
import { setStatusAction } from './actions';

export const dynamic = 'force-dynamic';

const STATUS_FILTERS: { value: ConvStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Needs review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'snoozed', label: 'Snoozed' },
];

const CHANNEL_FILTERS: { value: Channel | 'all'; label: string }[] = [
  { value: 'all', label: 'All channels' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
];

function href(params: Record<string, string | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && v !== 'all') sp.set(k, v);
  }
  const qs = sp.toString();
  return qs ? `/inbox?${qs}` : '/inbox';
}

const intentLabel = (t: string | null) =>
  t ? t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : null;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);

  const status = get('status') as ConvStatus | undefined;
  const channel = get('channel') as Channel | undefined;
  const assignment = get('assignment') === 'unassigned' ? ('unassigned' as const) : undefined;
  const q = get('q');
  const selectedId = get('c');

  const [conversations, counts, customers, thread] = await Promise.all([
    listConversations({ status, channel, assignment, q }),
    getInboxCounts(),
    getInboxCustomerSample(),
    selectedId ? getThread(selectedId) : Promise.resolve(null),
  ]);

  const baseFilter = { status, channel, q, assignment };

  return (
    <div className="px-6 pb-12">
      <div className="mb-5">
        <h1 className="type-heading-4">Inbox.</h1>
        <p className="mt-1.5 type-body-sm text-muted-foreground">
          {counts.open} open · {counts.pending} need review · {counts.heldDrafts} draft
          {counts.heldDrafts === 1 ? '' : 's'} awaiting approval · {counts.unassigned} unknown contact
          {counts.unassigned === 1 ? '' : 's'}
        </p>
      </div>

      <div className="grid grid-cols-[300px_minmax(0,1fr)_320px] items-start gap-4">
        {/* ── Conversation list ─────────────────────────────────────────── */}
        <div className="surface-card overflow-hidden">
          <form method="get" className="border-b border-hairline p-3">
            {status && <input type="hidden" name="status" value={status} />}
            {channel && <input type="hidden" name="channel" value={channel} />}
            <div className="field-shell flex h-9 items-center gap-2 px-3">
              <span className="type-caption text-faint">⌕</span>
              <input
                name="q"
                defaultValue={q ?? ''}
                placeholder="Customer, phone, email"
                className="w-full bg-transparent type-body-sm text-ink outline-none placeholder:text-faint"
              />
            </div>
          </form>

          <div className="flex flex-wrap gap-1 border-b border-hairline p-2">
            {STATUS_FILTERS.map((f) => (
              <Link
                key={f.value}
                href={href({ ...baseFilter, status: f.value === 'all' ? undefined : f.value, c: selectedId })}
                className={pillVariants({
                  variant: (status ?? 'all') === f.value ? 'primary' : 'chip',
                  size: 'sm',
                })}
              >
                {f.label}
              </Link>
            ))}
            <Link
              href={href({ ...baseFilter, assignment: assignment ? undefined : 'unassigned', c: selectedId })}
              className={pillVariants({ variant: assignment ? 'primary' : 'chip', size: 'sm' })}
            >
              Unknown
            </Link>
          </div>

          <div className="flex flex-wrap gap-1 border-b border-hairline p-2">
            {CHANNEL_FILTERS.map((f) => (
              <Link
                key={f.value}
                href={href({ ...baseFilter, channel: f.value === 'all' ? undefined : f.value, c: selectedId })}
                className={pillVariants({
                  variant: (channel ?? 'all') === f.value ? 'primary' : 'chip',
                  size: 'sm',
                })}
              >
                {f.label}
              </Link>
            ))}
          </div>

          <div className="max-h-[560px] overflow-y-auto">
            {conversations.length === 0 && (
              <div className="px-4 py-10 text-center type-body-sm text-muted-foreground">
                No conversations. Send one with the simulator →
              </div>
            )}
            {conversations.map((c) => {
              const active = c.id === selectedId;
              return (
                <Link
                  key={c.id}
                  href={href({ ...baseFilter, c: c.id })}
                  className={`row-divider block px-4 py-3 transition-colors last:border-b-0 ${
                    active ? 'bg-canvas-soft' : 'hover:bg-canvas-soft'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-7 flex-none items-center justify-center rounded-full bg-field type-caption font-semibold text-ink-soft">
                      {c.customerName
                        ? initials(c.customerName.split(' ')[0] ?? null, c.customerName.split(' ')[1] ?? null)
                        : '??'}
                    </span>
                    <span className="min-w-0 flex-1 truncate type-body-sm font-semibold text-ink">
                      {c.customerName ?? c.phoneE164 ?? 'Unknown contact'}
                    </span>
                    <span className="flex-none type-caption text-faint">
                      {relativeTime(c.lastMessageAt)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Tag className="flex-none">{formatChannel(c.channel)}</Tag>
                    {c.heldCount > 0 && (
                      <span className="inline-flex h-[18px] flex-none items-center rounded-full bg-brand-accent px-1.5 type-label text-white">
                        {c.heldCount} draft
                      </span>
                    )}
                    {c.status === 'resolved' && (
                      <span className="type-caption text-good">resolved</span>
                    )}
                  </div>
                  <p className="mt-1 truncate type-caption text-muted-foreground">
                    {c.lastDirection === 'outbound' ? '↩ ' : ''}
                    {c.lastBody ?? '—'}
                  </p>
                </Link>
              );
            })}
          </div>
        </div>

        {/* ── Thread ────────────────────────────────────────────────────── */}
        <div className="surface-card min-h-[400px] p-5">
          {!thread ? (
            <div className="flex h-full items-center justify-center py-20 text-center type-body-sm text-muted-foreground">
              Select a conversation, or send a simulated inbound message to start one.
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="type-title">
                      {thread.customer?.name ?? thread.customer?.phoneE164 ?? 'Unknown contact'}
                    </span>
                    <Tag>{formatChannel(thread.conversation.channel)}</Tag>
                    {intentLabel(thread.conversation.intentTag) && (
                      <Tag className="text-ink">{intentLabel(thread.conversation.intentTag)}</Tag>
                    )}
                  </div>
                  <p className="mt-1 type-caption text-muted-foreground">
                    {thread.customer?.city ? `${thread.customer.city} · ` : ''}
                    {thread.customer ? (
                      <Link href={`/customer-360/${thread.customer.id}`} className="underline">
                        Customer 360
                      </Link>
                    ) : (
                      'not resolved to a customer'
                    )}
                    {' · '}
                    {thread.conversation.sessionOpen
                      ? '24h session window open'
                      : 'session window closed'}
                  </p>
                </div>
                <div className="flex flex-none gap-1.5">
                  {(['open', 'pending', 'resolved'] as const).map((s) => (
                    <form key={s} action={setStatusAction}>
                      <input type="hidden" name="conversationId" value={thread.conversation.id} />
                      <input type="hidden" name="status" value={s} />
                      <button
                        className={pillVariants({
                          variant: thread.conversation.status === s ? 'primary' : 'outline',
                          size: 'sm',
                        })}
                      >
                        {s}
                      </button>
                    </form>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {thread.messages.map((m) => {
                  const held = m.status === 'held' && m.direction === 'outbound';
                  if (held) {
                    return (
                      <DraftReview
                        key={m.id}
                        messageId={m.id}
                        initialBody={m.body ?? ''}
                        sessionOpen={thread.conversation.sessionOpen}
                        channel={thread.conversation.channel}
                      />
                    );
                  }
                  const inbound = m.direction === 'inbound';
                  return (
                    <div
                      key={m.id}
                      className={`max-w-[80%] rounded-lg px-3.5 py-2.5 ${
                        inbound
                          ? 'self-start bg-canvas-soft'
                          : 'self-end bg-ink text-paper'
                      }`}
                    >
                      <p className="type-body-sm whitespace-pre-wrap">{m.body}</p>
                      <p
                        className={`mt-1 type-caption ${
                          inbound ? 'text-faint' : 'text-paper/60'
                        }`}
                      >
                        {formatDateTime(m.createdAt)}
                        {!inbound && ` · ${m.status}`}
                        {!inbound && m.aiGenerated && ' · AI'}
                        {!inbound &&
                          m.aiEditedPct != null &&
                          Number(m.aiEditedPct) > 0 &&
                          ` · ${Number(m.aiEditedPct)}% edited`}
                        {!inbound && m.externalId && ` · sent (${m.externalId.slice(0, 12)})`}
                        {!inbound && m.status === 'sent' && !m.externalId && ' · simulated'}
                        {m.status === 'failed' && m.heldReason && ` · ${m.heldReason}`}
                      </p>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* ── Simulator ─────────────────────────────────────────────────── */}
        <div className="sticky top-0">
          <ChannelSimulator customers={customers} />
        </div>
      </div>
    </div>
  );
}
