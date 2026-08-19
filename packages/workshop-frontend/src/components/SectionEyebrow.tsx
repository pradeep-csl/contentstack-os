export function SectionEyebrow({ label, count }: { label: string; count?: number }) {
  return (
    <div className="mb-3.5 flex items-center gap-3 px-1">
      <h2 className="m-0 text-ui-2xs leading-4 font-semibold uppercase tracking-[0.9px] text-kumo-subtle">
        {label}
      </h2>
      <div className="h-px flex-1 bg-kumo-line" />
      {typeof count === 'number' && (
        <span className="text-ui-2xs leading-4 font-semibold text-kumo-subtle">
          {count}
        </span>
      )}
    </div>
  )
}
