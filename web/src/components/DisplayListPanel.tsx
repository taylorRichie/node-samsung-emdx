import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Loader2, Locate, Monitor, Moon, Plus, Power, Sun, Wifi, WifiOff, Zap,
} from "lucide-react"
import type { DisplayConfig, DisplayStatus } from "@/lib/types"

interface DisplayListPanelProps {
  displays: DisplayConfig[]
  statuses: Record<string, DisplayStatus | null>
  lastImageTimestamps: Record<string, number>
  /** Display currently selected on the canvas (drives the Properties panel) */
  selectedId: string | null
  onGoto: (displayId: string) => void
  onSettings: (displayId: string) => void
  onAdd: () => void
  /** Reorder rows; commit=false while dragging, true on drop (persists) */
  onReorder: (ids: string[], commit: boolean) => void
}

function Thumb({ display, ts }: { display: DisplayConfig; ts: number }) {
  const [err, setErr] = useState(false)
  // A failed load isn't forever — a new push (fresh ts) retries the image
  useEffect(() => { setErr(false) }, [ts])
  const url = display.host ? `/api/displays/${display.id}/last-image?t=${ts}` : null
  return (
    <div className="h-9 w-9 shrink-0 rounded-md border border-border bg-muted/40 overflow-hidden flex items-center justify-center">
      {url && !err ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
          onError={() => setErr(true)}
        />
      ) : (
        <Monitor className="h-4 w-4 text-muted-foreground/50" />
      )}
    </div>
  )
}

/** Micro status icons gleaned from the last status probe. */
function StatusRow({ status }: { status: DisplayStatus | null }) {
  const chip = "flex items-center gap-0.5"
  if (!status) {
    return (
      <span className={`${chip} text-muted-foreground/60`} title="Unreachable — likely sleeping">
        <Moon className="h-2.5 w-2.5" /> Sleeping
      </span>
    )
  }
  const b = status.battery
  const BatteryIcon = b?.charging ? BatteryCharging : (b?.level ?? 0) > 66 ? BatteryFull : (b?.level ?? 0) > 25 ? BatteryMedium : BatteryLow
  return (
    <>
      {/* Reachable = awake: e-paper reads power "Off" between refreshes even
          though the display responds and accepts pushes */}
      <span className={`${chip} text-green-500`} title={`Reachable — accepts pushes (panel power: ${status.power ?? "unknown"})`}>
        <Power className="h-2.5 w-2.5" /> Awake
      </span>
      {/* Battery ahead of the standby chip so the percentage never truncates */}
      {b?.present && (
        <span className={`${chip} ${b.charging ? "text-green-400" : b.level <= 20 ? "text-red-400" : "text-muted-foreground/60"}`}
          title={b.charging ? `Battery ${b.level}% — charging` : `Battery ${b.level}%`}>
          <BatteryIcon className="h-2.5 w-2.5" /> {b.level}%{b.charging && <Zap className="h-2.5 w-2.5 fill-current -ml-0.5" />}
        </span>
      )}
      {status.networkStandby != null && (
        <span
          className={`${chip} ${status.networkStandby ? "text-sky-400" : "text-muted-foreground/60"}`}
          title={status.networkStandby ? "Light sleep — WiFi standby on, remotely wakeable" : "Deep sleep — radio off, timer or power button only"}
        >
          {status.networkStandby ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
          {status.networkStandby ? "Light" : "Deep"}
        </span>
      )}
      {status.sleepTimer && (
        <span className={`${chip} text-amber-500`} title={`Sleeps in ${Math.ceil(status.sleepTimer.remainingMs / 60000)} minutes`}>
          <Moon className="h-2.5 w-2.5" /> {Math.ceil(status.sleepTimer.remainingMs / 60000)}m
        </span>
      )}
    </>
  )
}

/** Floating panel on the left listing every display with quick goto/wake. */
export function DisplayListPanel({ displays, statuses, lastImageTimestamps, selectedId, onGoto, onSettings, onAdd, onReorder }: DisplayListPanelProps) {
  const [wakingId, setWakingId] = useState<string | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const iconBtn = "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    if (dragIdx === null || dragIdx === idx) return
    const ids = displays.map(d => d.id)
    const [moved] = ids.splice(dragIdx, 1)
    ids.splice(idx, 0, moved)
    onReorder(ids, false)
    setDragIdx(idx)
  }
  const handleDragEnd = () => {
    if (dragIdx === null) return
    setDragIdx(null)
    onReorder(displays.map(d => d.id), true)
  }

  const handleWake = async (d: DisplayConfig) => {
    setWakingId(d.id)
    try {
      const res = await fetch(`/api/displays/${d.id}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      const data = await res.json().catch(() => ({})) as { method?: string; error?: string }
      if (!res.ok) throw new Error(data.error || "Wake failed")
      toast.success(data.method === "mdc" ? `${d.name}: woken via MDC` : `${d.name}: Wake-on-LAN sent`)
    } catch (err) {
      toast.error(`Wake failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setWakingId(null) }
  }
  return (
    <div
      className="absolute left-3 md:left-4 top-[72px] z-[70] w-80 rounded-xl border border-border bg-background/70 backdrop-blur-md shadow-lg p-1.5"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <div className="flex flex-col gap-0.5">
        {displays.map((d, i) => (
          <div
            key={d.id}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={e => handleDragOver(e, i)}
            onDragEnd={handleDragEnd}
            className={`group flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors cursor-pointer ${
              d.id === selectedId ? "bg-accent ring-1 ring-primary/50" : "hover:bg-accent/50"
            } ${dragIdx === i ? "opacity-60" : ""}`}
            onClick={() => onSettings(d.id)}
          >
            <Thumb display={d} ts={lastImageTimestamps[d.id] || 0} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm leading-tight">{d.name}</p>
              <div className="flex items-center gap-1 text-[10px] leading-tight mt-0.5 whitespace-nowrap overflow-hidden">
                <StatusRow status={statuses[d.id] ?? null} />
              </div>
            </div>
            <button
              className={`${iconBtn} opacity-0 group-hover:opacity-100`}
              title="Go to display on canvas"
              onClick={e => { e.stopPropagation(); onGoto(d.id) }}
            >
              <Locate className="h-4 w-4" />
            </button>
            <button
              className={`${iconBtn} opacity-0 group-hover:opacity-100`}
              title="Wake display"
              disabled={wakingId === d.id}
              onClick={e => { e.stopPropagation(); handleWake(d) }}
            >
              {wakingId === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sun className="h-4 w-4" />}
            </button>
          </div>
        ))}
        <button
          className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          onClick={onAdd}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-dashed border-border">
            <Plus className="h-4 w-4" />
          </span>
          Add display
        </button>
      </div>
    </div>
  )
}
