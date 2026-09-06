import type { Metadata } from 'next';
import Link from 'next/link';
import { Inter } from 'next/font/google';
import './globals.css';
import { SidebarNav } from '../components/shell/sidebar-nav';
import { pillVariants } from '../components/ui/pill';

// DESIGN.md §Typography → Note on Font Substitutes: Saans is commercial, and
// Inter is the substitute it names — its variable axis carries the signature
// 652 / 456 / 300 weight positions directly. Loaded without a `weight` array
// so the full axis is available rather than a few static cuts.
const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Cadence',
  description: 'Cadence — the AI-native retention CRM for HomeStyle Furniture.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
      <body className="flex h-full min-w-[1024px] flex-col overflow-hidden bg-canvas text-ink antialiased">
        {/* nav-pill — a floating stadium bar detached from the viewport edge,
            with visible canvas wrapping around it, rather than a full-width
            bar clamped to the top. */}
        <header className="flex-none px-5 pt-5 pb-4">
          <div className="flex h-14 items-center gap-3 rounded-full bg-canvas-soft pr-2 pl-5">
            <div className="flex items-center gap-2.5">
              <span className="squircle flex size-7 items-center justify-center bg-ink type-label text-paper">
                C
              </span>
              <span className="type-link">Cadence</span>
            </div>
            <span className="h-5 w-px bg-hairline" />
            <div className="flex items-center gap-2 type-body-sm text-muted-foreground">
              <span className="inline-block size-1.5 rounded-full bg-good" />
              <span className="font-medium text-ink">HomeStyle</span>
              <span className="text-faint">·</span>
              <span>Shopify synced</span>
            </div>
            <div className="flex-1" />
            <Link href="/ask" className={pillVariants({ variant: 'primary', size: 'md' })}>
              Ask Cadence
            </Link>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Sidebar — whitespace and a single hairline do the grouping. */}
          <aside className="flex w-[216px] flex-none flex-col gap-4 border-r border-hairline-soft px-4 pb-5">
            <div className="px-3 type-caption text-faint">Workspace</div>
            <SidebarNav />
            <div className="flex-1" />
            <div className="surface-soft p-4 type-caption text-muted-foreground">
              Models refreshed nightly. Scores carry their inputs — every number
              sits next to the reason it was computed.
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
