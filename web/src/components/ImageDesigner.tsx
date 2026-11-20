import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignStartHorizontal, AlignStartVertical, Check, ImageOff, Link2, Link2Off, Loader2, Pipette,
  Redo2, RotateCcw, RotateCw, Undo2, X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Segmented } from "@/components/ui/segmented"
import { Slider } from "@/components/ui/slider"
import { ColorPicker } from "@/components/ColorPicker"
import { cn } from "@/lib/utils"
import type { Adjust, QueueEdit } from "@/lib/types"
import {
  ADJUST_KEYS, PANEL_PALETTE, PROFILES, adjustPixels, ditherToPanel, profileAdjust, sanitizeAdjust, type ProfileId,
} from "../../eink.mjs"
import type { PanelJob, PanelResult } from "@/lib/panel-worker"

export type DesignResult = QueueEdit

/** Several displays shown as one picture. Display pixels, origin top-left. */
export interface Wall {
  width: number
  height: number
  /** One display's frame width */
  bezel: number
  screens: { id: string; label: string; x: number; y: number; w: number; h: number }[]
}

interface ImageDesignerProps {
  /** Source image (raw file orientation; the design is applied on top) */
  imageUrl: string
  /** Display frame aspect (w/h) */
  aspect: number
  /** Span across several displays: the frame becomes the whole wall, and only
   *  its screens show the panel. Frames and gaps hide the picture behind them. */
  wall?: Wall
  /** How a newly opened image is sized: inside the frame, or covering it */
  initialSize?: "fit" | "fill"
  /** Sidebar sections shown before the built-in ones */
  sections?: React.ReactNode
  title: string
  subtitle: string
  /** Saved design to resume from */
  initial?: QueueEdit | null
  /** Look for an image that doesn't have one yet */
  defaultProfile: ProfileId
  primaryLabel: string
  onPrimary: (result: DesignResult) => void
  secondaryLabel?: string
  onSecondary?: (result: DesignResult) => void
  /** Busy while the caller applies the result */
  applying?: boolean
  onClose: () => void
}

type ViewMode = "panel" | "split" | "original"

/** Placed image in display pixels; the frame's top-left corner is the origin */
interface Xform { cx: number; cy: number; w: number; h: number; rot: number }

interface Design {
  xf: Xform
  bg: string
  radius: number
  borderColor: string
  borderWidth: number
  adjust: Adjust
}

type Drag =
  | { kind: "move"; start: Pt; base: Pt }
  | { kind: "scale"; anchor: Pt; sign: Pt }
  // A side handle stretches along one axis, whatever the proportions
  | { kind: "side"; anchor: Pt; axis: "x" | "y"; sign: number }
  | { kind: "rotate"; startAngle: number; base: number }
  | { kind: "split" }

interface Pt { x: number; y: number }

// Adjustments preview on a copy of the source capped at this long side
const PREVIEW_MAX = 1600
// Once things settle the panel preview is dithered finer than the screen and
// averaged down, so the dots blend as they do on the panel from across a room.
// That happens in a worker. While something is moving, a coarse draft stands in.
const FULL_PIXELS = 10_000_000
const DRAFT_PIXELS = 700_000
const SETTLE_MS = 150

// Screen sizes, in CSS pixels
const HANDLE = 9
const GRAB = 13
const ROTATE_ZONE = 30
const KNOB_DISTANCE = 26
const SNAP = 7

const WORKSPACE = "#100f0e"
const BEZEL = "#e8e5dd"
const GUIDE = "#f2b84b"
const SELECTION = "rgba(242,184,75,0.95)"

const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='M21 12a9 9 0 1 1-2.6-6.3'/%3E%3Cpath d='M21 3v5h-5'/%3E%3C/svg%3E") 10 10, alias`

const SLIDERS: { key: keyof Adjust; label: string; min: number; title: string }[] = [
  { key: "brightness", label: "Brightness", min: -100, title: "Lighten or darken everything" },
  { key: "contrast", label: "Contrast", min: -100, title: "Spread between lights and darks" },
  { key: "saturation", label: "Saturation", min: -100, title: "Color intensity. E-paper colors are muted, so most art wants a boost. -100 is grayscale." },
  { key: "midtones", label: "Midtones", min: -100, title: "Lighten or darken midtones without clipping black and white. E-paper tends to render dark." },
  { key: "sharpen", label: "Sharpen", min: 0, title: "Edge sharpening against dithering softness. The preview only approximates it." },
]

const rad = (deg: number) => (deg * Math.PI) / 180

/** Resize cursor for a side handle, turned with the image */
function sideCursor(side: number, rot: number) {
  const angle = ((rot + (side % 2 ? 0 : 90)) % 180 + 180) % 180
  return angle < 22.5 || angle >= 157.5 ? "ew-resize" : angle < 67.5 ? "nwse-resize" : angle < 112.5 ? "ns-resize" : "nesw-resize"
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const hex = ([r, g, b]: readonly number[]) => `#${[r, g, b].map(v => v.toString(16).padStart(2, "0")).join("")}`

function makeCanvas(width: number, height: number) {
  const c = document.createElement("canvas")
  c.width = width
  c.height = height
  return c
}

function toLocal(p: Pt, t: Xform): Pt {
  const c = Math.cos(-rad(t.rot)), s = Math.sin(-rad(t.rot))
  const dx = p.x - t.cx, dy = p.y - t.cy
  return { x: dx * c - dy * s, y: dx * s + dy * c }
}

function fromLocal(l: Pt, t: Xform): Pt {
  const c = Math.cos(rad(t.rot)), s = Math.sin(rad(t.rot))
  return { x: t.cx + l.x * c - l.y * s, y: t.cy + l.x * s + l.y * c }
}

function corners(t: Xform): Pt[] {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => fromLocal({ x: (sx * t.w) / 2, y: (sy * t.h) / 2 }, t))
}

/** Middles of the sides: top, right, bottom, left */
function sideMiddles(t: Xform): Pt[] {
  return [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([sx, sy]) => fromLocal({ x: (sx * t.w) / 2, y: (sy * t.h) / 2 }, t))
}

/** Size of the box around a rotated rectangle */
function rotatedBox(w: number, h: number, rot: number) {
  const c = Math.abs(Math.cos(rad(rot))), s = Math.abs(Math.sin(rad(rot)))
  return { w: w * c + h * s, h: w * s + h * c }
}

function drawArt(c: CanvasRenderingContext2D, src: CanvasImageSource, d: Design) {
  const { xf } = d
  const r = clamp(d.radius, 0, Math.min(xf.w, xf.h) / 2)
  c.save()
  c.translate(xf.cx, xf.cy)
  c.rotate(rad(xf.rot))
  c.beginPath()
  c.roundRect(-xf.w / 2, -xf.h / 2, xf.w, xf.h, r)
  c.save()
  c.clip()
  c.imageSmoothingQuality = "high"
  c.drawImage(src, -xf.w / 2, -xf.h / 2, xf.w, xf.h)
  c.restore()
  if (d.borderWidth > 0) {
    const b = d.borderWidth
    c.lineWidth = b
    c.strokeStyle = d.borderColor
    c.beginPath()
    c.roundRect(-xf.w / 2 + b / 2, -xf.h / 2 + b / 2, xf.w - b, xf.h - b, Math.max(0, r - b / 2))
    c.stroke()
  }
  c.restore()
}

/** Each profile on this image, as the panel would show it */
function profileThumbs(source: HTMLCanvasElement) {
  const W = 144, H = 176
  const c = makeCanvas(W, H)
  const ctx = c.getContext("2d", { willReadFrequently: true })!
  const s = Math.max(W / source.width, H / source.height)
  ctx.drawImage(source, (W - source.width * s) / 2, (H - source.height * s) / 2, source.width * s, source.height * s)
  const base = ctx.getImageData(0, 0, W, H)
  const thumbs: Partial<Record<ProfileId, string>> = {}
  for (const p of PROFILES) {
    const px = new ImageData(new Uint8ClampedArray(base.data), W, H)
    adjustPixels(px.data, 4, p.adjust)
    ditherToPanel(px.data, W, H)
    ctx.putImageData(px, 0, 0)
    thumbs[p.id] = c.toDataURL("image/png")
  }
  return thumbs
}

export function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5 border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex h-4 items-center justify-between">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function AdjustSlider({ label, title, value, min, onChange }: {
  label: string; title: string; value: number; min: number; onChange: (v: number) => void
}) {
  return (
    <div title={title}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn("text-xs tabular-nums", value ? "text-foreground" : "text-muted-foreground/60")}>
          {min < 0 && value > 0 ? `+${value}` : value}
        </span>
      </div>
      <Slider
        aria-label={label}
        value={[value]} min={min} max={100}
        onValueChange={([v]) => onChange(v)}
        onDoubleClick={() => onChange(0)}
      />
    </div>
  )
}

/** Numeric field that commits on blur/Enter (or on every keystroke with `live`) */
export function NumField({ label, value, onCommit, className, step = 1, live = false, unit, title }: {
  label: string; value: number; onCommit: (v: number) => void; className?: string; step?: number; live?: boolean; unit?: string; title?: string
}) {
  // What's being typed, which may not be a number yet; the value shows otherwise
  const [draft, setDraft] = useState<string | null>(null)
  const shown = String(Math.round(value * 10) / 10)
  const commit = (raw: string) => {
    const v = parseFloat(raw)
    if (Number.isFinite(v)) onCommit(v)
  }
  return (
    <label title={title} className={cn("flex h-8 items-center gap-1.5 rounded-lg border border-input bg-background/60 px-2 focus-within:ring-2 focus-within:ring-ring/60", className)}>
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <input
        type="number"
        aria-label={label}
        value={draft ?? shown}
        step={step}
        className="w-full min-w-0 bg-transparent text-right text-xs tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        onFocus={() => setDraft(shown)}
        onChange={e => { setDraft(e.target.value); if (live) commit(e.target.value) }}
        onBlur={e => { commit(e.target.value); setDraft(null) }}
        onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur() }}
      />
      {unit && <span className="shrink-0 text-[11px] text-muted-foreground">{unit}</span>}
    </label>
  )
}

/**
 * The colors the panel can show as solid ink, drawn as it renders them. Anything
 * else gets dithered, so these make the cleanest backgrounds and borders.
 */
function PanelSwatches({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      {PANEL_PALETTE.map(c => {
        const color = hex(c.nominal)
        return (
          <button
            key={c.name}
            type="button"
            title={`Panel ${c.name}`}
            aria-label={`${label}: ${c.name}`}
            aria-pressed={value === color}
            className={cn(
              "h-6 w-6 rounded-full border border-white/15 transition-shadow",
              value === color && "ring-2 ring-primary ring-offset-2 ring-offset-card",
            )}
            style={{ background: `rgb(${c.panel.join(",")})` }}
            onClick={() => onChange(color)}
          />
        )
      })}
    </div>
  )
}

/**
 * Lays out an image for the panel: a full-screen workspace showing how the
 * e-paper will render it. Values are in the display's real pixels. The design
 * is saved as an override, so the original image is never changed.
 */
export function ImageDesigner({
  imageUrl, aspect, wall, initialSize = "fit", sections, title, subtitle, initial, defaultProfile,
  primaryLabel, onPrimary, secondaryLabel, onSecondary, applying, onClose,
}: ImageDesignerProps) {
  // Real display pixels: what the server renders into
  const DW = wall ? wall.width : aspect >= 1 ? 2560 : 1440
  const DH = wall ? wall.height : aspect >= 1 ? 1440 : 2560

  const workspaceRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading")
  const ready = loadState === "ready"
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [design, setDesign] = useState<Design>({
    xf: { cx: DW / 2, cy: DH / 2, w: DW, h: DH, rot: 0 },
    bg: initial?.bg ?? "#000000",
    radius: initial?.radius ?? 0,
    borderColor: initial?.border?.color ?? "#ffffff",
    borderWidth: initial?.border?.width ?? 0,
    adjust: initial?.adjust ?? profileAdjust(defaultProfile),
  })
  const [mode, setMode] = useState<ViewMode>("panel")
  const [split, setSplit] = useState(0.5)
  const [selected, setSelected] = useState(true)
  const [aspectLock, setAspectLock] = useState(true)
  const [sampling, setSampling] = useState(false)
  const [cursor, setCursor] = useState("default")
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({})
  const [thumbs, setThumbs] = useState<Partial<Record<ProfileId, string>>>({})
  const [natural, setNatural] = useState({ w: 1, h: 1 })
  // The design as it opened, to tell whether there's anything to lose
  const [startKey, setStartKey] = useState("")

  const dragRef = useRef<Drag | null>(null)
  // Source pixels, a canvas of them, and a canvas with `adjust` applied
  const baseRef = useRef<ImageData | null>(null)
  const originalRef = useRef<HTMLCanvasElement | null>(null)
  const tonedRef = useRef<HTMLCanvasElement | null>(null)
  const tonedKeyRef = useRef("")
  const draftRef = useRef<{ key: string; canvas: HTMLCanvasElement; down: number } | null>(null)
  const fullRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const workerBusyRef = useRef(false)
  // Bumped when the worker finishes, to redraw with its result
  const [fullFrames, setFullFrames] = useState(0)

  const setXf = useCallback((fn: (t: Xform) => Xform) => setDesign(d => ({ ...d, xf: fn(d.xf) })), [])
  const patch = useCallback((p: Partial<Design>) => setDesign(d => ({ ...d, ...p })), [])
  const designKey = useMemo(() => JSON.stringify(design), [design])

  // ─── Load the image and restore the saved design ─────────────────────────
  useEffect(() => {
    let cancelled = false
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onerror = () => { if (!cancelled) setLoadState("failed") }
    img.onload = () => {
      if (cancelled) return
      const ps = Math.min(1, PREVIEW_MAX / Math.max(img.width, img.height))
      const original = makeCanvas(Math.max(1, Math.round(img.width * ps)), Math.max(1, Math.round(img.height * ps)))
      const ctx = original.getContext("2d", { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, original.width, original.height)
      baseRef.current = ctx.getImageData(0, 0, original.width, original.height)
      originalRef.current = original
      tonedRef.current = makeCanvas(original.width, original.height)
      tonedKeyRef.current = ""
      setThumbs(profileThumbs(original))
      setNatural({ w: img.width, h: img.height })

      let xf: Xform
      if (initial?.mode === "transform" && initial.offset && Number.isFinite(initial.scaleX)) {
        const sx = initial.scaleX ?? 1
        const sy = initial.scaleY ?? sx
        xf = {
          w: sx * DW, h: sy * DH,
          cx: DW / 2 + (initial.offset.x ?? 0) * DW,
          cy: DH / 2 + (initial.offset.y ?? 0) * DH,
          rot: initial.rotation ?? 0,
        }
      } else {
        const s = initialSize === "fill"
          ? Math.max(DW / img.width, DH / img.height)
          : Math.min(DW / img.width, DH / img.height)
        xf = { cx: DW / 2, cy: DH / 2, w: img.width * s, h: img.height * s, rot: 0 }
      }
      const start = { ...design, xf }
      setDesign(start)
      setStartKey(JSON.stringify(start))
      setLoadState("ready")
    }
    img.src = imageUrl
    return () => { cancelled = true }
  }, [imageUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const worker = new Worker(new URL("../lib/panel-worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = ({ data }: MessageEvent<PanelResult>) => {
      workerBusyRef.current = false
      const out = makeCanvas(data.width, data.height)
      out.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data.buffer), data.width, data.height), 0, 0)
      fullRef.current = { key: data.key, canvas: out }
      setFullFrames(n => n + 1)
    }
    workerRef.current = worker
    return () => { worker.terminate(); workerRef.current = null; workerBusyRef.current = false }
  }, [])

  // A wall grows or shrinks as its frames and gaps change. The picture keeps
  // its place in proportion and its size relative to covering the wall, so a
  // picture that covered it still does, and changing a gap back undoes it.
  const dimsRef = useRef({ w: DW, h: DH })
  useEffect(() => {
    const prev = dimsRef.current
    dimsRef.current = { w: DW, h: DH }
    if (!ready || (prev.w === DW && prev.h === DH)) return
    setXf(t => {
      const box = rotatedBox(t.w, t.h, t.rot)
      const cover = (w: number, h: number) => Math.max(w / box.w, h / box.h)
      const s = cover(DW, DH) / cover(prev.w, prev.h)
      return { ...t, cx: (t.cx * DW) / prev.w, cy: (t.cy * DH) / prev.h, w: t.w * s, h: t.h * s }
    })
  }, [DW, DH, ready, setXf])

  // ─── Workspace size and the frame's place in it ──────────────────────────
  useEffect(() => {
    const el = workspaceRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ w: width, h: height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const view = useMemo(() => {
    const dpr = window.devicePixelRatio || 1
    const pad = Math.max(44, Math.min(size.w, size.h) * 0.075)
    const scale = Math.max(0.01, Math.min((size.w - pad * 2) / DW, (size.h - pad * 2) / DH))
    // Whole device pixels, so the dither lands 1:1 on the screen
    const fw = Math.max(1, Math.round(DW * scale * dpr))
    const fh = Math.max(1, Math.round(DH * scale * dpr))
    const W = Math.round(size.w * dpr), H = Math.round(size.h * dpr)
    return { dpr, W, H, fw, fh, fx: Math.round((W - fw) / 2), fy: Math.round((H - fh) / 2), k: fw / DW }
  }, [size, DW, DH])

  // Coarse preview while things change, full once they've stopped
  const settleKey = `${designKey}|${view.fw}x${view.fh}`
  const [settled, setSettled] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setSettled(settleKey), SETTLE_MS)
    return () => clearTimeout(t)
  }, [settleKey])
  const quality = settled === settleKey ? "full" : "draft"

  // ─── Undo / redo ─────────────────────────────────────────────────────────
  const historyRef = useRef<{ past: Design[]; future: Design[]; last: Design | null }>({ past: [], future: [], last: null })
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const syncHistory = () => {
    setCanUndo(historyRef.current.past.length > 0)
    setCanRedo(historyRef.current.future.length > 0)
  }

  const recordHistory = useCallback((current: Design) => {
    const h = historyRef.current
    if (h.last && JSON.stringify(h.last) === JSON.stringify(current)) return
    if (h.last) h.past.push(h.last)
    if (h.past.length > 100) h.past.shift()
    h.last = current
    h.future = []
    syncHistory()
  }, [])

  // One step per pause, however the change was made
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => recordHistory(design), 350)
    return () => clearTimeout(t)
  }, [ready, design, recordHistory])

  const undo = useCallback(() => {
    recordHistory(design)
    const h = historyRef.current
    const prev = h.past.pop()
    if (!prev || !h.last) return
    h.future.push(h.last)
    h.last = prev
    setDesign(prev)
    syncHistory()
  }, [design, recordHistory])

  const redo = useCallback(() => {
    const h = historyRef.current
    const next = h.future.pop()
    if (!next || !h.last) return
    h.past.push(h.last)
    h.last = next
    setDesign(next)
    syncHistory()
  }, [])

  // ─── Draw: the image layer ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = sceneRef.current
    const base = baseRef.current
    const original = originalRef.current
    const toned = tonedRef.current
    if (!ready || !canvas || !base || !original || !toned || !size.w) return

    // Same math the server applies; sharpen happens in the worker
    const { adjust } = design
    const toneKey = [adjust.brightness, adjust.contrast, adjust.saturation, adjust.midtones].join()
    if (tonedKeyRef.current !== toneKey) {
      const px = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
      adjustPixels(px.data, 4, adjust)
      toned.getContext("2d")!.putImageData(px, 0, 0)
      tonedKeyRef.current = toneKey
    }

    const { W, H, fw, fh, fx, fy, k } = view
    if (canvas.width !== W) canvas.width = W
    if (canvas.height !== H) canvas.height = H
    const ctx = canvas.getContext("2d")!

    /** The frame's art at this resolution, as the server would lay it out */
    const frameCanvas = (w: number, h: number) => {
      const off = makeCanvas(w, h)
      const oc = off.getContext("2d", { willReadFrequently: true })!
      oc.setTransform(w / DW, 0, 0, h / DH, 0, 0)
      oc.fillStyle = design.bg
      oc.fillRect(0, 0, DW, DH)
      drawArt(oc, toned, design)
      return oc
    }

    const frameKey = `${designKey}|${fw}x${fh}`

    const requestFull = () => {
      const worker = workerRef.current
      if (!worker || workerBusyRef.current) return
      const up = clamp(Math.floor(Math.sqrt(FULL_PIXELS / (fw * fh))), 1, 3)
      const px = frameCanvas(fw * up, fh * up).getImageData(0, 0, fw * up, fh * up)
      const job: PanelJob = { key: frameKey, buffer: px.data.buffer as ArrayBuffer, width: px.width, height: px.height, up, sharpen: adjust.sharpen }
      workerBusyRef.current = true
      worker.postMessage(job, [job.buffer])
    }

    const draftFrame = () => {
      if (draftRef.current?.key === frameKey) return draftRef.current
      const down = Math.max(1, Math.ceil(Math.sqrt((fw * fh) / DRAFT_PIXELS)))
      const w = Math.ceil(fw / down), h = Math.ceil(fh / down)
      const oc = frameCanvas(w, h)
      const px = oc.getImageData(0, 0, w, h)
      ditherToPanel(px.data, w, h)
      oc.putImageData(px, 0, 0)
      draftRef.current = { key: frameKey, canvas: oc.canvas, down }
      return draftRef.current
    }

    /** On a wall only the screens show the panel; frames and gaps hide it */
    const clipToScreens = () => {
      if (!wall) return
      ctx.beginPath()
      for (const s of wall.screens) ctx.rect(fx + s.x * k, fy + s.y * k, s.w * k, s.h * k)
      ctx.clip()
    }

    const paintOriginal = (x: number, w: number) => {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.beginPath()
      ctx.rect(x, fy, w, fh)
      ctx.clip()
      clipToScreens()
      ctx.setTransform(k, 0, 0, k, fx, fy)
      ctx.fillStyle = design.bg
      ctx.fillRect(0, 0, DW, DH)
      drawArt(ctx, original, design)
      ctx.restore()
    }

    const paintPanel = (x: number, w: number) => {
      const full = fullRef.current?.key === frameKey ? fullRef.current : null
      if (!full && quality === "full") requestFull()
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.beginPath()
      ctx.rect(x, fy, w, fh)
      ctx.clip()
      clipToScreens()
      if (full) {
        // 1:1 device pixels; scaling a dither pattern here would alias into streaks
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(full.canvas, fx, fy)
      } else {
        const draft = draftFrame()
        ctx.imageSmoothingEnabled = true
        ctx.drawImage(draft.canvas, fx, fy, draft.canvas.width * draft.down, draft.canvas.height * draft.down)
      }
      ctx.restore()
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = WORKSPACE
    ctx.fillRect(0, 0, W, H)

    // Whatever falls outside the frame shows as a ghost, so it's easy to grab
    ctx.setTransform(k, 0, 0, k, fx, fy)
    ctx.globalAlpha = 0.28
    drawArt(ctx, mode === "original" ? original : toned, design)
    ctx.globalAlpha = 1

    if (mode === "panel") paintPanel(fx, fw)
    else if (mode === "original") paintOriginal(fx, fw)
    else {
      const left = Math.round(fw * split)
      paintOriginal(fx, left)
      paintPanel(fx + left, fw - left)
    }

    // The physical display's bezel; on a wall, each screen's frame at its real width
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.strokeStyle = BEZEL
    if (wall) {
      const b = Math.max(2, wall.bezel * k)
      ctx.lineWidth = b
      for (const s of wall.screens) ctx.strokeRect(fx + s.x * k - b / 2, fy + s.y * k - b / 2, s.w * k + b, s.h * k + b)
    } else {
      const bezel = Math.max(4, Math.round(Math.min(fw, fh) * 0.014))
      ctx.lineWidth = bezel
      ctx.strokeRect(fx - bezel / 2, fy - bezel / 2, fw + bezel, fh + bezel)
    }
  }, [ready, design, designKey, mode, split, view, quality, fullFrames, size.w, DW, DH, wall])

  // ─── Draw: handles and guides, over the image layer ──────────────────────
  useEffect(() => {
    const canvas = overlayRef.current
    if (!ready || !canvas || !size.w) return
    const { W, H, fw, fh, fx, fy, k, dpr } = view
    if (canvas.width !== W) canvas.width = W
    if (canvas.height !== H) canvas.height = H
    const ctx = canvas.getContext("2d")!
    ctx.clearRect(0, 0, W, H)
    const dev = (p: Pt) => ({ x: fx + p.x * k, y: fy + p.y * k })

    ctx.strokeStyle = GUIDE
    ctx.lineWidth = dpr
    ctx.setLineDash([6 * dpr, 4 * dpr])
    if (guides.x !== undefined) {
      const x = Math.round(dev({ x: guides.x, y: 0 }).x) + 0.5
      ctx.beginPath(); ctx.moveTo(x, fy); ctx.lineTo(x, fy + fh); ctx.stroke()
    }
    if (guides.y !== undefined) {
      const y = Math.round(dev({ x: 0, y: guides.y }).y) + 0.5
      ctx.beginPath(); ctx.moveTo(fx, y); ctx.lineTo(fx + fw, y); ctx.stroke()
    }
    ctx.setLineDash([])

    // Which display is which
    if (wall) {
      ctx.font = `600 ${11 * dpr}px system-ui`
      ctx.textAlign = "left"
      ctx.textBaseline = "middle"
      for (const s of wall.screens) {
        const p = dev({ x: s.x, y: s.y })
        const pad = 6 * dpr, h = 20 * dpr
        const w = ctx.measureText(s.label).width + 12 * dpr
        ctx.fillStyle = "rgba(0,0,0,0.55)"
        ctx.beginPath(); ctx.roundRect(p.x + pad, p.y + pad, w, h, 4 * dpr); ctx.fill()
        ctx.fillStyle = "#fff"
        ctx.fillText(s.label, p.x + pad + 6 * dpr, p.y + pad + h / 2)
      }
    }

    if (mode === "split") {
      const x = fx + Math.round(fw * split)
      ctx.strokeStyle = "#fff"
      ctx.lineWidth = 2 * dpr
      ctx.beginPath(); ctx.moveTo(x, fy); ctx.lineTo(x, fy + fh); ctx.stroke()
      ctx.fillStyle = "#fff"
      ctx.beginPath(); ctx.arc(x, fy + fh / 2, 11 * dpr, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = "#222"
      ctx.font = `600 ${13 * dpr}px system-ui`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("‹ ›", x, fy + fh / 2)
      ctx.font = `600 ${11 * dpr}px system-ui`
      ctx.fillStyle = "rgba(0,0,0,0.6)"
      ctx.fillRect(fx + 8 * dpr, fy + 8 * dpr, 58 * dpr, 20 * dpr)
      ctx.fillRect(fx + fw - 74 * dpr, fy + 8 * dpr, 66 * dpr, 20 * dpr)
      ctx.fillStyle = "#fff"
      ctx.fillText("Original", fx + 37 * dpr, fy + 18 * dpr)
      ctx.fillText("On panel", fx + fw - 41 * dpr, fy + 18 * dpr)
    }

    if (selected) {
      const pts = corners(design.xf).map(dev)
      ctx.strokeStyle = SELECTION
      ctx.lineWidth = 1.25 * dpr
      ctx.beginPath()
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath()
      ctx.stroke()

      const r = rad(design.xf.rot)
      const topMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
      const knob = { x: topMid.x + Math.sin(r) * KNOB_DISTANCE * dpr, y: topMid.y - Math.cos(r) * KNOB_DISTANCE * dpr }
      ctx.beginPath(); ctx.moveTo(topMid.x, topMid.y); ctx.lineTo(knob.x, knob.y); ctx.stroke()
      ctx.fillStyle = "#fff"
      ctx.beginPath(); ctx.arc(knob.x, knob.y, 5.5 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()

      const box = HANDLE * dpr
      for (const p of pts) {
        ctx.fillStyle = "#fff"
        ctx.beginPath()
        ctx.roundRect(p.x - box / 2, p.y - box / 2, box, box, 2 * dpr)
        ctx.fill()
        ctx.stroke()
      }
      // Side handles: bars along each side, for stretching one way
      sideMiddles(design.xf).map(dev).forEach((p, i) => {
        const long = 16 * dpr, thin = 6 * dpr
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(r + (i % 2 ? Math.PI / 2 : 0))
        ctx.fillStyle = "#fff"
        ctx.beginPath()
        ctx.roundRect(-long / 2, -thin / 2, long, thin, thin / 2)
        ctx.fill()
        ctx.stroke()
        ctx.restore()
      })
    }
  }, [ready, design.xf, selected, guides, mode, split, view, size.w, wall])

  // ─── Pointer interaction ─────────────────────────────────────────────────
  const toDisplay = (e: React.PointerEvent): Pt => {
    const rect = overlayRef.current!.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) * view.dpr - view.fx) / view.k,
      y: ((e.clientY - rect.top) * view.dpr - view.fy) / view.k,
    }
  }

  const hitTest = (p: Pt, xf: Xform) => {
    const { k, dpr } = view
    const px = (css: number) => (css * dpr) / k // CSS pixels → display pixels

    if (mode === "split" && Math.abs(p.x - DW * split) <= px(9) && p.y >= 0 && p.y <= DH) return { type: "split" as const }

    const pts = corners(xf)
    if (selected) {
      const topMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
      const r = rad(xf.rot)
      const knob = { x: topMid.x + Math.sin(r) * px(KNOB_DISTANCE), y: topMid.y - Math.cos(r) * px(KNOB_DISTANCE) }
      if (Math.hypot(p.x - knob.x, p.y - knob.y) <= px(GRAB)) return { type: "rotate" as const }
    }
    let nearest = -1, nd = Infinity
    pts.forEach((c, i) => {
      const d = Math.hypot(p.x - c.x, p.y - c.y)
      if (d < nd) { nd = d; nearest = i }
    })
    const local = toLocal(p, xf)
    const inside = Math.abs(local.x) <= xf.w / 2 && Math.abs(local.y) <= xf.h / 2
    if (nd <= px(GRAB)) return { type: "corner" as const, corner: nearest }
    if (selected) {
      const sides = sideMiddles(xf)
      const side = sides.findIndex(m => Math.hypot(p.x - m.x, p.y - m.y) <= px(GRAB))
      if (side !== -1) return { type: "side" as const, side }
    }
    if (!inside && nd <= px(ROTATE_ZONE)) return { type: "rotate" as const }
    if (inside) return { type: "inside" as const }
    return { type: "none" as const }
  }

  const sampleColor = (p: Pt) => {
    const base = baseRef.current
    if (!base) return
    const local = toLocal(p, design.xf)
    const u = local.x / design.xf.w + 0.5, v = local.y / design.xf.h + 0.5
    if (u < 0 || u > 1 || v < 0 || v > 1) return
    const i = (Math.min(base.height - 1, Math.floor(v * base.height)) * base.width + Math.min(base.width - 1, Math.floor(u * base.width))) * 4
    patch({ bg: hex([base.data[i], base.data[i + 1], base.data[i + 2]]) })
    setSampling(false)
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!ready || !overlayRef.current) return
    const p = toDisplay(e)
    if (sampling) { sampleColor(p); return }
    const { xf } = design
    const hit = hitTest(p, xf)
    const capture = () => (e.target as HTMLElement).setPointerCapture(e.pointerId)

    if (hit.type === "split") { dragRef.current = { kind: "split" }; capture(); return }
    if (!selected) {
      if (hit.type === "inside" || hit.type === "corner") {
        setSelected(true)
        dragRef.current = { kind: "move", start: p, base: { x: xf.cx, y: xf.cy } }
        capture()
      }
      return
    }
    if (hit.type === "corner") {
      const pts = corners(xf)
      const anchor = pts[(hit.corner + 2) % 4]
      const la = toLocal(anchor, xf), lc = toLocal(pts[hit.corner], xf)
      dragRef.current = { kind: "scale", anchor, sign: { x: Math.sign(lc.x - la.x) || 1, y: Math.sign(lc.y - la.y) || 1 } }
    } else if (hit.type === "side") {
      const sides = sideMiddles(xf)
      const axis = hit.side % 2 ? "x" : "y"
      const anchor = sides[(hit.side + 2) % 4]
      const la = toLocal(anchor, xf), lh = toLocal(sides[hit.side], xf)
      dragRef.current = { kind: "side", anchor, axis, sign: Math.sign(lh[axis] - la[axis]) || 1 }
    } else if (hit.type === "rotate") {
      dragRef.current = { kind: "rotate", startAngle: Math.atan2(p.y - xf.cy, p.x - xf.cx), base: xf.rot }
    } else if (hit.type === "inside") {
      dragRef.current = { kind: "move", start: p, base: { x: xf.cx, y: xf.cy } }
    } else {
      setSelected(false)
      return
    }
    capture()
  }

  /** Pull a dragged position onto the frame's center and edges */
  const snapped = (x: number, y: number, t: Xform) => {
    const tol = (SNAP * view.dpr) / view.k
    const box = rotatedBox(t.w, t.h, t.rot)
    const pick = (v: number, half: number, length: number) => {
      const options = [
        { to: length / 2, guide: length / 2 },
        { to: half, guide: 0 },
        { to: length - half, guide: length },
      ]
      const best = options.reduce((a, b) => (Math.abs(v - b.to) < Math.abs(v - a.to) ? b : a))
      return Math.abs(v - best.to) <= tol ? best : null
    }
    const sx = pick(x, box.w / 2, DW), sy = pick(y, box.h / 2, DH)
    return { x: sx ? sx.to : x, y: sy ? sy.to : y, guides: { x: sx?.guide, y: sy?.guide } }
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!ready || !overlayRef.current) return
    const p = toDisplay(e)
    const drag = dragRef.current
    const { xf } = design
    if (!drag) {
      if (sampling) { setCursor("crosshair"); return }
      const hit = hitTest(p, xf)
      setCursor(
        hit.type === "split" ? "ew-resize"
        : !selected ? (hit.type === "inside" || hit.type === "corner" ? "move" : "default")
        : hit.type === "corner" ? "nwse-resize"
        : hit.type === "side" ? sideCursor(hit.side, xf.rot)
        : hit.type === "rotate" ? ROTATE_CURSOR
        : hit.type === "inside" ? "move"
        : "default")
      return
    }
    if (drag.kind === "split") {
      setSplit(clamp(p.x / DW, 0.02, 0.98))
    } else if (drag.kind === "move") {
      const x = drag.base.x + (p.x - drag.start.x), y = drag.base.y + (p.y - drag.start.y)
      // ⌘/Ctrl moves freely
      const s = e.metaKey || e.ctrlKey ? { x, y, guides: {} } : snapped(x, y, xf)
      setGuides(s.guides)
      setXf(t => ({ ...t, cx: s.x, cy: s.y }))
    } else if (drag.kind === "rotate") {
      const angle = Math.atan2(p.y - xf.cy, p.x - xf.cx)
      let rot = drag.base + ((angle - drag.startAngle) * 180) / Math.PI
      if (e.shiftKey) rot = Math.round(rot / 15) * 15
      else if (Math.abs(rot - Math.round(rot / 90) * 90) < 1.5) rot = Math.round(rot / 90) * 90
      setXf(t => ({ ...t, rot }))
    } else if (drag.kind === "side") {
      setXf(t => {
        const la = toLocal(drag.anchor, t), lp = toLocal(p, t)
        const size = Math.max(40, (lp[drag.axis] - la[drag.axis]) * drag.sign)
        const center = drag.axis === "x"
          ? fromLocal({ x: la.x + (size * drag.sign) / 2, y: la.y }, t)
          : fromLocal({ x: la.x, y: la.y + (size * drag.sign) / 2 }, t)
        return drag.axis === "x" ? { ...t, w: size, cx: center.x, cy: center.y } : { ...t, h: size, cx: center.x, cy: center.y }
      })
    } else {
      // ⇧ flips the proportions lock while dragging a corner
      const lock = aspectLock !== e.shiftKey
      setXf(t => {
        const la = toLocal(drag.anchor, t), lp = toLocal(p, t)
        const min = 40
        const dw = Math.max(min, (lp.x - la.x) * drag.sign.x)
        const dh = Math.max(min, (lp.y - la.y) * drag.sign.y)
        let w = dw, h = dh
        if (lock) {
          const s = Math.max(dw / t.w, dh / t.h)
          w = t.w * s
          h = t.h * s
        }
        const center = fromLocal({ x: la.x + (w * drag.sign.x) / 2, y: la.y + (h * drag.sign.y) / 2 }, t)
        return { ...t, w, h, cx: center.x, cy: center.y }
      })
    }
  }

  const handlePointerUp = () => {
    dragRef.current = null
    setGuides({})
  }

  // ─── Keyboard ────────────────────────────────────────────────────────────
  const dirty = ready && designKey !== startKey

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (e.key === "Escape") {
        if (sampling) setSampling(false)
        else if (!dirty && !applying) onClose()
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault()
        const step = e.shiftKey ? 40 : 4
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0
        setXf(t => ({ ...t, cx: t.cx + dx, cy: t.cy + dy }))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo, dirty, sampling, applying, onClose, setXf])

  // ─── Sidebar values and actions ──────────────────────────────────────────
  const { xf, adjust } = design
  const posX = xf.cx - xf.w / 2
  const posY = xf.cy - xf.h / 2
  const rotation = ((xf.rot % 360) + 360) % 360

  const setW = (v: number) => setXf(t => {
    const w = Math.max(4, v)
    return aspectLock ? { ...t, w, h: t.h * (w / t.w) } : { ...t, w }
  })
  const setH = (v: number) => setXf(t => {
    const h = Math.max(4, v)
    return aspectLock ? { ...t, h, w: t.w * (h / t.h) } : { ...t, h }
  })

  const sizeTo = (how: "fit" | "fill") => setXf(t => {
    const box = rotatedBox(natural.w, natural.h, t.rot)
    const s = how === "fit" ? Math.min(DW / box.w, DH / box.h) : Math.max(DW / box.w, DH / box.h)
    return { ...t, w: natural.w * s, h: natural.h * s, cx: DW / 2, cy: DH / 2 }
  })

  // Fills the frame exactly, ignoring the image's proportions
  const stretchToFrame = () => {
    setAspectLock(false)
    setXf(t => {
      const quarterTurned = Math.abs(Math.round(t.rot / 90)) % 2 === 1
      return { ...t, w: quarterTurned ? DH : DW, h: quarterTurned ? DW : DH, cx: DW / 2, cy: DH / 2 }
    })
  }

  const align = (which: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") => setXf(t => {
    const box = rotatedBox(t.w, t.h, t.rot)
    switch (which) {
      case "left": return { ...t, cx: box.w / 2 }
      case "hcenter": return { ...t, cx: DW / 2 }
      case "right": return { ...t, cx: DW - box.w / 2 }
      case "top": return { ...t, cy: box.h / 2 }
      case "vcenter": return { ...t, cy: DH / 2 }
      case "bottom": return { ...t, cy: DH - box.h / 2 }
    }
  })

  const result: DesignResult = {
    mode: "transform",
    rotation,
    crop: null,
    scaleX: xf.w / DW,
    scaleY: xf.h / DH,
    offset: { x: (xf.cx - DW / 2) / DW, y: (xf.cy - DH / 2) / DH },
    bg: design.bg,
    radius: Math.max(0, design.radius),
    border: design.borderWidth > 0 ? { color: design.borderColor, width: design.borderWidth } : null,
    adjust: sanitizeAdjust(adjust),
  }

  const activeProfile = PROFILES.find(p => ADJUST_KEYS.every(key => p.adjust[key] === adjust[key]))
  const maxRadius = Math.round(Math.min(DW, DH) / 2)

  const alignBtn = (which: Parameters<typeof align>[0], label: string, icon: React.ReactNode) => (
    <button
      type="button"
      className="flex h-7 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
      title={label} aria-label={label} onClick={() => align(which)}
    >
      {icon}
    </button>
  )

  // Portal to <body>; only the close button or Cancel dismisses it, so a stray
  // click can't lose work
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Image designer" className="fixed inset-0 z-[100] flex flex-col bg-background">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
        <button
          type="button"
          aria-label="Close"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle} · {DW} × {DH}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={onClose} disabled={applying}>Cancel</Button>
          {secondaryLabel && onSecondary && (
            <Button variant="outline" size="sm" disabled={applying || !ready} onClick={() => onSecondary(result)}>
              {secondaryLabel}
            </Button>
          )}
          <Button size="sm" className="gap-1.5" disabled={applying || !ready} onClick={() => onPrimary(result)}>
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {primaryLabel}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Workspace */}
        <div ref={workspaceRef} className="relative min-h-[44vh] min-w-0 flex-1 overflow-hidden" style={{ background: WORKSPACE }}>
          <canvas ref={sceneRef} className="absolute inset-0 h-full w-full" />
          <canvas
            ref={overlayRef}
            data-testid="designer-canvas"
            className="absolute inset-0 h-full w-full touch-none"
            style={{ cursor }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />

          {loadState === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          )}
          {loadState === "failed" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <ImageOff className="h-7 w-7 opacity-50" />
              <p className="text-sm">This image couldn't be opened.</p>
              <p className="text-xs">Your browser may not support its file format. JPEG and PNG work best.</p>
            </div>
          )}

          {/* View controls float over the workspace, clear of the frame's edge */}
          <div className="absolute left-3 top-3 flex items-center gap-1 rounded-lg border border-white/10 bg-black/50 p-0.5 backdrop-blur-md">
            <button
              type="button" aria-label="Undo" title="Undo (⌘Z)" disabled={!canUndo} onClick={undo}
              className="flex h-7 w-7 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 disabled:text-white/25 disabled:hover:bg-transparent"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={redo}
              className="flex h-7 w-7 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/10 disabled:text-white/25 disabled:hover:bg-transparent"
            >
              <Redo2 className="h-4 w-4" />
            </button>
          </div>
          <div className="absolute left-1/2 top-3 -translate-x-1/2">
            <Segmented
              label="Preview"
              value={mode}
              onChange={setMode}
              className="border border-white/10 bg-black/50 backdrop-blur-md"
              options={[
                { value: "panel", label: "On panel", title: "An approximation of how the 6-color e-paper will render this" },
                { value: "split", label: "Compare", title: "Drag the divider to compare the original with the panel" },
                { value: "original", label: "Original", title: "The source image, with no adjustments" },
              ]}
            />
          </div>
          <p className="pointer-events-none absolute inset-x-0 bottom-2.5 hidden text-center text-[11px] text-white/45 lg:block">
            {sampling
              ? "Click the image to pick a background color. Esc cancels."
              : "Drag to move · corners resize (⇧ stretches) · side handles stretch · top knob rotates (⇧ for 15° steps) · arrow keys nudge · hold ⌘ to turn off snapping"}
          </p>
        </div>

        {/* Controls */}
        <aside className="scroll-thin min-h-0 w-full flex-1 overflow-y-auto border-t border-border bg-card md:w-[320px] md:flex-none md:border-l md:border-t-0">
          {sections}
          <Section title="Profile" aside={!activeProfile && <span className="text-[11px] text-foreground">Custom</span>}>
            <div className="grid grid-cols-4 gap-1.5">
              {PROFILES.map(p => (
                <button
                  key={p.id}
                  type="button"
                  title={p.description}
                  aria-pressed={activeProfile?.id === p.id}
                  className={cn(
                    "group overflow-hidden rounded-lg border text-center transition-colors",
                    activeProfile?.id === p.id ? "border-primary" : "border-border hover:border-muted-foreground/60",
                  )}
                  onClick={() => patch({ adjust: p.adjust })}
                >
                  <span className="block aspect-[9/11] w-full overflow-hidden bg-muted">
                    {thumbs[p.id] && <img src={thumbs[p.id]} alt="" className="h-full w-full object-cover" />}
                  </span>
                  <span className={cn(
                    "block truncate px-0.5 py-1 text-[11px]",
                    activeProfile?.id === p.id ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground group-hover:text-foreground",
                  )}>
                    {p.name}
                  </span>
                </button>
              ))}
            </div>
          </Section>

          <Section
            title="Tone"
            aside={activeProfile?.id !== defaultProfile && (
              <button
                type="button"
                className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => patch({ adjust: profileAdjust(defaultProfile) })}
              >
                Reset
              </button>
            )}
          >
            <div className="space-y-1.5">
              {SLIDERS.map(s => (
                <AdjustSlider
                  key={s.key} label={s.label} title={s.title} min={s.min} value={adjust[s.key]}
                  onChange={v => patch({ adjust: { ...adjust, [s.key]: v } })}
                />
              ))}
            </div>
          </Section>

          <Section title="Layout">
            <div className="grid grid-cols-3 gap-1">
              <Button variant="outline" size="xs" title="Show the whole image inside the frame" onClick={() => sizeTo("fit")}>Fit</Button>
              <Button variant="outline" size="xs" title="Cover the whole frame, cropping if needed" onClick={() => sizeTo("fill")}>Fill</Button>
              <Button variant="outline" size="xs" title="Fill the frame exactly, stretching the image to its shape" onClick={stretchToFrame}>Stretch</Button>
              <Button variant="outline" size="xs" className="px-0" title="Center in the frame" onClick={() => setXf(t => ({ ...t, cx: DW / 2, cy: DH / 2 }))}>Center</Button>
              <Button
                variant="outline" size="xs" className="px-0" aria-label="Rotate left" title="Rotate 90° left"
                onClick={() => setXf(t => ({ ...t, rot: t.rot - 90 }))}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline" size="xs" className="px-0" aria-label="Rotate right" title="Rotate 90° right"
                onClick={() => setXf(t => ({ ...t, rot: t.rot + 90 }))}
              >
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex gap-1.5">
              <div className="flex flex-1 gap-0.5 rounded-lg bg-secondary/70 p-0.5">
                {alignBtn("left", "Align left edge", <AlignStartVertical className="h-3.5 w-3.5" />)}
                {alignBtn("hcenter", "Align horizontal center", <AlignCenterVertical className="h-3.5 w-3.5" />)}
                {alignBtn("right", "Align right edge", <AlignEndVertical className="h-3.5 w-3.5" />)}
              </div>
              <div className="flex flex-1 gap-0.5 rounded-lg bg-secondary/70 p-0.5">
                {alignBtn("top", "Align top edge", <AlignStartHorizontal className="h-3.5 w-3.5" />)}
                {alignBtn("vcenter", "Align vertical middle", <AlignCenterHorizontal className="h-3.5 w-3.5" />)}
                {alignBtn("bottom", "Align bottom edge", <AlignEndHorizontal className="h-3.5 w-3.5" />)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <NumField label="X" value={posX} onCommit={v => setXf(t => ({ ...t, cx: v + t.w / 2 }))} />
              <NumField label="Y" value={posY} onCommit={v => setXf(t => ({ ...t, cy: v + t.h / 2 }))} />
            </div>
            <div className="flex items-center gap-0.5">
              <NumField label="W" value={xf.w} onCommit={setW} className="min-w-0 flex-1" />
              <button
                type="button"
                className={cn("flex h-8 w-6 shrink-0 items-center justify-center transition-colors", aspectLock ? "text-foreground" : "text-muted-foreground/50 hover:text-foreground")}
                title={aspectLock ? "Proportions linked. Click to unlink, so width and height change separately." : "Proportions unlinked: width and height change separately. Click to link."}
                aria-label={aspectLock ? "Unlink proportions" : "Link proportions"}
                onClick={() => setAspectLock(v => !v)}
              >
                {aspectLock ? <Link2 className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5" />}
              </button>
              <NumField label="H" value={xf.h} onCommit={setH} className="min-w-0 flex-1" />
            </div>
            <NumField label="Rotation" value={rotation} onCommit={v => setXf(t => ({ ...t, rot: v }))} unit="°" live />
          </Section>

          <Section title="Frame">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Background</span>
                <div className="flex items-center gap-1.5">
                  <ColorPicker value={design.bg} onChange={bg => patch({ bg })} title="Custom background color" />
                  <button
                    type="button"
                    aria-label="Pick background from the image"
                    title="Pick a color from the image"
                    aria-pressed={sampling}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
                      sampling ? "border-primary bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    onClick={() => setSampling(s => !s)}
                  >
                    <Pipette className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <PanelSwatches label="Background" value={design.bg} onChange={bg => patch({ bg })} />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Corner radius</span>
                <span className="text-xs tabular-nums text-muted-foreground">{design.radius} px</span>
              </div>
              <Slider aria-label="Corner radius" value={[Math.min(design.radius, maxRadius)]} min={0} max={maxRadius} onValueChange={([radius]) => patch({ radius })} />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Border</span>
                <span className="text-xs tabular-nums text-muted-foreground">{design.borderWidth ? `${design.borderWidth} px` : "None"}</span>
              </div>
              <Slider aria-label="Border width" value={[design.borderWidth]} min={0} max={200} onValueChange={([borderWidth]) => patch({ borderWidth })} />
              {design.borderWidth > 0 && (
                <div className="flex items-center justify-between pt-1">
                  <PanelSwatches label="Border" value={design.borderColor} onChange={borderColor => patch({ borderColor })} />
                  <ColorPicker value={design.borderColor} onChange={borderColor => patch({ borderColor })} title="Custom border color" />
                </div>
              )}
            </div>
          </Section>
        </aside>
      </div>
    </div>,
    document.body
  )
}
