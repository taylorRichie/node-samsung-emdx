import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Eye, EyeOff, Loader2, Moon, Power, RefreshCw, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Segmented } from "@/components/ui/segmented"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SettingGroup, SettingRow } from "@/components/ui/setting-row"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { RotationCalibration } from "@/components/RotationCalibration"
import { displayOrientation, displayState, type Orientation } from "@/lib/displayState"
import { WALLPAPER_COLORS, type DeviceSettings, type DisplayConfig, type DisplayStatus } from "@/lib/types"

// What Samsung's app sends; the display reports "Null" before one is set
const DEFAULT_NTP_SERVER = "http://pool.ntp.org"

const SWATCHES: Record<(typeof WALLPAPER_COLORS)[number], string> = {
  white: "#ffffff", black: "#000000", red: "#c62828", green: "#2e7d32", blue: "#1e50c8", yellow: "#f2d21b",
}

type Tab = "screen" | "power" | "time" | "security" | "device"

/** Text-style field that commits on blur or Enter, only when the value changed */
function CommitInput({ value, onCommit, className, ...props }: {
  value: string; onCommit: (value: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value">) {
  return (
    <Input
      key={value}
      defaultValue={value}
      className={`h-8 text-xs ${className ?? ""}`}
      onBlur={e => { const v = e.target.value.trim(); if (v !== value) onCommit(v) }}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur() }}
      {...props}
    />
  )
}

/** Hidden until asked for, since the PIN controls the display */
function PinInput({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex items-center gap-1">
      <CommitInput
        aria-label="PIN"
        type={shown ? "text" : "password"}
        autoComplete="off"
        value={value}
        placeholder="000000"
        className="w-28 text-right"
        onCommit={onCommit}
      />
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={shown ? "Hide PIN" : "Show PIN"} onClick={() => setShown(v => !v)}>
        {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}

interface BatteryRate { days: number; used: number; perDay: number }

function describeRate(rate: BatteryRate | null | undefined) {
  if (!rate) return "not enough readings yet"
  const span = rate.days < 2 ? `${Math.round(rate.days * 24)} h` : `${rate.days.toFixed(1)} days`
  if (rate.used <= 0) return `no drop over ${span}`
  return `${rate.perDay.toFixed(1)}% a day, about ${Math.round(100 / rate.perDay)} days a charge (${rate.used}% over ${span})`
}

/** Battery used per day, from the readings this app takes at each push and sleep */
function BatteryUse({ api }: { api: string }) {
  const [summary, setSummary] = useState<{ sinceCharge: BatteryRate | null; asleep: BatteryRate | null } | null>(null)
  useEffect(() => {
    fetch(`${api}/battery-log`).then(r => (r.ok ? r.json() : null)).then(setSummary).catch(() => setSummary(null))
  }, [api])
  return (
    <SettingRow
      label="Battery use"
      hint={<>Since the last charge: {describeRate(summary?.sinceCharge)}<br />While asleep: {describeRate(summary?.asleep)}</>}
    />
  )
}

const formatClock = ({ year, month, day, hour, minute, pm }: NonNullable<DeviceSettings["clock"]>) =>
  `${new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, `
  + `${hour}:${String(minute).padStart(2, "0")} ${pm ? "PM" : "AM"}`

interface DisplaySettingsProps {
  display: DisplayConfig
  status: DisplayStatus | null
  onPatchDisplay: (displayId: string, patch: Partial<DisplayConfig>) => void
  onOrientationChange: (display: DisplayConfig, orientation: Orientation) => void
  onDisplayUpdated: () => void
  onRemoved: () => void
}

/**
 * Everything about one display. Some of it lives in this app and always shows;
 * the rest is stored on the display itself, so reading it opens an MDC session
 * and needs the display awake.
 */
export function DisplaySettings({ display, status, onPatchDisplay, onOrientationChange, onDisplayUpdated, onRemoved }: DisplaySettingsProps) {
  const api = `api/displays/${display.id}`
  const configured = !!display.host && !!display.pin

  const [tab, setTab] = useState<Tab>("screen")
  const [settings, setSettings] = useState<DeviceSettings | null>(null)
  const [timeZones, setTimeZones] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [colorDraft, setColorDraft] = useState<number | null>(null)
  const [newPin, setNewPin] = useState("")
  const [pinConfirmOpen, setPinConfirmOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [waking, setWaking] = useState(false)

  const load = useCallback(async () => {
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
  }, [api])

  // Connection details changing is a fresh chance to reach it
  useEffect(() => {
    if (configured) load()
    else setSettings(null)
  }, [configured, display.host, display.pin, load])

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
      onPatchDisplay(display.id, { pin: newPin })
      setNewPin("")
      toast.success("PIN changed. Samsung's app will need the new one too.")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "PIN change failed")
    } finally { setSaving(false) }
  }

  const wake = async () => {
    setWaking(true)
    try {
      const res = await fetch(`${api}/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || "Wake failed")
      toast.success("Wake sent")
      setTimeout(load, 3000)
    } catch (err) {
      toast.error(`Wake failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setWaking(false) }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      const res = await fetch(api, { method: "DELETE" })
      if (!res.ok) throw new Error("Remove failed")
      toast.success(`Removed "${display.name}" from the app`)
      setRemoveOpen(false)
      onRemoved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove display")
    } finally { setRemoving(false) }
  }

  const saveField = (patch: Partial<DisplayConfig>) => onPatchDisplay(display.id, patch)
  const awake = displayState(status) === "awake"

  /** Stands in for the settings stored on the display while they can't be read */
  const deviceNotice = !settings && (
    <div className="rounded-xl border border-border bg-background/40 p-4">
      {!configured ? (
        <>
          <p className="text-[13px] font-medium">This display isn't connected yet</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Add its IP address and PIN on the Device tab to see the settings stored on it.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setTab("device")}>Go to Device</Button>
        </>
      ) : loading ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading from the display…
        </p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-[13px] font-medium"><Moon className="h-4 w-4 text-muted-foreground" /> Couldn't reach the display</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            These settings are stored on the display, so it needs to be awake and the PIN needs to match. {loadError}
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={wake} disabled={waking}>
              {waking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />} Wake
            </Button>
            <Button variant="ghost" size="sm" onClick={load}>Try again</Button>
          </div>
        </>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 pb-3 pt-4 sm:pr-12">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold leading-tight">{display.name}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {display.host || "Not connected"}{configured && ` · ${awake ? "Awake" : "Asleep or unreachable"}`}
          </p>
        </div>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Saving" />}
        <Button
          variant="ghost" size="icon" className="h-8 w-8" aria-label="Read settings from the display again"
          title="Read settings from the display again" onClick={load} disabled={loading || !configured}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="scroll-thin overflow-x-auto px-5 pt-3">
        <Segmented
          label="Display settings section"
          value={tab}
          onChange={setTab}
          options={[
            { value: "screen", label: "Screen" },
            { value: "power", label: "Power" },
            { value: "time", label: "Time" },
            { value: "security", label: "Security" },
            { value: "device", label: "Device" },
          ]}
        />
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {tab === "screen" && (
          <>
            <SettingGroup>
              <SettingRow label="Orientation" hint="Changes the display and the viewer together.">
                <Segmented
                  label="Orientation"
                  value={displayOrientation(display)}
                  options={[{ value: "landscape", label: "Landscape" }, { value: "portrait", label: "Portrait" }]}
                  onChange={orientation => onOrientationChange(display, orientation)}
                />
              </SettingRow>
              {settings && (
                <>
                  <SettingRow label="Source" hint="Where the display gets its content from.">
                    <Segmented
                      label="Source"
                      value={settings.source}
                      options={[{ value: "default", label: "Normal" }, { value: "usb", label: "USB" }]}
                      onChange={source => apply({ source })}
                    />
                  </SettingRow>
                  <SettingRow label="Wallpaper" hint="Shown when there's no image to display.">
                    <div className="flex gap-1.5" role="group" aria-label="Wallpaper color">
                      {WALLPAPER_COLORS.map(color => (
                        <button
                          key={color}
                          type="button"
                          title={color[0].toUpperCase() + color.slice(1)}
                          aria-label={`Wallpaper ${color}`}
                          aria-pressed={settings.wallpaperColor === color}
                          className={`h-6 w-6 rounded-full border border-white/20 transition-shadow ${
                            settings.wallpaperColor === color ? "ring-2 ring-primary ring-offset-2 ring-offset-card" : ""
                          }`}
                          style={{ backgroundColor: SWATCHES[color] }}
                          onClick={() => { if (color !== settings.wallpaperColor) apply({ wallpaperColor: color }) }}
                        />
                      ))}
                    </div>
                  </SettingRow>
                  <SettingRow label="Picture mode">
                    <Segmented
                      label="Picture mode"
                      value={settings.pictureMode}
                      options={[{ value: "vivid", label: "Vivid" }, { value: "custom", label: "Custom" }]}
                      onChange={pictureMode => apply({ pictureMode })}
                    />
                  </SettingRow>
                  {settings.pictureMode === "custom" && settings.color !== null && (
                    <SettingRow label={`Color: ${colorDraft ?? settings.color}`}>
                      <Slider
                        className="w-40"
                        aria-label="Color"
                        min={0} max={50}
                        value={[colorDraft ?? settings.color]}
                        onValueChange={([v]) => setColorDraft(v)}
                        onPointerUp={commitColor}
                        onKeyUp={commitColor}
                      />
                    </SettingRow>
                  )}
                </>
              )}
            </SettingGroup>
            {deviceNotice}
            {configured && (
              <RotationCalibration
                display={display}
                onLockChange={upLocked => saveField({ upLocked })}
                onChanged={onDisplayUpdated}
              />
            )}
          </>
        )}

        {tab === "power" && (
          <>
            <SettingGroup title="This app">
              <SettingRow label="Sleep after sending an image" hint="Minutes the display stays awake once it has the image, or after it wakes by itself (its daily panel care or its button). Every minute awake costs battery. 0 leaves it awake.">
                <div className="flex items-center gap-1.5">
                  <CommitInput
                    aria-label="Sleep after sending an image, in minutes"
                    type="number" min={0} max={1440}
                    value={String(display.sleepAfter ?? 2)}
                    className="w-16 text-right"
                    onCommit={v => {
                      const sleepAfter = Number(v)
                      if (v !== "" && Number.isInteger(sleepAfter) && sleepAfter >= 0 && sleepAfter <= 1440) saveField({ sleepAfter })
                      else toast.error("Enter 0 to 1440 minutes")
                    }}
                  />
                  <span className="text-xs text-muted-foreground">min</span>
                </div>
              </SettingRow>
              <BatteryUse api={api} />
            </SettingGroup>

            {deviceNotice}
            {settings && (
              <SettingGroup title="On the display">
                <SettingRow label="Sleep mode" hint="Deep sleep turns networking off: images wait until the display is woken by its button or its wake timer. Network standby lets this app wake it any time, but drains the battery faster. This app keeps the one you pick.">
                  <Segmented
                    label="Sleep mode"
                    value={settings.sleepMode}
                    options={[{ value: "standby", label: "Network standby" }, { value: "deep", label: "Deep" }]}
                    onChange={sleepMode => apply({ sleepMode })}
                  />
                </SettingRow>
                <SettingRow label="Sleep after" hint="The display's own timer, separate from this app's. The backup for when this app isn't running.">
                  <div className="flex items-center gap-1.5">
                    <CommitInput
                      aria-label="Sleep after, in minutes"
                      type="number" min={1} max={255}
                      value={settings.sleepAfter === null ? "" : String(settings.sleepAfter)}
                      placeholder="Preset"
                      className="w-20 text-right"
                      onCommit={v => {
                        const sleepAfter = Number(v)
                        if (Number.isInteger(sleepAfter) && sleepAfter >= 1 && sleepAfter <= 255) apply({ sleepAfter })
                        else toast.error("Sleep after must be 1 to 255 minutes")
                      }}
                    />
                    <span className="text-xs text-muted-foreground">min</span>
                  </div>
                </SettingRow>
                <SettingRow label="Sleep when content finishes">
                  <Switch
                    aria-label="Sleep when content finishes"
                    checked={!!settings.sleepWhenContentDone}
                    onCheckedChange={v => apply({ sleepWhenContentDone: v })}
                  />
                </SettingRow>
                <SettingRow label="Battery warning">
                  <Switch aria-label="Battery warning" checked={!!settings.batteryWarning} onCheckedChange={v => apply({ batteryWarning: v })} />
                </SettingRow>
                <SettingRow label="Screen protection time" hint="When the display wakes for its daily panel care. This app puts it back to sleep afterwards.">
                  <CommitInput
                    aria-label="Screen protection time"
                    type="time"
                    value={settings.screenProtectorTime ?? ""}
                    className="w-28"
                    onCommit={screenProtectorTime => { if (screenProtectorTime) apply({ screenProtectorTime }) }}
                  />
                </SettingRow>
              </SettingGroup>
            )}
          </>
        )}

        {tab === "time" && (
          <>
            {deviceNotice}
            {settings && !settings.time && (
              <p className="px-1 text-xs text-muted-foreground">The display didn't report its time settings.</p>
            )}
            {settings?.time && (
              <SettingGroup>
                <SettingRow label="Clock" hint={settings.clock ? formatClock(settings.clock) : undefined}>
                  <Button variant="outline" size="sm" title="Set the display's clock to this server's time" onClick={syncClock} disabled={saving}>Sync now</Button>
                </SettingRow>
                <SettingRow label="Time zone">
                  <Select value={settings.time.zone} onValueChange={zone => applyTime({ zone })}>
                    <SelectTrigger aria-label="Time zone" className="h-8 w-56 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {!timeZones.includes(settings.time.zone) && <SelectItem value={settings.time.zone}>{settings.time.zone}</SelectItem>}
                      {timeZones.map(zone => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Time server">
                  <CommitInput
                    aria-label="NTP server"
                    value={settings.time.server === "Null" ? "" : settings.time.server}
                    placeholder={DEFAULT_NTP_SERVER}
                    className="w-56"
                    onCommit={server => { if (server) applyTime({ server }) }}
                  />
                </SettingRow>
              </SettingGroup>
            )}
          </>
        )}

        {tab === "security" && (
          <>
            {deviceNotice}
            {settings && (
              <SettingGroup>
                <SettingRow label="Button lock" hint="Ignores the buttons on the display.">
                  <Switch aria-label="Button lock" checked={!!settings.buttonLock} onCheckedChange={v => apply({ buttonLock: v })} />
                </SettingRow>
                <SettingRow label="USB lock" hint="Ignores USB drives plugged into the display.">
                  <Switch aria-label="USB lock" checked={!!settings.usbLock} onCheckedChange={v => apply({ usbLock: v })} />
                </SettingRow>
                <SettingRow label="Change PIN" hint="This app saves the new PIN automatically. Samsung's app will ask for it.">
                  <div className="flex items-center gap-1.5">
                    <Input
                      aria-label="New PIN"
                      value={newPin}
                      onChange={e => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="6 digits"
                      className="h-8 w-24 text-xs"
                    />
                    <Button variant="outline" size="sm" disabled={newPin.length !== 6 || saving} onClick={() => setPinConfirmOpen(true)}>Change</Button>
                  </div>
                </SettingRow>
              </SettingGroup>
            )}
          </>
        )}

        {tab === "device" && (
          <>
            <SettingGroup title="Connection" description="How this app reaches the display. Saved as you leave each field.">
              <SettingRow label="Name in this app">
                <CommitInput aria-label="Name in this app" value={display.name} className="w-48" onCommit={name => { if (name) saveField({ name }) }} />
              </SettingRow>
              <SettingRow label="IP address">
                <CommitInput aria-label="IP address" value={display.host} placeholder="192.168.1.37" className="w-48" onCommit={host => saveField({ host })} />
              </SettingRow>
              <SettingRow label="PIN" hint="Set on the display, or with Change PIN on the Security tab.">
                <PinInput value={display.pin} onCommit={pin => saveField({ pin })} />
              </SettingRow>
              <SettingRow label="MAC address" hint="Needed for Wake-on-LAN.">
                <CommitInput aria-label="MAC address" value={display.mac} placeholder="00:11:22:33:44:55" className="w-48" onCommit={mac => saveField({ mac })} />
              </SettingRow>
            </SettingGroup>

            {(settings || status?.serialNumber) && (
              <SettingGroup title="About">
                {settings && (
                  <SettingRow label="Name on the display" hint="Shown in Samsung's app.">
                    <CommitInput
                      aria-label="Name on the display"
                      value={settings.deviceName ?? ""}
                      maxLength={32}
                      className="w-48"
                      onCommit={deviceName => { if (deviceName) apply({ deviceName }) }}
                    />
                  </SettingRow>
                )}
                {status?.serialNumber && <SettingRow label="Serial number"><span className="font-mono text-xs text-muted-foreground">{status.serialNumber}</span></SettingRow>}
                {status?.softwareVersion && <SettingRow label="Software"><span className="font-mono text-xs text-muted-foreground">{status.softwareVersion}</span></SettingRow>}
              </SettingGroup>
            )}

            <SettingGroup>
              <SettingRow label="Remove from this app" hint="Deletes its queue, schedule and image history here. The display itself isn't changed.">
                <Button variant="outline" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setRemoveOpen(true)}>
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </Button>
              </SettingRow>
            </SettingGroup>
          </>
        )}
      </div>

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

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove "{display.name}"?</DialogTitle>
            <DialogDescription>
              This deletes its queue, schedule and image history from the app. The display itself isn't changed, but you'll need to add it again to control it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setRemoveOpen(false)} disabled={removing}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={remove} disabled={removing} className="gap-1.5">
              {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Remove display
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
