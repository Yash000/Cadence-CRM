import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

// DESIGN.md §Components → Buttons, and §Do "use rounded.full for every
// interactive element — a rectangular button does not exist in this system".
//
// Exported as a variants function rather than only as a component because
// most of the interactive elements on these surfaces are Next `<Link>`s
// (filter chips, sort options, pagination), which need the class string
// rather than a wrapper.
export const pillVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        /** button-primary — ink fill, light label. The single CTA style. */
        primary: 'bg-ink text-paper hover:bg-ink-soft',
        /** button-outline — the de-emphasized twin of the primary pill. */
        outline: 'bg-canvas text-ink border border-hairline hover:bg-canvas-soft',
        /** button-pill-soft — tertiary utility pill; tint fill, no border. */
        soft: 'bg-canvas-soft text-ink hover:bg-field',
        /** Resting filter chip. Its selected state is the `primary` fill. */
        chip: 'bg-canvas-soft text-ink-soft hover:bg-field',
      },
      size: {
        /** Inline tags inside dense table rows. */
        xs: 'h-[22px] px-2.5 type-caption',
        sm: 'h-7 px-3 type-caption font-medium',
        md: 'h-9 px-4 text-[13px] font-semibold',
        /** Comfortably above the 44px touch minimum. */
        lg: 'h-11 px-5 type-link',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type PillVariants = VariantProps<typeof pillVariants>;

export function Pill({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<'button'> & PillVariants) {
  return (
    <button
      type="button"
      className={cn(pillVariants({ variant, size }), className)}
      {...props}
    />
  );
}

/**
 * Non-interactive stadium chip — segment names, event-type tags, metadata
 * markers. `badge-overlay` geometry without the photographic scrim.
 */
export function Tag({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center rounded-full bg-canvas-soft px-2.5 type-caption text-ink-soft',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * badge-popular — the one place `{colors.accent}` is allowed on a surface.
 * DESIGN.md reserves electric blue for commercial signals and caps it at one
 * or two elements per page, so this is deliberately not a general-purpose
 * badge: it marks the single item asking for a decision.
 */
export function AccentBadge({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center rounded-full bg-brand-accent px-2.5 type-label text-white',
        className,
      )}
    >
      {children}
    </span>
  );
}
