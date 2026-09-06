import Link from 'next/link';
import {
  getAttachRates,
  getRoomBoard,
  getRoomSummary,
  formatRoom,
  isValidRoom,
  isValidRoomState,
  ROOM_ORDER,
  type Room,
  type RoomState,
} from '../../lib/queries-rooms';
import { formatCount, formatINR, initials } from '../../lib/format';
import { pillVariants } from '../../components/ui/pill';

export const dynamic = 'force-dynamic';

const STATE_OPTIONS: { value: RoomState; label: string; hint: string }[] = [
  { value: 'open', label: 'Open', hint: 'Unfinished — there is something left to sell' },
  { value: 'stalled', label: 'Stalled', hint: 'Unfinished and more than a month past the attach window' },
  { value: 'complete', label: 'Complete', hint: 'Every piece of the room bought' },
  { value: 'all', label: 'All', hint: 'Every room project on record' },
];

// One template shared by the header and every row so the two cannot drift.
const COLUMNS =
  'grid grid-cols-[minmax(180px,1.3fr)_120px_136px_minmax(210px,1.5fr)_128px_120px] items-center gap-4';

function buildHref(params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== 'all') sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `/rooms?${qs}` : '/rooms';
}

/** A hairline completion bar. Ink fill on a field track — no color, per DESIGN.md. */
function CompletionBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 flex-none overflow-hidden rounded-full bg-field">
        <div
          className="h-full rounded-full bg-ink"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <span className="type-caption tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

/**
 * The attach window rendered as words rather than a signed integer. Negative
 * means the window has already closed, which is the normal state of a stalled
 * room — see db/views-room.sql on why it is deliberately not clamped at zero.
 */
function WindowCell({ days }: { days: number | null }) {
  if (days === null) return <span className="type-caption text-faint">—</span>;
  if (days >= 0) {
    return (
      <span className="type-caption text-muted-foreground">
        <span className="inline-block size-1.5 translate-y-[-1px] rounded-full bg-good" />{' '}
        closes in {days}d
      </span>
    );
  }
  const overdue = Math.abs(days);
  return (
    <span className="type-caption text-muted-foreground">
      <span
        className={`inline-block size-1.5 translate-y-[-1px] rounded-full ${
          overdue > 30 ? 'bg-bad' : 'bg-warn'
        }`}
      />{' '}
      closed {overdue}d ago
    </span>
  );
}

export default async function RoomsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // A tampered, stale or crawled URL can carry anything here. Validate rather
  // than passing it through — the same treatment /customers gives `segment`,
  // and it keeps the active chip reflecting reality instead of the raw string.
  const rawRoom = typeof sp.room === 'string' ? sp.room : undefined;
  const room: Room | undefined = rawRoom && isValidRoom(rawRoom) ? rawRoom : undefined;

  const rawState = typeof sp.state === 'string' ? sp.state : undefined;
  const state: RoomState = rawState && isValidRoomState(rawState) ? rawState : 'open';

  const page = sp.page ? Math.max(1, Number(sp.page) || 1) : 1;
  const pageSize = 25;

  const [{ rows, total }, summary, attachRates] = await Promise.all([
    getRoomBoard({ room, state, page, pageSize }),
    getRoomSummary(),
    getAttachRates(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeState = STATE_OPTIONS.find((o) => o.value === state);

  return (
    <div className="px-6 pb-12">
      <div className="mb-6">
        <h1 className="type-heading-4">Rooms.</h1>
        <p className="mt-1.5 type-body-sm text-muted-foreground">
          Furniture does not get reordered — it gets completed. Every suggestion below is
          ranked by a measured attach rate, not a guess.
        </p>
      </div>

      {/* Per-room headline numbers. */}
      {summary.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-4">
          {summary.map((s) => (
            <div key={s.room} className="surface-card p-5">
              <div className="type-caption text-muted-foreground">{formatRoom(s.room)}</div>
              <div className="mt-1 type-heading-4 tabular-nums">
                {formatINR(s.valueRemaining)}
              </div>
              <div className="mt-0.5 type-caption text-faint">still missing from open rooms</div>
              <div className="mt-3 flex items-center gap-3 type-caption text-muted-foreground">
                <span className="tabular-nums">{formatCount(s.open)} open</span>
                <span className="text-faint">·</span>
                <span className="tabular-nums">{formatCount(s.complete)} complete</span>
                <span className="text-faint">·</span>
                <span className="tabular-nums">{s.avgCompletionPct}% avg</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="surface-soft mb-4 flex flex-wrap items-center gap-3 p-4">
        <span className="type-caption text-muted-foreground">Room</span>
        <div className="flex flex-wrap gap-2">
          <Link
            href={buildHref({ state })}
            className={pillVariants({ variant: !room ? 'primary' : 'chip', size: 'sm' })}
          >
            All
          </Link>
          {ROOM_ORDER.map((r) => (
            <Link
              key={r}
              href={buildHref({ state, room: r })}
              className={pillVariants({ variant: room === r ? 'primary' : 'chip', size: 'sm' })}
            >
              {formatRoom(r)}
            </Link>
          ))}
        </div>
        <span className="h-6 w-px bg-hairline" />
        <span className="type-caption text-muted-foreground">State</span>
        <div className="flex flex-wrap gap-2">
          {STATE_OPTIONS.map((o) => (
            <Link
              key={o.value}
              href={buildHref({ room, state: o.value })}
              title={o.hint}
              className={pillVariants({
                variant: state === o.value ? 'primary' : 'chip',
                size: 'sm',
              })}
            >
              {o.label}
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        <span className="type-caption text-faint">
          {formatCount(total)} {total === 1 ? 'project' : 'projects'}
          {activeState ? ` · ${activeState.hint.toLowerCase()}` : ''}
        </span>
      </div>

      {/* Board */}
      <div className="surface-card overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[1020px]">
            <div
              className={`${COLUMNS} row-divider bg-canvas-soft px-5 py-3 type-caption text-muted-foreground`}
            >
              <div>Customer</div>
              <div>Room</div>
              <div>Completion</div>
              <div>Next best piece</div>
              <div>Attach window</div>
              <div className="text-right">Still missing</div>
            </div>

            {rows.length === 0 && (
              <div className="px-5 py-14 text-center">
                <p className="type-body-sm text-muted-foreground">
                  No room projects match this filter.
                </p>
                <p className="mt-1 type-caption text-faint">
                  If every filter is empty, the store has not been re-seeded with the HomeStyle
                  catalogue yet — v_room_completion reads the living-room, bedroom and dining
                  collections.
                </p>
              </div>
            )}

            {rows.map((p) => (
              <Link
                key={`${p.customerId}-${p.room}`}
                href={`/customer-360/${p.customerId}`}
                className={`${COLUMNS} row-divider px-5 py-3.5 transition-colors last:border-b-0 hover:bg-canvas-soft`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 flex-none items-center justify-center rounded-full bg-canvas-soft type-caption font-semibold text-ink-soft">
                    {initials(
                      p.customerName.split(' ')[0] ?? null,
                      p.customerName.split(' ').slice(1).join(' ') || null,
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate type-body-sm font-semibold text-ink">
                      {p.customerName}
                    </span>
                    <span className="block truncate type-caption text-faint">
                      {p.city ?? '—'}
                    </span>
                  </span>
                </div>

                <div className="min-w-0">
                  <span className="block truncate type-body-sm text-ink">
                    {formatRoom(p.room)}
                  </span>
                  <span className="block truncate type-caption text-faint">
                    {p.anchorTitle ?? '—'}
                  </span>
                </div>

                <div>
                  <CompletionBar pct={p.completionPct} />
                  <span className="mt-1 block type-caption text-faint tabular-nums">
                    {p.piecesOwned} of {p.piecesTotal} pieces
                  </span>
                </div>

                <div className="min-w-0">
                  {p.nextBestTitle ? (
                    <>
                      <span className="block truncate type-body-sm text-ink">
                        {p.nextBestTitle}
                      </span>
                      <span className="block truncate type-caption text-muted-foreground tabular-nums">
                        {formatINR(p.nextBestPrice)}
                        {p.nextBestAttachRate !== null && (
                          <>
                            {' · '}
                            {Math.round(Number(p.nextBestAttachRate) * 100)}% follow the{' '}
                            {p.anchorTitle ? p.anchorTitle.split(' ').slice(-1)[0].toLowerCase() : 'anchor'}
                          </>
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="type-caption text-faint">Room complete — nothing to add</span>
                  )}
                </div>

                <div>
                  <WindowCell days={p.windowClosesInDays} />
                  <span className="mt-1 block type-caption text-faint tabular-nums">
                    {p.daysSinceLastPiece !== null ? `last piece ${p.daysSinceLastPiece}d ago` : '—'}
                  </span>
                </div>

                <div className="text-right">
                  <span className="block type-body-sm font-semibold text-ink tabular-nums">
                    {formatINR(p.roomValueRemaining)}
                  </span>
                  <span className="block type-caption text-faint">
                    {p.missingTitles.length} left
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <span className="type-caption text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Link
              href={buildHref({ room, state, page: page > 1 ? page - 1 : undefined })}
              aria-disabled={page <= 1}
              className={`${pillVariants({ variant: 'outline', size: 'sm' })} ${
                page <= 1 ? 'pointer-events-none opacity-40' : ''
              }`}
            >
              Previous
            </Link>
            <Link
              href={buildHref({ room, state, page: page + 1 })}
              aria-disabled={page >= totalPages}
              className={`${pillVariants({ variant: 'outline', size: 'sm' })} ${
                page >= totalPages ? 'pointer-events-none opacity-40' : ''
              }`}
            >
              Next
            </Link>
          </div>
        </div>
      )}

      {/* The evidence. Every recommendation above is sorted by these measured
          rates, so they are shown rather than left implicit. */}
      {attachRates.length > 0 && (
        <div className="mt-8">
          <h2 className="type-title">Why these suggestions.</h2>
          <p className="mt-1 mb-3 type-body-sm text-muted-foreground">
            Attach rate is measured from order items: of the customers who bought a room&rsquo;s
            anchor piece, the share who later bought this one. Nothing here is hand-weighted.
          </p>
          <div className="surface-card overflow-hidden">
            <div className="overflow-x-auto">
              <div className="min-w-[720px]">
                <div className="grid grid-cols-[minmax(200px,1.6fr)_140px_140px_140px] items-center gap-4 row-divider bg-canvas-soft px-5 py-3 type-caption text-muted-foreground">
                  <div>Piece</div>
                  <div>Room</div>
                  <div className="text-right">Attach rate</div>
                  <div className="text-right">On the table</div>
                </div>
                {attachRates.map((a) => (
                  <div
                    key={`${a.room}-${a.title}`}
                    className="grid grid-cols-[minmax(200px,1.6fr)_140px_140px_140px] items-center gap-4 row-divider px-5 py-3 last:border-b-0"
                  >
                    <div className="truncate type-body-sm text-ink">{a.title}</div>
                    <div className="type-caption text-muted-foreground">{formatRoom(a.room)}</div>
                    <div className="text-right type-body-sm tabular-nums text-ink">
                      {a.attachRatePct}%
                      <span className="ml-1 type-caption text-faint">
                        ({formatCount(a.customersMissingIt)} missing)
                      </span>
                    </div>
                    <div className="text-right type-body-sm font-semibold tabular-nums text-ink">
                      {formatINR(a.valueOnTheTable)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
