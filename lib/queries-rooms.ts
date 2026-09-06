// Server-only read queries for the Room Completion Board (the furniture
// cross-sell surface).
//
// Separate from lib/queries.ts, which is already long and is about scores and
// customers; this module is about one thing — which pieces of a room somebody
// is missing, and which one to suggest next.
//
// Everything here reads the v_room_completion VIEW (db/views-room.sql) rather
// than re-deriving attach rates in the app. There is one definition of "which
// piece follows the sofa, and how often", exactly as db/scoring.sql is the one
// definition of what a score means. If this module computed its own copy, the
// board and Ask Cadence would eventually disagree on screen about the same
// customer, and neither would be obviously wrong.
//
// The view is addressed through raw SQL rather than a Drizzle table object on
// purpose: db/schema.ts mirrors TABLES only, and declaring a pgTable for a view
// would imply Drizzle manages it.
import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '../db/index';
import { normalizePage, normalizePageSize } from './list-params';

/** The three room collections, in the order the board shows them. */
export const ROOM_ORDER = ['living-room', 'bedroom', 'dining'] as const;
export type Room = (typeof ROOM_ORDER)[number];

export type RoomState = 'open' | 'stalled' | 'complete' | 'all';
const ROOM_STATES: readonly RoomState[] = ['open', 'stalled', 'complete', 'all'];

export function isValidRoom(value: string): value is Room {
  return (ROOM_ORDER as readonly string[]).includes(value);
}

export function isValidRoomState(value: string): value is RoomState {
  return (ROOM_STATES as readonly string[]).includes(value);
}

export function formatRoom(room: string): string {
  return room
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface RoomProject {
  customerId: string;
  customerName: string;
  city: string | null;
  segment: string | null;
  room: string;
  piecesTotal: number;
  piecesOwned: number;
  completionPct: number;
  anchorTitle: string | null;
  daysSinceAnchor: number | null;
  daysSinceLastPiece: number | null;
  attachWindowDays: number | null;
  /** Negative once the attach window has passed — a stalled room, not an error. */
  windowClosesInDays: number | null;
  ownedTitles: string[];
  missingTitles: string[];
  nextBestTitle: string | null;
  nextBestPrice: string | null;
  /** 0–1, measured from order_items: share of anchor buyers who later bought this piece. */
  nextBestAttachRate: string | null;
  roomValueRemaining: string;
  consentWhatsapp: boolean;
}

// Money columns come back from pg as strings (numeric(12,2)) and stay strings
// all the way to the formatter — the same rule lib/queries.ts follows. No
// arithmetic on them happens in JavaScript anywhere in this file.
interface RoomRow {
  customer_id: string;
  customer_name: string;
  city: string | null;
  segment: string | null;
  room: string;
  pieces_total: number;
  pieces_owned: number;
  completion_pct: number;
  anchor_title: string | null;
  days_since_anchor: number | null;
  days_since_last_piece: number | null;
  attach_window_days: number | null;
  window_closes_in_days: number | null;
  owned_titles: string[] | null;
  missing_titles: string[] | null;
  next_best_title: string | null;
  next_best_price: string | null;
  next_best_attach_rate: string | null;
  room_value_remaining: string;
  consent_whatsapp: boolean;
}

const SELECT_COLUMNS = sql`
  r.customer_id, c.customer_name, c.city, c.segment::text as segment,
  r.room, r.pieces_total, r.pieces_owned, r.completion_pct,
  r.anchor_title, r.days_since_anchor, r.days_since_last_piece,
  r.attach_window_days, r.window_closes_in_days,
  r.owned_titles, r.missing_titles,
  r.next_best_title, r.next_best_price, r.next_best_attach_rate,
  r.room_value_remaining, c.consent_whatsapp
`;

function toProject(r: RoomRow): RoomProject {
  return {
    customerId: r.customer_id,
    customerName: r.customer_name,
    city: r.city,
    segment: r.segment,
    room: r.room,
    piecesTotal: r.pieces_total,
    piecesOwned: r.pieces_owned,
    completionPct: r.completion_pct,
    anchorTitle: r.anchor_title,
    daysSinceAnchor: r.days_since_anchor,
    daysSinceLastPiece: r.days_since_last_piece,
    attachWindowDays: r.attach_window_days,
    windowClosesInDays: r.window_closes_in_days,
    ownedTitles: r.owned_titles ?? [],
    missingTitles: r.missing_titles ?? [],
    nextBestTitle: r.next_best_title,
    nextBestPrice: r.next_best_price,
    nextBestAttachRate: r.next_best_attach_rate,
    roomValueRemaining: r.room_value_remaining,
    consentWhatsapp: r.consent_whatsapp,
  };
}

export interface RoomBoardParams {
  room?: Room;
  /** Defaults to 'open': a finished room has nothing left to sell. */
  state?: RoomState;
  page?: number;
  pageSize?: number;
}

export interface RoomBoardResult {
  rows: RoomProject[];
  total: number;
}

/**
 * The board. Ordered by what is most worth acting on: the value still missing
 * from the room first, then how far past its attach window it has drifted. A
 * ₹40,000 gap that closed last week outranks a ₹3,000 gap that closed a year
 * ago, which is the judgement an operator working a queue actually needs.
 */
export async function getRoomBoard(params: RoomBoardParams = {}): Promise<RoomBoardResult> {
  const { room, state = 'open' } = params;
  const page = normalizePage(params.page);
  const pageSize = normalizePageSize(params.pageSize, 25);
  const offset = (page - 1) * pageSize;

  // 'stalled' is "unfinished AND more than a month past the window" — the same
  // >30-day threshold the agent's few-shot example uses, so the board and Ask
  // Cadence answer "which rooms have stalled" with the same set of customers.
  const stateFilter =
    state === 'complete' ? sql`r.completion_pct >= 100`
    : state === 'stalled' ? sql`r.completion_pct < 100 and r.window_closes_in_days < -30`
    : state === 'all' ? sql`true`
    : sql`r.completion_pct < 100`;

  const roomFilter = room ? sql`and r.room = ${room}` : sql``;

  const [pageResult, countResult] = await Promise.all([
    db.execute(sql`
      select ${SELECT_COLUMNS}
      from v_room_completion r
      join v_customer_360 c on c.customer_id = r.customer_id
      where ${stateFilter} ${roomFilter}
      order by r.room_value_remaining desc, r.window_closes_in_days asc, r.customer_id
      limit ${pageSize} offset ${offset}
    `),
    db.execute(sql`
      select count(*)::int as n
      from v_room_completion r
      where ${stateFilter} ${roomFilter}
    `),
  ]);

  const rows = pageResult.rows as unknown as RoomRow[];
  const total = (countResult.rows[0] as unknown as { n: number } | undefined)?.n ?? 0;
  return { rows: rows.map(toProject), total };
}

export interface RoomSummaryRow {
  room: string;
  projects: number;
  open: number;
  complete: number;
  avgCompletionPct: number;
  valueRemaining: string;
}

/** Per-room headline numbers for the top of the board. */
export async function getRoomSummary(): Promise<RoomSummaryRow[]> {
  const result = await db.execute(sql`
    select room,
           count(*)::int                                     as projects,
           count(*) filter (where completion_pct < 100)::int  as open,
           count(*) filter (where completion_pct >= 100)::int as complete,
           coalesce(round(avg(completion_pct)), 0)::int       as avg_completion_pct,
           coalesce(sum(room_value_remaining), 0)::text       as value_remaining
    from v_room_completion
    group by room
  `);

  const rows = result.rows as unknown as {
    room: string;
    projects: number;
    open: number;
    complete: number;
    avg_completion_pct: number;
    value_remaining: string;
  }[];

  const order = new Map<string, number>(ROOM_ORDER.map((r, i) => [r as string, i]));
  return rows
    .map((r) => ({
      room: r.room,
      projects: r.projects,
      open: r.open,
      complete: r.complete,
      avgCompletionPct: r.avg_completion_pct,
      valueRemaining: r.value_remaining,
    }))
    .sort((a, b) => (order.get(a.room) ?? 99) - (order.get(b.room) ?? 99));
}

/**
 * Every room one customer has started — the Customer 360 panel.
 *
 * Complete rooms ARE included here, unlike the board's default view: on a
 * profile, "this room is finished" is context an operator wants before they
 * pitch anything, not noise to filter out.
 */
export async function getCustomerRooms(customerId: string): Promise<RoomProject[]> {
  const result = await db.execute(sql`
    select ${SELECT_COLUMNS}
    from v_room_completion r
    join v_customer_360 c on c.customer_id = r.customer_id
    where r.customer_id = ${customerId}
    order by r.completion_pct asc, r.room_value_remaining desc
  `);
  return (result.rows as unknown as RoomRow[]).map(toProject);
}

export interface AttachRateRow {
  room: string;
  title: string;
  customersMissingIt: number;
  attachRatePct: number;
  valueOnTheTable: string;
}

/**
 * The evidence behind the board, aggregated: for each piece, how many open
 * rooms are missing it and how often it actually follows that room's anchor.
 *
 * This is the answer to "why is it recommending that?" — and it is a measured
 * rate over order_items, never a hand-assigned weight.
 */
export async function getAttachRates(): Promise<AttachRateRow[]> {
  const result = await db.execute(sql`
    select room,
           next_best_title                                  as title,
           count(*)::int                                    as customers_missing_it,
           coalesce(round(avg(next_best_attach_rate) * 100), 0)::int as attach_rate_pct,
           coalesce(sum(next_best_price), 0)::text          as value_on_the_table
    from v_room_completion
    where next_best_title is not null and completion_pct < 100
    group by room, next_best_title
    order by sum(next_best_price) desc nulls last
  `);

  const rows = result.rows as unknown as {
    room: string;
    title: string;
    customers_missing_it: number;
    attach_rate_pct: number;
    value_on_the_table: string;
  }[];

  return rows.map((r) => ({
    room: r.room,
    title: r.title,
    customersMissingIt: r.customers_missing_it,
    attachRatePct: r.attach_rate_pct,
    valueOnTheTable: r.value_on_the_table,
  }));
}
