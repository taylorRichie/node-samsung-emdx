import { useState, useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"
import {
  ChevronDown, ChevronRight, GripVertical, ImagePlus, LayoutGrid, List, ListOrdered, Loader2, Plus, Rss, Send, Trash2, TriangleAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Segmented } from "@/components/ui/segmented"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { RailPanelShell } from "@/components/RightRail"
import { ImageDesigner, type DesignResult } from "@/components/ImageDesigner"
import { ScheduleEditor } from "@/components/ScheduleEditor"
import { withWakeHint } from "@/lib/wakeHint"
import { readSend, toastSend } from "@/lib/send"
import type {
  DisplayConfig, DisplayStatus, ProfileId, ProviderConfig, QueueData, QueueImage, Schedule, SleepMode,
} from "@/lib/types"
import { displayAspect, displayState } from "@/lib/displayState"
import { scheduleSentence } from "@/lib/schedule"

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
  defaultProfile: ProfileId
  onDisplayUpdated: () => void
  /** Bumped when something external (e.g. the gallery) modifies the queue */
  refreshKey?: number
}

export function QueuePanel({ open, display, status, defaultProfile, onDisplayUpdated, refreshKey }: QueuePanelProps) {
  const api = `api/displays/${display.id}`

  const [queue, setQueue] = useState<QueueData>({ images: [], currentIndex: 0 })
  const [mode, setMode] = useState<SleepMode>("manual")
  const [schedule, setSchedule] = useState<Schedule>({
    enabled: false, by: "times", times: ["08:00"], days: [0, 1, 2, 3, 4, 5, 6], intervalValue: 1, intervalUnit: "hours", between: null,
  })
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
    const { enabled, by, times, days, intervalValue, intervalUnit, between } = next
    const res = await fetch(`${api}/schedule`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, by, times, days, intervalValue, intervalUnit, between }),
    }).catch(() => null)
    const data = await res?.json().catch(() => null) as { schedule?: Schedule; error?: string } | null
    if (res?.ok && data?.schedule) setSchedule(data.schedule)
    else if (data?.error) toast.error(data.error)
    // Captions follow the new times
    fetch(`${api}/schedule/upcoming?count=${Math.max(queue.images.length, 10)}`).then(r => r.ok ? r.json() : null)
      .then(u => { if (u) setWakeTimes(u.times ?? []) }).catch(() => {})
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
      const res = await withWakeHint(display.name, () =>
        fetch(`${api}/queue/${img.id}/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
      toastSend(display.name, await readSend(res))
      fetchQueue(); onDisplayUpdated()
    } catch (err) {
      toast.error(`Push failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setPushingId(null) }
  }

  const handleRemove = async (img: QueueImage) => {
    await fetch(`${api}/queue/${img.id}`, { method: "DELETE" }).catch(() => {})
    fetchQueue()
  }

  // ─── Image designer ──────────────────────────────────────────────────────
  const saveDesign = async (img: QueueImage, result: DesignResult) => {
    const res = await fetch(`${api}/queue/${img.id}/edit`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    })
    if (!res.ok) throw new Error("Couldn't save the design")
  }

  const handleDesignSave = async (result: DesignResult) => {
    if (!editImg) return
    setEditApplying(true)
    try {
      await saveDesign(editImg, result)
      toast.success("Saved. It'll be used when this image goes to the display.")
      setEditImg(null)
      fetchQueue()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the design")
    } finally { setEditApplying(false) }
  }

  const handleDesignSend = async (result: DesignResult) => {
    if (!editImg) return
    setEditApplying(true)
    try {
      await saveDesign(editImg, result)
      const res = await withWakeHint(display.name, () =>
        fetch(`${api}/queue/${editImg.id}/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
      toastSend(display.name, await readSend(res))
      setEditImg(null)
      fetchQueue(); onDisplayUpdated()
    } catch (err) {
      toast.error(`Couldn't send: ${err instanceof Error ? err.message : "Unknown error"}. The design was saved.`)
      fetchQueue()
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
      <div className="px-4 py-2.5 border-b border-border shrink-0 space-y-2">
        <div className="flex items-center justify-between">
          <button
            aria-expanded={detailsOpen}
            className="eyebrow flex items-center gap-1 transition-colors hover:text-foreground"
            onClick={() => setDetailsOpen(v => !v)}
          >
            {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Schedule
          </button>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-muted-foreground">{queueEnabled ? "On" : "Off"}</span>
            <Switch aria-label="Run the schedule" checked={queueEnabled} onCheckedChange={setQueueEnabled} />
          </label>
        </div>

        {detailsOpen && (
          <div className="space-y-3 pb-1">
            <ScheduleEditor schedule={schedule} onChange={updateSchedule} />

            {/* Whether anything can actually wake it */}
            {queueEnabled && schedule.wakeMethod === "network" && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                This app wakes it over the network at each time, since it uses network standby.
              </p>
            )}
            {queueEnabled && schedule.wakeMethod === "timer" && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-500">
                <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  {schedule.wakeTimer === "refused"
                    ? "This display refused its wake timer, so it can't wake itself for these times. "
                    : "In deep sleep it has to wake itself with its own timer, which firmware 1130.7 refuses. "}
                  For reliable times, set its sleep mode to Network standby and add its MAC address in its settings, so this app can wake it.
                  Until then each image waits and goes out when the display next wakes.
                </span>
              </div>
            )}

            {/* Source */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Source</Label>
              <Segmented
                stretch
                label="Source"
                value={providerConfig.sourceMode}
                onChange={setSourceMode}
                options={[
                  { value: "queue", label: <><ListOrdered className="h-3.5 w-3.5" /> Queue</> },
                  { value: "provider", label: <><Rss className="h-3.5 w-3.5" /> Provider</> },
                ]}
              />
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
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <span className="eyebrow flex-1">
          Queue <span className="font-normal normal-case tracking-normal">· {queue.images.length} image{queue.images.length === 1 ? "" : "s"}</span>
        </span>
        <Button variant="outline" size="xs" className="gap-1.5" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add
        </Button>
        <Segmented
          label="Queue view"
          value={view}
          onChange={setView}
          options={[
            { value: "list", label: <List className="h-3.5 w-3.5" />, title: "List view" },
            { value: "gallery", label: <LayoutGrid className="h-3.5 w-3.5" />, title: "Gallery view" },
          ]}
        />
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
          onChange={e => { const fs = Array.from(e.target.files ?? []); if (fs.length) addFiles(fs); e.target.value = "" }} />
      </div>

      {/* Deep sleep notice */}
      {deepSleepLikely && (
        <div className="flex items-start gap-2 mx-3 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-500 shrink-0">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span>The display seems to be in deep sleep. Images sent now wait and go out as soon as it wakes: press its power button to send them straight away.</span>
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
                  title="Open in the image designer"
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
                title="Open in the image designer"
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

      {/* Design for a queued image: stored, and used when it's sent */}
      {editImg && (
        <ImageDesigner
          imageUrl={`${api}/queue/image/${editImg.id}`}
          aspect={displayAspect(display)}
          title={display.name}
          subtitle="Queued image"
          initial={editImg.edit ?? null}
          defaultProfile={defaultProfile}
          primaryLabel="Save"
          onPrimary={handleDesignSave}
          secondaryLabel="Save and send now"
          onSecondary={handleDesignSend}
          applying={editApplying}
          onClose={() => setEditImg(null)}
        />
      )}
    </RailPanelShell>
  )
}
