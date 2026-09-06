'use client';

// PRD-02 §F3.7 "recompute now", sitting in the Scores card header on
// /customer-360/[id]. The demo (§11) turns on this: an order arrives, this is
// pressed, the segment and churn score change without a page reload.
//
// router.refresh() re-runs the server component with fresh data — the scores
// are read server-side, so nothing here needs to know the new values.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pill } from '../ui/pill';

export function RescoreButton({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Busy until BOTH the write and the refetch have finished, otherwise the
  // button goes idle while the page still shows the old score.
  const busy = posting || pending;

  async function run() {
    setPosting(true);
    setError(null);
    try {
      const res = await fetch(`/api/customers/${customerId}/recompute`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? `Failed (${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError('Network error');
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="type-caption text-bad">{error}</span>}
      <Pill variant="outline" size="sm" onClick={run} disabled={busy}>
        {busy ? 'Rescoring…' : 'Rescore'}
      </Pill>
    </div>
  );
}
