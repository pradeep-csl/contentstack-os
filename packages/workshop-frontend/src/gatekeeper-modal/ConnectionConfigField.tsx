import type { ReactNode } from 'react'

export interface ConnectionConfigFieldProps {
  label: string
  description?: string
  optional?: boolean
  children: ReactNode
}

export function ConnectionConfigField({
  label,
  description,
  optional,
  children,
}: ConnectionConfigFieldProps) {
  return (
    <section className="grid gap-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-ui-xs leading-4 font-medium text-kumo-default">{label}</p>
        {optional && <span className="text-ui-xs leading-4 font-normal text-kumo-subtle">Optional</span>}
      </div>
      {description && (
        <p className="-mt-1 mb-2 text-ui-xs leading-4 font-normal text-kumo-subtle">
          {description}
        </p>
      )}
      {children}
    </section>
  )
}
