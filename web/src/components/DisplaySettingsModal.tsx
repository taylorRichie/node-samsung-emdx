import { useState, useCallback, useRef, useEffect } from "react"
import Cropper from "react-easy-crop"
import type { Area, Point } from "react-easy-crop"
import { toast } from "sonner"
import {
  Upload, Send, RotateCw, X, ZoomIn, Loader2, ImageIcon,
  Sun, Contrast, Power, PowerOff, BatteryMedium, BatteryCharging,
  Moon, RefreshCw, Smartphone, Monitor, Clock, Trash2, GripVertical,
  Plus, Rss, ListOrdered, ExternalLink,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { getCroppedImageBlob } from "@/lib/crop-image"
import type {
  DisplayConfig, DisplayStatus, Schedule, QueueImage, QueueData,
  ProviderConfig, ProviderPreview, SleepMode,
} from "@/lib/types"

function formatTime12h(hour: number, minute: number) {
  const ampm = hour >= 12 ? "PM" : "AM"
  const h = hour % 12 || 12
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`
}

function formatTimeTo24h(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

function getTimeUntilWake(hour: number, minute: number): string {
  const now = new Date()
  const wake = new Date()
  wake.setHours(hour, minute, 0, 0)
  if (wake <= now) wake.setDate(wake.getDate() + 1)
  const diffMs = wake.getTime() - now.getTime()
  const h = Math.floor(diffMs / 3600000)
  const m = Math.floor((diffMs % 3600000) / 60000)
  return `${h}h ${String(m).padStart(2, "0")}m`
}

interface Props {
  display: DisplayConfig
  open: boolean
  onOpenChange: (open: boolean) => void
  onDisplayUpdated: () => void
}

export function DisplaySettingsModal({ display, open, onOpenChange, onDisplayUpdated }: Props) {
  const api = `/api/displays/${display.id}`

  // Connection settings (editable copies)
  const [name, setName] = useState(display.name)
  const [host, setHost] = useState(display.host)
  const [pin, setPin] = useState(display.pin)
  const [mac, setMac] = useState(display.mac)
  const [sleepAfter, setSleepAfter] = useState(display.sleepAfter)

  // Mode
  const [mode, setModeState] = useState<SleepMode>("manual")

  // Status
  const [status, setStatus] = useState<DisplayStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)

  // Schedule
  const [schedule, setSchedule] = useState<Schedule>({ enabled: false, hour: 8, minute: 0, repeat: "daily" })

  // Queue
  const [queue, setQueue] = useState<QueueData>({ images: [], currentIndex: 0 })
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  // Providers
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({ sourceMode: "queue", activeProvider: "nasa-iotd", providers: [] })
  const [providerPreview, setProviderPreview] = useState<ProviderPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [addingFeed, setAddingFeed] = useState(false)
  const [newFeedName, setNewFeedName] = useState("")
  const [newFeedUrl, setNewFeedUrl] = useState("")

  // Image crop state
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [brightness, setBrightness] = useState(100)
  const [contrast, setContrast] = useState(100)
  const [orientation, setOrientation] = useState<"landscape" | "portrait">("portrait")
  const [outputRotation, setOutputRotation] = useState(90)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)

  // UI state
  const [pushing, setPushing] = useState(false)
  const [waking, setWaking] = useState(false)
  const [sleeping, setSleeping] = useState(false)
  const [forceSleeping, setForceSleeping] = useState(false)
  const [lastImage, setLastImage] = useState<string | null>(null)
  const [settingsExpanded, setSettingsExpanded] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queueFileRef = useRef<HTMLInputElement>(null)

  const aspect = orientation === "landscape" ? 16 / 9 : 9 / 16
  const isScheduled = mode === "scheduled"
  const isOn = status?.power === "On"
  const isScheduledSleep = isScheduled && !isOn && schedule.enabled
  const showingProvider = isScheduled && !imageSrc && providerConfig.sourceMode === "provider" && !!providerPreview?.imageUrl

  // ─── Data fetching ───────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    const [modeRes, schedRes, queueRes, provRes, lastImgRes] = await Promise.allSettled([
      fetch(`${api}/mode`).then(r => r.ok ? r.json() : null),
      fetch(`${api}/schedule`).then(r => r.ok ? r.json() : null),
      fetch(`${api}/queue`).then(r => r.ok ? r.json() : null),
      fetch(`${api}/providers`).then(r => r.ok ? r.json() : null),
      fetch(`${api}/last-image`).then(r => r.ok ? r.blob() : null),
    ])

    if (modeRes.status === "fulfilled" && modeRes.value) {
      setModeState(modeRes.value.mode === "scheduled" ? "scheduled" : "manual")
    }
    if (schedRes.status === "fulfilled" && schedRes.value) setSchedule(schedRes.value)
    if (queueRes.status === "fulfilled" && queueRes.value) setQueue(queueRes.value)
    if (provRes.status === "fulfilled" && provRes.value) setProviderConfig(provRes.value)
    if (lastImgRes.status === "fulfilled" && lastImgRes.value) {
      const blob = lastImgRes.value as Blob
      if (blob.size > 0) setLastImage(URL.createObjectURL(blob))
    }
  }, [api])

  const fetchStatus = useCallback(async () => {
    if (!host || !pin) return
    setStatusLoading(true)
    try {
      const res = await fetch(`${api}/status`)
      if (res.ok) setStatus(await res.json())
    } catch { /* display may be asleep */ }
    finally { setStatusLoading(false) }
  }, [api, host, pin])

  const fetchQueue = useCallback(async () => {
    try { const r = await fetch(`${api}/queue`); if (r.ok) setQueue(await r.json()) } catch { /**/ }
  }, [api])

  const fetchProviders = useCallback(async () => {
    try { const r = await fetch(`${api}/providers`); if (r.ok) setProviderConfig(await r.json()) } catch { /**/ }
  }, [api])

  const fetchProviderPreview = useCallback(async (id: string) => {
    setPreviewLoading(true); setProviderPreview(null)
    try { const r = await fetch(`${api}/providers/${id}/preview`); if (r.ok) setProviderPreview(await r.json()) } catch { /**/ }
    setPreviewLoading(false)
  }, [api])

  useEffect(() => {
    if (!open) return
    setName(display.name); setHost(display.host); setPin(display.pin)
    setMac(display.mac); setSleepAfter(display.sleepAfter)
    setImageSrc(null); setLastImage(null); setStatus(null)
    fetchAll()
    fetchStatus()
  }, [open, display.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open && providerConfig.sourceMode === "provider" && providerConfig.activeProvider && !providerPreview) {
      fetchProviderPreview(providerConfig.activeProvider)
    }
  }, [open, providerConfig.sourceMode, providerConfig.activeProvider]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Save connection settings on change ──────────────────────────────────

  const saveConnection = useCallback(async (patch: Partial<DisplayConfig>) => {
    await fetch(`/api/displays/${display.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {})
    onDisplayUpdated()
  }, [display.id, onDisplayUpdated])

  // ─── Crop handlers ───────────────────────────────────────────────────────

  const onCropComplete = useCallback((_: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels)
  }, [])

  const onMediaLoaded = useCallback((mediaSize: { width: number; height: number }) => {
    const { width: w, height: h } = mediaSize
    const targetAspect = aspect
    let cropW: number, cropH: number
    if (w / h > targetAspect) { cropH = h; cropW = h * targetAspect }
    else { cropW = w; cropH = w / targetAspect }
    setCroppedAreaPixels({ x: (w - cropW) / 2, y: (h - cropH) / 2, width: cropW, height: cropH })
  }, [aspect])

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) { toast.error("Please drop an image file"); return }
    const reader = new FileReader()
    reader.onload = () => {
      setImageSrc(reader.result as string)
      setCrop({ x: 0, y: 0 }); setZoom(1); setRotation(0)
      setBrightness(100); setContrast(100); setOutputRotation(90)
    }
    reader.readAsDataURL(file)
  }, [])

  const handleLoadLastImage = useCallback(() => {
    if (!lastImage) return
    setImageSrc(lastImage); setCrop({ x: 0, y: 0 }); setZoom(1); setRotation(0); setOutputRotation(90)
  }, [lastImage])

  const handleLoadQueueImage = useCallback((img: QueueImage) => {
    setImageSrc(`${api}/queue/image/${img.id}`)
    setCrop({ x: 0, y: 0 }); setZoom(1); setRotation(0)
    setBrightness(100); setContrast(100); setOrientation("portrait")
    setOutputRotation(img.outputRotation ?? 90)
  }, [api])

  const clearImage = () => {
    setImageSrc(null); setCroppedAreaPixels(null); setZoom(1); setRotation(0)
    setBrightness(100); setContrast(100); setOrientation("portrait"); setOutputRotation(90)
  }

  // ─── Push / Wake / Sleep handlers ────────────────────────────────────────

  const handlePush = async () => {
    if (!imageSrc || !croppedAreaPixels || !host || !pin) return
    setPushing(true)
    try {
      const blob = await getCroppedImageBlob(imageSrc, croppedAreaPixels, rotation, brightness, contrast, outputRotation)
      const formData = new FormData()
      formData.append("image", blob, "display.jpg")
      formData.append("sleepAfter", String(sleepAfter))
      formData.append("sleepMode", mode)
      const res = await fetch(`${api}/push`, { method: "POST", body: formData })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || "Push failed")
      toast.success(`Image pushed to ${name}!`)
      setLastImage(URL.createObjectURL(blob))
      onDisplayUpdated()
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      toast.error(`Failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setPushing(false) }
  }

  const handleWake = async () => {
    if (!host && !mac) return
    setWaking(true)
    try {
      const res = await fetch(`${api}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
      const data = await res.json().catch(() => ({})) as { method?: string; error?: string }
      if (!res.ok) throw new Error(data.error || "Wake failed")
      toast.success(data.method === "mdc" ? "Woken via MDC" : "Wake-on-LAN sent")
      setTimeout(fetchStatus, 3000)
    } catch (err: unknown) {
      toast.error(`Wake failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setWaking(false) }
  }

  const handleSleep = async () => {
    if (!host || !pin) return
    setSleeping(true)
    try {
      const res = await fetch(`${api}/sleep`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sleepMode: mode }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || "Sleep failed")
      toast.success(mode === "scheduled"
        ? `Scheduled sleep (wakes ${formatTime12h(schedule.hour, schedule.minute)} ${schedule.repeat})`
        : "Display powered off")
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      toast.error(`Sleep failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setSleeping(false) }
  }

  const handleForceSleep = async () => {
    if (!host || !pin) return
    setForceSleeping(true)
    try {
      const res = await fetch(`${api}/sleep/force`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || "Force sleep failed")
      toast.success("Display forced into deep sleep")
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      toast.error(`Force sleep failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setForceSleeping(false) }
  }

  // ─── Mode handler ────────────────────────────────────────────────────────

  const handleSetMode = async (m: SleepMode) => {
    setModeState(m)
    await fetch(`${api}/mode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: m }) }).catch(() => {})
    if (m === "scheduled") {
      const r = await fetch(`${api}/schedule`).catch(() => null)
      if (r?.ok) setSchedule(await r.json())
    }
  }

  // ─── Schedule handlers ───────────────────────────────────────────────────

  const updateSchedule = async (patch: Partial<Schedule>) => {
    const next = { ...schedule, ...patch }
    setSchedule(next)
    await fetch(`${api}/schedule`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => {})
  }

  // ─── Queue handlers ─────────────────────────────────────────────────────

  const handleAddCroppedToQueue = async () => {
    if (!imageSrc || !croppedAreaPixels) return
    setPushing(true)
    try {
      const blob = await getCroppedImageBlob(imageSrc, croppedAreaPixels, rotation, brightness, contrast, 0)
      const formData = new FormData()
      formData.append("image", blob, "queued.jpg")
      formData.append("outputRotation", String(outputRotation))
      const res = await fetch(`${api}/queue`, { method: "POST", body: formData })
      if (!res.ok) throw new Error("Failed to add to queue")
      toast.success("Image added to queue")
      fetchQueue(); clearImage()
    } catch (err: unknown) {
      toast.error(`Failed to queue: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setPushing(false) }
  }

  const handleRemoveFromQueue = async (id: string) => {
    await fetch(`${api}/queue/${id}`, { method: "DELETE" })
    fetchQueue()
  }

  const handlePushNextInQueue = async () => {
    if (!host || !pin) return
    setPushing(true)
    try {
      const res = await fetch(`${api}/queue/push-next`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
      const data = await res.json().catch(() => ({})) as { error?: string; filename?: string }
      if (!res.ok) throw new Error(data.error || "Failed")
      toast.success(`Pushed next queue image`)
      fetchQueue(); onDisplayUpdated()
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      toast.error(`Queue push failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setPushing(false) }
  }

  const handleQueueDragStart = (idx: number) => setDragIdx(idx)
  const handleQueueDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    if (dragIdx === null || dragIdx === idx) return
    const newImages = [...queue.images]
    const [moved] = newImages.splice(dragIdx, 1)
    newImages.splice(idx, 0, moved)
    setQueue({ ...queue, images: newImages })
    setDragIdx(idx)
  }
  const handleQueueDragEnd = async () => {
    setDragIdx(null)
    await fetch(`${api}/queue/reorder`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: queue.images.map(i => i.id) }) })
  }

  // ─── Provider handlers ──────────────────────────────────────────────────

  const setSourceMode = async (sm: "queue" | "provider") => {
    setProviderConfig(prev => ({ ...prev, sourceMode: sm }))
    if (sm === "provider" && imageSrc) clearImage()
    await fetch(`${api}/providers/active`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceMode: sm }) })
  }

  const setActiveProvider = async (id: string) => {
    setProviderConfig(prev => ({ ...prev, activeProvider: id }))
    await fetch(`${api}/providers/active`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activeProvider: id }) })
    fetchProviderPreview(id)
  }

  const handleAddCustomFeed = async () => {
    if (!newFeedName.trim() || !newFeedUrl.trim()) return
    try {
      const res = await fetch(`${api}/providers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newFeedName.trim(), feedUrl: newFeedUrl.trim() }) })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || "Failed")
      toast.success("Feed added"); setNewFeedName(""); setNewFeedUrl(""); setAddingFeed(false)
      fetchProviders()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add feed")
    }
  }

  const handleApplyProvider = async () => {
    if (!host || !pin) return
    setPushing(true)
    try {
      const res = await fetch(`${api}/providers/apply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleepAfter: String(sleepAfter), sleepMode: mode }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string; title?: string }
      if (!res.ok) throw new Error(data.error || "Apply failed")
      toast.success(`Applied "${data.title}"!`)
      const imgRes = await fetch(`${api}/last-image`)
      if (imgRes.ok) { const b = await imgRes.blob(); if (b.size > 0) setLastImage(URL.createObjectURL(b)) }
      onDisplayUpdated()
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      toast.error(`Apply failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setPushing(false) }
  }

  const handleDeleteProvider = async (id: string) => {
    await fetch(`${api}/providers/${id}`, { method: "DELETE" })
    fetchProviders()
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5 text-primary" />
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={() => { if (name !== display.name) saveConnection({ name } as Partial<DisplayConfig>) }}
              className="h-7 text-lg font-semibold border-none bg-transparent p-0 shadow-none focus-visible:ring-0 w-auto"
            />
          </DialogTitle>
          <DialogDescription className="flex items-center gap-3 text-xs">
            {status && (
              <>
                {status.battery && (
                  <span className="flex items-center gap-1">
                    {status.battery.charging ? <BatteryCharging className="h-3.5 w-3.5 text-green-500" /> : <BatteryMedium className="h-3.5 w-3.5" />}
                    {status.battery.level}%
                  </span>
                )}
                <span className={isOn ? "text-green-500" : "text-muted-foreground/50"}>
                  <Power className="h-3 w-3 inline mr-0.5" />{status.power ?? "?"}
                </span>
                {status.sleepTimer && (
                  <span className="text-amber-500">
                    <Moon className="h-3 w-3 inline mr-0.5" />{Math.ceil(status.sleepTimer.remainingMs / 60000)}m
                  </span>
                )}
              </>
            )}
            <Button variant="ghost" size="icon" className="h-5 w-5" onClick={fetchStatus} disabled={statusLoading}>
              <RefreshCw className={`h-3 w-3 ${statusLoading ? "animate-spin" : ""}`} />
            </Button>
          </DialogDescription>
        </DialogHeader>

        {/* Connection settings (collapsible) */}
        <div className="border border-border rounded-lg">
          <button
            type="button"
            onClick={() => setSettingsExpanded(!settingsExpanded)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
          >
            Connection Settings
            <span className="text-[10px]">{settingsExpanded ? "▲" : "▼"}</span>
          </button>
          {settingsExpanded && (
            <div className="px-3 pb-3 grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Host IP</Label>
                <Input value={host} onChange={e => setHost(e.target.value)}
                  onBlur={() => { if (host !== display.host) saveConnection({ host } as Partial<DisplayConfig>) }}
                  placeholder="192.168.1.37" className="h-8" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">PIN</Label>
                <Input value={pin} onChange={e => setPin(e.target.value)}
                  onBlur={() => { if (pin !== display.pin) saveConnection({ pin } as Partial<DisplayConfig>) }}
                  placeholder="000000" className="h-8" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">MAC <span className="text-muted-foreground">(WoL)</span></Label>
                <Input value={mac} onChange={e => setMac(e.target.value)}
                  onBlur={() => { if (mac !== display.mac) saveConnection({ mac } as Partial<DisplayConfig>) }}
                  placeholder="00:11:22:33:44:55" className="h-8" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Sleep After (min)</Label>
                <Input type="number" min={0} value={sleepAfter}
                  onChange={e => setSleepAfter(Math.max(0, parseInt(e.target.value) || 0))}
                  onBlur={() => { if (sleepAfter !== display.sleepAfter) saveConnection({ sleepAfter } as Partial<DisplayConfig>) }}
                  className="h-8" />
              </div>
            </div>
          )}
        </div>

        {/* Mode toggle */}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => handleSetMode("manual")}
            className={`flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors ${mode === "manual" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"}`}>
            <Send className={`h-4 w-4 mt-0.5 shrink-0 ${mode === "manual" ? "text-primary" : "text-muted-foreground"}`} />
            <div>
              <p className="text-sm font-medium">Manual</p>
              <p className="text-xs text-muted-foreground">Push images directly</p>
            </div>
          </button>
          <button type="button" onClick={() => handleSetMode("scheduled")}
            className={`flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors ${mode === "scheduled" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"}`}>
            <Clock className={`h-4 w-4 mt-0.5 shrink-0 ${mode === "scheduled" ? "text-primary" : "text-muted-foreground"}`} />
            <div>
              <p className="text-sm font-medium">Scheduled</p>
              <p className="text-xs text-muted-foreground">
                {schedule.enabled ? `Wake ${formatTime12h(schedule.hour, schedule.minute)} ${schedule.repeat}` : "Timer wake + auto push"}
              </p>
            </div>
          </button>
        </div>

        {/* Schedule config */}
        {isScheduled && (
          <div className="space-y-3 border border-border rounded-lg p-3">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">Wake Schedule</Label>
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox checked={schedule.enabled} onCheckedChange={v => updateSchedule({ enabled: !!v })} />
              <span className="text-sm">Enabled</span>
            </label>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Wake Time</Label>
                <Input type="time" value={formatTimeTo24h(schedule.hour, schedule.minute)}
                  onChange={e => { const [h, m] = e.target.value.split(":").map(Number); if (!isNaN(h) && !isNaN(m)) updateSchedule({ hour: h, minute: m }) }}
                  className="w-32 h-8" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Repeat</Label>
                <Select value={schedule.repeat} onValueChange={v => updateSchedule({ repeat: v })}>
                  <SelectTrigger className="w-[140px] h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekdays">Weekdays</SelectItem>
                    <SelectItem value="once">Once</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sleep After</Label>
                <div className="flex items-center gap-1">
                  <Input type="number" min={0} value={sleepAfter}
                    onChange={e => { const v = Math.max(0, parseInt(e.target.value) || 0); setSleepAfter(v); saveConnection({ sleepAfter: v } as Partial<DisplayConfig>) }}
                    className="w-16 h-8" />
                  <span className="text-xs text-muted-foreground">min</span>
                </div>
              </div>
            </div>
            {schedule.enabled && (
              <p className="text-xs text-muted-foreground">
                Wake at <span className="font-medium text-foreground">{formatTime12h(schedule.hour, schedule.minute)}</span>{" "}
                {schedule.repeat === "once" ? "(once)" : `every ${schedule.repeat === "weekdays" ? "weekday" : "day"}`}, push next image, sleep after {sleepAfter || 20}m.
              </p>
            )}

            {/* Image source */}
            <div className="pt-3 border-t border-border">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 block">Image Source</Label>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <button type="button" onClick={() => setSourceMode("queue")}
                  className={`flex items-center gap-2 rounded-lg border p-2 text-left transition-colors ${providerConfig.sourceMode === "queue" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"}`}>
                  <ListOrdered className={`h-4 w-4 shrink-0 ${providerConfig.sourceMode === "queue" ? "text-primary" : "text-muted-foreground"}`} />
                  <span className="text-sm font-medium">Queue</span>
                </button>
                <button type="button" onClick={() => { setSourceMode("provider"); fetchProviderPreview(providerConfig.activeProvider) }}
                  className={`flex items-center gap-2 rounded-lg border p-2 text-left transition-colors ${providerConfig.sourceMode === "provider" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"}`}>
                  <Rss className={`h-4 w-4 shrink-0 ${providerConfig.sourceMode === "provider" ? "text-primary" : "text-muted-foreground"}`} />
                  <span className="text-sm font-medium">Provider</span>
                </button>
              </div>

              {/* Queue panel */}
              {providerConfig.sourceMode === "queue" && (
                <div className="space-y-2">
                  {queue.images.length > 0 ? (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {queue.images.map((img, idx) => (
                        <div key={img.id} draggable onDragStart={() => handleQueueDragStart(idx)}
                          onDragOver={e => handleQueueDragOver(e, idx)} onDragEnd={handleQueueDragEnd}
                          className={`flex items-center gap-2 rounded-md border p-1 transition-colors ${idx === queue.currentIndex ? "border-primary/50 bg-primary/5" : "border-border"} ${dragIdx === idx ? "opacity-50" : ""}`}>
                          <GripVertical className="h-3.5 w-3.5 text-muted-foreground/50 cursor-grab shrink-0" />
                          <img src={`${api}/queue/image/${img.id}`} alt="" className="h-8 w-8 rounded object-cover shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/50"
                            onClick={() => handleLoadQueueImage(img)} />
                          <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleLoadQueueImage(img)}>
                            <p className="text-xs text-muted-foreground truncate">
                              {idx === queue.currentIndex && <span className="text-primary font-medium">Next · </span>}#{idx + 1}
                            </p>
                          </div>
                          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => handleRemoveFromQueue(img.id)}>
                            <Trash2 className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground text-center py-3">No images in queue</p>
                  )}
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="gap-1.5 flex-1 h-7 text-xs" onClick={() => queueFileRef.current?.click()}>
                      <Plus className="h-3 w-3" /> Add
                    </Button>
                    <Button variant="outline" size="sm" className="gap-1.5 flex-1 h-7 text-xs" onClick={handlePushNextInQueue}
                      disabled={pushing || queue.images.length === 0}>
                      {pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} Push Next
                    </Button>
                  </div>
                  <input ref={queueFileRef} type="file" accept="image/*" className="hidden" onChange={e => {
                    const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""
                  }} />
                </div>
              )}

              {/* Provider panel */}
              {providerConfig.sourceMode === "provider" && (
                <div className="space-y-2">
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {providerConfig.providers.map(p => (
                      <div key={p.id}
                        className={`flex items-center gap-2 rounded-md border p-1.5 cursor-pointer transition-colors ${providerConfig.activeProvider === p.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"}`}
                        onClick={() => setActiveProvider(p.id)}>
                        <Rss className={`h-3.5 w-3.5 shrink-0 ${providerConfig.activeProvider === p.id ? "text-primary" : "text-muted-foreground"}`} />
                        <span className="text-xs flex-1">{p.name}</span>
                        {!p.builtin && (
                          <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={e => { e.stopPropagation(); handleDeleteProvider(p.id) }}>
                            <Trash2 className="h-2.5 w-2.5 text-muted-foreground" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  {previewLoading && <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading...</p>}
                  {providerPreview && !previewLoading && (
                    <p className="text-xs text-muted-foreground">Showing &ldquo;{providerPreview.title}&rdquo;</p>
                  )}
                  {addingFeed ? (
                    <div className="space-y-1.5 border border-border rounded-md p-2">
                      <Input placeholder="Feed name" value={newFeedName} onChange={e => setNewFeedName(e.target.value)} className="h-7 text-xs" />
                      <Input placeholder="RSS/Atom feed URL" value={newFeedUrl} onChange={e => setNewFeedUrl(e.target.value)} className="h-7 text-xs" />
                      <div className="flex gap-2">
                        <Button size="sm" className="h-6 text-xs" onClick={handleAddCustomFeed} disabled={!newFeedName.trim() || !newFeedUrl.trim()}>Add</Button>
                        <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setAddingFeed(false)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <Button variant="outline" size="sm" className="gap-1.5 w-full h-7 text-xs" onClick={() => setAddingFeed(true)}>
                      <Plus className="h-3 w-3" /> Add Custom Feed
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Display / Crop area */}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {!imageSrc ? (
              <div className="p-3 space-y-3">
                {showingProvider ? (
                  <div className="flex flex-col items-center py-3">
                    <p className="text-xs font-medium text-primary uppercase tracking-wider mb-1">
                      <Rss className="h-3 w-3 inline mr-1" />
                      {providerConfig.providers.find(p => p.id === providerConfig.activeProvider)?.name}
                    </p>
                    <p className="text-sm font-medium mb-2 text-center max-w-[90%]">{providerPreview?.title}</p>
                    <img src={providerPreview!.imageUrl || undefined} alt={providerPreview?.title || ""}
                      className="max-h-[250px] max-w-full rounded-md border border-border shadow-lg object-contain" />
                    <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
                      <ExternalLink className="h-3 w-3" /> {providerPreview?.source}
                    </p>
                  </div>
                ) : lastImage ? (
                  <div className="flex flex-col items-center py-3">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Current display</p>
                    <img src={lastImage} alt="Current" className="max-h-[250px] max-w-full rounded-md border border-border shadow-lg object-contain cursor-pointer hover:ring-2 hover:ring-primary/50"
                      onClick={handleLoadLastImage} title="Click to edit" />
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <Monitor className="h-10 w-10 text-muted-foreground/30 mb-2" />
                    <p className="text-sm text-muted-foreground">No image on display</p>
                  </div>
                )}
                <div
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
                  onDragOver={e => e.preventDefault()}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center justify-center gap-2 cursor-pointer py-2 border border-dashed rounded-lg border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30 transition-colors"
                >
                  <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Drop or click to upload</span>
                </div>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={e => {
                  const f = e.target.files?.[0]; if (f) handleFile(f)
                }} />
              </div>
            ) : (
              <div>
                <div className="relative h-[300px] bg-black/50" style={{ filter: `brightness(${brightness}%) contrast(${contrast}%)` }}>
                  <Cropper image={imageSrc} crop={crop} zoom={zoom} rotation={rotation} aspect={aspect}
                    onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={onCropComplete} onMediaLoaded={onMediaLoaded} />
                </div>
                <div className="p-3 space-y-3 border-t border-border">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => { setOrientation(o => o === "landscape" ? "portrait" : "landscape"); setCrop({ x: 0, y: 0 }) }} className="gap-1.5 text-xs h-7">
                      {orientation === "landscape" ? <Monitor className="h-3 w-3" /> : <Smartphone className="h-3 w-3" />}
                      {orientation === "landscape" ? "16:9" : "9:16"}
                    </Button>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-muted-foreground">Out:</span>
                      {([0, 90, 180, 270] as const).map(deg => (
                        <Button key={deg} variant={outputRotation === deg ? "default" : "outline"} size="sm"
                          onClick={() => setOutputRotation(deg)} className="h-6 px-1.5 text-[10px]">{deg}°</Button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ZoomIn className="h-3 w-3" /> Zoom <span className="ml-auto tabular-nums">{zoom.toFixed(1)}x</span>
                      </div>
                      <Slider value={[zoom]} onValueChange={([v]) => setZoom(v)} min={1} max={3} step={0.1} />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <RotateCw className="h-3 w-3" /> Rotation <span className="ml-auto tabular-nums">{rotation}°</span>
                      </div>
                      <Slider value={[rotation]} onValueChange={([v]) => setRotation(v)} min={0} max={360} step={1} />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Sun className="h-3 w-3" /> Brightness <span className="ml-auto tabular-nums">{brightness}%</span>
                      </div>
                      <Slider value={[brightness]} onValueChange={([v]) => setBrightness(v)} min={0} max={200} step={1} />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Contrast className="h-3 w-3" /> Contrast <span className="ml-auto tabular-nums">{contrast}%</span>
                      </div>
                      <Slider value={[contrast]} onValueChange={([v]) => setContrast(v)} min={0} max={200} step={1} />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {imageSrc ? (
            <Button variant="outline" size="sm" onClick={clearImage} className="gap-1.5">
              <X className="h-3.5 w-3.5" /> Clear
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleWake} disabled={waking || (!mac && !host)} className="gap-1.5">
                {waking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />} Wake
              </Button>
              <Button variant="outline" size="sm" onClick={handleSleep} disabled={sleeping || !host} className="gap-1.5">
                {sleeping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />} Sleep
              </Button>
              <Button variant="destructive" size="sm" onClick={handleForceSleep} disabled={forceSleeping || !host || !pin} className="gap-1.5">
                {forceSleeping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />} Force Sleep
              </Button>
            </>
          )}
          <div className="flex-1" />
          {showingProvider && (
            <Button onClick={handleApplyProvider} disabled={pushing} className="gap-2" size="sm">
              {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Apply
            </Button>
          )}
          {imageSrc && isScheduled && (
            <Button variant="outline" size="sm" onClick={handleAddCroppedToQueue} disabled={pushing || !croppedAreaPixels} className="gap-1.5">
              {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add to Queue
            </Button>
          )}
          {imageSrc && (
            <Button onClick={handlePush} disabled={pushing || !croppedAreaPixels || !host || !pin} className="gap-2" size="sm">
              {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Push to Display
            </Button>
          )}
        </div>

        {/* Wake countdown */}
        {isScheduledSleep && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span>
              Wakes in <span className="font-medium text-foreground">{getTimeUntilWake(schedule.hour, schedule.minute)}</span>
              {" "}at <span className="font-medium text-foreground">{formatTime12h(schedule.hour, schedule.minute)}</span>
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
