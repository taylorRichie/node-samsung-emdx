import { Images, SlidersHorizontal } from "lucide-react"

export type RailPanel = "properties" | "queue"

interface RightRailProps {
  /** No display selected — icons render dimmed */
  disabled: boolean
  active: RailPanel | null
  onPick: (panel: RailPanel) => void
}

/** Vertical toolbar on the right edge, top-aligned with the display panel. */
export function RightRail({ disabled, active, onPick }: RightRailProps) {
  const btn = (panel: RailPanel, title: string, icon: React.ReactNode) => (
    <button
      disabled={disabled}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
        disabled
          ? "text-muted-foreground/30 cursor-default"
          : active === panel
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-accent"
      }`}
      title={disabled ? "Select a display" : title}
      onClick={() => onPick(panel)}
    >
      {icon}
    </button>
  )
  return (
    <div className="fixed right-3 md:right-4 top-[72px] z-40 flex flex-col gap-1 rounded-xl border border-border bg-background/70 backdrop-blur-md shadow-lg p-1.5">
      {btn("properties", "Properties", <SlidersHorizontal className="h-4 w-4" />)}
      {btn("queue", "Queue", <Images className="h-4 w-4" />)}
    </div>
  )
}

/** Shared slide-in shell for right-rail panels. Stays mounted for the transition. */
export function RailPanelShell({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className="fixed top-[72px] bottom-3 right-[64px] z-40 w-[360px] max-w-[calc(100vw-80px)] flex flex-col rounded-xl border border-border bg-background/85 backdrop-blur-md shadow-xl overflow-hidden"
      style={{
        transform: open ? "translateX(0)" : "translateX(calc(100% + 90px))",
        transition: "transform 260ms cubic-bezier(0.32, 0.72, 0, 1)",
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  )
}
