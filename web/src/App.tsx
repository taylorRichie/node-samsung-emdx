import { useState, useCallback, useEffect, useRef } from "react"
import { Toaster, toast } from "sonner"
import { RefreshCw, Plus, Radar, Check, Settings } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DisplayCanvas } from "@/components/DisplayCanvas"
import { RightRail, type RailPanel } from "@/components/RightRail"
import { LeftRail } from "@/components/LeftRail"
import { GalleryPanel } from "@/components/GalleryPanel"
import { PropertiesPanel } from "@/components/PropertiesPanel"
import { QueuePanel } from "@/components/QueuePanel"
import { SettingsDialog, type SettingsSaveResult } from "@/components/SettingsDialog"
import { SpanDesigner, type SpanJob } from "@/components/SpanDesigner"
import type { AppSettings, Delivery, DisplayConfig, DisplayGroup, DisplayStatus, DiscoveredDisplay, ImageFit, Scene } from "@/lib/types"
import { sameMembers } from "@/lib/span"
import type { Orientation } from "@/lib/displayState"
import { applyTheme, loadTheme, saveTheme } from "@/lib/theme"
import { addressFromBrowser } from "@/lib/utils"
import { DEFAULT_PROFILE, PANEL_PALETTE, type ProfileId } from "../eink.mjs"

/** The six inks the panel is made of */
function BrandMark() {
  return (
    <span aria-hidden className="grid h-7 w-[42px] shrink-0 grid-cols-3 gap-0.5 overflow-hidden rounded-md">
      {PANEL_PALETTE.map(c => <span key={c.name} style={{ background: `rgb(${c.panel.join(",")})` }} />)}
    </span>
  )
}

export default function App() {
  const [theme, setThemeState] = useState(loadTheme)
  const [displays, setDisplays] = useState<DisplayConfig[]>([])
  const [scenes, setScenes] = useState<Scene[]>([])
  const [groups, setGroups] = useState<DisplayGroup[]>([])
  const [statuses, setStatuses] = useState<Record<string, DisplayStatus | null>>({})
  // The image waiting to reach each display, if any
  const [deliveries, setDeliveries] = useState<Record<string, Delivery | null>>({})
  const [lastImageTimestamps, setLastImageTimestamps] = useState<Record<string, number>>({})
  const [refreshing, setRefreshing] = useState(false)

  // Right rail: acts on the display currently selected on the canvas
  const [activeDisplayId, setActiveDisplayId] = useState<string | null>(null)
  const [railPanel, setRailPanel] = useState<RailPanel | null>(null)
  const [listOpen, setListOpen] = useState(true)
  const activeDisplay = displays.find(d => d.id === activeDisplayId) ?? null
  // The event stream outlives renders, so it reads names through a ref
  const displaysRef = useRef(displays)
  useEffect(() => { displaysRef.current = displays }, [displays])

  // Selecting a display opens Properties (unless another panel is already up);
  // deselecting slides the panel away
  useEffect(() => {
    if (!activeDisplayId) { setRailPanel(null); return }
    setRailPanel(prev => prev ?? "properties")
    // No room for both on a phone
    if (window.matchMedia("(max-width: 767px)").matches) setListOpen(false)
  }, [activeDisplayId])

  // Add display dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  // Left rail panels: display list + gallery (one at a time — they share the slot)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [queueRefresh, setQueueRefresh] = useState(0)
  const handleLeftPick = (panel: "displays" | "gallery") => {
    if (panel === "displays") { setListOpen(v => !v); setGalleryOpen(false) }
    else { setGalleryOpen(v => !v); setListOpen(false) }
  }
  const [newName, setNewName] = useState("")
  const [newHost, setNewHost] = useState("")
  const [newPin, setNewPin] = useState("")
  const [newMac, setNewMac] = useState("")
  const [newServerAddress, setNewServerAddress] = useState(addressFromBrowser)

  // Without an address, displays can't download images
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  /** Open settings page: an app page, or a display's id */
  const [settingsPage, setSettingsPage] = useState<string | null>(null)
  const needsServerAddress = !!appSettings && !appSettings.serverAddress && !appSettings.detectedAddress

  const saveAppSettings = useCallback(async (patch: {
    serverAddress?: string; timeZone?: string; defaultProfile?: ProfileId
    imageFit?: ImageFit; imageBackground?: string; syncClocks?: boolean
  }) => {
    const res = await fetch("api/app-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
    const data = await res.json().catch(() => ({})) as SettingsSaveResult & { error?: string }
    if (!res.ok) throw new Error(data.error || "Couldn't save settings")
    setAppSettings(data)
    return data
  }, [])

  // The browser knows the user's time zone, so a new install needn't ask
  useEffect(() => {
    fetch("api/app-settings")
      .then(res => (res.ok ? res.json() as Promise<AppSettings> : null))
      .then(settings => {
        if (!settings) return
        setAppSettings(settings)
        if (!settings.timeZone) return saveAppSettings({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      })
      .catch(() => {})
  }, [saveAppSettings])

  // Network discovery
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredDisplay[]>([])

  const setTheme = (id: string) => {
    setThemeState(id)
    saveTheme(id)
  }

  useEffect(() => { applyTheme(loadTheme()) }, [])

  // ─── Data fetching ───────────────────────────────────────────────────────

  const fetchDisplays = useCallback(async () => {
    try {
      const res = await fetch("api/displays")
      if (res.ok) {
        const data: DisplayConfig[] = await res.json()
        setDisplays(data)
        const ts: Record<string, number> = {}
        for (const d of data) ts[d.id] = Date.now()
        setLastImageTimestamps(prev => ({ ...prev, ...ts }))
      }
    } catch { /* ignore */ }
  }, [])

  const fetchAllStatuses = useCallback(async () => {
    setRefreshing(true)
    const results: Record<string, DisplayStatus | null> = {}
    await Promise.allSettled(
      displays.map(async d => {
        if (!d.host || !d.pin) { results[d.id] = null; return }
        try {
          const res = await fetch(`api/displays/${d.id}/status`)
          if (res.ok) results[d.id] = await res.json()
          else results[d.id] = null
        } catch { results[d.id] = null }
      })
    )
    setStatuses(prev => ({ ...prev, ...results }))
    setRefreshing(false)
  }, [displays])

  const fetchScenes = useCallback(async () => {
    try {
      const res = await fetch("api/scenes")
      if (res.ok) setScenes(await res.json())
    } catch { /* ignore */ }
  }, [])

  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch("api/groups")
      if (res.ok) setGroups(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchDisplays()
    fetchScenes()
    fetchGroups()
  }, [fetchDisplays, fetchScenes, fetchGroups])

  // ─── Spanning one image across several displays ──────────────────────────
  const [spanJob, setSpanJob] = useState<SpanJob | null>(null)
  const spanFileRef = useRef<HTMLInputElement>(null)
  const pendingSpan = useRef<string[]>([])

  const groupFor = useCallback((displayIds: string[]) =>
    groups.find(g => sameMembers(g.displayIds, displayIds)) ?? null, [groups])

  // "new" picks an image; "edit" reopens the group's last one with its design
  const handleSpanImage = (displayIds: string[], mode: "new" | "edit") => {
    const group = groupFor(displayIds)
    if (mode === "edit" && group?.span) {
      setSpanJob({
        displayIds, groupId: group.id, file: null, initial: group.span.edit,
        src: `api/groups/${group.id}/source?t=${Date.parse(group.span.updatedAt) || 0}`,
      })
      return
    }
    pendingSpan.current = displayIds
    spanFileRef.current?.click()
  }

  const handleSpanFile = (file: File) => {
    if (!file.type.startsWith("image/")) { toast.error("Please choose an image file"); return }
    const displayIds = pendingSpan.current
    setSpanJob({ displayIds, groupId: groupFor(displayIds)?.id ?? null, src: URL.createObjectURL(file), file, initial: null })
  }

  const closeSpan = () => {
    if (spanJob?.file) URL.revokeObjectURL(spanJob.src)
    setSpanJob(null)
  }

  const handleDeleteGroup = async (groupId: string) => {
    setGroups(prev => prev.filter(g => g.id !== groupId))
    await fetch(`api/groups/${groupId}`, { method: "DELETE" }).catch(() => {})
    fetchGroups()
  }

  // Server is the source of truth for display state: seed from its cache and
  // subscribe to the event stream — pushes and status changes made by the
  // backend (or any other open client) update this view in real time.
  useEffect(() => {
    fetch("api/statuses").then(r => r.ok ? r.json() : null)
      .then(s => { if (s) setStatuses(prev => ({ ...prev, ...s })) })
      .catch(() => {})
    fetch("api/deliveries").then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setDeliveries(d) })
      .catch(() => {})
    const es = new EventSource("api/events")
    es.onmessage = e => {
      try {
        const ev = JSON.parse(e.data)
        if (ev.type === "snapshot") setStatuses(prev => ({ ...prev, ...ev.statuses }))
        else if (ev.type === "status") setStatuses(prev => ({ ...prev, [ev.displayId]: ev.status }))
        else if (ev.type === "push") setLastImageTimestamps(prev => ({ ...prev, [ev.displayId]: ev.ts }))
        else if (ev.type === "display") setDisplays(prev => prev.map(d => d.id === ev.displayId ? { ...d, ...ev.patch } : d))
        else if (ev.type === "delivery") setDeliveries(prev => ({ ...prev, [ev.displayId]: ev.delivery }))
        // One that had to wait got there in the end
        else if (ev.type === "delivered" && ev.delivery?.attempts > 1) {
          const name = displaysRef.current.find(d => d.id === ev.displayId)?.name ?? "The display"
          toast.success(`${name} got the image that was waiting`, { description: ev.delivery.label ?? undefined })
        }
      } catch { /* malformed event */ }
    }
    return () => es.close()
  }, [])

  // ─── Display CRUD ────────────────────────────────────────────────────────

  const handleScan = async () => {
    setScanning(true)
    try {
      const res = await fetch("api/discover")
      if (!res.ok) throw new Error("Scan failed")
      const found: DiscoveredDisplay[] = await res.json()
      setDiscovered(found)
      setScanned(true)
      const fresh = found.filter(d => !d.alreadyAdded).length
      if (found.length === 0) toast.info("No displays found — sleeping displays don't respond to scans")
      else toast.success(`Found ${found.length} display${found.length !== 1 ? "s" : ""}${fresh < found.length ? ` (${found.length - fresh} already added)` : ""}`)
    } catch {
      toast.error("Network scan failed")
    } finally {
      setScanning(false)
    }
  }

  const handlePickDiscovered = (d: DiscoveredDisplay) => {
    setNewName(d.name)
    setNewHost(d.host)
    setNewMac(d.mac ?? "")
  }

  const handleAddDisplay = async () => {
    if (!newName.trim()) { toast.error("Display name is required"); return }
    try {
      if (needsServerAddress && newServerAddress.trim()) await saveAppSettings({ serverAddress: newServerAddress.trim() })
      const res = await fetch("api/displays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), host: newHost.trim(), pin: newPin.trim(), mac: newMac.trim() }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as { error?: string }).error || "Failed") }
      toast.success(`Display "${newName.trim()}" added`)
      setNewName(""); setNewHost(""); setNewPin(""); setNewMac("")
      setAddDialogOpen(false)
      fetchDisplays()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add display")
    }
  }

  const handlePatchDisplay = async (displayId: string, patch: Partial<DisplayConfig>) => {
    setDisplays(prev => prev.map(d => d.id === displayId ? { ...d, ...patch } : d))
    await fetch(`api/displays/${displayId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {})
  }

  // The viewer only follows once the display accepts, so the two can't disagree.
  // A display with no connection details yet has nothing to stay in step with.
  const handleOrientation = async (display: DisplayConfig, orientation: Orientation) => {
    const rotation = orientation === "landscape" ? 90 : 0
    if (!display.host || !display.pin) { handlePatchDisplay(display.id, { rotation }); return }
    try {
      const res = await fetch(`api/displays/${display.id}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orientation }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || "The display didn't accept that change")
      setDisplays(prev => prev.map(d => d.id === display.id ? { ...d, rotation } : d))
    } catch (err: unknown) {
      toast.error(`Couldn't change orientation: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }

  // Reorder the display list; `commit` persists (dragover reorders locally only)
  const handleReorderDisplays = async (ids: string[], commit: boolean) => {
    setDisplays(prev => {
      const byId = new Map(prev.map(d => [d.id, d]))
      const ordered = ids.map(id => byId.get(id)).filter((d): d is DisplayConfig => !!d)
      for (const d of prev) if (!ordered.includes(d)) ordered.push(d)
      return ordered
    })
    if (commit) {
      await fetch("api/displays/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }).catch(() => {})
    }
  }

  const handlePatchScene = async (sceneId: string, patch: Partial<Scene>) => {
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, ...patch } : s))
    await fetch(`api/scenes/${sceneId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {})
  }

  const handleSceneUpload = async (file: File, canvasX: number, canvasY: number) => {
    const form = new FormData()
    form.append("image", file)
    form.append("canvasX", String(canvasX))
    form.append("canvasY", String(canvasY))
    try {
      const res = await fetch("api/scenes", { method: "POST", body: form })
      if (!res.ok) throw new Error("Upload failed")
      toast.success("Environment added — drag a display onto it")
      fetchScenes()
    } catch {
      toast.error("Failed to add environment image")
    }
  }

  const handleSceneDelete = async (sceneId: string) => {
    setScenes(prev => prev.filter(s => s.id !== sceneId))
    await fetch(`api/scenes/${sceneId}`, { method: "DELETE" }).catch(() => {})
    fetchDisplays() // attached displays got released server-side
  }

  const handleDisplayUpdated = useCallback(() => {
    fetchDisplays()
  }, [fetchDisplays])

  const handleDisplayRemoved = useCallback((displayId: string) => {
    setSettingsPage("general")
    setRailPanel(null)
    setActiveDisplayId(prev => prev === displayId ? null : prev)
    setDisplays(prev => prev.filter(d => d.id !== displayId))
    fetchDisplays()
    fetchGroups() // the server took it out of its groups
  }, [fetchDisplays, fetchGroups])

  const defaultProfile = appSettings?.defaultProfile ?? DEFAULT_PROFILE
  const awakeCount = displays.filter(d => statuses[d.id]).length

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 overflow-hidden bg-background">
      <Toaster theme="dark" position="bottom-center" richColors />

      {/* Fullscreen infinite canvas */}
      <DisplayCanvas
        displays={displays}
        scenes={scenes}
        statuses={statuses}
        lastImageTimestamps={lastImageTimestamps}
        settingsOpenId={null}
        onOpenDisplay={() => setRailPanel("properties")}
        onOpenSettings={id => setSettingsPage(id)}
        onActiveDisplayChange={setActiveDisplayId}
        onPatchDisplay={handlePatchDisplay}
        onOrientationChange={handleOrientation}
        onPatchScene={handlePatchScene}
        onSceneUpload={handleSceneUpload}
        onSceneDelete={handleSceneDelete}
        onAddDisplay={() => setAddDialogOpen(true)}
        listOpen={listOpen}
        onReorderDisplays={handleReorderDisplays}
        groups={groups}
        deliveries={deliveries}
        onSpanImage={handleSpanImage}
        onDeleteGroup={handleDeleteGroup}
      />

      {/* Floating header */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 flex items-start justify-between p-3 md:p-4">
        <div className="surface pointer-events-auto flex items-center gap-2.5 px-3 py-2">
          <BrandMark />
          <div>
            <h1 className="text-sm font-semibold leading-tight tracking-tight">Samsung EMDX</h1>
            <p className="text-[11px] leading-tight text-muted-foreground">
              {displays.length === 0 ? "No displays yet" : `${displays.length} display${displays.length !== 1 ? "s" : ""} · ${awakeCount} awake`}
            </p>
          </div>
        </div>

        <div className="surface pointer-events-auto flex items-center gap-0.5 p-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fetchAllStatuses} disabled={refreshing} aria-label="Refresh all statuses" title="Refresh all statuses">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="ghost" size="icon" className="relative h-8 w-8"
            title={needsServerAddress ? "Settings: this computer's IP address is needed" : "Settings"}
            aria-label="Settings"
            onClick={() => setSettingsPage("general")}
          >
            <Settings className="h-4 w-4" />
            {needsServerAddress && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500" />}
          </Button>
        </div>
      </div>

      {/* Left rail: display list + gallery library */}
      <LeftRail displaysOpen={listOpen} galleryOpen={galleryOpen} onPick={handleLeftPick} />
      <GalleryPanel
        open={galleryOpen}
        displays={displays}
        lastImageTimestamps={lastImageTimestamps}
        activeQueueDisplayId={railPanel === "queue" && activeDisplay ? activeDisplay.id : null}
        onQueued={() => setQueueRefresh(n => n + 1)}
        defaultProfile={defaultProfile}
        onSent={handleDisplayUpdated}
      />

      {/* Right rail: vertical toolbar + slide-in panels */}
      <RightRail
        disabled={!activeDisplay}
        active={railPanel}
        onPick={p => setRailPanel(prev => prev === p ? null : p)}
        onSettings={() => { if (activeDisplay) setSettingsPage(activeDisplay.id) }}
      />
      {activeDisplay && (
        <>
          <PropertiesPanel
            open={railPanel === "properties"}
            display={activeDisplay}
            status={statuses[activeDisplay.id] ?? null}
            delivery={deliveries[activeDisplay.id] ?? null}
            lastImageTs={lastImageTimestamps[activeDisplay.id] || 0}
            defaultProfile={defaultProfile}
            onPatchDisplay={handlePatchDisplay}
            onOrientationChange={handleOrientation}
            onDisplayUpdated={handleDisplayUpdated}
            onOpenSettings={() => setSettingsPage(activeDisplay.id)}
          />
          <QueuePanel
            open={railPanel === "queue"}
            display={activeDisplay}
            status={statuses[activeDisplay.id] ?? null}
            defaultProfile={defaultProfile}
            onDisplayUpdated={handleDisplayUpdated}
            refreshKey={queueRefresh}
          />
        </>
      )}

      {/* Add display dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-primary" /> Add a display
            </DialogTitle>
            <DialogDescription>Scan for it, or enter its details from the display's network screen.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/* Network scan */}
            <div className="space-y-2">
              <Button variant="outline" className="w-full h-9" onClick={handleScan} disabled={scanning}>
                <Radar className={`h-4 w-4 mr-2 ${scanning ? "animate-spin" : ""}`} />
                {scanning ? "Scanning network..." : "Scan network for displays"}
              </Button>
              {scanned && discovered.length === 0 && (
                <p className="text-xs text-muted-foreground text-center">
                  No displays found. Sleeping displays don't respond, and Docker Desktop can't scan your network, so you can enter the details below instead.
                </p>
              )}
              {discovered.length > 0 && (
                <div className="rounded-md border divide-y">
                  {discovered.map(d => (
                    <button
                      key={d.host}
                      type="button"
                      onClick={() => handlePickDiscovered(d)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium truncate">{d.name}</span>
                        <span className="block text-xs text-muted-foreground truncate">
                          {d.host} · {d.model}{d.mac ? ` · ${d.mac}` : ""}
                        </span>
                      </span>
                      {d.alreadyAdded ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                          <Check className="h-3 w-3" /> {d.existingName}
                        </span>
                      ) : (
                        <span className="text-xs text-primary shrink-0">Use</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Living Room" className="h-9" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">IP address</Label>
                <Input value={newHost} onChange={e => setNewHost(e.target.value)} placeholder="192.168.1.37" className="h-9" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">PIN</Label>
                <Input value={newPin} onChange={e => setNewPin(e.target.value)} placeholder="000000" className="h-9" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">MAC address <span className="text-muted-foreground">(for Wake-on-LAN)</span></Label>
              <Input value={newMac} onChange={e => setNewMac(e.target.value)} placeholder="00:11:22:33:44:55" className="h-9" />
            </div>
            {needsServerAddress && (
              <div className="space-y-1">
                <Label className="text-xs">This computer's IP address</Label>
                <Input value={newServerAddress} onChange={e => setNewServerAddress(e.target.value)} placeholder="192.168.1.20" className="h-9" />
                <p className="text-[11px] text-muted-foreground">
                  Displays download images from this address. On a Mac, run ipconfig getifaddr en0 to find it.
                </p>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAddDisplay} disabled={!newName.trim()}>Add display</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Image to span across the selected displays */}
      <input
        ref={spanFileRef} type="file" accept="image/*" className="hidden" aria-label="Choose an image to span"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleSpanFile(f); e.target.value = "" }}
      />
      {spanJob && (
        <SpanDesigner
          job={spanJob}
          displays={displays}
          scenes={scenes}
          groups={groups}
          defaultProfile={defaultProfile}
          onClose={closeSpan}
          onSent={() => { closeSpan(); fetchGroups() }}
        />
      )}

      {settingsPage && (
        <SettingsDialog
          page={settingsPage}
          onPageChange={setSettingsPage}
          onClose={() => setSettingsPage(null)}
          settings={appSettings}
          onSave={saveAppSettings}
          theme={theme}
          onThemeChange={setTheme}
          displays={displays}
          statuses={statuses}
          onPatchDisplay={handlePatchDisplay}
          onOrientationChange={handleOrientation}
          onDisplayUpdated={handleDisplayUpdated}
          onDisplayRemoved={handleDisplayRemoved}
          onAddDisplay={() => { setSettingsPage(null); setAddDialogOpen(true) }}
        />
      )}
    </div>
  )
}
