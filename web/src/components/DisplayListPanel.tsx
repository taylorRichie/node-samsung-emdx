import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Columns3, Hourglass, Loader2, Locate, Monitor, Moon, Plus, Power, Sun, Trash2,
  TriangleAlert, Wifi, WifiOff, Zap,
} from "lucide-react"
import type { Delivery, DisplayConfig, DisplayGroup, DisplayStatus } from "@/lib/types"

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
  groups: DisplayGroup[]
  deliveries: Record<string, Delivery | null>
  /** The group whose displays are exactly the canvas selection */
  activeGroupId: string | null
  onSelectGroup: (groupId: string) => void
  onDeleteGroup: (groupId: string) => void
}

function Thumb({ display, ts }: { display: DisplayConfig; ts: number }) {
  const [err, setErr] = useState(false)
  // A failed load isn't forever — a new push (fresh ts) retries the image
  useEffect(() => { setErr(false) }, [ts])
  const url = display.host ? `api/displays/${display.id}/last-image?t=${ts}` : null
  return (
    <div className="h-10 w-10 shrink-0 rounded-md border border-border bg-muted/40 overflow-hidden flex items-center justify-center">
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

/** The group's spanned image, or its icon before it has one. Keyed by the
 *  span's time, so a new span retries an image that failed to load. */
function GroupThumb({ group }: { group: DisplayGroup }) {
  const [err, setErr] = useState(false)
  const ts = group.span ? Date.parse(group.span.updatedAt) || 0 : 0
  return (
    <div className="h-10 w-10 shrink-0 rounded-md border border-border bg-muted/40 overflow-hidden flex items-center justify-center">
      {group.span && !err ? (
        <img src={`api/groups/${group.id}/source?t=${ts}`} alt="" draggable={false} className="h-full w-full object-cover" onError={() => setErr(true)} />
      ) : (
        <Columns3 className="h-4 w-4 text-muted-foreground/50" />
      )}
    </div>
  )
}

/** Micro status icons gleaned from the last status probe. */
function StatusRow({ status }: { status: DisplayStatus | null }) {
  const chip = "flex items-center gap-1"
  if (!status) {
    return (
      <span className={`${chip} text-muted-foreground/60`} title="Unreachable — likely sleeping">
        <Moon className="h-3 w-3" /> Sleeping
      </span>
    )
  }
  const b = status.battery
  const BatteryIcon = b?.charging ? BatteryCharging : (b?.level ?? 0) > 66 ? BatteryFull : (b?.level ?? 0) > 25 ? BatteryMedium : BatteryLow
  return (
    <>
      {/* Reachable = awake: e-paper reads power "Off" between refreshes even
          though the display responds and accepts pushes */}
      <span className={`${chip} text-emerald-400`} title={`Reachable — accepts pushes (panel power: ${status.power ?? "unknown"})`}>
        <Power className="h-3 w-3" /> Awake
      </span>
      {/* Battery ahead of the standby chip so the percentage never truncates */}
      {b?.present && (
        <span className={`${chip} ${b.charging ? "text-emerald-400" : b.level <= 20 ? "text-red-400" : "text-muted-foreground/60"}`}
          title={b.charging ? `Battery ${b.level}% — charging` : `Battery ${b.level}%`}>
          <BatteryIcon className="h-3 w-3" /> {b.level}%{b.charging && <Zap className="h-3 w-3 fill-current -ml-0.5" />}
        </span>
      )}
      {status.networkStandby != null && (
        <span
          className={`${chip} ${status.networkStandby ? "text-muted-foreground" : "text-muted-foreground/60"}`}
          title={status.networkStandby ? "Light sleep — WiFi standby on, remotely wakeable" : "Deep sleep — radio off, timer or power button only"}
        >
          {status.networkStandby ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {status.networkStandby ? "Light" : "Deep"}
        </span>
      )}
      {status.sleepTimer && (
        <span className={`${chip} text-amber-500`} title={`Sleeps in ${Math.ceil(status.sleepTimer.remainingMs / 60000)} minutes`}>
          <Moon className="h-3 w-3" /> {Math.ceil(status.sleepTimer.remainingMs / 60000)}m
        </span>
      )}
    </>
  )
}

/** Floating panel on the left listing every display with quick goto/wake. */
export function DisplayListPanel({
  displays, statuses, lastImageTimestamps, selectedId, onGoto, onSettings, onAdd, onReorder,
  groups, deliveries, activeGroupId, onSelectGroup, onDeleteGroup,
}: DisplayListPanelProps) {
  const [wakingId, setWakingId] = useState<string | null>(null)
  // Deleting a group asks once more, right where the click was
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  useEffect(() => {
    if (!confirmDelete) return
    const t = setTimeout(() => setConfirmDelete(null), 4000)
    return () => clearTimeout(t)
  }, [confirmDelete])
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
      const res = await fetch(`api/displays/${d.id}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      const data = await res.json().catch(() => ({})) as { method?: string; error?: string }
      if (!res.ok) throw new Error(data.error || "Wake failed")
      toast.success(data.method === "mdc" ? `${d.name}: woken via MDC` : `${d.name}: Wake-on-LAN sent`)
    } catch (err) {
      toast.error(`Wake failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setWakingId(null) }
  }
  return (
    <div
      className="surface absolute left-[60px] md:left-[64px] top-[72px] z-[70] w-80 p-1.5"
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
            className={`group flex items-center gap-2 rounded-xl px-1.5 py-1.5 transition-colors cursor-pointer ${
              d.id === selectedId ? "bg-accent" : "hover:bg-accent/50"
            } ${dragIdx === i ? "opacity-60" : ""}`}
            onClick={() => onSettings(d.id)}
          >
            <Thumb display={d} ts={lastImageTimestamps[d.id] || 0} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium leading-tight">{d.name}</p>
              <div className="flex items-center gap-1 text-[11px] leading-tight mt-1 whitespace-nowrap overflow-hidden gap-x-2">
                {deliveries[d.id] && (
                  <span
                    className={`flex items-center gap-1 ${deliveries[d.id]!.state === "failed" ? "text-red-400" : "text-amber-500"}`}
                    title={deliveries[d.id]!.error ?? "An image is waiting to be sent"}
                  >
                    {deliveries[d.id]!.state === "failed" ? <TriangleAlert className="h-3 w-3" /> : <Hourglass className="h-3 w-3" />}
                    {deliveries[d.id]!.state === "failed" ? "Not sent" : "Waiting"}
                  </span>
                )}
                <StatusRow status={statuses[d.id] ?? null} />
              </div>
            </div>
            <button
              className={`${iconBtn} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
              title="Go to display on canvas"
              onClick={e => { e.stopPropagation(); onGoto(d.id) }}
            >
              <Locate className="h-4 w-4" />
            </button>
            <button
              className={`${iconBtn} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
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
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-dashed border-input">
            <Plus className="h-4 w-4" />
          </span>
          Add display
        </button>

        {groups.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5 border-t border-border pt-1.5">
            <p className="eyebrow px-1.5 pb-0.5 pt-1">Groups</p>
            {groups.map(g => {
              const names = g.displayIds.map(id => displays.find(d => d.id === id)?.name).filter(Boolean)
              return (
                <div
                  key={g.id}
                  className={`group flex items-center gap-2 rounded-xl px-1.5 py-1.5 transition-colors cursor-pointer ${
                    g.id === activeGroupId ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                  title="Select these displays on the canvas"
                  onClick={() => onSelectGroup(g.id)}
                >
                  <GroupThumb key={g.span?.updatedAt ?? "none"} group={g} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium leading-tight">{g.name}</p>
                    <p className="mt-1 truncate text-[11px] leading-tight text-muted-foreground">
                      {names.length} display{names.length === 1 ? "" : "s"} · {names.join(", ")}
                    </p>
                  </div>
                  {confirmDelete === g.id ? (
                    <button
                      className="shrink-0 rounded-md bg-destructive px-2 py-1 text-[11px] font-medium text-destructive-foreground hover:bg-destructive/90"
                      title="Forgets the group and its image. The displays, and what they show, stay."
                      onClick={e => { e.stopPropagation(); setConfirmDelete(null); onDeleteGroup(g.id) }}
                    >
                      Delete
                    </button>
                  ) : (
                    <button
                      className={`${iconBtn} opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive`}
                      title="Delete group"
                      aria-label={`Delete group ${g.name}`}
                      onClick={e => { e.stopPropagation(); setConfirmDelete(g.id) }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
