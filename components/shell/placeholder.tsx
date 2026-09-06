export function SurfacePlaceholder({
  title,
  note,
}: {
  title: string;
  note: string;
}) {
  return (
    <div className="flex h-full flex-col items-start px-6 pb-12">
      <h1 className="type-heading-4">{title}.</h1>
      <p className="mt-1.5 max-w-md type-body-sm text-muted-foreground">{note}</p>
      {/* ex-empty-state-card — canvas-soft frame, generous padding. */}
      <div className="surface-soft mt-6 w-full max-w-2xl px-12 py-12 text-center type-body text-muted-foreground">
        Surface scaffolded — wired up in a later task.
      </div>
    </div>
  );
}
