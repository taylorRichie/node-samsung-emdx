import { useMemo, useState } from "react"
import { Check, CircleAlert, ImageIcon, Loader2, Palette, Plus, Server } from "lucide-react"

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SettingGroup, SettingRow } from "@/components/ui/setting-row"
import { Segmented } from "@/components/ui/segmented"
import { Switch } from "@/components/ui/switch"
import { DisplaySettings } from "@/components/DisplaySettings"
import { displayState, type Orientation } from "@/lib/displayState"
import { ACCENT_THEMES } from "@/lib/theme"
import type { AppSettings, DisplayConfig, DisplayStatus, ImageFit } from "@/lib/types"
import { addressFromBrowser, cn } from "@/lib/utils"
import { PANEL_PALETTE, PROFILES, type ProfileId } from "../../eink.mjs"

export type SettingsSaveResult = AppSettings & { reachable?: boolean | null }
type AppPatch = {
  serverAddress?: string; timeZone?: string; defaultProfile?: ProfileId
  imageFit?: ImageFit; imageBackground?: string; syncClocks?: boolean
}

interface SettingsDialogProps {
  /** "general" | "images" | "appearance" | a display's id */
  page: string
  onPageChange: (page: string) => void
  onClose: () => void
  settings: AppSettings | null
  onSave: (patch: AppPatch) => Promise<SettingsSaveResult>
  theme: string
  onThemeChange: (theme: string) => void
  displays: DisplayConfig[]
  statuses: Record<string, DisplayStatus | null>
  onPatchDisplay: (displayId: string, patch: Partial<DisplayConfig>) => void
  onOrientationChange: (display: DisplayConfig, orientation: Orientation) => void
  onDisplayUpdated: () => void
  onDisplayRemoved: (displayId: string) => void
  onAddDisplay: () => void
}

const timeZoneNames = () => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  return intl.supportedValuesOf?.("timeZone") ?? []
}

function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-b border-border px-5 pb-3 pt-4 sm:pr-12">
      <h2 className="text-base font-semibold leading-tight">{title}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

function GeneralPage({ settings, onSave }: { settings: AppSettings | null; onSave: SettingsDialogProps["onSave"] }) {
  const [address, setAddress] = useState(settings?.serverAddress ?? "")
  const [timeZone, setTimeZone] = useState(settings?.timeZone ?? "")
  const [check, setCheck] = useState<{ state: "saving" | "ok" | "warn" | "error"; message: string } | null>(null)
  const [zoneError, setZoneError] = useState<string | null>(null)
  const zones = useMemo(() => timeZoneNames(), [])
  const needed = !settings?.detectedAddress

  const saveAddress = async () => {
    const value = address.trim()
    // Back to the saved value, so any complaint about what was typed no longer applies
    if (value === (settings?.serverAddress ?? "")) { setCheck(null); return }
    setCheck({ state: "saving", message: "Checking that address…" })
    try {
      const saved = await onSave({ serverAddress: value })
      if (!value) setCheck(null)
      else if (saved.reachable === false) setCheck({ state: "warn", message: `Saved, but ${value} didn't lead back to this app. Check it's this computer's current IP address.` })
      else setCheck({ state: "ok", message: "Saved. That address leads back to this app." })
    } catch (err) {
      setCheck({ state: "error", message: err instanceof Error ? err.message : "Couldn't save that address" })
    }
  }

  const saveZone = async () => {
    const value = timeZone.trim()
    if (!value || value === settings?.timeZone) return
    setZoneError(null)
    try { await onSave({ timeZone: value }) }
    catch (err) { setZoneError(err instanceof Error ? err.message : "Couldn't save that time zone") }
  }

  return (
    <>
      <PageHeader title="General" description="How displays reach this app" />
      <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <SettingGroup>
          <SettingRow
            stacked
            label="This computer's IP address"
            hint={settings?.detectedAddress
              ? `Displays download images from this address. Leave it blank to use ${settings.detectedAddress}, which was detected automatically.`
              : "Displays download images from this address. It can't be detected in Docker Desktop. On a Mac, run ipconfig getifaddr en0 to find it."}
          >
            <div className="flex items-center gap-2">
              <Input
                aria-label="This computer's IP address"
                value={address}
                onChange={e => setAddress(e.target.value)}
                onBlur={saveAddress}
                onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur() }}
                placeholder={settings?.detectedAddress ?? addressFromBrowser() ?? "192.168.1.20"}
                className="h-8 max-w-56 text-xs"
              />
              {needed && !address.trim() && !check && <span className="text-xs text-amber-500">Needed to send images</span>}
            </div>
            {check && (
              <p role="status" className={cn(
                "flex items-start gap-1.5 text-xs leading-relaxed",
                check.state === "ok" ? "text-emerald-400" : check.state === "saving" ? "text-muted-foreground" : check.state === "warn" ? "text-amber-500" : "text-destructive",
              )}>
                {check.state === "ok" ? <Check className="mt-0.5 h-3 w-3 shrink-0" />
                  : check.state === "saving" ? <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
                  : <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />}
                {check.message}
              </p>
            )}
          </SettingRow>
          <SettingRow stacked label="Time zone" hint="Used for scheduled wake times and syncing a display's clock.">
            <Input
              aria-label="Time zone"
              list="time-zones"
              value={timeZone}
              onChange={e => setTimeZone(e.target.value)}
              onBlur={saveZone}
              onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur() }}
              placeholder="America/New_York"
              className="h-8 max-w-56 text-xs"
            />
            <datalist id="time-zones">{zones.map(z => <option key={z} value={z} />)}</datalist>
            {zoneError && <p className="text-xs text-destructive">{zoneError}</p>}
          </SettingRow>
          <SettingRow
            label="Keep display clocks in sync"
            hint="Each time it sends an image, this app checks the display's clock and sets it to this app's time when it's more than a minute out. The display's clock decides when an image starts showing."
          >
            <Switch
              aria-label="Keep display clocks in sync"
              checked={settings?.syncClocks ?? true}
              onCheckedChange={on => { onSave({ syncClocks: on }) }}
            />
          </SettingRow>
        </SettingGroup>
      </div>
    </>
  )
}

const hex = ([r, g, b]: readonly number[]) => `#${[r, g, b].map(v => v.toString(16).padStart(2, "0")).join("")}`

function ImagesPage({ settings, onSave }: { settings: AppSettings | null; onSave: SettingsDialogProps["onSave"] }) {
  const current = settings?.defaultProfile ?? "eink"
  const fit = settings?.imageFit ?? "fit"
  const background = settings?.imageBackground ?? "#000000"
  return (
    <>
      <PageHeader title="Images" description="What images look like when they go to a display" />
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <SettingGroup
          title="Image fit"
          description="How an image is sized to the panel when it hasn't been laid out in the designer: queued images, the library, links and the API. Every image goes out at the panel's exact size."
        >
          <SettingRow label="Fit" hint={
            fit === "fit" ? "Shows the whole image, with bars where its shape differs from the panel's."
              : fit === "fill" ? "Covers the whole panel, cropping what doesn't fit."
                : "Fills the panel exactly, squashing or stretching the image."
          }>
            <Segmented
              label="Image fit"
              value={fit}
              onChange={v => { onSave({ imageFit: v }) }}
              options={[
                { value: "fit", label: "Fit" },
                { value: "fill", label: "Fill" },
                { value: "stretch", label: "Stretch" },
              ]}
            />
          </SettingRow>
          {fit === "fit" && (
            <SettingRow label="Bars" hint="The panel's own inks show cleanest.">
              <div className="flex items-center gap-1" role="radiogroup" aria-label="Bar color">
                {PANEL_PALETTE.map(c => {
                  const color = hex(c.nominal)
                  return (
                    <button
                      key={c.name}
                      type="button"
                      role="radio"
                      aria-checked={background === color}
                      aria-label={c.name}
                      title={c.name}
                      className={cn("h-6 w-6 rounded-full border border-white/15", background === color && "ring-2 ring-primary ring-offset-2 ring-offset-card")}
                      style={{ background: `rgb(${c.panel.join(",")})` }}
                      onClick={() => { onSave({ imageBackground: color }) }}
                    />
                  )
                })}
              </div>
            </SettingRow>
          )}
        </SettingGroup>

        <SettingGroup
          title="Default profile"
          description="Used for every image that hasn't been given its own look in the designer, including queued images and image feeds."
        >
          <div role="radiogroup" aria-label="Default profile" className="divide-y divide-border">
            {PROFILES.map(p => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={current === p.id}
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/50"
                onClick={() => { if (p.id !== current) onSave({ defaultProfile: p.id }) }}
              >
                <span className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                  current === p.id ? "border-primary bg-primary" : "border-muted-foreground/50",
                )}>
                  {current === p.id && <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] leading-snug">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">{p.description}</span>
                </span>
              </button>
            ))}
          </div>
        </SettingGroup>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          Images you've picked a profile for in the designer keep it. Changing this doesn't update what's on a display until its next image.
        </p>
      </div>
    </>
  )
}

function AppearancePage({ theme, onThemeChange }: { theme: string; onThemeChange: (theme: string) => void }) {
  return (
    <>
      <PageHeader title="Appearance" description="How this app looks in this browser" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <SettingGroup title="Accent color">
          <div role="radiogroup" aria-label="Accent color" className="grid grid-cols-4 gap-1 p-2">
            {ACCENT_THEMES.map(t => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={theme === t.id}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs transition-colors",
                  theme === t.id ? "border-primary bg-accent text-foreground" : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
                onClick={() => onThemeChange(t.id)}
              >
                <span className="h-6 w-6 rounded-full" style={{ background: t.swatch }} />
                {t.label}
              </button>
            ))}
          </div>
        </SettingGroup>
      </div>
    </>
  )
}

/** The app's settings in one window: app-wide pages, then one page per display */
export function SettingsDialog({
  page, onPageChange, onClose, settings, onSave, theme, onThemeChange,
  displays, statuses, onPatchDisplay, onOrientationChange, onDisplayUpdated, onDisplayRemoved, onAddDisplay,
}: SettingsDialogProps) {
  const display = displays.find(d => d.id === page)

  const navItem = (id: string, label: string, icon: React.ReactNode, attention?: boolean) => (
    <button
      key={id}
      type="button"
      aria-current={page === id ? "page" : undefined}
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors sm:w-full",
        page === id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      onClick={() => onPageChange(id)}
    >
      {icon}
      <span className="truncate">{label}</span>
      {attention && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-label="Needs attention" />}
    </button>
  )

  const needsAddress = !!settings && !settings.serverAddress && !settings.detectedAddress

  return (
    <Dialog open onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="flex h-[min(660px,92vh)] w-[calc(100vw-1.5rem)] max-w-[860px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:flex-row">
        <DialogDescription className="sr-only">App and display settings</DialogDescription>
        <nav className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-background/50 p-2 pr-10 sm:w-52 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden sm:border-b-0 sm:border-r sm:p-3 sm:pr-3">
          <DialogTitle className="hidden px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:block">Settings</DialogTitle>
          {navItem("general", "General", <Server className="h-4 w-4 shrink-0" />, needsAddress)}
          {navItem("images", "Images", <ImageIcon className="h-4 w-4 shrink-0" />)}
          {navItem("appearance", "Appearance", <Palette className="h-4 w-4 shrink-0" />)}

          <p className="eyebrow hidden px-2.5 pb-1 pt-4 sm:block">Displays</p>
          {displays.map(d => navItem(
            d.id, d.name,
            <span
              className={cn("mx-1 h-2 w-2 shrink-0 rounded-full", displayState(statuses[d.id]) === "awake" ? "bg-emerald-500" : "bg-muted-foreground/40")}
              title={displayState(statuses[d.id]) === "awake" ? "Awake" : "Asleep or unreachable"}
            />,
          ))}
          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground sm:w-full"
            onClick={onAddDisplay}
          >
            <Plus className="h-4 w-4 shrink-0" /> Add display
          </button>
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {page === "general" && <GeneralPage settings={settings} onSave={onSave} />}
          {page === "images" && <ImagesPage settings={settings} onSave={onSave} />}
          {page === "appearance" && <AppearancePage theme={theme} onThemeChange={onThemeChange} />}
          {display && (
            <DisplaySettings
              key={display.id}
              display={display}
              status={statuses[display.id] ?? null}
              onPatchDisplay={onPatchDisplay}
              onOrientationChange={onOrientationChange}
              onDisplayUpdated={onDisplayUpdated}
              onRemoved={() => onDisplayRemoved(display.id)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
