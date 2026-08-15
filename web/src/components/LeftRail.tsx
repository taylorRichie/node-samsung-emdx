import { Images, MonitorSmartphone } from "lucide-react"

export type LeftPanel = "displays" | "gallery"

interface LeftRailProps {
  displaysOpen: boolean
  galleryOpen: boolean
  onPick: (panel: LeftPanel) => void
}

/** Vertical toolbar on the left edge: display list + gallery library. */
export function LeftRail({ displaysOpen, galleryOpen, onPick }: LeftRailProps) {
  const btn = (panel: LeftPanel, active: boolean, title: string, icon: React.ReactNode) => (
    <button
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"
      }`}
      title={title}
      onClick={() => onPick(panel)}
    >
      {icon}
    </button>
  )
  return (
    <div className="fixed left-3 md:left-4 top-[72px] z-40 flex flex-col gap-1 rounded-xl border border-border bg-background/70 backdrop-blur-md shadow-lg p-1.5">
      {btn("displays", displaysOpen, displaysOpen ? "Hide displays" : "Show displays", <MonitorSmartphone className="h-4 w-4" />)}
      {btn("gallery", galleryOpen, galleryOpen ? "Hide gallery" : "Show gallery", <Images className="h-4 w-4" />)}
    </div>
  )
}

/** Shared slide-in shell for left-side panels. Stays mounted for the transition. */
export function LeftPanelShell({ open, width = 420, children }: { open: boolean; width?: number; children: React.ReactNode }) {
  return (
    <div
      className="fixed top-[72px] bottom-3 left-[60px] md:left-[64px] z-40 flex flex-col rounded-xl border border-border bg-background/85 backdrop-blur-md shadow-xl overflow-hidden"
      style={{
        width, maxWidth: "calc(100vw - 80px)",
        transform: open ? "translateX(0)" : "translateX(calc(-100% - 90px))",
        transition: "transform 260ms cubic-bezier(0.32, 0.72, 0, 1)",
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  )
}
