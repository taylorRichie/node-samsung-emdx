import { useState, useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"
import {
  BatteryCharging, BatteryMedium, Clock3, Hourglass, ImagePlus, Loader2, Monitor, Moon, Pencil, Power, PowerOff,
  RectangleHorizontal, RectangleVertical, RefreshCw, Settings, TriangleAlert, Wifi, WifiOff,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Segmented } from "@/components/ui/segmented"
import { RailPanelShell } from "@/components/RightRail"
import { ImageDesigner, type DesignResult } from "@/components/ImageDesigner"
import { withWakeHint } from "@/lib/wakeHint"
import { readSend, toastSend, fromNow, driftText } from "@/lib/send"
import { displayAspect, displayOrientation, type Orientation } from "@/lib/displayState"
import type { Delivery, DisplayClock, DisplayConfig, DisplayStatus, ProfileId, SleepMode } from "@/lib/types"

interface PropertiesPanelProps {
  open: boolean
  display: DisplayConfig
  status: DisplayStatus | null
  /** The image waiting to reach it, if any */
  delivery: Delivery | null
  lastImageTs: number
  defaultProfile: ProfileId
  onPatchDisplay: (displayId: string, patch: Partial<DisplayConfig>) => void
  onOrientationChange: (display: DisplayConfig, orientation: Orientation) => void
  onDisplayUpdated: () => void
  onOpenSettings: () => void
}

/** What's on the display now and the things you do with it day to day */
export function PropertiesPanel({
  open, display, status: statusProp, delivery, lastImageTs, defaultProfile,
  onPatchDisplay, onOrientationChange, onDisplayUpdated, onOpenSettings,
}: PropertiesPanelProps) {
  const api = `api/displays/${display.id}`

  const [name, setName] = useState(display.name)
  const [status, setStatus] = useState<DisplayStatus | null>(statusProp)
  const [statusLoading, setStatusLoading] = useState(false)
  const [mode, setModeState] = useState<SleepMode>("manual")

  const [waking, setWaking] = useState(false)
  const [sleeping, setSleeping] = useState(false)
  const [forceSleeping, setForceSleeping] = useState(false)
  // A picked file isn't on the server yet, so it goes up with the design
  const [designer, setDesigner] = useState<{ src: string; initial: DesignResult | null; file: File | null } | null>(null)
  const [applying, setApplying] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  const [clock, setClock] = useState<DisplayClock | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [deliveryBusy, setDeliveryBusy] = useState<"retry" | "cancel" | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // ─── Fetch on open / display change ──────────────────────────────────────
  useEffect(() => {
    if (!open) return
    setName(display.name)
    setStatus(statusProp); setImgError(false)
    fetch(`${api}/mode`).then(r => r.ok ? r.json() : null).then(m => {
      if (m) setModeState(m.mode === "scheduled" ? "scheduled" : "manual")
    }).catch(() => {})
  }, [open, display.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The name can also change in Settings
  useEffect(() => { setName(display.name) }, [display.name])

  useEffect(() => { setImgError(false) }, [lastImageTs, display.id])

  // Track live server-pushed status updates while the panel is open
  useEffect(() => { setStatus(statusProp) }, [statusProp])

  // The display's clock: read now if it's awake, its last reading otherwise.
  // Every send checks it too, so it follows new images.
  useEffect(() => {
    if (!open || !display.host || !display.pin) return
    let cancelled = false
    fetch(`${api}/clock`).then(r => r.ok ? r.json() : null)
      .then(c => { if (!cancelled) setClock(c) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open, display.id, display.host, display.pin, lastImageTs]) // eslint-disable-line react-hooks/exhaustive-deps
  const shownClock = statusProp?.clock ?? clock

  const handleSyncClock = async () => {
    setSyncing(true)
    try {
      const res = await withWakeHint(display.name, () => fetch(`${api}/clock/sync`, { method: "POST" }))
      const data = await res.json().catch(() => ({})) as DisplayClock & { error?: string }
      if (!res.ok) throw new Error(data.error || "Couldn't sync")
      setClock(data)
      toast.success(`${display.name}'s clock is set to this app's time`)
    } catch (err) {
      toast.error(`Couldn't sync the clock: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setSyncing(false) }
  }

  // ─── The image waiting to reach it ───────────────────────────────────────
  const retryDelivery = async () => {
    setDeliveryBusy("retry")
    try {
      const res = await withWakeHint(display.name, () => fetch(`${api}/delivery/retry`, { method: "POST" }))
      toastSend(display.name, await readSend(res))
    } catch (err) {
      toast.error(`Couldn't send: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setDeliveryBusy(null) }
  }
  const cancelDelivery = async () => {
    setDeliveryBusy("cancel")
    await fetch(`${api}/delivery`, { method: "DELETE" }).catch(() => {})
    setDeliveryBusy(null)
  }

  const fetchStatus = useCallback(async () => {
    if (!display.host || !display.pin) return
    setStatusLoading(true)
    try { const r = await fetch(`${api}/status`); if (r.ok) setStatus(await r.json()) }
    catch { /* asleep */ }
    finally { setStatusLoading(false) }
  }, [api, display.host, display.pin])

  // ─── Power controls ──────────────────────────────────────────────────────
  const handleWake = async () => {
    setWaking(true)
    try {
      const res = await withWakeHint(display.name, () =>
        fetch(`${api}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
      const data = await res.json().catch(() => ({})) as { confirmed?: boolean; error?: string }
      if (!res.ok) throw new Error(data.error || "Wake failed")
      toast.success(data.confirmed === false ? "Wake-on-LAN sent" : `${display.name} is awake`)
      setTimeout(fetchStatus, 3000)
    } catch (err) {
      toast.error(`Wake failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setWaking(false) }
  }

  const handleSleep = async () => {
    setSleeping(true)
    try {
      const res = await fetch(`${api}/sleep`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sleepMode: mode }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || "Sleep failed")
      toast.success(mode === "scheduled" ? "Sleeping, with the wake timer set" : "Display is going to sleep")
      setTimeout(fetchStatus, 2000)
    } catch (err) {
      toast.error(`Sleep failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setSleeping(false) }
  }

  const handleForceSleep = async () => {
    setForceSleeping(true)
    try {
      const res = await fetch(`${api}/sleep/force`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || "Deep sleep failed")
      toast.success("Display is in deep sleep. Its power button wakes it.")
      setModeState("manual") // deep sleep drops the display back to manual
      setTimeout(fetchStatus, 2000)
    } catch (err) {
      toast.error(`Deep sleep failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setForceSleeping(false) }
  }

  // ─── Image designer ──────────────────────────────────────────────────────
  const lastImageUrl = display.host ? `${api}/last-image?t=${lastImageTs}` : null

  // Opens against the ORIGINAL art + its saved design. Designs are stored as
  // overrides, never baked into the source, so they stay editable next time.
  const openCurrent = async () => {
    if (!lastImageUrl) return
    try {
      const [editRes, srcRes] = await Promise.all([
        fetch(`${api}/current-edit`),
        fetch(`${api}/current-source`, { method: "HEAD" }),
      ])
      const data = editRes.ok ? await editRes.json() as { edit?: DesignResult | null } : {}
      setDesigner({ src: srcRes.ok ? `${api}/current-source?t=${lastImageTs}` : lastImageUrl, initial: data.edit ?? null, file: null })
    } catch {
      setDesigner({ src: lastImageUrl, initial: null, file: null })
    }
  }

  const openFile = (file: File) => {
    if (!file.type.startsWith("image/")) { toast.error("Please choose an image file"); return }
    setDesigner({ src: URL.createObjectURL(file), initial: null, file })
  }

  const closeDesigner = () => {
    if (designer?.file) URL.revokeObjectURL(designer.src)
    setDesigner(null)
  }

  const handleSend = async (result: DesignResult) => {
    if (!designer) return
    setApplying(true)
    try {
      const res = await withWakeHint(display.name, () => {
        if (designer.file) {
          const form = new FormData()
          form.append("image", designer.file)
          form.append("edit", JSON.stringify(result))
          form.append("sleepMode", mode)
          return fetch(`${api}/push`, { method: "POST", body: form })
        }
        return fetch(`${api}/push-edit`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ edit: result }),
        })
      })
      toastSend(display.name, await readSend(res))
      closeDesigner()
      onDisplayUpdated()
      setTimeout(fetchStatus, 2000)
    } catch (err) {
      toast.error(`Couldn't send: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setApplying(false) }
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  const orientation = displayOrientation(display)
  const hasImage = !!lastImageUrl && !imgError

  return (
    <RailPanelShell open={open}>
      {/* Header: name + status */}
      <div className="flex shrink-0 items-start gap-2 border-b border-border px-4 pb-3 pt-3.5">
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Display name"
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={() => { if (name.trim() && name !== display.name) onPatchDisplay(display.id, { name: name.trim() }) }}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur() }}
            className="h-6 rounded-md border-none bg-transparent p-0 text-[15px] font-semibold shadow-none focus-visible:ring-0"
          />
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {status ? (
              <>
                {/* Reachable = awake (e-paper power reads "Off" between refreshes) */}
                <span className="flex items-center gap-1 text-emerald-400" title={`Reachable, so it accepts images (panel power: ${status.power ?? "unknown"})`}>
                  <Power className="h-3 w-3" /> Awake
                </span>
                {status.battery && (
                  <span
                    className={`flex items-center gap-1 ${status.battery.charging ? "text-emerald-400" : ""}`}
                    title={status.battery.charging ? `Battery ${status.battery.level}%, charging` : `Battery ${status.battery.level}%`}
                  >
                    {status.battery.charging ? <BatteryCharging className="h-3.5 w-3.5" /> : <BatteryMedium className="h-3.5 w-3.5" />}
                    {status.battery.level}%
                  </span>
                )}
                {status.networkStandby != null && (
                  <span
                    className="flex items-center gap-1"
                    title={status.networkStandby ? "Network standby: can be woken remotely" : "Deep sleep: can't be woken remotely"}
                  >
                    {status.networkStandby ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                    {status.networkStandby ? "Standby" : "Deep"}
                  </span>
                )}
                {status.sleepTimer && (
                  <span className="flex items-center gap-1 text-amber-500" title="Time until this app puts it to sleep">
                    <Moon className="h-3 w-3" /> {Math.ceil(status.sleepTimer.remainingMs / 60000)}m
                  </span>
                )}
              </>
            ) : (
              <span>{display.host ? "Asleep or unreachable" : "Not connected yet"}</span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={fetchStatus} disabled={statusLoading} aria-label="Refresh status" title="Refresh status">
          <RefreshCw className={`h-3.5 w-3.5 ${statusLoading ? "animate-spin" : ""}`} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onOpenSettings} aria-label="Display settings" title="Display settings">
          <Settings className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* The image on the display, framed like the display */}
        <div
          className={`relative overflow-hidden rounded-[3px] border-[3px] bg-black transition-colors ${
            fileOver ? "border-primary" : "border-[#e8e5dd]"
          } ${orientation === "landscape" ? "w-full" : "mx-auto h-[min(40vh,360px)]"}`}
          style={{ aspectRatio: String(displayAspect(display)) }}
          onDragOver={e => { e.preventDefault(); setFileOver(true) }}
          onDragLeave={() => setFileOver(false)}
          onDrop={e => { e.preventDefault(); setFileOver(false); const f = e.dataTransfer.files[0]; if (f) openFile(f) }}
        >
          {hasImage ? (
            <button type="button" className="group block h-full w-full" title="Open in the image designer" onClick={openCurrent}>
              <img src={lastImageUrl} alt="On the display now" className="h-full w-full object-contain" onError={() => setImgError(true)} />
              <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="flex items-center gap-1.5 rounded-lg bg-white/90 px-2.5 py-1.5 text-xs font-medium text-black">
                  <Pencil className="h-3 w-3" /> Edit image
                </span>
              </span>
            </button>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-white/45">
              <Monitor className="h-7 w-7 opacity-50" />
              <span className="text-xs">{fileOver ? "Drop to open in the designer" : "No image yet"}</span>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button size="sm" className="flex-1 gap-1.5" onClick={() => fileRef.current?.click()}>
            <ImagePlus className="h-3.5 w-3.5" /> New image
          </Button>
          <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={openCurrent} disabled={!hasImage}>
            <Pencil className="h-3.5 w-3.5" /> Edit image
          </Button>
          <input
            ref={fileRef} type="file" accept="image/*" className="hidden" aria-label="Choose an image"
            onChange={e => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = "" }}
          />
        </div>

        {delivery && (
          <div className={`space-y-2 rounded-lg border px-3 py-2.5 text-xs ${
            delivery.state === "failed" ? "border-destructive/40 bg-destructive/10" : "border-amber-500/30 bg-amber-500/10"
          }`}>
            <div className="flex items-start gap-2">
              {delivery.state === "failed"
                ? <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                : delivery.state === "sending"
                  ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />
                  : <Hourglass className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />}
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {delivery.state === "failed" ? "Not sent" : delivery.state === "sending" ? "Sending" : "Waiting to send"}
                  {delivery.label ? `: ${delivery.label}` : ""}
                </p>
                {delivery.error && delivery.state !== "sending" && <p className="text-muted-foreground">{delivery.error}</p>}
                {delivery.state === "pending" && delivery.nextAttemptAt && (
                  <p className="text-muted-foreground">
                    Tried {delivery.attempts} time{delivery.attempts === 1 ? "" : "s"}. Next try {fromNow(delivery.nextAttemptAt)}, or as soon as it's awake.
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="xs" onClick={cancelDelivery} disabled={!!deliveryBusy || delivery.state === "sending"}>
                {deliveryBusy === "cancel" && <Loader2 className="h-3 w-3 animate-spin" />} Cancel
              </Button>
              <Button variant="outline" size="xs" onClick={retryDelivery} disabled={!!deliveryBusy || delivery.state === "sending"}>
                {deliveryBusy === "retry" && <Loader2 className="h-3 w-3 animate-spin" />} Try now
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-xs text-muted-foreground">Orientation</span>
            <Segmented
              label="Orientation"
              value={orientation}
              options={[
                { value: "portrait", label: <><RectangleVertical className="h-3.5 w-3.5" /> Portrait</> },
                { value: "landscape", label: <><RectangleHorizontal className="h-3.5 w-3.5" /> Landscape</> },
              ]}
              onChange={o => onOrientationChange(display, o)}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-xs text-muted-foreground">Power</span>
            <div className="flex gap-1">
              <Button variant="outline" size="xs" className="gap-1.5" onClick={handleWake} disabled={waking || (!display.mac && !display.host)}>
                {waking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />} Wake
              </Button>
              <Button variant="outline" size="xs" className="gap-1.5" onClick={handleSleep} disabled={sleeping || !display.host}>
                {sleeping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Moon className="h-3 w-3" />} Sleep
              </Button>
              <Button
                variant="outline" size="xs" className="gap-1.5"
                title="Turns networking off, so only its power button or a scheduled wake can bring it back"
                onClick={handleForceSleep} disabled={forceSleeping || !display.host || !display.pin}
              >
                {forceSleeping ? <Loader2 className="h-3 w-3 animate-spin" /> : <PowerOff className="h-3 w-3" />} Deep
              </Button>
            </div>
          </div>
          {display.host && display.pin && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="text-xs text-muted-foreground">Clock</span>
              <div className="flex items-center gap-2">
                <span
                  className={`flex items-center gap-1 text-xs ${shownClock && Math.abs(shownClock.drift ?? 0) >= 90 ? "text-amber-500" : "text-muted-foreground"}`}
                  title={shownClock?.checkedAt ? `What the display's clock said, read ${new Date(shownClock.checkedAt).toLocaleString()}` : undefined}
                >
                  <Clock3 className="h-3 w-3" />
                  {shownClock?.time
                    ? `${new Date(shownClock.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${driftText(shownClock.drift)}`
                    : shownClock ? "Unreadable" : "Not read yet"}
                </span>
                <Button variant="outline" size="xs" className="gap-1.5" onClick={handleSyncClock} disabled={syncing} title="Set the display's clock to this app's time">
                  {syncing && <Loader2 className="h-3 w-3 animate-spin" />} Sync
                </Button>
              </div>
            </div>
          )}
        </div>

      </div>

      {designer && (
        <ImageDesigner
          imageUrl={designer.src}
          aspect={displayAspect(display)}
          title={display.name}
          subtitle={designer.file ? "New image" : "On the display now"}
          initial={designer.initial}
          defaultProfile={defaultProfile}
          primaryLabel="Send to display"
          onPrimary={handleSend}
          applying={applying}
          onClose={closeDesigner}
        />
      )}
    </RailPanelShell>
  )
}
