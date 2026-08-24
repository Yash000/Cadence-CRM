export function SurfacePlaceholder({
  title,
  note,
}: {
  title: string;
  note: string;
}) {
  return (
    <div className="flex h-full flex-col items-start justify-start px-4.5 py-4">
      <div className="text-[19px] font-semibold tracking-tight">{title}</div>
      <div className="mt-1 max-w-md text-[12px] leading-relaxed text-muted-foreground">{note}</div>
      <div className="mt-4 rounded-md border border-dashed border-hairline bg-card px-4 py-6 font-mono text-[11px] text-muted-foreground">
        Surface scaffolded — wired up in a later task.
      </div>
    </div>
  );
}
