import { cn } from "@/lib/utils"

/** A titled card of setting rows */
export function SettingGroup({ title, description, children, className }: {
  title?: string; description?: string; children: React.ReactNode; className?: string
}) {
  return (
    <section className={cn("space-y-2", className)}>
      {(title || description) && (
        <div className="px-1">
          {title && <h3 className="text-sm font-semibold">{title}</h3>}
          {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
      )}
      <div className="divide-y divide-border rounded-xl border border-border bg-background/40">{children}</div>
    </section>
  )
}

/** Label and hint on the left, control on the right */
export function SettingRow({ label, hint, children, stacked }: {
  label: string; hint?: React.ReactNode; children?: React.ReactNode
  /** Put the control under the label, for wide controls */
  stacked?: boolean
}) {
  return (
    <div className={cn("gap-x-6 gap-y-2 px-3.5 py-2.5", stacked ? "space-y-2" : "flex min-h-[48px] items-center justify-between")}>
      <div className="min-w-0">
        <p className="text-[13px] leading-snug">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      {children && <div className={cn(!stacked && "shrink-0")}>{children}</div>}
    </div>
  )
}
