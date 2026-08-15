import { useState, useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"
import {
  ChevronDown, ChevronRight, GripVertical, ImagePlus, LayoutGrid, List, ListOrdered, Loader2, Plus, Rss, Send, Trash2, TriangleAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RailPanelShell } from "@/components/RightRail"
import { LightboxEditor, displayAspect, type LightboxResult } from "@/components/LightboxEditor"
import type {
  DisplayConfig, DisplayStatus, IntervalUnit, ProviderConfig, QueueData, QueueImage, Schedule, SleepMode,
} from "@/lib/types"
import { displayState } from "@/lib/displayState"
import { scheduleSentence, to24h } from "@/lib/schedule"

const PAGE = 24
/** Drag payload type set by GalleryPanel tiles */
const GALLERY_MIME = "application/x-gallery-items"

function formatTime12h(d: Date) {
  const ampm = d.getHours() >= 12 ? "PM" : "AM"
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`
}

/** "Will display at 8:00 AM tomorrow" / "... in 45 minutes" / "... on Friday" */
function wakeCaption(ts: number | undefined): string {
  if (!ts) return "No wake scheduled"
  const now = new Date()
  const d = new Date(ts)
  const mins = Math.max(1, Math.round((ts - now.getTime()) / 60000))
  if (mins < 60) return `Will display in ${mins} minute${mins === 1 ? "" : "s"}`
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `Will display at ${formatTime12h(d)} today`
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `Will display at ${formatTime12h(d)} tomorrow`
  const days = Math.round(mins / 1440)
  if (days < 7) return `Will display at ${formatTime12h(d)} on ${d.toLocaleDateString(undefined, { weekday: "long" })}`
  if (days < 14) return `Will display in ${days} days`
  if (days < 60) return `Will display in ${Math.round(days / 7)} weeks`
  return `Will display in ${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? "" : "s"}`
}

interface QueuePanelProps {
  open: boolean
  display: DisplayConfig
  status: DisplayStatus | null
  onDisplayUpdated: () => void
  /** Bumped when something external (e.g. the gallery) modifies the queue */
  refreshKey?: number
}

export function QueuePanel({ open, display, status, onDisplayUpdated, refreshKey }: QueuePanelProps) {
  const api = `/api/displays/${display.id}`

  const [queue, setQueue] = useState<QueueData>({ images: [], currentIndex: 0 })
  const [mode, setMode] = useState<SleepMode>("manual")
  const [schedule, setSchedule] = useState<Schedule>({ enabled: false, by: "time", hour: 8, minute: 0, repeat: "daily" })
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({ sourceMode: "queue", activeProvider: "nasa-iotd", providers: [] })
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [wakeTimes, setWakeTimes] = useState<number[]>([])
  const [view, setView] = useState<"list" | "gallery">("list")
  const [dragIdx, setDragIdx] = useState<number | null>(null) // index in play order
  const [visible, setVisible] = useState(PAGE)
  const [pushingId, setPushingId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [editImg, setEditImg] = useState<QueueImage | null>(null)
  const [editApplying, setEditApplying] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Play order: rotate so the next-to-display image comes first
  const playOrder: QueueImage[] = queue.images.length
    ? [...queue.images.slice(queue.currentIndex), ...queue.images.slice(0, queue.currentIndex)]
    : []

  // Reachable (light sleep) displays accept pushes — only warn when the
  // status probe got no answer at all (deep sleep, radio off)
  const deepSleepLikely = mode === "scheduled" && displayState(status) === "asleep"

  // ─── Data ────────────────────────────────────────────────────────────────
  const fetchQueue = useCallback(async () => {
    try { const r = await fetch(`${api}/queue`); if (r.ok) setQueue(await r.json()) } catch { /**/ }
  }, [api])

  const fetchMeta = useCallback(async (count: number) => {
    try {
      const [m, u, s, p] = await Promise.allSettled([
        fetch(`${api}/mode`).then(r => r.ok ? r.json() : null),
        fetch(`${api}/schedule/upcoming?count=${Math.max(count, 10)}`).then(r => r.ok ? r.json() : null),
        fetch(`${api}/schedule`).then(r => r.ok ? r.json() : null),
        fetch(`${api}/providers`).then(r => r.ok ? r.json() : null),
      ])
      if (m.status === "fulfilled" && m.value) setMode(m.value.mode === "scheduled" ? "scheduled" : "manual")
      if (u.status === "fulfilled" && u.value) setWakeTimes(u.value.times ?? [])
      if (s.status === "fulfilled" && s.value) setSchedule(s.value)
      if (p.status === "fulfilled" && p.value) setProviderConfig(p.value)
    } catch { /**/ }
  }, [api])

  // ─── Queue details (mode + schedule + source) ────────────────────────────
  const updateSchedule = async (patch: Partial<Schedule>) => {
    const next = { ...schedule, ...patch }
    setSchedule(next)
    const res = await fetch(`${api}/schedule`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => null)
    if (res?.ok) {
      const data = await res.json().catch(() => null) as { schedule?: Schedule } | null
      if (data?.schedule) setSchedule(data.schedule)
    }
  }

  // "Queue enabled" = scheduled mode + an enabled schedule, toggled as one
  const queueEnabled = mode === "scheduled" && schedule.enabled
  const setQueueEnabled = async (on: boolean) => {
    setMode(on ? "scheduled" : "manual")
    await fetch(`${api}/mode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: on ? "scheduled" : "manual" }) }).catch(() => {})
    await updateSchedule({ enabled: on })
  }

  const setSourceMode = async (sm: "queue" | "provider") => {
    setProviderConfig(prev => ({ ...prev, sourceMode: sm }))
    await fetch(`${api}/providers/active`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceMode: sm }) }).catch(() => {})
  }

  const setActiveProvider = async (id: string) => {
    setProviderConfig(prev => ({ ...prev, activeProvider: id }))
    await fetch(`${api}/providers/active`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activeProvider: id }) }).catch(() => {})
  }

  const providerName = providerConfig.providers.find(p => p.id === providerConfig.activeProvider)?.name ?? "the provider"
  const sourceLabel = providerConfig.sourceMode === "provider" ? `one from ${providerName}` : "the next image from its queue"

  const segBtn = (active: boolean) =>
    `flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
    }`

  useEffect(() => {
    if (!open) return
    setVisible(PAGE)
    fetchQueue()
  }, [open, display.id, fetchQueue, refreshKey])

  useEffect(() => {
    if (open) fetchMeta(queue.images.length)
  }, [open, display.id, queue.images.length, fetchMeta])

  // ─── Add images ──────────────────────────────────────────────────────────
  const addFiles = async (files: File[]) => {
    const images = files.filter(f => f.type.startsWith("image/"))
    if (images.length === 0) return
    setUploading(true)
    try {
      for (const f of images) {
        const form = new FormData()
        form.append("image", f)
        const res = await fetch(`${api}/queue`, { method: "POST", body: form })
        if (!res.ok) throw new Error(`Failed to add ${f.name}`)
      }
      toast.success(`Added ${images.length} image${images.length === 1 ? "" : "s"} to queue`)
      fetchQueue()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add images")
      fetchQueue()
    } finally { setUploading(false) }
  }

  // Drop from the gallery panel: payload is a JSON array of gallery item ids
  const addFromGallery = async (json: string) => {
    try {
      const ids = JSON.parse(json) as string[]
      if (!Array.isArray(ids) || ids.length === 0) return
      const res = await fetch(`${api}/queue/from-gallery`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
      const data = await res.json().catch(() => ({})) as { added?: number; error?: string }
      if (!res.ok) throw new Error(data.error || "Failed to add")
      toast.success(`Added ${data.added ?? ids.length} image${(data.added ?? ids.length) === 1 ? "" : "s"} from the gallery`)
      fetchQueue()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add from gallery")
    }
  }

  // ─── Reorder (drag in play order; persisted with currentIndex reset to 0) ─
  const handleDragStart = (idx: number) => setDragIdx(idx)
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    if (e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    if (dragIdx === null || dragIdx === idx) return
    const next = [...playOrder]
    const [moved] = next.splice(dragIdx, 1)
    next.splice(idx, 0, moved)
    setQueue({ images: next, currentIndex: 0 })
    setDragIdx(idx)
  }
  const handleDragEnd = async () => {
    if (dragIdx === null) return
    setDragIdx(null)
    await fetch(`${api}/queue/reorder`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: queue.images.map(i => i.id), currentIndex: 0 }),
    }).catch(() => {})
    fetchQueue()
  }

  // ─── Push / remove ───────────────────────────────────────────────────────
  const handlePush = async (img: QueueImage) => {
    setPushingId(img.id)
    try {
      const res = await fetch(`${api}/queue/${img.id}/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || "Push failed")
      toast.success("Image pushed to display")
      fetchQueue(); onDisplayUpdated()
    } catch (err) {
      toast.error(`Push failed: ${err instanceof Error ? err.message : "Unknown error"}${
        deepSleepLikely ? " — the display is in deep sleep; press its power button first." : ""}`)
    } finally { setPushingId(null) }
  }

  const handleRemove = async (img: QueueImage) => {
    await fetch(`${api}/queue/${img.id}`, { method: "DELETE" }).catch(() => {})
    fetchQueue()
  }

  // ─── Presentation override (lightbox editor) ─────────────────────────────
  const handleEditApply = async (result: LightboxResult) => {
    if (!editImg) return
    setEditApplying(true)
    try {
      const res = await fetch(`${api}/queue/${editImg.id}/edit`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      })
      if (!res.ok) throw new Error("Failed to save presentation")
      toast.success("Presentation saved — applied when the image displays")
      setEditImg(null)
      fetchQueue()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save presentation")
    } finally { setEditApplying(false) }
  }

  // Thumbnails show the curated presentation; the editor works from the raw file
  const thumbUrl = (img: QueueImage) => `${api}/queue/image/${img.id}?edited=1&t=${encodeURIComponent(img.editedAt ?? "")}`

  // ─── Lazy load ───────────────────────────────────────────────────────────
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 240 && visible < playOrder.length) {
      setVisible(v => Math.min(v + PAGE, playOrder.length))
    }
  }

  const positionLabel = (idx: number) => idx === 0 ? "Next" : idx === 1 ? "Following" : `#${idx + 1}`
  const caption = (idx: number) => wakeCaption(wakeTimes[idx])

  const shown = playOrder.slice(0, visible)

  return (
    <RailPanelShell open={open}>
      {/* Queue details: enable toggle + collapsible schedule/source settings */}
      <div className="px-3 py-2 border-b border-border shrink-0 space-y-2">
        <div className="flex items-center justify-between">
          <button
            className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setDetailsOpen(v => !v)}
          >
            {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Queue details
          </button>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={queueEnabled} onCheckedChange={v => setQueueEnabled(!!v)} />
            <span className="text-xs">Queue enabled</span>
          </label>
        </div>

        {detailsOpen && (
          <div className="space-y-3 pb-1">
            {/* By: interval / time */}
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">By</Label>
                <Select value={schedule.by ?? "time"} onValueChange={v => updateSchedule({ by: v as "time" | "interval" })}>
                  <SelectTrigger className="w-[104px] h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="interval">Interval</SelectItem>
                    <SelectItem value="time">Time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(schedule.by ?? "time") === "interval" ? (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Every</Label>
                    <Input type="number" min={1} value={schedule.intervalValue ?? 1}
                      onChange={e => updateSchedule({ intervalValue: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="w-16 h-8 text-xs" />
                  </div>
                  <Select value={schedule.intervalUnit ?? "days"} onValueChange={v => updateSchedule({ intervalUnit: v as IntervalUnit })}>
                    <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="minutes">Minutes</SelectItem>
                      <SelectItem value="hours">Hours</SelectItem>
                      <SelectItem value="days">Days</SelectItem>
                      <SelectItem value="weeks">Weeks</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">At</Label>
                    <Input type="time" value={to24h(schedule.hour, schedule.minute)}
                      onChange={e => { const [h, m] = e.target.value.split(":").map(Number); if (!isNaN(h) && !isNaN(m)) updateSchedule({ hour: h, minute: m }) }}
                      className="w-[108px] h-8 text-xs" />
                  </div>
                  <Select value={schedule.repeat} onValueChange={v => updateSchedule({ repeat: v })}>
                    <SelectTrigger className="flex-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekdays">Weekdays</SelectItem>
                      <SelectItem value="once">Once</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>

            {/* Source */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Source</Label>
              <div className="flex items-center rounded-lg border border-border p-0.5 gap-0.5">
                <button className={segBtn(providerConfig.sourceMode === "queue")} onClick={() => setSourceMode("queue")}>
                  <ListOrdered className="h-3.5 w-3.5" /> Queue
                </button>
                <button className={segBtn(providerConfig.sourceMode === "provider")} onClick={() => setSourceMode("provider")}>
                  <Rss className="h-3.5 w-3.5" /> Provider
                </button>
              </div>
              {providerConfig.sourceMode === "provider" && (
                <Select value={providerConfig.activeProvider} onValueChange={setActiveProvider}>
                  <SelectTrigger className="w-full h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {providerConfig.providers.map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Human-readable summary */}
            <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2 leading-relaxed">
              {scheduleSentence(schedule, sourceLabel)}
            </p>
          </div>
        )}
      </div>

      {/* Queue: add + count + view toggle */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Queue <span className="font-normal normal-case tracking-normal">· {queue.images.length} image{queue.images.length === 1 ? "" : "s"}</span>
        </span>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
        </Button>
        <div className="flex items-center rounded-lg border border-border p-0.5 gap-0.5">
          <button
            className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${view === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            title="List view" onClick={() => setView("list")}
          >
            <List className="h-3.5 w-3.5" />
          </button>
          <button
            className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${view === "gallery" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            title="Gallery view" onClick={() => setView("gallery")}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
          onChange={e => { const fs = Array.from(e.target.files ?? []); if (fs.length) addFiles(fs); e.target.value = "" }} />
      </div>

      {/* Deep sleep notice */}
      {deepSleepLikely && (
        <div className="flex items-start gap-2 mx-3 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-500 shrink-0">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>Display appears to be in deep sleep. To push now, press its power button first — otherwise images go out on the next scheduled wake.</span>
        </div>
      )}

      {/* Content (drop zone) */}
      <div
        ref={scrollRef}
        className={`flex-1 overflow-y-auto p-3 ${fileOver ? "outline outline-2 -outline-offset-2 outline-dashed outline-primary/60 rounded-b-xl bg-primary/5" : ""}`}
        onScroll={handleScroll}
        onDragOver={e => {
          if (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes(GALLERY_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = "copy"
            setFileOver(true)
          }
        }}
        onDragLeave={() => setFileOver(false)}
        onDrop={e => {
          const galleryData = e.dataTransfer.getData(GALLERY_MIME)
          if (galleryData) {
            e.preventDefault(); setFileOver(false)
            addFromGallery(galleryData)
            return
          }
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault(); setFileOver(false)
          addFiles(Array.from(e.dataTransfer.files))
        }}
      >
        {playOrder.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-muted-foreground">
            <ImagePlus className="h-8 w-8 opacity-30 mb-2" />
            <p className="text-xs">Queue is empty</p>
            <p className="text-[11px] opacity-70 mt-0.5">Drop images here or click Add</p>
          </div>
        ) : view === "list" ? (
          <div className="space-y-1.5">
            {shown.map((img, idx) => (
              <div
                key={img.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={e => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                className={`group flex items-center gap-2 rounded-lg border p-1.5 transition-colors ${
                  idx === 0 ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/40"
                } ${dragIdx === idx ? "opacity-50" : ""}`}
              >
                <GripVertical className="h-4 w-4 text-muted-foreground/0 group-hover:text-muted-foreground/60 cursor-grab shrink-0 transition-colors" />
                <img src={thumbUrl(img)} alt="" loading="lazy"
                  className="h-12 w-12 rounded-md object-cover shrink-0 border border-border cursor-pointer hover:ring-2 hover:ring-primary/50"
                  title="Tune presentation (rotate, scale, crop)"
                  onClick={() => setEditImg(img)} />
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setEditImg(img)}>
                  <p className="text-xs font-medium">
                    {idx === 0 && <span className="text-primary">Next · </span>}
                    {idx === 1 && <span className="text-muted-foreground">Following · </span>}
                    {idx > 1 && <span className="text-muted-foreground">#{idx + 1} · </span>}
                    <span className="text-muted-foreground font-normal">{caption(idx)}</span>
                  </p>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <Button variant="ghost" size="icon" className="h-6 w-6" title="Push to display now"
                    onClick={e => { e.stopPropagation(); handlePush(img) }} disabled={pushingId !== null}>
                    {pushingId === img.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6" title="Remove from queue"
                    onClick={e => { e.stopPropagation(); handleRemove(img) }}>
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {shown.map((img, idx) => (
              <div
                key={img.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={e => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                className={`group relative aspect-square rounded-lg overflow-hidden border cursor-pointer ${
                  idx === 0 ? "border-primary/60 ring-1 ring-primary/40" : "border-border"
                } ${dragIdx === idx ? "opacity-50" : ""}`}
                title="Tune presentation (rotate, scale, crop)"
                onClick={() => setEditImg(img)}
              >
                <img src={thumbUrl(img)} alt="" loading="lazy" draggable={false}
                  className="absolute inset-0 h-full w-full object-cover" />
                {idx <= 1 && (
                  <span className={`absolute top-1 left-1 rounded px-1 py-px text-[9px] font-semibold ${
                    idx === 0 ? "bg-primary text-primary-foreground" : "bg-background/80 text-foreground"
                  }`}>
                    {positionLabel(idx)}
                  </span>
                )}
                {/* Hover overlay: caption + actions */}
                <div className="absolute inset-0 flex flex-col justify-end opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-t from-black/80 via-black/20 to-transparent p-1.5">
                  <p className="text-[10px] leading-tight text-white/90 mb-1">{caption(idx)}</p>
                  <div className="flex items-center gap-1">
                    <button
                      className="flex h-6 flex-1 items-center justify-center gap-1 rounded-md bg-white/15 hover:bg-white/25 text-white text-[10px] transition-colors"
                      title="Push to display now" onClick={e => { e.stopPropagation(); handlePush(img) }} disabled={pushingId !== null}
                    >
                      {pushingId === img.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                    </button>
                    <button
                      className="flex h-6 w-6 items-center justify-center rounded-md bg-white/15 hover:bg-white/25 text-white transition-colors"
                      title="Remove from queue" onClick={e => { e.stopPropagation(); handleRemove(img) }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {visible < playOrder.length && (
          <p className="text-center text-[11px] text-muted-foreground py-3">Scroll for more…</p>
        )}
      </div>

      {/* Presentation tuner for a queued image (stored, applied at push) */}
      {editImg && (
        <LightboxEditor
          open={!!editImg}
          imageUrl={`${api}/queue/image/${editImg.id}`}
          aspect={displayAspect(display)}
          title="Tune presentation — queued image"
          initial={editImg.edit ?? null}
          applying={editApplying}
          onApply={handleEditApply}
          onClose={() => setEditImg(null)}
        />
      )}
    </RailPanelShell>
  )
}
