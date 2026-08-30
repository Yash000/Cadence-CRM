import { getRecentEvents } from '../../lib/events-db';
import { getSimulatorCustomerSample } from '../../lib/queries';
import { SimulatorForm } from '../../components/simulator/simulator-form';

export const dynamic = 'force-dynamic';

export default async function SimulatorPage() {
  const [recentEvents, customers] = await Promise.all([
    getRecentEvents(20),
    getSimulatorCustomerSample(15),
  ]);

  return (
    <div className="px-4.5 py-3.5 pb-7">
      <div className="mb-1 flex items-center gap-2">
        <div className="text-[19px] font-semibold tracking-tight">Event Simulator</div>
        <span className="rounded border border-[#e8c98a] bg-[#fdf6e6] px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.06em] text-[#8a6a1f]">
          SIMULATOR
        </span>
      </div>
      <p className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
        Not live storefront traffic. This posts the exact same JSON shape the
        Dawn theme&apos;s tracking snippet posts (
        <code className="font-mono text-[11px]">rasaya-theme/snippets/cadence-tracking.liquid</code>
        ) to the same <code className="font-mono text-[11px]">/api/events</code> endpoint —
        page_view, product_view, add_to_cart, checkout_started — so the
        endpoint and the customer-360 timeline can be exercised without a
        public URL for the theme to reach. PRD-01 §7&apos;s documented fallback
        for exactly that gap.
      </p>

      <SimulatorForm customers={customers} initialEvents={recentEvents} />
    </div>
  );
}
