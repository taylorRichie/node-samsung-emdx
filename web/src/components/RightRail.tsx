import { ListOrdered, Monitor, Settings } from "lucide-react"

export type RailPanel = "properties" | "queue"

interface RightRailProps {
  /** No display selected — icons render dimmed */
  disabled: boolean
  active: RailPanel | null
  onPick: (panel: RailPanel) => void
  onSettings: () => void
}

/** Vertical toolbar on the right edge, top-aligned with the display panel. */
export function RightRail({ disabled, active, onPick, onSettings }: RightRailProps) {
  const btn = (panel: RailPanel, title: string, icon: React.ReactNode) => (
    <button
      disabled={disabled}
      aria-label={title}
      aria-pressed={active === panel}
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
    <div className="surface fixed right-3 md:right-4 top-[72px] z-40 flex flex-col gap-1 p-1.5">
      {btn("properties", "Display", <Monitor className="h-4 w-4" />)}
      {btn("queue", "Queue", <ListOrdered className="h-4 w-4" />)}
      <button
        disabled={disabled}
        aria-label="Display settings"
        title={disabled ? "Select a display" : "Display settings"}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
          disabled ? "text-muted-foreground/30 cursor-default" : "text-muted-foreground hover:text-foreground hover:bg-accent"
        }`}
        onClick={onSettings}
      >
        <Settings className="h-4 w-4" />
      </button>
    </div>
  )
}

/** Shared slide-in shell for right-rail panels. Stays mounted for the transition. */
export function RailPanelShell({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className="surface fixed bottom-3 left-3 right-[60px] top-[72px] z-40 flex flex-col overflow-hidden md:left-auto md:right-[64px] md:w-[360px]"
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
