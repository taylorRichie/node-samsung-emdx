import { Settings, Power, BatteryMedium, BatteryCharging, Moon, Monitor } from "lucide-react"
import type { DisplayConfig, DisplayStatus } from "@/lib/types"

interface DisplayTileProps {
  display: DisplayConfig
  status: DisplayStatus | null
  lastImageUrl: string | null
  onSettingsClick: () => void
}

export function DisplayTile({ display, status, lastImageUrl, onSettingsClick }: DisplayTileProps) {
  const isOn = status?.power === "On"

  return (
    <div
      className="group relative rounded-lg border border-border bg-card overflow-hidden shadow-md hover:shadow-xl hover:border-primary/50 transition-all cursor-pointer"
      style={{ width: display.canvasWidth, height: display.canvasHeight }}
      onClick={onSettingsClick}
    >
      {lastImageUrl ? (
        <img
          src={lastImageUrl}
          alt={display.name}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/30">
          <Monitor className="h-10 w-10 text-muted-foreground/30" />
        </div>
      )}

      {/* Status overlay (top) */}
      <div className="absolute top-0 left-0 right-0 p-1.5 flex items-center gap-1.5 bg-gradient-to-b from-black/70 to-transparent">
        {status?.battery && (
          <span className="flex items-center gap-0.5 text-[10px] text-white/90">
            {status.battery.charging
              ? <BatteryCharging className="h-3 w-3 text-green-400" />
              : <BatteryMedium className="h-3 w-3" />
            }
            {status.battery.level}%
          </span>
        )}
        <span className={`flex items-center gap-0.5 text-[10px] ${isOn ? "text-green-400" : "text-white/50"}`}>
          <Power className="h-2.5 w-2.5" />
          {status?.power ?? "?"}
        </span>
        {status?.sleepTimer && (
          <span className="flex items-center gap-0.5 text-[10px] text-amber-300">
            <Moon className="h-2.5 w-2.5" />
            {Math.ceil(status.sleepTimer.remainingMs / 60000)}m
          </span>
        )}
      </div>

      {/* Name overlay (bottom) */}
      <div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/70 to-transparent">
        <p className="text-[11px] font-medium text-white truncate">{display.name}</p>
        {display.host && <p className="text-[9px] text-white/60 truncate">{display.host}</p>}
      </div>

      {/* Settings gear on hover */}
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
        <div className="rounded-full bg-background/90 p-2 shadow-lg">
          <Settings className="h-5 w-5 text-foreground" />
        </div>
      </div>
    </div>
  )
}
