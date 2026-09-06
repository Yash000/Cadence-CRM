import { getRecentEvents } from '../../lib/events-db';
import { getSimulatorCustomerSample } from '../../lib/queries';
import { SimulatorForm } from '../../components/simulator/simulator-form';
import { Tag } from '../../components/ui/pill';

export const dynamic = 'force-dynamic';

export default async function SimulatorPage() {
  const [recentEvents, customers] = await Promise.all([
    getRecentEvents(20),
    getSimulatorCustomerSample(15),
  ]);

  return (
    <div className="px-6 pb-12">
      <div className="mb-1.5 flex items-center gap-3">
        <h1 className="type-heading-4">Event Simulator.</h1>
        <Tag className="text-warn">Simulator</Tag>
      </div>
      <p className="max-w-2xl type-body-sm text-muted-foreground">
        Not live storefront traffic. This posts the exact same JSON shape the
        Dawn theme&apos;s tracking snippet posts (
        <code className="text-ink">homestyle-theme/snippets/cadence-tracking.liquid</code>
        ) to the same <code className="text-ink">/api/events</code> endpoint —
        page_view, product_view, add_to_cart, checkout_started — so the
        endpoint and the customer-360 timeline can be exercised without a
        public URL for the theme to reach. PRD-01 §7&apos;s documented fallback
        for exactly that gap.
      </p>

      <SimulatorForm customers={customers} initialEvents={recentEvents} />
    </div>
  );
}
