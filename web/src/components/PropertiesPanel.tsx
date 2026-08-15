import { useState, useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"
import {
  ArrowUp, BatteryCharging, BatteryMedium, Check, Crosshair, Info, Loader2, Lock, LockOpen,
  Monitor, Moon, Power, PowerOff, RefreshCw, Trash2, Upload, Wifi, WifiOff, X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RailPanelShell } from "@/components/RightRail"
import { LightboxEditor, displayAspect, type LightboxResult } from "@/components/LightboxEditor"
import type {
  DisplayConfig, DisplayStatus, SleepMode,
} from "@/lib/types"

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">{children}</Label>
)
const Divider = () => <div className="h-px bg-border" />

interface PropertiesPanelProps {
  open: boolean
  display: DisplayConfig
  status: DisplayStatus | null
  lastImageTs: number
  onPatchDisplay: (displayId: string, patch: Partial<DisplayConfig>) => void
  onDisplayUpdated: () => void
  onDeleted: () => void
}

export function PropertiesPanel({
  open, display, status: statusProp, lastImageTs,
  onPatchDisplay, onDisplayUpdated, onDeleted,
}: PropertiesPanelProps) {
  const api = `/api/displays/${display.id}`

  const [name, setName] = useState(display.name)
  const [host, setHost] = useState(display.host)
  const [pin, setPin] = useState(display.pin)
  const [mac, setMac] = useState(display.mac)
  const [sleepAfter, setSleepAfter] = useState(display.sleepAfter)

  const [status, setStatus] = useState<DisplayStatus | null>(statusProp)
  const [statusLoading, setStatusLoading] = useState(false)
  const [mode, setModeState] = useState<SleepMode>("manual")

  const [waking, setWaking] = useState(false)
  const [sleeping, setSleeping] = useState(false)
  const [forceSleeping, setForceSleeping] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorApplying, setEditorApplying] = useState(false)
  const [calib, setCalib] = useState<"idle" | "sending" | "awaiting" | "finishing">("idle")
  const [calibSel, setCalibSel] = useState<number | null>(null)
  const [calibInfo, setCalibInfo] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  const [history, setHistory] = useState<{ id: string; ts: number }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const upLocked = !!display.upLocked

  // ─── Fetch on open / display change ──────────────────────────────────────
  useEffect(() => {
    if (!open) return
    setName(display.name); setHost(display.host); setPin(display.pin)
    setMac(display.mac); setSleepAfter(display.sleepAfter)
    setStatus(statusProp); setImgError(false); setCalib("idle")
    fetch(`${api}/mode`).then(r => r.ok ? r.json() : null).then(m => {
      if (m) setModeState(m.mode === "scheduled" ? "scheduled" : "manual")
    }).catch(() => {})
  }, [open, display.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setImgError(false) }, [lastImageTs, display.id])

  // Track live server-pushed status updates while the panel is open
  useEffect(() => { setStatus(statusProp) }, [statusProp])

  // History follows the current image: refetch whenever a push lands
  useEffect(() => {
    if (!open) return
    fetch(`${api}/history`).then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.images) setHistory(d.images) })
      .catch(() => {})
  }, [open, display.id, lastImageTs]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchStatus = useCallback(async () => {
    if (!display.host || !display.pin) return
    setStatusLoading(true)
    try { const r = await fetch(`${api}/status`); if (r.ok) setStatus(await r.json()) }
    catch { /* asleep */ }
    finally { setStatusLoading(false) }
  }, [api, display.host, display.pin])

  // ─── Connection field save (on blur) ─────────────────────────────────────
  const saveField = (patch: Partial<DisplayConfig>) => onPatchDisplay(display.id, patch)

  // ─── Power controls ──────────────────────────────────────────────────────
  const handleWake = async () => {
    setWaking(true)
    try {
      const res = await fetch(`${api}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      const data = await res.json().catch(() => ({})) as { method?: string; error?: string }
      if (!res.ok) throw new Error(data.error || "Wake failed")
      toast.success(data.method === "mdc" ? "Woken via MDC" : "Wake-on-LAN sent")
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
      toast.success(mode === "scheduled" ? "Sleeping — wake timer armed" : "Display powered off")
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
      if (!res.ok) throw new Error((data as { error?: string }).error || "Force sleep failed")
      toast.success("Forced into deep sleep")
      setModeState("manual") // force sleep drops the display back to manual
      setTimeout(fetchStatus, 2000)
    } catch (err) {
      toast.error(`Force sleep failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setForceSleeping(false) }
  }

  // ─── Manual replace (push) ───────────────────────────────────────────────
  // Pushes the image exactly as the file is; calibration happens server-side
  const pushBlob = async (blob: Blob) => {
    const form = new FormData()
    form.append("image", blob, "display.jpg")
    form.append("sleepAfter", String(sleepAfter))
    form.append("sleepMode", mode)
    const res = await fetch(`${api}/push`, { method: "POST", body: form })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as { error?: string }).error || "Push failed")
    onDisplayUpdated()
    setTimeout(fetchStatus, 2000)
  }

  const handleReplace = async (file: File) => {
    if (!file.type.startsWith("image/")) { toast.error("Please choose an image file"); return }
    setPushing(true)
    try {
      await pushBlob(file)
      toast.success(`Image pushed to ${display.name}`)
    } catch (err) {
      toast.error(`Push failed: ${err instanceof Error ? err.message : "Unknown error"}. If the display is in deep sleep, press its power button first.`)
    } finally { setPushing(false) }
  }

  // Lightbox tune of the current image: the server re-renders last-push.jpg
  // with the edit (crop/fit/stretch, rotation, letterbox) and pushes it
  const handleEditorApply = async (result: LightboxResult) => {
    setEditorApplying(true)
    try {
      const res = await fetch(`${api}/push-edit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edit: result }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || "Push failed")
      toast.success("Presentation updated and pushed")
      setEditorOpen(false)
      onDisplayUpdated()
      setTimeout(fetchStatus, 2000)
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setEditorApplying(false) }
  }

  // ─── Rotation calibration ────────────────────────────────────────────────
  const startCalibration = async () => {
    setCalib("sending")
    setCalibSel(null)
    try {
      const res = await fetch(`${api}/calibrate/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || "Failed to send test image")
      onDisplayUpdated() // refresh thumbnails — the arrow is on the glass now
      setCalib("awaiting")
    } catch (err) {
      toast.error(`Calibration failed: ${err instanceof Error ? err.message : "Unknown error"}. If the display is asleep, wake it first.`)
      setCalib("idle")
    }
  }

  const finishCalibration = async (observed: number | null) => {
    setCalib("finishing")
    try {
      const res = await fetch(`${api}/calibrate/finish`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observed }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string; upRotation?: number }
      if (!res.ok) throw new Error(data.error || "Calibration failed")
      if (observed !== null) toast.success("Calibration locked in — previous image restored")
      else toast.info("Calibration cancelled — previous image restored")
      onDisplayUpdated()
    } catch (err) {
      toast.error(`Calibration failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setCalib("idle") }
  }

  // ─── Remove from app ─────────────────────────────────────────────────────
  const handleRemove = async () => {
    setRemoving(true)
    try {
      const res = await fetch(api, { method: "DELETE" })
      if (!res.ok) throw new Error("Remove failed")
      toast.success(`Removed "${display.name}" from the app`)
      setRemoveOpen(false)
      onDeleted()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove display")
    } finally { setRemoving(false) }
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  const lastImageUrl = display.host ? `${api}/last-image?t=${lastImageTs}` : null

  return (
    <RailPanelShell open={open}>
      {/* Header: name + status, refresh/remove stacked on the right */}
      <div className="px-3 pt-3 pb-2 border-b border-border shrink-0 flex items-start gap-2">
        <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-primary shrink-0" />
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={() => { if (name.trim() && name !== display.name) saveField({ name: name.trim() }) }}
            className="h-7 text-sm font-semibold border-none bg-transparent p-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
          {status ? (
            <>
              {status.battery && (
                <span
                  className={`flex items-center gap-1 ${status.battery.charging ? "text-green-400" : ""}`}
                  title={status.battery.charging ? `Battery ${status.battery.level}% — charging` : `Battery ${status.battery.level}%`}
                >
                  {status.battery.charging ? <BatteryCharging className="h-3.5 w-3.5" /> : <BatteryMedium className="h-3.5 w-3.5" />}
                  {status.battery.level}%
                </span>
              )}
              {/* Reachable = awake (e-paper power reads "Off" between refreshes) */}
              <span className="text-green-500" title={`Reachable — accepts pushes (panel power: ${status.power ?? "unknown"})`}>
                <Power className="h-3 w-3 inline mr-0.5" />Awake
              </span>
              {status.networkStandby != null && (
                <span className={status.networkStandby ? "text-sky-400" : ""}>
                  {status.networkStandby
                    ? <><Wifi className="h-3 w-3 inline mr-0.5" />Light</>
                    : <><WifiOff className="h-3 w-3 inline mr-0.5" />Deep</>}
                </span>
              )}
              {status.sleepTimer && (
                <span className="text-amber-500">
                  <Moon className="h-3 w-3 inline mr-0.5" />{Math.ceil(status.sleepTimer.remainingMs / 60000)}m
                </span>
              )}
            </>
          ) : (
            <span>Status unknown — display may be asleep</span>
          )}
        </div>
        </div>
        <div className="flex flex-col items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={fetchStatus} disabled={statusLoading} title="Refresh status">
            <RefreshCw className={`h-3 w-3 ${statusLoading ? "animate-spin" : ""}`} />
          </Button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 hover:text-destructive hover:bg-accent transition-colors"
            title="Remove display from app"
            onClick={() => setRemoveOpen(true)}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {/* Control bar */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="flex-1 gap-1.5 h-8 text-xs" onClick={handleWake} disabled={waking || (!display.mac && !display.host)}>
            {waking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />} Wake
          </Button>
          <Button variant="outline" size="sm" className="flex-1 gap-1.5 h-8 text-xs" onClick={handleSleep} disabled={sleeping || !display.host}>
            {sleeping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Moon className="h-3.5 w-3.5" />} Sleep
          </Button>
          <Button variant="destructive" size="sm" className="flex-1 gap-1.5 h-8 text-xs" onClick={handleForceSleep} disabled={forceSleeping || !display.host || !display.pin}>
            {forceSleeping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />} Force
          </Button>
        </div>

        {/* Connection settings */}
        <div className="space-y-2">
          <SectionLabel>Connection</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">IP</Label>
              <Input value={host} onChange={e => setHost(e.target.value)}
                onBlur={() => { if (host !== display.host) saveField({ host }) }}
                placeholder="192.168.1.37" className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">PIN</Label>
              <Input value={pin} onChange={e => setPin(e.target.value)}
                onBlur={() => { if (pin !== display.pin) saveField({ pin }) }}
                placeholder="000000" className="h-8 text-xs" />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs text-muted-foreground">MAC address <span className="opacity-60">(Wake-on-LAN)</span></Label>
              <Input value={mac} onChange={e => setMac(e.target.value)}
                onBlur={() => { if (mac !== display.mac) saveField({ mac }) }}
                placeholder="00:11:22:33:44:55" className="h-8 text-xs" />
            </div>
          </div>
        </div>

        <Divider />

        {/* Rotation — calibration via test arrow */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <SectionLabel>Rotation</SectionLabel>
            <button
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="Which way is up on the physical display — applied when pushing images."
              onClick={() => setCalibInfo(v => !v)}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
            <div className="flex-1" />
            <button
              className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                upLocked
                  ? "text-foreground bg-primary/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
              title={upLocked ? "Unlock rotation" : "Lock rotation (protects calibration)"}
              onClick={() => saveField({ upLocked: !upLocked })}
            >
              {upLocked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
            </button>
          </div>

          {calibInfo && (
            <p className="text-[11px] text-muted-foreground -mt-1">Which way is up on the physical display — applied when pushing images.</p>
          )}

          {calib === "sending" || calib === "finishing" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              {calib === "sending" ? "Sending test arrow to the display…" : "Saving calibration and restoring the previous image…"}
            </div>
          ) : calib === "awaiting" ? (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <p className="text-xs text-amber-500">
                <span className="font-medium">2/2</span> · Click the direction the arrow is pointing on your display, then confirm.
              </p>
              <div className="flex items-center gap-1.5">
                {([0, 90, 180, 270] as const).map(deg => (
                  <button
                    key={deg}
                    className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                      calibSel === deg
                        ? "border-amber-400 bg-amber-500/30 text-amber-300"
                        : "border-amber-500/40 text-amber-400 hover:bg-amber-500/20"
                    }`}
                    title={`Arrow points ${deg === 0 ? "up" : deg === 90 ? "right" : deg === 180 ? "down" : "left"}`}
                    onClick={() => setCalibSel(deg)}
                  >
                    <ArrowUp className="h-4 w-4" style={{ transform: `rotate(${deg}deg)` }} />
                  </button>
                ))}
                <div className="flex-1" />
                <button
                  className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                    calibSel === null
                      ? "border-border text-muted-foreground/40 cursor-default"
                      : "border-green-500/50 text-green-400 hover:bg-green-500/20"
                  }`}
                  title="Confirm — save calibration"
                  disabled={calibSel === null}
                  onClick={() => { if (calibSel !== null) finishCalibration(calibSel) }}
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  title="Cancel — restore the previous image"
                  onClick={() => finishCalibration(null)}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : !upLocked ? (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground/70">1/2</span> · Send a test image, then check how it appears on your display.
              </p>
              <div className="flex items-center">
                <Button
                  size="sm" variant="outline" className="h-8 px-2.5 text-xs gap-1.5"
                  title="Send a test arrow to the display"
                  onClick={startCalibration}
                >
                  <Crosshair className="h-3.5 w-3.5" /> Test
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <Divider />

        {/* Image — current image preview + manual replace */}
        <div className="space-y-3">
          <SectionLabel>Image</SectionLabel>
          <div className="space-y-2">
            <div
              className={`relative rounded-lg border ${fileOver ? "border-primary border-dashed bg-primary/5" : "border-border"} overflow-hidden`}
              onDragOver={e => { e.preventDefault(); setFileOver(true) }}
              onDragLeave={() => setFileOver(false)}
              onDrop={e => { e.preventDefault(); setFileOver(false); const f = e.dataTransfer.files[0]; if (f) handleReplace(f) }}
            >
              {lastImageUrl && !imgError ? (
                <img
                  src={lastImageUrl} alt="Current"
                  className="w-full max-h-56 object-contain bg-black/40 cursor-pointer hover:opacity-90 transition-opacity"
                  title="Click to tune presentation (rotate, scale, crop)"
                  onClick={() => setEditorOpen(true)}
                  onError={() => setImgError(true)}
                />
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <Monitor className="h-8 w-8 opacity-30 mb-1" />
                  <span className="text-xs">No image on display</span>
                </div>
              )}
              {pushing && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
            </div>
            <button
              className="w-full flex items-center justify-center gap-2 py-2 border border-dashed rounded-lg border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30 transition-colors text-xs text-muted-foreground"
              onClick={() => fileRef.current?.click()}
              disabled={pushing}
            >
              <Upload className="h-3.5 w-3.5" /> Drop an image or click to replace
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleReplace(f); e.target.value = "" }} />
          </div>

          {/* History — previously displayed images, dimmed, below the fold */}
          {history.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <SectionLabel>History</SectionLabel>
              <div className="grid grid-cols-3 gap-1.5">
                {history.map(h => (
                  <img
                    key={h.id}
                    src={`${api}/history/${h.id}`}
                    alt=""
                    loading="lazy"
                    title={new Date(h.ts).toLocaleString()}
                    className="w-full aspect-square object-cover rounded-md border border-border opacity-40 hover:opacity-100 transition-opacity"
                  />
                ))}
              </div>
            </div>
          )}
        </div>

      </div>

      {/* Presentation tuner for the current image */}
      {lastImageUrl && (
        <LightboxEditor
          open={editorOpen}
          imageUrl={lastImageUrl}
          aspect={displayAspect(display)}
          title={`Tune presentation — ${display.name}`}
          applying={editorApplying}
          onApply={handleEditorApply}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {/* Remove confirmation */}
      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove "{display.name}"?</DialogTitle>
            <DialogDescription>
              This removes the display from the app, along with its queue, schedule, and image history.
              The physical display isn't affected — but to control it again you'll need to discover,
              add, and configure it from scratch.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setRemoveOpen(false)} disabled={removing}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleRemove} disabled={removing} className="gap-1.5">
              {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Remove display
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </RailPanelShell>
  )
}
