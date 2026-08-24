'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from '../../lib/nav';
import { cn } from '../../lib/utils';

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const active =
          item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] transition-colors',
              active
                ? 'bg-ink text-paper font-medium'
                : 'text-ink-soft hover:bg-secondary hover:text-foreground',
            )}
          >
            <span className="w-4 font-mono text-[10px]">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
