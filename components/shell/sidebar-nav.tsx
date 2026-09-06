'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Inbox,
  LayoutGrid,
  Sparkles,
  UserRound,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { NAV_ITEMS } from '../../lib/nav';
import { cn } from '../../lib/utils';

// The glyph characters on NavItem.icon (▦ ≡ ◎ …) belonged to the previous
// monospace voice. DESIGN.md runs one family at natural tracking with no
// terminal affectations, so the rows carry line icons instead; the mapping
// lives here rather than in lib/nav.ts to keep that module free of React.
const ICONS: Record<string, LucideIcon> = {
  '/': LayoutGrid,
  '/customers': Users,
  '/customer-360': UserRound,
  '/ask': Sparkles,
  '/inbox': Inbox,
  '/simulator': Zap,
};

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const active =
          item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        const Icon = ICONS[item.href];
        return (
          <Link
            key={item.href}
            href={item.href}
            // ex-app-shell-row — rounded.sm, spacing.xs/spacing.md padding,
            // brand primary as the active indicator.
            className={cn(
              'flex items-center gap-2.5 rounded-sm px-4 py-2.5 type-body-sm transition-colors',
              active
                ? 'bg-ink font-semibold text-paper'
                : 'text-ink-soft hover:bg-canvas-soft',
            )}
          >
            {Icon && <Icon className="size-4 shrink-0" strokeWidth={active ? 2.25 : 1.75} />}
            <span className="flex-1">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
