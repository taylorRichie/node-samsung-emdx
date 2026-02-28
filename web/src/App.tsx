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
  MonitorSmartphone,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { getCroppedImageBlob } from "@/lib/crop-image"
import { loadSettings, saveSettings, loadDefaultsFromServer, type DisplaySettings } from "@/lib/settings"

interface DisplayStatus {
  power: string | null
  battery: { level: number; charging: boolean; healthy: boolean; present: boolean } | null
  deviceName: string | null
  sleepTimer: { remainingMs: number; minutes: number } | null
}

export default function App() {
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
  const [lastImage, setLastImage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const aspect = orientation === "landscape" ? 16 / 9 : 9 / 16

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

  useEffect(() => {
    // Load server defaults if no settings have been saved locally yet
    if (!settings.host) {
      loadDefaultsFromServer().then(defaults => {
        if (defaults && defaults.host) {
          const merged = { ...settings, ...defaults }
          setSettings(merged)
          saveSettings(merged)
        }
      })
    }

    fetchStatus()
    fetch("/api/last-image").then(r => {
      if (r.ok) return r.blob()
      return null
    }).then(blob => {
      if (blob && blob.size > 0) setLastImage(URL.createObjectURL(blob))
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    setCroppedAreaPixels({
      x: (w - cropW) / 2,
      y: (h - cropH) / 2,
      width: cropW,
      height: cropH,
    })
  }, [aspect])

  const handleLoadLastImage = useCallback(() => {
    if (!lastImage) return
    setImageSrc(lastImage)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setRotation(0)
  }, [lastImage])

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
    }
    reader.readAsDataURL(file)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile]
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile()
          if (file) handleFile(file)
          return
        }
      }
    },
    [handleFile]
  )

  const clearImage = () => {
    setImageSrc(null)
    setCroppedAreaPixels(null)
    setZoom(1)
    setRotation(0)
    setBrightness(100)
    setContrast(100)
  }

  const handlePush = async () => {
    if (!imageSrc || !croppedAreaPixels) return

    if (!settings.host || !settings.pin) {
      toast.error("Configure display host and PIN in settings")
      setSettingsOpen(true)
      return
    }

    setPushing(true)
    try {
      const blob = await getCroppedImageBlob(
        imageSrc, croppedAreaPixels, rotation, brightness, contrast, outputRotation
      )

      const formData = new FormData()
      formData.append("image", blob, "display.jpg")
      formData.append("host", settings.host)
      formData.append("pin", settings.pin)
      if (settings.mac) formData.append("mac", settings.mac)
      formData.append("sleepAfter", String(settings.sleepAfter))

      const res = await fetch("/api/push", { method: "POST", body: formData })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText || "Push failed")

      const sleepMsg = settings.sleepAfter > 0
        ? ` Display will sleep in ${settings.sleepAfter}min.`
        : ""
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
    if (!settings.mac) {
      toast.error("MAC address required for Wake-on-LAN. Set it in settings.")
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
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText || "Wake failed")
      toast.success("Wake-on-LAN sent!")
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
        body: JSON.stringify({ host: settings.host, pin: settings.pin, mac: settings.mac }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText || "Sleep failed")
      toast.success("Display powered off")
      setTimeout(fetchStatus, 2000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error"
      toast.error(`Sleep failed: ${message}`)
    } finally {
      setSleeping(false)
    }
  }

  const updateSetting = <K extends keyof DisplaySettings>(
    key: K,
    value: DisplaySettings[K]
  ) => {
    const next = { ...settings, [key]: value }
    setSettings(next)
    saveSettings(next)
  }

  const isOn = status?.power === "On"

  return (
    <div className="min-h-screen bg-background p-4 md:p-8" onPaste={onPaste}>
      <Toaster theme="dark" position="top-center" richColors />

      <div className="mx-auto max-w-3xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Monitor className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">
                Samsung EMDX
              </h1>
              <p className="text-xs text-muted-foreground">
                E-Paper Display Controller
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {/* Status indicators */}
            {status && (
              <div className="flex items-center gap-2 mr-2 text-xs text-muted-foreground">
                {status.battery && (
                  <span className="flex items-center gap-1" title={`Battery: ${status.battery.level}%${status.battery.charging ? " (charging)" : ""}`}>
                    {status.battery.charging
                      ? <BatteryCharging className="h-4 w-4 text-green-500" />
                      : <BatteryMedium className="h-4 w-4" />
                    }
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

            <Button
              variant="ghost"
              size="icon"
              onClick={fetchStatus}
              disabled={statusLoading}
              title="Refresh status"
            >
              <RefreshCw className={`h-4 w-4 ${statusLoading ? "animate-spin" : ""}`} />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(!settingsOpen)}
              className="relative"
            >
              <Settings className="h-5 w-5" />
              {(!settings.host || !settings.pin) && (
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-destructive" />
              )}
            </Button>
          </div>
        </div>

        {/* Settings */}
        {settingsOpen && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Display Connection
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSettingsOpen(false)}
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="host">Host IP</Label>
                  <Input
                    id="host"
                    placeholder="192.168.1.37"
                    value={settings.host}
                    onChange={(e) => updateSetting("host", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pin">PIN</Label>
                  <Input
                    id="pin"
                    placeholder="000000"
                    value={settings.pin}
                    onChange={(e) => updateSetting("pin", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mac">
                    MAC <span className="text-muted-foreground">(for Wake-on-LAN)</span>
                  </Label>
                  <Input
                    id="mac"
                    placeholder="00:11:22:33:44:55"
                    value={settings.mac}
                    onChange={(e) => updateSetting("mac", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sleepAfter">
                    Sleep After <span className="text-muted-foreground">(minutes, 0 = never)</span>
                  </Label>
                  <Input
                    id="sleepAfter"
                    type="number"
                    min={0}
                    placeholder="20"
                    value={settings.sleepAfter}
                    onChange={(e) => updateSetting("sleepAfter", Math.max(0, parseInt(e.target.value) || 0))}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 mt-4 pt-4 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleWake}
                  disabled={waking || !settings.mac}
                  className="gap-2"
                >
                  {waking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                  Wake
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSleep}
                  disabled={sleeping || !settings.host}
                  className="gap-2"
                >
                  {sleeping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />}
                  Sleep
                </Button>
                {status?.deviceName && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {status.deviceName}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Drop Zone / Cropper */}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {!imageSrc ? (
              <div
                onDrop={onDrop}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onClick={() => fileInputRef.current?.click()}
                className={`
                  flex flex-col items-center justify-center gap-4 cursor-pointer
                  h-[420px] transition-all duration-200 border-2 border-dashed rounded-lg m-2
                  ${
                    dragOver
                      ? "border-primary bg-primary/5 scale-[0.99]"
                      : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30"
                  }
                `}
              >
                {lastImage && !dragOver ? (
                  <div
                    className="relative flex flex-col items-center gap-3 cursor-pointer group"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleLoadLastImage()
                    }}
                  >
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Currently on display
                    </p>
                    <img
                      src={lastImage}
                      alt="Last pushed"
                      className="max-h-[280px] max-w-full rounded-md border border-border shadow-lg object-contain group-hover:ring-2 group-hover:ring-primary/50 transition-shadow"
                    />
                    <p className="text-xs text-muted-foreground">
                      Click to edit & push again · or drop a new image
                    </p>
                  </div>
                ) : (
                  <>
                    <div className={`p-4 rounded-full transition-colors ${dragOver ? "bg-primary/10" : "bg-muted"}`}>
                      {dragOver ? (
                        <ImageIcon className="h-10 w-10 text-primary" />
                      ) : (
                        <Upload className="h-10 w-10 text-muted-foreground" />
                      )}
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium">
                        {dragOver ? "Drop it!" : "Drop an image here"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        or click to browse &middot; paste from clipboard
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        JPG, PNG, WebP, BMP
                      </p>
                    </div>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleFile(file)
                  }}
                />
              </div>
            ) : (
              <div>
                <div
                  className="relative h-[420px] bg-black/50"
                  style={{
                    filter: `brightness(${brightness}%) contrast(${contrast}%)`,
                  }}
                >
                  <Cropper
                    image={imageSrc}
                    crop={crop}
                    zoom={zoom}
                    rotation={rotation}
                    aspect={aspect}
                    onCropChange={setCrop}
                    onZoomChange={setZoom}
                    onCropComplete={onCropComplete}
                    onMediaLoaded={onMediaLoaded}
                  />
                </div>

                {/* Controls */}
                <div className="p-4 space-y-4 border-t border-border">
                  <div className="flex flex-wrap items-center gap-3 mb-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setOrientation(o => o === "landscape" ? "portrait" : "landscape")
                        setCrop({ x: 0, y: 0 })
                      }}
                      className="gap-2 text-xs"
                    >
                      {orientation === "landscape"
                        ? <Monitor className="h-3.5 w-3.5" />
                        : <Smartphone className="h-3.5 w-3.5" />
                      }
                      {orientation === "landscape" ? "Landscape 16:9" : "Portrait 9:16"}
                    </Button>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">Output:</span>
                      {([0, 90, 180, 270] as const).map((deg) => (
                        <Button
                          key={deg}
                          variant={outputRotation === deg ? "default" : "outline"}
                          size="sm"
                          onClick={() => setOutputRotation(deg)}
                          className="h-7 px-2 text-xs"
                        >
                          {deg}°
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <ZoomIn className="h-3.5 w-3.5" />
                        Zoom
                        <span className="ml-auto tabular-nums">{zoom.toFixed(1)}x</span>
                      </div>
                      <Slider
                        value={[zoom]}
                        onValueChange={([v]) => setZoom(v)}
                        min={1}
                        max={3}
                        step={0.1}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <RotateCw className="h-3.5 w-3.5" />
                        Rotation
                        <span className="ml-auto tabular-nums">{rotation}°</span>
                      </div>
                      <Slider
                        value={[rotation]}
                        onValueChange={([v]) => setRotation(v)}
                        min={0}
                        max={360}
                        step={1}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <Sun className="h-3.5 w-3.5" />
                        Brightness
                        <span className="ml-auto tabular-nums">{brightness}%</span>
                      </div>
                      <Slider
                        value={[brightness]}
                        onValueChange={([v]) => setBrightness(v)}
                        min={0}
                        max={200}
                        step={1}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <Contrast className="h-3.5 w-3.5" />
                        Contrast
                        <span className="ml-auto tabular-nums">{contrast}%</span>
                      </div>
                      <Slider
                        value={[contrast]}
                        onValueChange={([v]) => setContrast(v)}
                        min={0}
                        max={200}
                        step={1}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        {imageSrc && (
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={clearImage} className="gap-2">
              <X className="h-4 w-4" />
              Clear
            </Button>
            <div className="flex-1" />
            {!settingsOpen && settings.host && (
              <span className="text-xs text-muted-foreground hidden sm:block">
                {settings.host}
                {settings.sleepAfter > 0 && (
                  <span className="ml-1 text-muted-foreground/50">
                    &middot; sleep {settings.sleepAfter}m
                  </span>
                )}
              </span>
            )}
            {!settingsOpen && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSettingsOpen(true)}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            )}
            <Button
              onClick={handlePush}
              disabled={pushing || !croppedAreaPixels}
              className="gap-2 min-w-[180px]"
              size="lg"
            >
              {pushing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Pushing...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Push to Display
                </>
              )}
            </Button>
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
