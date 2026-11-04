import { useState } from "react"
import { toast } from "sonner"
import { ChevronRight, Loader2, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { WALLPAPER_COLORS, type DeviceSettings } from "@/lib/types"

// What Samsung's app sends; the display reports "Null" before one is set
const DEFAULT_NTP_SERVER = "http://pool.ntp.org"

const SWATCHES: Record<(typeof WALLPAPER_COLORS)[number], string> = {
  white: "#ffffff", black: "#000000", red: "#c62828", green: "#2e7d32", blue: "#1e50c8", yellow: "#f2d21b",
}

const GroupLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pt-1">{children}</p>
)

function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2" title={title}>
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T | null; options: { value: T; label: string }[]; onChange: (value: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-0.5 rounded-lg border border-border p-0.5">
      {options.map(o => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          className={`h-6 rounded-md px-2 text-[11px] transition-colors ${
            value === o.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => { if (o.value !== value) onChange(o.value) }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Text-style field that commits on blur or Enter, only when the value changed */
function CommitInput({ value, onCommit, className, ...props }: {
  value: string; onCommit: (value: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value">) {
  return (
    <Input
      key={value}
      defaultValue={value}
      className={`h-7 text-xs ${className ?? ""}`}
      onBlur={e => { const v = e.target.value.trim(); if (v && v !== value) onCommit(v) }}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur() }}
      {...props}
    />
  )
}

const formatClock = ({ year, month, day, hour, minute, pm }: NonNullable<DeviceSettings["clock"]>) =>
  `${new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, `
  + `${hour}:${String(minute).padStart(2, "0")} ${pm ? "PM" : "AM"}`

interface DeviceSettingsSectionProps {
  api: string
  configured: boolean
  onPinChanged: (pin: string) => void
}

/**
 * Settings stored on the display itself. Collapsed by default and read only on
 * expand, because reading means opening an MDC session with the display.
 */
export function DeviceSettingsSection({ api, configured, onPinChanged }: DeviceSettingsSectionProps) {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<DeviceSettings | null>(null)
  const [timeZones, setTimeZones] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [colorDraft, setColorDraft] = useState<number | null>(null)
  const [newPin, setNewPin] = useState("")
  const [pinConfirmOpen, setPinConfirmOpen] = useState(false)

  const load = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`${api}/settings`)
      const data = await res.json().catch(() => ({})) as { settings?: DeviceSettings; timeZones?: string[]; error?: string }
      if (!res.ok || !data.settings) throw new Error(data.error || "Couldn't read settings")
      setSettings(data.settings)
      setTimeZones(data.timeZones ?? [])
    } catch (err) {
      setSettings(null)
      setLoadError(err instanceof Error ? err.message : "Couldn't read settings")
    } finally { setLoading(false) }
  }

  const toggleOpen = () => {
    setOpen(!open)
    if (!open && !settings && !loading) load()
  }

  /** Shows the change straight away and puts it back if the display refuses it */
  const apply = async (changes: Partial<DeviceSettings>) => {
    const before = settings
    setSettings(s => s && { ...s, ...changes })
    setSaving(true)
    try {
      const res = await fetch(`${api}/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || "The display didn't accept that change")
    } catch (err) {
      setSettings(before)
      toast.error(err instanceof Error ? err.message : "The display didn't accept that change")
    } finally { setSaving(false) }
  }

  const applyTime = (patch: { zone?: string; server?: string }) => {
    const time = settings?.time
    if (!time) return
    const server = time.server && time.server !== "Null" ? time.server : DEFAULT_NTP_SERVER
    apply({ time: { ntp: true, server, zone: time.zone, ...patch } })
  }

  const syncClock = async () => {
    setSaving(true)
    try {
      const res = await fetch(`${api}/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clock: "now" }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || "Sync failed")
      toast.success("Display clock synced to the server's time")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed")
    } finally { setSaving(false) }
  }

  const commitColor = () => {
    if (colorDraft !== null && colorDraft !== settings?.color) apply({ color: colorDraft })
    setColorDraft(null)
  }

  const changePin = async () => {
    setPinConfirmOpen(false)
    setSaving(true)
    try {
      const res = await fetch(`${api}/settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: newPin }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || "PIN change failed")
      onPinChanged(newPin)
      setNewPin("")
      toast.success("PIN changed. Samsung's app will need the new one too.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "PIN change failed")
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <button className="flex flex-1 items-center gap-1 text-left" onClick={toggleOpen} disabled={!configured}>
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer">Device settings</Label>
        </button>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {open && (
          <Button variant="ghost" size="icon" className="h-6 w-6" title="Read settings from the display again" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        )}
      </div>

      {open && loading && !settings && (
        <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading from the display…
        </div>
      )}

      {open && loadError && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">{loadError}</p>
          <p className="text-[11px] text-muted-foreground">These settings are stored on the display, so it needs to be awake, and the PIN above needs to match it.</p>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={load} disabled={loading}>Try again</Button>
        </div>
      )}

      {open && settings && (
        <div className="space-y-1 pl-1">
          <GroupLabel>Screen</GroupLabel>
          <Row label="Orientation" title="How the display is mounted. Separate from Rotation above, which only changes how this app sends images.">
            <Segmented
              label="Orientation"
              value={settings.orientation}
              options={[{ value: "landscape", label: "Landscape" }, { value: "portrait", label: "Portrait" }]}
              onChange={orientation => apply({ orientation })}
            />
          </Row>
          <Row label="Source">
            <Segmented
              label="Source"
              value={settings.source}
              options={[{ value: "default", label: "Normal" }, { value: "usb", label: "USB" }]}
              onChange={source => apply({ source })}
            />
          </Row>
          <Row label="Wallpaper color" title="Shown when there's no image to display">
            <div className="flex gap-1">
              {WALLPAPER_COLORS.map(color => (
                <button
                  key={color}
                  title={color[0].toUpperCase() + color.slice(1)}
                  aria-label={`Wallpaper ${color}`}
                  aria-pressed={settings.wallpaperColor === color}
                  className={`h-5 w-5 rounded-full border transition-shadow ${
                    settings.wallpaperColor === color ? "border-primary ring-2 ring-primary/60" : "border-border"
                  }`}
                  style={{ backgroundColor: SWATCHES[color] }}
                  onClick={() => { if (color !== settings.wallpaperColor) apply({ wallpaperColor: color }) }}
                />
              ))}
            </div>
          </Row>
          <Row label="Picture mode">
            <Segmented
              label="Picture mode"
              value={settings.pictureMode}
              options={[{ value: "vivid", label: "Vivid" }, { value: "custom", label: "Custom" }]}
              onChange={pictureMode => apply({ pictureMode })}
            />
          </Row>
          {settings.pictureMode === "custom" && settings.color !== null && (
            <Row label={`Color: ${colorDraft ?? settings.color}`}>
              <Slider
                className="h-1.5 w-32"
                aria-label="Color"
                min={0} max={50}
                value={[colorDraft ?? settings.color]}
                onValueChange={([v]) => setColorDraft(v)}
                onPointerUp={commitColor}
                onKeyUp={commitColor}
              />
            </Row>
          )}

          <GroupLabel>Sleep</GroupLabel>
          <Row label="Sleep mode" title="Deep sleep turns networking off, so the display can't be woken over the network">
            <Segmented
              label="Sleep mode"
              value={settings.sleepMode}
              options={[{ value: "standby", label: "Network standby" }, { value: "deep", label: "Deep" }]}
              onChange={sleepMode => apply({ sleepMode })}
            />
          </Row>
          <p className="text-[10px] text-muted-foreground">This app turns network standby back on whenever it pushes an image.</p>
          <Row label="Sleep after" title="The display's own timer, in minutes. Separate from the sleep this app schedules after a push.">
            <div className="flex items-center gap-1.5">
              <CommitInput
                aria-label="Sleep after, in minutes"
                type="number" min={1} max={255}
                value={settings.sleepAfter === null ? "" : String(settings.sleepAfter)}
                placeholder="Preset"
                className="w-16 text-right"
                onCommit={v => {
                  const sleepAfter = Number(v)
                  if (Number.isInteger(sleepAfter) && sleepAfter >= 1 && sleepAfter <= 255) apply({ sleepAfter })
                  else toast.error("Sleep after must be 1 to 255 minutes")
                }}
              />
              <span className="text-[11px] text-muted-foreground">min</span>
            </div>
          </Row>
          <Row label="Sleep when content finishes">
            <Checkbox
              aria-label="Sleep when content finishes"
              checked={!!settings.sleepWhenContentDone}
              onCheckedChange={v => apply({ sleepWhenContentDone: v === true })}
            />
          </Row>
          <Row label="Battery warning">
            <Checkbox
              aria-label="Battery warning"
              checked={!!settings.batteryWarning}
              onCheckedChange={v => apply({ batteryWarning: v === true })}
            />
          </Row>
          <Row label="Screen protection time">
            <CommitInput
              aria-label="Screen protection time"
              type="time"
              value={settings.screenProtectorTime ?? ""}
              className="w-24"
              onCommit={screenProtectorTime => apply({ screenProtectorTime })}
            />
          </Row>

          {settings.time && (
            <>
              <GroupLabel>Time</GroupLabel>
              <Row label={settings.clock ? `Clock: ${formatClock(settings.clock)}` : "Clock"}>
                <Button variant="outline" size="sm" className="h-7 text-xs" title="Set the display's clock to this server's time" onClick={syncClock} disabled={saving}>Sync</Button>
              </Row>
              <Row label="Time zone">
                <Select value={settings.time.zone} onValueChange={zone => applyTime({ zone })}>
                  <SelectTrigger aria-label="Time zone" className="h-7 w-44 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {!timeZones.includes(settings.time.zone) && <SelectItem value={settings.time.zone}>{settings.time.zone}</SelectItem>}
                    {timeZones.map(zone => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Row>
              <Row label="NTP server">
                <CommitInput
                  aria-label="NTP server"
                  value={settings.time.server === "Null" ? "" : settings.time.server}
                  placeholder={DEFAULT_NTP_SERVER}
                  className="w-44"
                  onCommit={server => applyTime({ server })}
                />
              </Row>
            </>
          )}

          <GroupLabel>Security</GroupLabel>
          <Row label="Button lock">
            <Checkbox aria-label="Button lock" checked={!!settings.buttonLock} onCheckedChange={v => apply({ buttonLock: v === true })} />
          </Row>
          <Row label="USB lock">
            <Checkbox aria-label="USB lock" checked={!!settings.usbLock} onCheckedChange={v => apply({ usbLock: v === true })} />
          </Row>
          <Row label="Change PIN">
            <div className="flex items-center gap-1.5">
              <Input
                aria-label="New PIN"
                value={newPin}
                onChange={e => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                placeholder="6 digits"
                className="h-7 w-20 text-xs"
              />
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={newPin.length !== 6 || saving} onClick={() => setPinConfirmOpen(true)}>
                Change
              </Button>
            </div>
          </Row>

          <GroupLabel>Device</GroupLabel>
          <Row label="Name on display" title="Shown in Samsung's app. Separate from the name in this app's header.">
            <CommitInput
              aria-label="Name on display"
              value={settings.deviceName ?? ""}
              maxLength={32}
              className="w-44"
              onCommit={deviceName => apply({ deviceName })}
            />
          </Row>
        </div>
      )}

      <Dialog open={pinConfirmOpen} onOpenChange={setPinConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Change the display's PIN?</DialogTitle>
            <DialogDescription>
              This app will save the new PIN automatically, but Samsung's app will need it the next time it connects.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setPinConfirmOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={changePin}>Change PIN</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
