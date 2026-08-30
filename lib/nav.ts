// The five Cadence surfaces (Pulse CRM Interface Design/Pulse CRM.dc.html,
// renamed PULSE -> Cadence). Dashboard is the only surface wired to live
// Postgres data in this task; the rest are placeholders that still render
// through the real shell (header, sidebar, nav).
export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: '▦' },
  { href: '/customers', label: 'Customers', icon: '≡' },
  { href: '/customer-360', label: 'Customer 360', icon: '◎' },
  { href: '/ask', label: 'Ask Cadence', icon: '✦' },
  { href: '/inbox', label: 'Inbox', icon: '▭' },
  // Not one of the five mockup surfaces above — added in Task 9 as the
  // PRD-01 §7 fallback for storefront event tracking (see app/simulator).
  { href: '/simulator', label: 'Event Simulator', icon: '⚡' },
];
