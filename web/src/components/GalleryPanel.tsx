import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { toast } from "sonner"
import { Check, Loader2, ListPlus, Monitor, Search, Send, Trash2, Upload, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LeftPanelShell } from "@/components/LeftRail"
import { ImageDesigner, type DesignResult } from "@/components/ImageDesigner"
import { displayAspect } from "@/lib/displayState"
import { readSend, toastSend } from "@/lib/send"
import { withWakeHint } from "@/lib/wakeHint"
import type { DisplayConfig, GalleryItem, ProfileId } from "@/lib/types"

const PAGE = 60

const prettyCategory = (c: string) =>
  c.split("-").map(w => w === "ai" ? "AI" : w[0]?.toUpperCase() + w.slice(1)).join(" ")

interface GalleryPanelProps {
  open: boolean
  displays: DisplayConfig[]
  lastImageTimestamps: Record<string, number>
  /** Display whose queue panel is currently open (direct add target), or null */
  activeQueueDisplayId: string | null
  /** Called after a successful add so the open queue can refresh */
  onQueued: (displayId: string, added: number) => void
  /** Look for artwork that hasn't been given one in the designer */
  defaultProfile: ProfileId
  /** Called once artwork was sent, so thumbnails can refresh */
  onSent: () => void
}

/**
 * Artwork library browser: filter/sort/search over the server's gallery,
 * multi-select, and add straight to a display's queue.
 */
export function GalleryPanel({ open, displays, lastImageTimestamps, activeQueueDisplayId, onQueued, defaultProfile, onSent }: GalleryPanelProps) {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState("all")
  const [sort, setSort] = useState<"title-asc" | "title-desc" | "category">("title-asc")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [visible, setVisible] = useState(PAGE)
  const [adding, setAdding] = useState(false)
  const [chooserOpen, setChooserOpen] = useState(false)
  // The chooser either adds the selection to a queue, or picks where one piece is sent
  const [chooserFor, setChooserFor] = useState<"queue" | "send">("queue")
  // Artwork being laid out in the designer before it goes to a display
  const [sending, setSending] = useState<{ item: GalleryItem; display: DisplayConfig } | null>(null)
  const [sendBusy, setSendBusy] = useState(false)
  // Files picked or dropped, waiting for a category before they go up
  const [pending, setPending] = useState<File[] | null>(null)
  const [uploadCategory, setUploadCategory] = useState("")
  const [uploading, setUploading] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => {
    return fetch("api/gallery").then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.items) { setItems(d.items); setLoaded(true) } })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!open || loaded) return
    reload()
  }, [open, loaded, reload])

  const categories = useMemo(() => [...new Set(items.map(i => i.category))].sort(), [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = items
    if (category !== "all") out = out.filter(i => i.category === category)
    if (q) out = out.filter(i => i.title.toLowerCase().includes(q))
    out = [...out]
    if (sort === "title-asc") out.sort((a, b) => a.title.localeCompare(b.title))
    else if (sort === "title-desc") out.sort((a, b) => b.title.localeCompare(a.title))
    else out.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
    return out
  }, [items, search, category, sort])

  useEffect(() => { setVisible(PAGE) }, [search, category, sort])
  useEffect(() => { setConfirmDelete(false) }, [selected])

  // ─── Adding artwork ──────────────────────────────────────────────────────
  const pickFiles = (files: File[]) => {
    const images = files.filter(f => f.type.startsWith("image/"))
    if (!images.length) { toast.error("Choose image files"); return }
    setUploadCategory(category !== "all" ? prettyCategory(category) : "")
    setPending(images)
  }

  const upload = async () => {
    if (!pending) return
    setUploading(true)
    try {
      let added = 0
      // A few at a time keeps each request small
      for (let i = 0; i < pending.length; i += 10) {
        const form = new FormData()
        if (uploadCategory.trim()) form.append("category", uploadCategory.trim())
        for (const f of pending.slice(i, i + 10)) form.append("images", f)
        const res = await fetch("api/gallery", { method: "POST", body: form })
        const data = await res.json().catch(() => ({})) as { items?: GalleryItem[]; failed?: string[]; error?: string }
        if (!res.ok) throw new Error(data.error || "Upload failed")
        added += data.items?.length ?? 0
        if (data.failed?.length) toast.error(`Couldn't read ${data.failed.join(", ")}`)
      }
      toast.success(`Added ${added} piece${added === 1 ? "" : "s"} to the library`)
      setPending(null)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    } finally { setUploading(false) }
  }

  // ─── Sending one piece, laid out first ───────────────────────────────────
  const openSend = () => {
    if (displays.length === 1) {
      const item = items.find(i => selected.has(i.id))
      if (item) setSending({ item, display: displays[0] })
      return
    }
    setChooserFor("send")
    setChooserOpen(true)
  }

  const sendDesigned = async (result: DesignResult) => {
    if (!sending) return
    const { item, display } = sending
    setSendBusy(true)
    try {
      const res = await withWakeHint(display.name, () => fetch(`api/displays/${display.id}/push`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gallery: item.id, edit: result }),
      }))
      toastSend(display.name, await readSend(res))
      setSending(null)
      setSelected(new Set())
      onSent()
    } catch (err) {
      toast.error(`Couldn't send: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setSendBusy(false) }
  }

  // Only artwork added here can be deleted; the library folder's stays
  const deletable = items.filter(i => selected.has(i.id) && i.uploaded)
  const deleteSelected = async () => {
    setDeleting(true)
    let removed = 0
    for (const item of deletable) {
      const res = await fetch(`api/gallery/${item.id}`, { method: "DELETE" }).catch(() => null)
      if (res?.ok) removed++
    }
    toast.success(`Deleted ${removed} piece${removed === 1 ? "" : "s"}`)
    setSelected(new Set())
    setConfirmDelete(false)
    setDeleting(false)
    reload()
  }

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const handleScroll = () => {
    const el = scrollRef.current
    if (el && el.scrollTop + el.clientHeight > el.scrollHeight - 400 && visible < filtered.length) {
      setVisible(v => Math.min(v + PAGE, filtered.length))
    }
  }

  const addToQueue = async (displayId: string) => {
    setAdding(true)
    try {
      const res = await fetch(`api/displays/${displayId}/queue/from-gallery`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      })
      const data = await res.json().catch(() => ({})) as { added?: number; error?: string }
      if (!res.ok) throw new Error(data.error || "Failed to add")
      const name = displays.find(d => d.id === displayId)?.name ?? "display"
      toast.success(`Added ${data.added ?? selected.size} image${(data.added ?? 2) === 1 ? "" : "s"} to ${name}'s queue`)
      setSelected(new Set())
      setChooserOpen(false)
      onQueued(displayId, data.added ?? 0)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add to queue")
    } finally { setAdding(false) }
  }

  return (
    <LeftPanelShell open={open} width={440}>
      {/* Controls */}
      <div className="px-3 py-2 border-b border-border shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search artwork…" className="h-8 pl-7 text-xs"
            />
          </div>
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{filtered.length}</span>
          <Button variant="outline" size="xs" className="shrink-0 gap-1.5" onClick={() => fileRef.current?.click()} title="Add artwork to the library">
            <Upload className="h-3.5 w-3.5" /> Upload
          </Button>
          <input
            ref={fileRef} type="file" accept="image/*" multiple className="hidden" aria-label="Choose artwork"
            onChange={e => { const fs = Array.from(e.target.files ?? []); if (fs.length) pickFiles(fs); e.target.value = "" }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="flex-1 h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map(c => <SelectItem key={c} value={c}>{prettyCategory(c)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={v => setSort(v as typeof sort)}>
            <SelectTrigger className="w-[120px] h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="title-asc">Title A–Z</SelectItem>
              <SelectItem value="title-desc">Title Z–A</SelectItem>
              <SelectItem value="category">Category</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Grid */}
      <div
        ref={scrollRef}
        className={`flex-1 overflow-y-auto p-2 ${fileOver ? "outline outline-2 -outline-offset-2 outline-dashed outline-primary/60 bg-primary/5" : ""}`}
        onScroll={handleScroll}
        onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setFileOver(true) } }}
        onDragLeave={() => setFileOver(false)}
        onDrop={e => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          setFileOver(false)
          pickFiles(Array.from(e.dataTransfer.files))
        }}
      >
        {!loaded ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-10">
            {items.length ? "No artwork matches" : "No artwork yet. Upload some, or drop image files here."}
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {filtered.slice(0, visible).map(item => {
              const isSel = selected.has(item.id)
              return (
                <button
                  key={item.id}
                  className={`relative group rounded-md overflow-hidden border text-left transition-all ${
                    isSel ? "border-primary ring-2 ring-primary/60" : "border-border hover:border-muted-foreground/50"
                  }`}
                  title={`${item.title} — ${prettyCategory(item.category)}`}
                  onClick={() => toggle(item.id)}
                  draggable
                  onDragStart={e => {
                    // Dragging a selected tile carries the whole selection
                    const ids = selected.has(item.id) ? [...selected] : [item.id]
                    e.dataTransfer.setData("application/x-gallery-items", JSON.stringify(ids))
                    e.dataTransfer.effectAllowed = "copy"
                  }}
                >
                  <img
                    src={`api/gallery/image/${item.id}?w=300`}
                    alt={item.title} loading="lazy"
                    className={`w-full aspect-[0.72] object-cover transition-opacity ${isSel ? "opacity-90" : ""}`}
                  />
                  {isSel && (
                    <span className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3 text-[10px] text-white/90 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                    {item.title}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border shrink-0 bg-background/95">
          <span className="text-xs text-muted-foreground tabular-nums">{selected.size} selected</span>
          <button className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Clear selection" onClick={() => setSelected(new Set())}>
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="flex-1" />
          {deletable.length > 0 && (confirmDelete ? (
            <Button variant="destructive" size="sm" className="h-8 text-xs gap-1.5" disabled={deleting} onClick={deleteSelected}>
              {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Delete {deletable.length}?
            </Button>
          ) : (
            <Button
              variant="ghost" size="sm" className="h-8 w-8 px-0 text-muted-foreground hover:text-destructive"
              title={deletable.length === selected.size ? "Delete from the library" : `Delete the ${deletable.length} uploaded here (the library folder's stay)`}
              aria-label="Delete from the library"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ))}
          {selected.size === 1 && displays.length > 0 && (
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={openSend} title="Lay it out in the designer, then send it to a display">
              <Send className="h-3.5 w-3.5" /> Send…
            </Button>
          )}
          <Button
            size="sm" className="h-8 text-xs gap-1.5" disabled={adding}
            onClick={() => { if (activeQueueDisplayId) addToQueue(activeQueueDisplayId); else { setChooserFor("queue"); setChooserOpen(true) } }}
          >
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListPlus className="h-3.5 w-3.5" />}
            Add to Queue
          </Button>
        </div>
      )}

      {/* Category for new artwork */}
      <Dialog open={!!pending} onOpenChange={o => { if (!o && !uploading) setPending(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add to the library</DialogTitle>
            <DialogDescription>
              {pending?.length} image{pending?.length === 1 ? "" : "s"}. Each is kept as a JPEG named after its file.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="upload-category">Category</label>
            <Input
              id="upload-category"
              list="library-categories"
              value={uploadCategory}
              onChange={e => setUploadCategory(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") upload() }}
              placeholder="Uploads"
              className="h-9"
              autoFocus
            />
            <datalist id="library-categories">{categories.map(c => <option key={c} value={prettyCategory(c)} />)}</datalist>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setPending(null)} disabled={uploading}>Cancel</Button>
            <Button onClick={upload} disabled={uploading} className="gap-1.5">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Visual display chooser */}
      <Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{chooserFor === "send" ? "Send to which display?" : "Add to which display?"}</DialogTitle>
            <DialogDescription>
              {chooserFor === "send"
                ? "It opens in the designer first, so you can size, stretch and adjust it for that display."
                : `${selected.size} image${selected.size === 1 ? "" : "s"} will be added to the chosen display's queue.`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-2 pt-1">
            {displays.map(d => (
              <button
                key={d.id}
                disabled={adding}
                className="group rounded-lg border border-border hover:border-primary/60 hover:bg-accent/50 transition-colors overflow-hidden"
                onClick={() => {
                  if (chooserFor === "queue") { addToQueue(d.id); return }
                  const item = items.find(i => selected.has(i.id))
                  setChooserOpen(false)
                  if (item) setSending({ item, display: d })
                }}
              >
                <div className="aspect-[0.72] bg-muted/40 flex items-center justify-center overflow-hidden">
                  <img
                    src={`api/displays/${d.id}/last-image?t=${lastImageTimestamps[d.id] || 0}`}
                    alt="" className="h-full w-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display = "none" }}
                  />
                  <Monitor className="h-6 w-6 text-muted-foreground/40 hidden first:block" />
                </div>
                <p className="px-1.5 py-1 text-[11px] truncate text-center">{d.name}</p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      {sending && (
        <ImageDesigner
          imageUrl={`api/gallery/image/${sending.item.id}`}
          aspect={displayAspect(sending.display)}
          initialSize="fill"
          title={sending.display.name}
          subtitle={sending.item.title}
          defaultProfile={defaultProfile}
          primaryLabel="Send to display"
          onPrimary={sendDesigned}
          applying={sendBusy}
          onClose={() => setSending(null)}
        />
      )}
    </LeftPanelShell>
  )
}
