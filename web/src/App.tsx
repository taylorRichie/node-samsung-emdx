import { useState, useCallback, useEffect } from "react"
import { Toaster, toast } from "sonner"
import {
  Monitor, RefreshCw, Palette, Plus, Radar, Check,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DisplayCanvas } from "@/components/DisplayCanvas"
import { RightRail, type RailPanel } from "@/components/RightRail"
import { PropertiesPanel } from "@/components/PropertiesPanel"
import { QueuePanel } from "@/components/QueuePanel"
import type { DisplayConfig, DisplayStatus, DiscoveredDisplay, Scene } from "@/lib/types"

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
  const [displays, setDisplays] = useState<DisplayConfig[]>([])
  const [scenes, setScenes] = useState<Scene[]>([])
  const [statuses, setStatuses] = useState<Record<string, DisplayStatus | null>>({})
  const [lastImageTimestamps, setLastImageTimestamps] = useState<Record<string, number>>({})
  const [refreshing, setRefreshing] = useState(false)

  // Right rail: acts on the display currently selected on the canvas
  const [activeDisplayId, setActiveDisplayId] = useState<string | null>(null)
  const [railPanel, setRailPanel] = useState<RailPanel | null>(null)
  const activeDisplay = displays.find(d => d.id === activeDisplayId) ?? null

  // Selecting a display opens Properties (unless another panel is already up);
  // deselecting slides the panel away
  useEffect(() => {
    if (activeDisplayId) setRailPanel(prev => prev ?? "properties")
    else setRailPanel(null)
  }, [activeDisplayId])

  // Add display dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  // Display list panel visibility (toggled from the header icon)
  const [listOpen, setListOpen] = useState(true)
  const [newName, setNewName] = useState("")
  const [newHost, setNewHost] = useState("")
  const [newPin, setNewPin] = useState("")
  const [newMac, setNewMac] = useState("")

  // Network discovery
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [discovered, setDiscovered] = useState<DiscoveredDisplay[]>([])

  const setTheme = (id: string) => {
    setThemeState(id)
    localStorage.setItem("emdx-theme", id)
    if (id === "default") document.documentElement.removeAttribute("data-theme")
    else document.documentElement.setAttribute("data-theme", id)
  }

  useEffect(() => {
    const saved = loadTheme()
    if (saved !== "default") document.documentElement.setAttribute("data-theme", saved)
  }, [])

  // ─── Data fetching ───────────────────────────────────────────────────────

  const fetchDisplays = useCallback(async () => {
    try {
      const res = await fetch("/api/displays")
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
          const res = await fetch(`/api/displays/${d.id}/status`)
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
      const res = await fetch("/api/scenes")
      if (res.ok) setScenes(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchDisplays()
    fetchScenes()
  }, [fetchDisplays, fetchScenes])

  // Server is the source of truth for display state: seed from its cache and
  // subscribe to the event stream — pushes and status changes made by the
  // backend (or any other open client) update this view in real time.
  useEffect(() => {
    fetch("/api/statuses").then(r => r.ok ? r.json() : null)
      .then(s => { if (s) setStatuses(prev => ({ ...prev, ...s })) })
      .catch(() => {})
    const es = new EventSource("/api/events")
    es.onmessage = e => {
      try {
        const ev = JSON.parse(e.data)
        if (ev.type === "snapshot") setStatuses(prev => ({ ...prev, ...ev.statuses }))
        else if (ev.type === "status") setStatuses(prev => ({ ...prev, [ev.displayId]: ev.status }))
        else if (ev.type === "push") setLastImageTimestamps(prev => ({ ...prev, [ev.displayId]: ev.ts }))
      } catch { /* malformed event */ }
    }
    return () => es.close()
  }, [])

  // ─── Display CRUD ────────────────────────────────────────────────────────

  const handleScan = async () => {
    setScanning(true)
    try {
      const res = await fetch("/api/discover")
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
      const res = await fetch("/api/displays", {
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
    await fetch(`/api/displays/${displayId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {})
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
      await fetch("/api/displays/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }).catch(() => {})
    }
  }

  const handlePatchScene = async (sceneId: string, patch: Partial<Scene>) => {
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, ...patch } : s))
    await fetch(`/api/scenes/${sceneId}`, {
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
      const res = await fetch("/api/scenes", { method: "POST", body: form })
      if (!res.ok) throw new Error("Upload failed")
      toast.success("Environment added — drag a display onto it")
      fetchScenes()
    } catch {
      toast.error("Failed to add environment image")
    }
  }

  const handleSceneDelete = async (sceneId: string) => {
    setScenes(prev => prev.filter(s => s.id !== sceneId))
    await fetch(`/api/scenes/${sceneId}`, { method: "DELETE" }).catch(() => {})
    fetchDisplays() // attached displays got released server-side
  }

  const handleDisplayUpdated = useCallback(() => {
    fetchDisplays()
  }, [fetchDisplays])

  const handleDisplayDeleted = useCallback(() => {
    setRailPanel(null)
    setDisplays(prev => prev.filter(d => d.id !== activeDisplayId))
    fetchDisplays()
  }, [fetchDisplays, activeDisplayId])

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 overflow-hidden bg-background">
      <Toaster theme="dark" position="top-center" richColors />

      {/* Fullscreen infinite canvas */}
      <DisplayCanvas
        displays={displays}
        scenes={scenes}
        statuses={statuses}
        lastImageTimestamps={lastImageTimestamps}
        settingsOpenId={null}
        onOpenSettings={() => setRailPanel("properties")}
        onActiveDisplayChange={setActiveDisplayId}
        onPatchDisplay={handlePatchDisplay}
        onPatchScene={handlePatchScene}
        onSceneUpload={handleSceneUpload}
        onSceneDelete={handleSceneDelete}
        onAddDisplay={() => setAddDialogOpen(true)}
        listOpen={listOpen}
        onReorderDisplays={handleReorderDisplays}
      />

      {/* Floating header (top-left) */}
      <div className="pointer-events-none absolute top-0 left-0 right-0 flex items-start justify-between p-3 md:p-4">
        <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-background/70 backdrop-blur-md px-3 py-2 shadow-lg">
          <button
            className={`flex h-8 w-8 -ml-1 items-center justify-center rounded-md transition-colors ${
              listOpen ? "text-primary" : "text-muted-foreground hover:text-primary"
            } hover:bg-accent`}
            title={listOpen ? "Hide display list" : "Show display list"}
            onClick={() => setListOpen(v => !v)}
          >
            <Monitor className="h-6 w-6" />
          </button>
          <div>
            <h1 className="text-base font-bold tracking-tight leading-none">Samsung EMDX</h1>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {displays.length} display{displays.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border bg-background/70 backdrop-blur-md px-1.5 py-1 shadow-lg">
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
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fetchAllStatuses} disabled={refreshing} title="Refresh all statuses">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Right rail: vertical toolbar + slide-in panels */}
      <RightRail
        disabled={!activeDisplay}
        active={railPanel}
        onPick={p => setRailPanel(prev => prev === p ? null : p)}
      />
      {activeDisplay && (
        <>
          <PropertiesPanel
            open={railPanel === "properties"}
            display={activeDisplay}
            status={statuses[activeDisplay.id] ?? null}
            lastImageTs={lastImageTimestamps[activeDisplay.id] || 0}
            onPatchDisplay={handlePatchDisplay}
            onDisplayUpdated={handleDisplayUpdated}
            onDeleted={handleDisplayDeleted}
          />
          <QueuePanel
            open={railPanel === "queue"}
            display={activeDisplay}
            status={statuses[activeDisplay.id] ?? null}
            onDisplayUpdated={handleDisplayUpdated}
          />
        </>
      )}

      {/* Add display dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-primary" /> Add Display
            </DialogTitle>
            <DialogDescription>Configure a new Samsung EMDX display</DialogDescription>
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
                  No displays found. Sleeping displays don't respond — wake them and rescan.
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
              <Label className="text-xs">Display Name *</Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Living Room" className="h-9" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Host IP</Label>
                <Input value={newHost} onChange={e => setNewHost(e.target.value)} placeholder="192.168.1.37" className="h-9" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">PIN</Label>
                <Input value={newPin} onChange={e => setNewPin(e.target.value)} placeholder="000000" className="h-9" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">MAC Address <span className="text-muted-foreground">(for Wake-on-LAN)</span></Label>
              <Input value={newMac} onChange={e => setNewMac(e.target.value)} placeholder="00:11:22:33:44:55" className="h-9" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAddDisplay} disabled={!newName.trim()}>Add Display</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
