import { useState, useEffect } from "react"
import { Power, BatteryMedium, BatteryCharging, Hourglass, Monitor, Wifi, WifiOff, Moon, TriangleAlert } from "lucide-react"
import type { Delivery, DisplayConfig, DisplayStatus } from "@/lib/types"

export const BEZEL = 10 // px white frame, simulating the physical device

interface DisplayTileProps {
  display: DisplayConfig
  status: DisplayStatus | null
  lastImageUrl: string | null
  selected: boolean
  /** True when rendered inside a perspective quad on a scene */
  perspective?: boolean
  /** Footprint size (already rotation-swapped by the parent) */
  width: number
  height: number
  /** An image waiting to reach it */
  delivery?: Delivery | null
}

function idToColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
  const h = ((hash % 360) + 360) % 360
  return `hsl(${h} 12% 16%)`
}

/** Footprint (w,h) of a display tile given its rotation */
export function footprint(display: DisplayConfig): { w: number; h: number } {
  const rot = ((display.rotation ?? 0) % 360 + 360) % 360
  return rot % 180 === 0
    ? { w: display.canvasWidth, h: display.canvasHeight }
    : { w: display.canvasHeight, h: display.canvasWidth }
}

export function DisplayTile({ display, status, lastImageUrl, selected, perspective = false, width, height, delivery }: DisplayTileProps) {
  const awake = status != null
  const [imgError, setImgError] = useState(false)
  useEffect(() => setImgError(false), [lastImageUrl])
  const showImage = lastImageUrl && !imgError

  const screenW = width - BEZEL * 2
  const screenH = height - BEZEL * 2

  const showChrome = selected && !perspective

  return (
    <div className="relative" style={{ width, height }}>
      {/* Header — power, connection, battery */}
      {showChrome && (
        <div className="absolute -top-7 left-0 right-0 flex items-center justify-center gap-3 h-6 rounded-lg border border-border bg-card/90 backdrop-blur-md shadow-md px-2">
          {/* Reachable = awake: e-paper reports power "Off" between refreshes */}
          <span className={`flex items-center gap-1 text-[10px] ${awake ? "text-emerald-400" : "text-muted-foreground/60"}`}>
            <Power className="h-3 w-3" />{awake ? "Awake" : "Asleep"}
          </span>
          {status?.networkStandby != null && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {status.networkStandby ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {status.networkStandby ? "Standby" : "Deep"}
            </span>
          )}
          {status?.battery && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {status.battery.charging
                ? <BatteryCharging className="h-3 w-3 text-emerald-400" />
                : <BatteryMedium className="h-3 w-3" />}
              {status.battery.level}%
            </span>
          )}
          {status?.sleepTimer && (
            <span className="flex items-center gap-1 text-[10px] text-amber-500">
              <Moon className="h-3 w-3" />{Math.ceil(status.sleepTimer.remainingMs / 60000)}m
            </span>
          )}
        </div>
      )}

      {/* Device: white bezel frame around the screen */}
      <div
        className="absolute inset-0 rounded-[3px] bg-[#e8e5dd] transition-shadow"
        style={{
          padding: BEZEL,
          boxShadow: selected
            ? "0 0 0 2px hsl(var(--primary)), 0 8px 24px rgba(0,0,0,0.35)"
            : "0 2px 10px rgba(0,0,0,0.3)",
        }}
      >
        <div className="relative w-full h-full overflow-hidden bg-black" style={{ width: screenW, height: screenH }}>
          {showImage ? (
            <img
              src={lastImageUrl}
              alt={display.name}
              draggable={false}
              // The image keeps its default orientation regardless of frame
              // orientation — internal rotation is governed by settings.
              className="absolute inset-0 w-full h-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-1"
              style={{ backgroundColor: idToColor(display.id) }}
            >
              <Monitor className="h-8 w-8 text-white/20" />
              <span className="text-[9px] text-white/30">no image</span>
            </div>
          )}
          {/* An image on its way: waiting for the display, or stopped */}
          {delivery && (
            <div
              className={`absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium shadow ${
                delivery.state === "failed" ? "bg-destructive text-destructive-foreground" : "bg-amber-400 text-black"
              }`}
              title={delivery.error ?? "Waiting to send"}
            >
              {delivery.state === "failed" ? <TriangleAlert className="h-2.5 w-2.5" /> : <Hourglass className="h-2.5 w-2.5" />}
              {delivery.state === "failed" ? "Not sent" : delivery.state === "sending" ? "Sending" : "Waiting"}
            </div>
          )}
        </div>
      </div>

      {/* Footer — name + IP */}
      {showChrome && (
        <div className="absolute -bottom-7 left-0 right-0 flex items-center justify-center gap-2 h-6 rounded-lg border border-border bg-card/90 backdrop-blur-md shadow-md px-2">
          <span className="text-[10px] font-medium truncate">{display.name}</span>
          {display.host && <span className="text-[9px] text-muted-foreground truncate">{display.host}</span>}
        </div>
      )}
    </div>
  )
}
