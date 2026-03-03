import { useState, useCallback, useEffect } from "react"
import { Toaster, toast } from "sonner"
import {
  Monitor, RefreshCw, Palette, Plus,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DisplayCanvas } from "@/components/DisplayCanvas"
import { DisplaySettingsModal } from "@/components/DisplaySettingsModal"
import type { DisplayConfig, DisplayStatus } from "@/lib/types"

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
  const [statuses, setStatuses] = useState<Record<string, DisplayStatus | null>>({})
  const [lastImageTimestamps, setLastImageTimestamps] = useState<Record<string, number>>({})
  const [refreshing, setRefreshing] = useState(false)

  // Selected display for settings modal
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null)
  const selectedDisplay = displays.find(d => d.id === selectedDisplayId) ?? null

  // Add display dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newHost, setNewHost] = useState("")
  const [newPin, setNewPin] = useState("")
  const [newMac, setNewMac] = useState("")

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

  useEffect(() => {
    fetchDisplays()
  }, [fetchDisplays])

  useEffect(() => {
    if (displays.length > 0) fetchAllStatuses()
  }, [displays.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Display CRUD ────────────────────────────────────────────────────────

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

  const handlePositionChange = async (displayId: string, x: number, y: number) => {
    setDisplays(prev => prev.map(d => d.id === displayId ? { ...d, canvasX: x, canvasY: y } : d))
    await fetch(`/api/displays/${displayId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canvasX: x, canvasY: y }),
    }).catch(() => {})
  }

  const handleDisplayUpdated = useCallback(() => {
    fetchDisplays()
  }, [fetchDisplays])

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <Toaster theme="dark" position="top-center" richColors />

      <div className="mx-auto max-w-6xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Monitor className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Samsung EMDX</h1>
              <p className="text-xs text-muted-foreground">
                E-Paper Display Controller · {displays.length} display{displays.length !== 1 ? "s" : ""}
              </p>
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
            <Button variant="ghost" size="icon" onClick={fetchAllStatuses} disabled={refreshing} title="Refresh all statuses">
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Canvas */}
        <DisplayCanvas
          displays={displays}
          statuses={statuses}
          lastImageTimestamps={lastImageTimestamps}
          onSettingsClick={setSelectedDisplayId}
          onPositionChange={handlePositionChange}
          onAddDisplay={() => setAddDialogOpen(true)}
        />

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground/50 pt-2">
          Drag displays to arrange · Click to configure · Images sent via Samsung MDC protocol
        </p>
      </div>

      {/* Display settings modal */}
      {selectedDisplay && (
        <DisplaySettingsModal
          display={selectedDisplay}
          open={!!selectedDisplayId}
          onOpenChange={open => { if (!open) setSelectedDisplayId(null) }}
          onDisplayUpdated={handleDisplayUpdated}
        />
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
