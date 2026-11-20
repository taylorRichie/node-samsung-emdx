import { cn } from "@/lib/utils"

export interface SegmentOption<T extends string> {
  value: T
  label: React.ReactNode
  title?: string
}

interface SegmentedProps<T extends string> {
  label: string
  value: T | null
  options: SegmentOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  /** Share the width equally instead of sizing to the labels */
  stretch?: boolean
  className?: string
}

/** One choice out of a few, all visible at once */
export function Segmented<T extends string>({ label, value, options, onChange, disabled, stretch, className }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex gap-0.5 rounded-lg bg-secondary/70 p-0.5", stretch && "flex w-full", className)}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          disabled={disabled}
          aria-pressed={value === o.value}
          className={cn(
            "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50",
            stretch && "flex-1",
            value === o.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => { if (o.value !== value) onChange(o.value) }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
