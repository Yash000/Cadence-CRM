import Link from 'next/link';

export default function Customer360LandingPage() {
  return (
    <div className="flex h-full flex-col items-start justify-start px-4.5 py-4">
      <div className="text-[19px] font-semibold tracking-tight">Customer 360</div>
      <div className="mt-1 max-w-md text-[12px] leading-relaxed text-muted-foreground">
        Pick a customer from the list to see their profile, scores with reasons, consent
        state, and unified timeline.
      </div>
      <Link
        href="/customers"
        className="mt-4 rounded-md border border-ink bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:opacity-90"
      >
        Go to Customers →
      </Link>
    </div>
  );
}
