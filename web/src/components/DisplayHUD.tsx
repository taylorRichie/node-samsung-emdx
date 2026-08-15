import {
  BoxSelect, Lock, LockOpen, Move, RectangleHorizontal, RectangleVertical, Scaling, Settings,
} from "lucide-react"

export type HudMode = "move" | "scale" | "free"
export type FtSub = "constrained" | "free"

interface DisplayHUDProps {
  /** Anchor point in canvas coordinates (center-x, top-y of the tile/quad) */
  x: number
  y: number
  zoom: number
  onScene: boolean
  orientation: "portrait" | "landscape"
  onOrientation: (o: "portrait" | "landscape") => void
  mode: HudMode
  onMode: (m: HudMode) => void
  /** Free-transform sub-mode: constrained keeps verticals vertical */
  ftSub: FtSub
  onFtSub: (s: FtSub) => void
  onSettings: () => void
}

function HudButton({ active, accent, disabled, title, onClick, children }: {
  active?: boolean
  accent?: boolean
  disabled?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      disabled={disabled}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        disabled
          ? "text-muted-foreground/30 cursor-default"
          : active
            ? accent
              ? "bg-amber-500/20 text-amber-400"
              : "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-accent"
      }`}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

const Sep = () => <div className="w-px h-4 bg-border mx-0.5" />

/**
 * Floating context bar above a selected display. Rendered inside the canvas
 * plane but counter-scaled so it stays a constant screen size. When Free
 * Transform is active, a second bar with its sub-modes appears above.
 */
export function DisplayHUD({
  x, y, zoom, onScene, orientation, onOrientation, mode, onMode, ftSub, onFtSub, onSettings,
}: DisplayHUDProps) {
  return (
    <div
      className="absolute z-[60] flex flex-col items-center gap-1.5"
      style={{
        left: x,
        top: y,
        transform: `translate(-50%, -100%) scale(${1 / zoom}) translateY(-12px)`,
        transformOrigin: "50% 100%",
      }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      {/* Free Transform sub-modes */}
      {mode === "free" && (
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/90 backdrop-blur-md shadow-xl px-1 py-1">
          <HudButton
            active={ftSub === "constrained"}
            title="Constrained — verticals stay vertical"
            onClick={() => onFtSub("constrained")}
          >
            <Lock className="h-4 w-4" />
          </HudButton>
          <HudButton
            active={ftSub === "free"}
            accent
            title="Free — verticals may be angled"
            onClick={() => onFtSub("free")}
          >
            <LockOpen className="h-4 w-4" />
          </HudButton>
        </div>
      )}

      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/90 backdrop-blur-md shadow-xl px-1 py-1">
        <HudButton
          active={orientation === "portrait"}
          title="Portrait frame"
          onClick={() => onOrientation("portrait")}
        >
          <RectangleVertical className="h-4 w-4" />
        </HudButton>
        <HudButton
          active={orientation === "landscape"}
          title="Landscape frame"
          onClick={() => onOrientation("landscape")}
        >
          <RectangleHorizontal className="h-4 w-4" />
        </HudButton>
        <Sep />
        <HudButton active={mode === "move"} title="Move (drag or arrow keys)" onClick={() => onMode("move")}>
          <Move className="h-4 w-4" />
        </HudButton>
        <HudButton
          active={mode === "scale"}
          title="Scale (drag a corner, or ↑/↓)"
          onClick={() => onMode("scale")}
        >
          <Scaling className="h-4 w-4" />
        </HudButton>
        <HudButton
          active={mode === "free"}
          disabled={!onScene}
          title={onScene ? "Free Transform (select nodes, nudge)" : "Free Transform (environment only)"}
          onClick={() => onScene && onMode("free")}
        >
          <BoxSelect className="h-4 w-4" />
        </HudButton>
        <Sep />
        <HudButton title="Display settings" onClick={onSettings}>
          <Settings className="h-4 w-4" />
        </HudButton>
      </div>
    </div>
  )
}
