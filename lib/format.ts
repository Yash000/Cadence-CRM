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

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "3d ago" / "just now" style relative label. Only ever fed an already-final
 * Date — never used to derive a value that gets stored or compared. */
export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.round(diffMonth / 12)}y ago`;
}

export function initials(firstName: string | null, lastName: string | null): string {
  const a = firstName?.trim()?.[0] ?? '';
  const b = lastName?.trim()?.[0] ?? '';
  return (a + b).toUpperCase() || '?';
}

export function fullName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}

const CONSENT_LABELS: Record<string, string> = {
  opted_in: 'Opted in',
  opted_out: 'Opted out',
  unknown: 'Unknown',
};

export function formatConsentStatus(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  return CONSENT_LABELS[status] ?? status;
}

export function consentStatusColor(status: string | null | undefined): string {
  if (status === 'opted_in') return 'text-good';
  if (status === 'opted_out') return 'text-bad';
  return 'text-muted-foreground';
}

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
  sms: 'SMS',
};

export function formatChannel(channel: string | null | undefined): string {
  if (!channel) return '—';
  return CHANNEL_LABELS[channel] ?? channel;
}

// Timeline event-type presentation. `events.type` values confirmed live:
// product_view, add_to_cart, checkout_started, checkout_abandoned, page_view.
const EVENT_TYPE_LABELS: Record<string, string> = {
  product_view: 'Viewed product',
  add_to_cart: 'Added to cart',
  checkout_started: 'Started checkout',
  checkout_abandoned: 'Abandoned checkout',
  page_view: 'Viewed page',
};

export function formatEventType(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? type;
}

const EVENT_TYPE_TAGS: Record<string, string> = {
  product_view: 'VIEW',
  add_to_cart: 'CART',
  checkout_started: 'CHK',
  checkout_abandoned: 'DROP',
  page_view: 'PAGE',
};

export function eventTypeTag(type: string): string {
  return EVENT_TYPE_TAGS[type] ?? type.slice(0, 4).toUpperCase();
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}
