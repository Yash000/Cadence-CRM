import Link from 'next/link';
import { pillVariants } from '../../components/ui/pill';

export default function Customer360LandingPage() {
  return (
    <div className="flex h-full flex-col items-start px-6 pb-12">
      <h1 className="type-heading-4">Customer 360.</h1>
      <p className="mt-1.5 max-w-md type-body-sm text-muted-foreground">
        Pick a customer from the list to see their profile, scores with reasons, consent state,
        and unified timeline.
      </p>
      <Link href="/customers" className={`${pillVariants({ size: 'md' })} mt-6`}>
        Go to Customers →
      </Link>
    </div>
  );
}
