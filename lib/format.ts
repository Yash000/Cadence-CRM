// Display-only formatters. Money columns are numeric(12,2) and Drizzle
// returns them as strings — these helpers turn ONE already-final string into
// a display string; they never combine two numeric values in JavaScript.

export function formatINR(value: string | number | null | undefined): string {
  if (value == null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function formatCount(value: number | null | undefined): string {
  if (value == null) return '—';
  return value.toLocaleString('en-IN');
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

const SEGMENT_LABELS: Record<string, string> = {
  champions: 'Champions',
  loyal: 'Loyal',
  potential_loyalist: 'Potential loyalist',
  new_customer: 'New customer',
  promising: 'Promising',
  need_attention: 'Need attention',
  about_to_sleep: 'About to sleep',
  at_risk: 'At risk',
  cant_lose_them: "Can't lose them",
  hibernating: 'Hibernating',
  lost: 'Lost',
};

export function formatSegment(segment: string | null | undefined): string {
  if (!segment) return 'Unscored';
  return SEGMENT_LABELS[segment] ?? segment;
}

export function churnRiskColor(risk: number | null | undefined): string {
  if (risk == null) return 'text-muted-foreground';
  if (risk >= 76) return 'text-bad';
  if (risk >= 51) return 'text-warn';
  if (risk >= 26) return 'text-ink-soft';
  return 'text-good';
}
