import { useState, useCallback, useRef, useEffect } from "react"
import Cropper from "react-easy-crop"
import type { Area, Point } from "react-easy-crop"
import { Toaster, toast } from "sonner"
import {
  Upload,
  Send,
  RotateCw,
  X,
  Settings,
  Monitor,
  ZoomIn,
  Loader2,
  ImageIcon,
  ChevronDown,
  ChevronUp,
  Sun,
  Contrast,
  Power,
  PowerOff,
  BatteryMedium,
  BatteryCharging,
  Moon,
  RefreshCw,
  Smartphone,
  Clock,
  Trash2,
  GripVertical,
  Plus,
  Rss,
  ListOrdered,
  ExternalLink,
  Palette,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { getCroppedImageBlob } from "@/lib/crop-image"
import { loadSettings, saveSettings, loadDefaultsFromServer, type DisplaySettings, type SleepMode } from "@/lib/settings"

interface DisplayStatus {
  power: string | null
  battery: { level: number; charging: boolean; healthy: boolean; present: boolean } | null
  deviceName: string | null
  sleepTimer: { remainingMs: number; minutes: number } | null
}

interface Schedule {
  enabled: boolean
  hour: number
  minute: number
  repeat: string
}

interface QueueImage {
  id: string
  filename: string
  addedAt: string
}

interface QueueData {
  images: QueueImage[]
  currentIndex: number
}

interface Provider {
  id: string
  name: string
  feedUrl: string
  builtin: boolean
  type?: string
}

interface ProviderConfig {
  sourceMode: "queue" | "provider"
  activeProvider: string
  providers: Provider[]
}

interface ProviderPreview {
  title: string
  imageUrl: string | null
  source: string
  date: string | null
}

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

const ACCENT_THEMES = [
  { id: "default", label: "Default", swatch: "hsl(0 0% 98%)" },
  { id: "blue", label: "Blue", swatch: "hsl(217.2 91.2% 59.8%)" },
  { id: "green", label: "Green", swatch: "hsl(142.1 76.2% 36.3%)" },
  { id: "orange", label: "Orange", swatch: "hsl(24.6 95% 53.1%)" },
  { id: "red", label: "Red", swatch: "hsl(0 72.2% 50.6%)" },
  { id: "rose", label: "Rose", swatch: "hsl(346.8 77.2% 49.8%)" },
  { id: "violet", label: "Violet", swatch: "hsl(263.4 70% 50.4%)" },
  { id: "yellow", label: "Yellow", swatch: "hsl(47.9 95.8% 53.1%)" },
] as const

function loadTheme(): string {
  return localStorage.getItem("emdx-theme") || "default"
}

export default function App() {
  const [theme, setThemeState] = useState(loadTheme)
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [brightness, setBrightness] = useState(100)
  const [contrast, setContrast] = useState(100)
  const [orientation, setOrientation] = useState<"landscape" | "portrait">("portrait")
  const [outputRotation, setOutputRotation] = useState(90)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [pushing, setPushing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<DisplaySettings>(loadSettings)
  const [dragOver, setDragOver] = useState(false)
  const [status, setStatus] = useState<DisplayStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [waking, setWaking] = useState(false)
  const [sleeping, setSleeping] = useState(false)
  const [forceSleeping, setForceSleeping] = useState(false)
  const [lastImage, setLastImage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queueFileRef = useRef<HTMLInputElement>(null)

  // Schedule state
  const [schedule, setSchedule] = useState<Schedule>({ enabled: false, hour: 8, minute: 0, repeat: "daily" })

  // Queue state
  const [queue, setQueue] = useState<QueueData>({ images: [], currentIndex: 0 })
  const [dragIdx, setDragIdx] = useState<number | null>(null)

  // Provider state
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({ sourceMode: "queue", activeProvider: "nasa-iotd", providers: [] })
  const [providerPreview, setProviderPreview] = useState<ProviderPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [addingFeed, setAddingFeed] = useState(false)
  const [newFeedName, setNewFeedName] = useState("")
  const [newFeedUrl, setNewFeedUrl] = useState("")

  const aspect = orientation === "landscape" ? 16 / 9 : 9 / 16

  const setTheme = (id: string) => {
    setThemeState(id)
    localStorage.setItem("emdx-theme", id)
    if (id === "default") {
      document.documentElement.removeAttribute("data-theme")
    } else {
      document.documentElement.setAttribute("data-theme", id)
    }
  }

  useEffect(() => {
    const saved = loadTheme()
    if (saved !== "default") document.documentElement.setAttribute("data-theme", saved)
  }, [])

  // ─── Data fetching ───────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    if (!settings.host || !settings.pin) return
    setStatusLoading(true)
    try {
      const params = new URLSearchParams({ host: settings.host, pin: settings.pin })
      if (settings.mac) params.set("mac", settings.mac)
      const res = await fetch(`/api/status?${params}`)
      if (res.ok) {
        const data = await res.json().catch(() => null)
        if (data) setStatus(data)
      }
    } catch {
      /* display may be asleep */
    } finally {
      setStatusLoading(false)
    }
  }, [settings.host, settings.pin, settings.mac])

  const fetchSchedule = useCallback(async () => {
    try {
      const res = await fetch("/api/schedule")
      if (res.ok) setSchedule(await res.json())
    } catch { /* ignore */ }
  }, [])

  const fetchMode = useCallback(async () => {
    try {
      const res = await fetch("/api/mode")
      if (!res.ok) return
      const data = await res.json().catch(() => null) as { mode?: SleepMode } | null
      const mode: SleepMode = data?.mode === "scheduled" ? "scheduled" : "manual"
      setSettings(prev => {
        if (prev.sleepMode === mode) return prev
        const next = { ...prev, sleepMode: mode }
        saveSettings(next)
        return next
      })
    } catch { /* ignore */ }
  }, [])

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/queue")
      if (res.ok) setQueue(await res.json())
    } catch { /* ignore */ }
  }, [])

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers")
      if (res.ok) setProviderConfig(await res.json())
    } catch { /* ignore */ }
  }, [])

  const fetchProviderPreview = useCallback(async (id: string) => {
    setPreviewLoading(true)
    setProviderPreview(null)
    try {
      const res = await fetch(`/api/providers/${id}/preview`)
      if (res.ok) setProviderPreview(await res.json())
    } catch { /* ignore */ }
    setPreviewLoading(false)
  }, [])

  useEffect(() => {
    loadDefaultsFromServer().then(defaults => {
      if (!defaults) return
      setSettings(prev => {
        const merged = {
          host: prev.host || defaults.host || "",
          pin: prev.pin || defaults.pin || "",
          mac: prev.mac || defaults.mac || "",
          sleepAfter: prev.sleepAfter ?? defaults.sleepAfter ?? 20,
          sleepMode: prev.sleepMode || "manual" as SleepMode,
        }
        if (merged.host !== prev.host || merged.pin !== prev.pin || merged.mac !== prev.mac || merged.sleepAfter !== prev.sleepAfter || merged.sleepMode !== prev.sleepMode) {
          saveSettings(merged)
        }
        return merged
      })
    })

    fetchStatus()
    fetchMode()
    fetchSchedule()
    fetchQueue()
    fetchProviders()
    fetch("/api/last-image").then(r => {
      if (r.ok) return r.blob()
      return null
    }).then(blob => {
      if (blob && blob.size > 0) setLastImage(URL.createObjectURL(blob))
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (providerConfig.sourceMode === "provider" && providerConfig.activeProvider && !providerPreview) {
      fetchProviderPreview(providerConfig.activeProvider)
    }
  }, [providerConfig.sourceMode, providerConfig.activeProvider]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Crop handlers ───────────────────────────────────────────────────────

  const onCropComplete = useCallback((_: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels)
  }, [])

  const onMediaLoaded = useCallback((mediaSize: { width: number; height: number }) => {
    const { width: w, height: h } = mediaSize
    const targetAspect = aspect
    let cropW: number, cropH: number
    if (w / h > targetAspect) {
      cropH = h
      cropW = h * targetAspect
    } else {
      cropW = w
      cropH = w / targetAspect
    }
    setCroppedAreaPixels({ x: (w - cropW) / 2, y: (h - cropH) / 2, width: cropW, height: cropH })
  }, [aspect])

  const handleLoadLastImage = useCallback(() => {
    if (!lastImage) return
    setImageSrc(lastImage)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setRotation(0)
    setOutputRotation(90)
  }, [lastImage])

  const handleLoadQueueImage = useCallback((id: string) => {
    setImageSrc(`/api/queue/image/${id}`)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setRotation(0)
    setBrightness(100)
    setContrast(100)
    setOrientation("portrait")
    setOutputRotation(90)
  }, [])

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please drop an image file")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setImageSrc(reader.result as string)
      setCrop({ x: 0, y: 0 })
      setZoom(1)
      setRotation(0)
      setBrightness(100)
      setContrast(100)
      setOutputRotation(90)
    }
    reader.readAsDataURL(file)
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile()
        if (file) handleFile(file)
        return
      }
    }
  }, [handleFile])

  const clearImage = () => {
    setImageSrc(null)
    setCroppedAreaPixels(null)
    setZoom(1)
    setRotation(0)
    setBrightness(100)
    setContrast(100)
    setOrientation("portrait")
    setOutputRotation(90)
  }

  // ─── Push / Wake / Sleep handlers ────────────────────────────────────────

  const handlePush = async () => {
    if (!imageSrc || !croppedAreaPixels) return
    if (!settings.host || !settings.pin) {
      toast.error("Configure display host and PIN in settings")
      setSettingsOpen(true)
      return
    }
    setPushing(true)
    try {
      const blob = await getCroppedImageBlob(imageSrc, croppedAreaPixels, rotation, brightness, contrast, outputRotation)
      const formData = new FormData()
      formData.append("image", blob, "display.jpg")
      formData.append("host", settings.host)
      formData.append("pin", settings.pin)
      if (settings.mac) formData.append("mac", settings.mac)
      formData.append("sleepAfter", String(settings.sleepAfter))
      formData.append("sleepMode", settings.sleepMode)

      const res = await fetch("/api/push", { method: "POST", body: formData })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText || "Push failed")

      const sleepMsg = settings.sleepAfter > 0 ? ` Display will sleep in ${settings.sleepAfter}min.` : ""
      toast.success(`Image pushed to display!${sleepMsg}`)
      setLastImage(URL.createObjectURL(blob))
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error"
      toast.error(`Failed: ${message}`)
    } finally {
      setPushing(false)
    }
  }

  const handleWake = async () => {
    if (!settings.mac && !settings.host) {
      toast.error("Host IP or MAC address required to wake. Set them in settings.")
      setSettingsOpen(true)
      return
    }
    setWaking(true)
    try {
      const res = await fetch("/api/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: settings.host, pin: settings.pin, mac: settings.mac }),
      })
      const data = await res.json().catch(() => ({})) as { success?: boolean; method?: string; error?: string }
      if (!res.ok) throw new Error(data.error || res.statusText || "Wake failed")
      const methodMsg = data.method === "mdc" ? "Woken via network (MDC)" : "Wake-on-LAN sent"
      toast.success(`${methodMsg}!`)
      setTimeout(fetchStatus, 3000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error"
      toast.error(`Wake failed: ${message}`)
    } finally {
      setWaking(false)
    }
  }

  const handleSleep = async () => {
    if (!settings.host || !settings.pin) return
    setSleeping(true)
    try {
      const res = await fetch("/api/sleep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: settings.host, pin: settings.pin, mac: settings.mac, sleepMode: settings.sleepMode }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText || "Sleep failed")
      const label = settings.sleepMode === "scheduled"
        ? `scheduled sleep (wakes ${formatTime12h(schedule.hour, schedule.minute)} ${schedule.repeat})`
        : "powered off"
      toast.success(`Display ${label}`)
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error"
      toast.error(`Sleep failed: ${message}`)
    } finally {
      setSleeping(false)
    }
  }

  const handleForceSleep = async () => {
    if (!settings.host || !settings.pin) return
    setForceSleeping(true)
    try {
      const res = await fetch("/api/sleep/force", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: settings.host, pin: settings.pin, mac: settings.mac }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText || "Force sleep failed")
      toast.success("Display forced into deep sleep (power button required to wake)")
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error"
      toast.error(`Force sleep failed: ${message}`)
    } finally {
      setForceSleeping(false)
    }
  }

  // ─── Schedule handlers ───────────────────────────────────────────────────

  const updateSchedule = async (patch: Partial<Schedule>) => {
    const next = { ...schedule, ...patch }
    setSchedule(next)
    await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).catch(() => {})
  }

  // ─── Queue handlers ─────────────────────────────────────────────────────

  const handleAddToQueue = async (file: File) => {
    const formData = new FormData()
    formData.append("image", file)
    try {
      const res = await fetch("/api/queue", { method: "POST", body: formData })
      if (!res.ok) throw new Error("Failed to add to queue")
      toast.success("Image added to queue")
      fetchQueue()
    } catch {
      toast.error("Failed to add image to queue")
    }
  }

  const handleAddCroppedToQueue = async () => {
    if (!imageSrc || !croppedAreaPixels) return
    setPushing(true)
    try {
      const blob = await getCroppedImageBlob(imageSrc, croppedAreaPixels, rotation, brightness, contrast, outputRotation)
      const formData = new FormData()
      formData.append("image", blob, "queued.jpg")
      const res = await fetch("/api/queue", { method: "POST", body: formData })
      if (!res.ok) throw new Error("Failed to add to queue")
      toast.success("Image added to queue")
      fetchQueue()
      clearImage()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error"
      toast.error(`Failed to queue: ${message}`)
    } finally {
      setPushing(false)
    }
  }

  const handleRemoveFromQueue = async (id: string) => {
    await fetch(`/api/queue/${id}`, { method: "DELETE" })
    fetchQueue()
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
    await fetch("/api/queue/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: queue.images.map(i => i.id) }),
    })
  }

  // ─── Provider handlers ──────────────────────────────────────────────────

  const setSourceMode = async (mode: "queue" | "provider") => {
    setProviderConfig(prev => ({ ...prev, sourceMode: mode }))
    if (mode === "provider" && imageSrc) {
      clearImage()
    }
    await fetch("/api/providers/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceMode: mode }),
    })
  }

  const setActiveProvider = async (id: string) => {
    setProviderConfig(prev => ({ ...prev, activeProvider: id }))
    await fetch("/api/providers/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeProvider: id }),
    })
    fetchProviderPreview(id)
  }

  const handleAddCustomFeed = async () => {
    if (!newFeedName.trim() || !newFeedUrl.trim()) return
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newFeedName.trim(), feedUrl: newFeedUrl.trim() }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || "Failed to add feed")
      toast.success("Feed added")
      setNewFeedName("")
      setNewFeedUrl("")
      setAddingFeed(false)
      fetchProviders()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to add feed"
      toast.error(message)
    }
  }

  const handleApplyProvider = async () => {
    if (!settings.host || !settings.pin) {
      toast.error("Configure display host and PIN in settings")
      setSettingsOpen(true)
      return
    }
    setPushing(true)
    try {
      const res = await fetch("/api/providers/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: settings.host,
          pin: settings.pin,
          mac: settings.mac || undefined,
          sleepAfter: String(settings.sleepAfter),
          sleepMode: settings.sleepMode,
        }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string; title?: string }
      if (!res.ok) throw new Error(data.error || "Apply failed")
      const sleepMsg = settings.sleepAfter > 0 ? ` Display will sleep in ${settings.sleepAfter}min.` : ""
      toast.success(`Applied "${data.title || "provider image"}"!${sleepMsg}`)
      fetch("/api/last-image").then(r => {
        if (r.ok) return r.blob()
        return null
      }).then(blob => {
        if (blob && blob.size > 0) setLastImage(URL.createObjectURL(blob))
      })
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error"
      toast.error(`Apply failed: ${message}`)
    } finally {
      setPushing(false)
    }
  }

  const handleDeleteProvider = async (id: string) => {
    await fetch(`/api/providers/${id}`, { method: "DELETE" })
    fetchProviders()
  }

  // ─── Settings ────────────────────────────────────────────────────────────

  const updateSetting = <K extends keyof DisplaySettings>(key: K, value: DisplaySettings[K]) => {
    const next = { ...settings, [key]: value }
    setSettings(next)
    saveSettings(next)
  }

  const setMode = async (mode: SleepMode) => {
    updateSetting("sleepMode", mode)
    await fetch("/api/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).catch(() => {})

    if (mode === "scheduled") {
      fetchSchedule()
    }
  }

  const isOn = status?.power === "On"
  const isScheduled = settings.sleepMode === "scheduled"
  const isScheduledSleep = isScheduled && !isOn && schedule.enabled
  const showingProvider = isScheduled && !imageSrc && providerConfig.sourceMode === "provider" && !!providerPreview?.imageUrl

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background p-4 md:p-8" onPaste={onPaste}>
      <Toaster theme="dark" position="top-center" richColors />

      <div className="mx-auto max-w-3xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Monitor className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Samsung EMDX</h1>
              <p className="text-xs text-muted-foreground">E-Paper Display Controller</p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger className="w-auto h-8 gap-1.5 border-none bg-transparent shadow-none text-muted-foreground hover:text-foreground px-2">
                <Palette className="h-4 w-4" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {ACCENT_THEMES.map(t => (
                  <SelectItem key={t.id} value={t.id}>
                    <span className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-full shrink-0" style={{ background: t.swatch }} />
                      {t.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {status && (
              <div className="flex items-center gap-2 mr-2 text-xs text-muted-foreground">
                {status.battery && (
                  <span className="flex items-center gap-1" title={`Battery: ${status.battery.level}%${status.battery.charging ? " (charging)" : ""}`}>
                    {status.battery.charging ? <BatteryCharging className="h-4 w-4 text-green-500" /> : <BatteryMedium className="h-4 w-4" />}
                    <span className="tabular-nums">{status.battery.level}%</span>
                  </span>
                )}
                <span className={`flex items-center gap-1 ${isOn ? "text-green-500" : "text-muted-foreground/50"}`}>
                  <Power className="h-3.5 w-3.5" />
                  <span>{status.power ?? "?"}</span>
                </span>
                {status.sleepTimer && (
                  <span className="flex items-center gap-1" title={`Sleeping in ${Math.ceil(status.sleepTimer.remainingMs / 60000)}min`}>
                    <Moon className="h-3.5 w-3.5" />
                    <span className="tabular-nums">{Math.ceil(status.sleepTimer.remainingMs / 60000)}m</span>
                  </span>
                )}
              </div>
            )}
            <Button variant="ghost" size="icon" onClick={fetchStatus} disabled={statusLoading} title="Refresh status">
              <RefreshCw className={`h-4 w-4 ${statusLoading ? "animate-spin" : ""}`} />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(!settingsOpen)} className="relative">
              <Settings className="h-5 w-5" />
              {(!settings.host || !settings.pin) && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-destructive" />}
            </Button>
          </div>
        </div>

        {/* Settings */}
        {settingsOpen && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Display Connection</h2>
                <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(false)}>
                  <ChevronUp className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="host">Host IP</Label>
                  <Input id="host" placeholder="192.168.1.37" value={settings.host} onChange={(e) => updateSetting("host", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pin">PIN</Label>
                  <Input id="pin" placeholder="000000" value={settings.pin} onChange={(e) => updateSetting("pin", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mac">MAC <span className="text-muted-foreground">(for Wake-on-LAN)</span></Label>
                  <Input id="mac" placeholder="00:11:22:33:44:55" value={settings.mac} onChange={(e) => updateSetting("mac", e.target.value)} />
                </div>
              </div>

              {/* Mode toggle */}
              <div className="mt-4 pt-4 border-t border-border">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 block">Mode</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setMode("manual")}
                    className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${settings.sleepMode === "manual" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"}`}>
                    <Send className={`h-4 w-4 mt-0.5 shrink-0 ${settings.sleepMode === "manual" ? "text-primary" : "text-muted-foreground"}`} />
                    <div>
                      <p className="text-sm font-medium">Manual</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Push images directly. No auto push.</p>
                    </div>
                  </button>
                  <button type="button" onClick={() => setMode("scheduled")}
                    className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${settings.sleepMode === "scheduled" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"}`}>
                    <Clock className={`h-4 w-4 mt-0.5 shrink-0 ${settings.sleepMode === "scheduled" ? "text-primary" : "text-muted-foreground"}`} />
                    <div>
                      <p className="text-sm font-medium">Scheduled</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {schedule.enabled
                          ? `Wake ${formatTime12h(schedule.hour, schedule.minute)} ${schedule.repeat}`
                          : "Timer wake + auto queue push"}
                      </p>
                    </div>
                  </button>
                </div>
              </div>

              {/* Schedule config (when scheduled mode selected) */}
              {settings.sleepMode === "scheduled" && (
                <div className="mt-4 pt-4 border-t border-border space-y-4">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">Wake Schedule</Label>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={schedule.enabled}
                        onCheckedChange={(v) => updateSchedule({ enabled: !!v })}
                      />
                      <span className="text-sm">Enabled</span>
                    </label>
                  </div>
                  <div className="flex items-end gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Wake Time</Label>
                      <Input
                        type="time"
                        value={formatTimeTo24h(schedule.hour, schedule.minute)}
                        onChange={(e) => {
                          const [h, m] = e.target.value.split(":").map(Number)
                          if (!isNaN(h) && !isNaN(m)) updateSchedule({ hour: h, minute: m })
                        }}
                        className="w-32"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Repeat</Label>
                      <Select value={schedule.repeat} onValueChange={(v) => updateSchedule({ repeat: v })}>
                        <SelectTrigger className="w-[160px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekdays">Weekdays (Mon-Fri)</SelectItem>
                          <SelectItem value="once">Once</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Sleep After</Label>
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          min={0}
                          value={settings.sleepAfter}
                          onChange={(e) => updateSetting("sleepAfter", Math.max(0, parseInt(e.target.value) || 0))}
                          className="w-20"
                        />
                        <span className="text-xs text-muted-foreground">min</span>
                      </div>
                    </div>
                  </div>
                  {schedule.enabled && (
                    <p className="text-xs text-muted-foreground">
                      Display will wake at <span className="font-medium text-foreground">{formatTime12h(schedule.hour, schedule.minute)}</span> {schedule.repeat === "once" ? "(once)" : `every ${schedule.repeat === "weekdays" ? "weekday" : "day"}`}, push the next image, then sleep after {settings.sleepAfter || 20} min.
                    </p>
                  )}

                  {/* Image source picker */}
                  <div className="pt-4 border-t border-border">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 block">Image Source</Label>
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      <button type="button" onClick={() => setSourceMode("queue")}
                        className={`flex items-center gap-2 rounded-lg border p-2.5 text-left transition-colors ${providerConfig.sourceMode === "queue" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"}`}>
                        <ListOrdered className={`h-4 w-4 shrink-0 ${providerConfig.sourceMode === "queue" ? "text-primary" : "text-muted-foreground"}`} />
                        <span className="text-sm font-medium">Manual Queue</span>
                      </button>
                      <button type="button" onClick={() => { setSourceMode("provider"); fetchProviderPreview(providerConfig.activeProvider) }}
                        className={`flex items-center gap-2 rounded-lg border p-2.5 text-left transition-colors ${providerConfig.sourceMode === "provider" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"}`}>
                        <Rss className={`h-4 w-4 shrink-0 ${providerConfig.sourceMode === "provider" ? "text-primary" : "text-muted-foreground"}`} />
                        <span className="text-sm font-medium">Auto Provider</span>
                      </button>
                    </div>

                    {/* Queue panel */}
                    {providerConfig.sourceMode === "queue" && (
                      <div className="space-y-3">
                        {queue.images.length > 0 ? (
                          <div className="space-y-1">
                            {queue.images.map((img, idx) => (
                              <div
                                key={img.id}
                                draggable
                                onDragStart={() => handleQueueDragStart(idx)}
                                onDragOver={(e) => handleQueueDragOver(e, idx)}
                                onDragEnd={handleQueueDragEnd}
                                className={`flex items-center gap-2 rounded-md border p-1.5 transition-colors ${
                                  idx === queue.currentIndex ? "border-primary/50 bg-primary/5" : "border-border"
                                } ${dragIdx === idx ? "opacity-50" : ""}`}
                              >
                                <GripVertical className="h-4 w-4 text-muted-foreground/50 cursor-grab shrink-0" />
                                <img
                                  src={`/api/queue/image/${img.id}`}
                                  alt=""
                                  className="h-10 w-10 rounded object-cover shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-shadow"
                                  onClick={() => handleLoadQueueImage(img.id)}
                                  title="Click to edit"
                                />
                                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleLoadQueueImage(img.id)}>
                                  <p className="text-xs text-muted-foreground truncate">
                                    {idx === queue.currentIndex && <span className="text-primary font-medium">Next &middot; </span>}
                                    #{idx + 1}
                                  </p>
                                </div>
                                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => handleRemoveFromQueue(img.id)}>
                                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground text-center py-4">No images in queue. Add some below.</p>
                        )}
                        <Button variant="outline" size="sm" className="gap-2 w-full" onClick={() => queueFileRef.current?.click()}>
                          <Plus className="h-3.5 w-3.5" /> Add Image to Queue
                        </Button>
                        <input ref={queueFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) handleFile(file)
                          e.target.value = ""
                        }} />
                      </div>
                    )}

                    {/* Provider panel */}
                    {providerConfig.sourceMode === "provider" && (
                      <div className="space-y-3">
                        <div className="space-y-1">
                          {providerConfig.providers.map(p => (
                            <div key={p.id}
                              className={`flex items-center gap-2 rounded-md border p-2 cursor-pointer transition-colors ${
                                providerConfig.activeProvider === p.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-muted-foreground/50"
                              }`}
                              onClick={() => setActiveProvider(p.id)}>
                              <Rss className={`h-4 w-4 shrink-0 ${providerConfig.activeProvider === p.id ? "text-primary" : "text-muted-foreground"}`} />
                              <span className="text-sm flex-1">{p.name}</span>
                              {!p.builtin && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={(e) => { e.stopPropagation(); handleDeleteProvider(p.id) }}>
                                  <Trash2 className="h-3 w-3 text-muted-foreground" />
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>

                        {previewLoading && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading preview...</p>}
                        {providerPreview && !previewLoading && (
                          <p className="text-xs text-muted-foreground">Showing <span className="font-medium text-foreground">&ldquo;{providerPreview.title}&rdquo;</span> in display area</p>
                        )}

                        {/* Add custom feed */}
                        {addingFeed ? (
                          <div className="space-y-2 border border-border rounded-md p-2">
                            <Input placeholder="Feed name" value={newFeedName} onChange={(e) => setNewFeedName(e.target.value)} className="h-8 text-sm" />
                            <Input placeholder="RSS/Atom feed URL" value={newFeedUrl} onChange={(e) => setNewFeedUrl(e.target.value)} className="h-8 text-sm" />
                            <div className="flex gap-2">
                              <Button size="sm" className="h-7 text-xs" onClick={handleAddCustomFeed} disabled={!newFeedName.trim() || !newFeedUrl.trim()}>Add</Button>
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAddingFeed(false)}>Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <Button variant="outline" size="sm" className="gap-2 w-full" onClick={() => setAddingFeed(true)}>
                            <Plus className="h-3.5 w-3.5" /> Add Custom Feed
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

            </CardContent>
          </Card>
        )}

        {/* Display Area */}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {!imageSrc ? (
              <div className="p-4 space-y-4">
                {showingProvider ? (
                  <div className="flex flex-col items-center py-4">
                    <p className="text-xs font-medium text-primary uppercase tracking-wider mb-1">
                      <Rss className="h-3 w-3 inline mr-1" />
                      {providerConfig.providers.find(p => p.id === providerConfig.activeProvider)?.name}
                    </p>
                    <p className="text-sm font-medium mb-3 text-center max-w-[90%]">{providerPreview?.title}</p>
                    <img
                      src={providerPreview!.imageUrl || undefined}
                      alt={providerPreview?.title || "Provider image"}
                      className="max-h-[350px] max-w-full rounded-md border border-border shadow-lg object-contain"
                    />
                    <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                      <ExternalLink className="h-3 w-3" /> {providerPreview?.source}
                    </p>
                  </div>
                ) : lastImage ? (
                  <div className="flex flex-col items-center py-4">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Currently on display</p>
                    <img
                      src={lastImage}
                      alt="Current display"
                      className="max-h-[350px] max-w-full rounded-md border border-border shadow-lg object-contain cursor-pointer hover:ring-2 hover:ring-primary/50 transition-shadow"
                      onClick={handleLoadLastImage}
                      title="Click to edit this image"
                    />
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Monitor className="h-12 w-12 text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">No image on display</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">Upload an image or select a provider</p>
                  </div>
                )}
                <div
                  onDrop={onDrop}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onClick={() => fileInputRef.current?.click()}
                  className={`flex items-center justify-center gap-3 cursor-pointer py-3 transition-all duration-200 border border-dashed rounded-lg ${
                    dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30"
                  }`}
                >
                  {dragOver
                    ? <><ImageIcon className="h-4 w-4 text-primary" /><span className="text-sm font-medium text-primary">Drop it!</span></>
                    : <><Upload className="h-4 w-4 text-muted-foreground" /><span className="text-sm text-muted-foreground">Drop image here or click to upload</span></>
                  }
                </div>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                }} />
              </div>
            ) : (
              <div>
                <div className="relative h-[420px] bg-black/50" style={{ filter: `brightness(${brightness}%) contrast(${contrast}%)` }}>
                  <Cropper image={imageSrc} crop={crop} zoom={zoom} rotation={rotation} aspect={aspect}
                    onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={onCropComplete} onMediaLoaded={onMediaLoaded} />
                </div>
                <div className="p-4 space-y-4 border-t border-border">
                  <div className="flex flex-wrap items-center gap-3 mb-2">
                    <Button variant="outline" size="sm" onClick={() => { setOrientation(o => o === "landscape" ? "portrait" : "landscape"); setCrop({ x: 0, y: 0 }) }} className="gap-2 text-xs">
                      {orientation === "landscape" ? <Monitor className="h-3.5 w-3.5" /> : <Smartphone className="h-3.5 w-3.5" />}
                      {orientation === "landscape" ? "Landscape 16:9" : "Portrait 9:16"}
                    </Button>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">Output:</span>
                      {([0, 90, 180, 270] as const).map((deg) => (
                        <Button key={deg} variant={outputRotation === deg ? "default" : "outline"} size="sm" onClick={() => setOutputRotation(deg)} className="h-7 px-2 text-xs">{deg}°</Button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <ZoomIn className="h-3.5 w-3.5" /> Zoom <span className="ml-auto tabular-nums">{zoom.toFixed(1)}x</span>
                      </div>
                      <Slider value={[zoom]} onValueChange={([v]) => setZoom(v)} min={1} max={3} step={0.1} />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <RotateCw className="h-3.5 w-3.5" /> Rotation <span className="ml-auto tabular-nums">{rotation}°</span>
                      </div>
                      <Slider value={[rotation]} onValueChange={([v]) => setRotation(v)} min={0} max={360} step={1} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <Sun className="h-3.5 w-3.5" /> Brightness <span className="ml-auto tabular-nums">{brightness}%</span>
                      </div>
                      <Slider value={[brightness]} onValueChange={([v]) => setBrightness(v)} min={0} max={200} step={1} />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <Contrast className="h-3.5 w-3.5" /> Contrast <span className="ml-auto tabular-nums">{contrast}%</span>
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
        <div className="flex items-center gap-3">
          {imageSrc ? (
            <Button variant="outline" onClick={clearImage} className="gap-2">
              <X className="h-4 w-4" /> Clear
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleWake} disabled={waking || (!settings.mac && !settings.host)} className="gap-2">
                {waking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                Wake
              </Button>
              <Button variant="outline" size="sm" onClick={handleSleep} disabled={sleeping || !settings.host} className="gap-2">
                {sleeping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />}
                Sleep
              </Button>
              <Button variant="destructive" size="sm" onClick={handleForceSleep} disabled={forceSleeping || !settings.host || !settings.pin} className="gap-2">
                {forceSleeping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />}
                Force Sleep
              </Button>
            </>
          )}
          <div className="flex-1" />
          {!settingsOpen && settings.host && (
            <span className="text-xs text-muted-foreground hidden sm:block">
              {settings.host}
              {settings.sleepAfter > 0 && <span className="ml-1 text-muted-foreground/50">&middot; sleep {settings.sleepAfter}m</span>}
            </span>
          )}
          {!settingsOpen && (
            <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)}>
              <ChevronDown className="h-4 w-4" />
            </Button>
          )}
          {showingProvider && (
            <Button onClick={handleApplyProvider} disabled={pushing} className="gap-2 min-w-[180px]" size="lg">
              {pushing ? (<><Loader2 className="h-4 w-4 animate-spin" /> Applying...</>) : (<><Send className="h-4 w-4" /> Apply</>)}
            </Button>
          )}
          {imageSrc && (
            isScheduled ? (
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={handleAddCroppedToQueue} disabled={pushing || !croppedAreaPixels} className="gap-2">
                  {pushing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add to Queue
                </Button>
                <Button onClick={handlePush} disabled={pushing || !croppedAreaPixels} className="gap-2 min-w-[180px]" size="lg">
                  {pushing ? (<><Loader2 className="h-4 w-4 animate-spin" /> Pushing...</>) : (<><Send className="h-4 w-4" /> Push to Display</>)}
                </Button>
              </div>
            ) : (
              <Button onClick={handlePush} disabled={pushing || !croppedAreaPixels} className="gap-2 min-w-[180px]" size="lg">
                {pushing ? (<><Loader2 className="h-4 w-4 animate-spin" /> Pushing...</>) : (<><Send className="h-4 w-4" /> Push to Display</>)}
              </Button>
            )
          )}
        </div>

        {/* Wake countdown */}
        {isScheduledSleep && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-4 py-2.5">
            <Clock className="h-4 w-4 shrink-0" />
            <span>
              Screen will wake up in{" "}
              <span className="font-medium text-foreground">{getTimeUntilWake(schedule.hour, schedule.minute)}</span>
              {" "}at{" "}
              <span className="font-medium text-foreground">{formatTime12h(schedule.hour, schedule.minute)}</span>
            </span>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground/50 pt-4">
          Images are cropped to {orientation === "landscape" ? "16:9" : "9:16"} and sent via Samsung MDC protocol
        </p>
      </div>
    </div>
  )
}
