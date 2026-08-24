import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { SidebarNav } from '../components/shell/sidebar-nav';

const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'Cadence',
  description: 'Cadence — the AI-native retention CRM for Rasaya.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} h-full`}>
      <body className="flex h-full min-w-[1024px] flex-col overflow-hidden bg-background text-[13px] text-foreground antialiased">
        {/* Top bar */}
        <header className="flex h-[46px] flex-none items-center gap-3.5 border-b border-black bg-ink px-3.5 text-paper">
          <div className="font-mono text-sm font-semibold tracking-[0.18em]">CADENCE</div>
          <div className="h-4.5 w-px bg-[#3a3833]" />
          <div className="flex items-center gap-1.5 text-xs text-[#c9c5bd]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-good" />
            <span className="font-medium text-paper">Rasaya</span>
            <span className="text-[#6f6b63]">·</span>
            <span>Shopify synced</span>
          </div>
          <div className="flex-1" />
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Sidebar */}
          <aside className="flex w-[196px] flex-none flex-col gap-3 border-r border-hairline bg-card px-2 py-2.5">
            <div className="px-2 pb-1 font-mono text-[10px] tracking-[0.12em] text-muted-foreground">
              WORKSPACE
            </div>
            <SidebarNav />
            <div className="flex-1" />
            <div className="rounded-md border border-hairline bg-secondary/40 p-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
              Models refreshed nightly. Scores carry their inputs — every
              number sits next to the reason it was computed.
            </div>
          </aside>

          {/* Main content */}
          <main className="min-w-0 flex-1 overflow-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
