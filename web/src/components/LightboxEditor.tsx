import { useState, useEffect, useRef, useCallback } from "react"
import { createPortal } from "react-dom"
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignStartHorizontal, AlignStartVertical, Check, Eye, EyeOff, Link2, Link2Off, Loader2, Pipette, X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { ColorPicker } from "@/components/ColorPicker"
import type { Adjust, QueueEdit } from "@/lib/types"
import { ADJUST_KEYS, adjustPixels, boxDownscale, ditherToPanel, sanitizeAdjust } from "../../eink.mjs"

export type LightboxResult = QueueEdit

interface LightboxEditorProps {
  open: boolean
  /** Source image (raw file orientation — overrides are applied on top) */
  imageUrl: string
  /** Display frame aspect (w/h) */
  aspect: number
  title: string
  /** Existing override to resume from (queue items) */
  initial?: QueueEdit | null
  /** Busy state while the caller applies the result */
  applying?: boolean
  onApply: (result: LightboxResult) => void
  onClose: () => void
}

// Canvas workspace internals (hit-test + draw all happen in these units)
const CW = 640
const CH = 520
// The display frame sits smaller than the workspace so the image can be
// positioned "behind" it — visible pixels are what lands inside the frame
const FRAME_H_RATIO = 0.74

const HANDLE = 7
const GRAB = 12
const ROTATE_ZONE = 30

const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='M21 12a9 9 0 1 1-2.6-6.3'/%3E%3Cpath d='M21 3v5h-5'/%3E%3C/svg%3E") 10 10, alias`

type DragKind =
  | { kind: "move"; start: { x: number; y: number }; base: { x: number; y: number } }
  | { kind: "scale"; corner: number; anchor: { x: number; y: number }; sign: { x: number; y: number } }
  | { kind: "rotate"; lastAngle: number }

interface Xform { cx: number; cy: number; w: number; h: number; rot: number }

// Adjustments preview on a copy of the source capped at this long side
const PREVIEW_MAX = 1600
// E-ink preview dithers the frame at an integer 1–3× workspace resolution
// (the largest that stays under this many pixels, so dragging stays smooth),
// then box-averages back down — roughly the panel seen from viewing distance
const SIM_PIXELS = 1_100_000

const NEUTRAL: Adjust = { brightness: 0, contrast: 0, saturation: 0, midtones: 0, sharpen: 0 }

// Color e-paper renders darker and duller than a monitor: these lift
// midtones, add saturation, and crisp up edges the panel's dithering softens
const PRESETS: { name: string; title: string; adjust: Adjust }[] = [
  { name: "None", title: "No adjustment", adjust: NEUTRAL },
  { name: "E-ink", title: "Balanced boost for color e-paper",
    adjust: { brightness: 5, contrast: 15, saturation: 35, midtones: 15, sharpen: 30 } },
  { name: "Vivid", title: "Strong color for illustrations and graphics",
    adjust: { brightness: 5, contrast: 25, saturation: 70, midtones: 10, sharpen: 40 } },
  { name: "B&W", title: "Grayscale with extra contrast",
    adjust: { brightness: 0, contrast: 20, saturation: -100, midtones: 10, sharpen: 30 } },
]

const SLIDERS: { key: keyof Adjust; label: string; min: number; title: string }[] = [
  { key: "brightness", label: "Brightness", min: -100, title: "Lighten or darken everything" },
  { key: "contrast", label: "Contrast", min: -100, title: "Spread between lights and darks" },
  { key: "saturation", label: "Saturation", min: -100, title: "Color intensity — e-paper colors are muted, so most art wants a boost; -100 is grayscale" },
  { key: "midtones", label: "Midtones", min: -100, title: "Lighten or darken midtones without clipping black and white — e-paper tends to render dark" },
  { key: "sharpen", label: "Sharpen", min: 0, title: "Edge sharpening against dithering softness — applied at full resolution, so it isn't visible in this preview" },
]

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</p>
}

/** Labeled -100..100 (or 0..100) slider; double-click resets to 0 */
function AdjustSlider({ label, title, value, min, onChange }: {
  label: string; title: string; value: number; min: number; onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1" title={title}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className={`text-[11px] tabular-nums ${value ? "text-foreground" : "text-muted-foreground/60"}`}>
          {min < 0 && value > 0 ? `+${value}` : value}
        </span>
      </div>
      <Slider
        value={[value]} min={min} max={100} step={1} className="h-1.5"
        onValueChange={([v]) => onChange(v)}
        onDoubleClick={() => onChange(0)}
      />
    </div>
  )
}

/** Numeric field that commits on blur/Enter (or on every keystroke with `live`) */
function NumField({ label, value, onCommit, width = "flex-1", step = 1, live = false }: {
  label: string; value: number; onCommit: (v: number) => void; width?: string; step?: number; live?: boolean
}) {
  const editing = useRef(false)
  return (
    <label className={`flex items-center gap-1 rounded-md border border-border bg-muted/30 px-1.5 h-7 ${width}`}>
      {label && <span className="text-[10px] text-muted-foreground w-3 shrink-0">{label}</span>}
      <input
        key={live && editing.current ? "editing" : value}
        type="number"
        defaultValue={Math.round(value * 10) / 10}
        step={step}
        className="w-full min-w-0 bg-transparent text-xs outline-none tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        onFocus={() => { editing.current = true }}
        onChange={e => {
          if (!live) return
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onCommit(v)
        }}
        onBlur={e => {
          editing.current = false
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onCommit(v)
        }}
        onKeyDown={e => {
          if (e.key === "Enter") {
            const v = parseFloat((e.target as HTMLInputElement).value)
            if (Number.isFinite(v)) onCommit(v)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
    </label>
  )
}

/**
 * Free-transform presentation tuner with a properties sidebar. Drag inside the
 * image to position, corner nodes to scale (aspect link → uniform), hover just
 * outside a corner for rotation — or type exact values in the panel. Values
 * are expressed in the display's real pixels (e.g. 1440×2560 frame).
 */
export function LightboxEditor({ open, imageUrl, aspect, title, initial, applying, onApply, onClose }: LightboxEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgReady, setImgReady] = useState(false)
  const [xf, setXf] = useState<Xform>({ cx: CW / 2, cy: CH / 2, w: 100, h: 100, rot: 0 })
  const [bg, setBg] = useState("#000000")
  const [radius, setRadius] = useState(0)
  const [borderColor, setBorderColor] = useState("#ffffff")
  const [borderWidth, setBorderWidth] = useState(0)
  const [aspectLock, setAspectLock] = useState(true)
  const [sampling, setSampling] = useState(false)
  const [cursor, setCursor] = useState("default")
  // Deselect (click empty workspace) hides the outline/handles so the actual
  // result — radius, border, edges — is visible unobstructed
  const [selected, setSelected] = useState(true)
  const dragRef = useRef<DragKind | null>(null)
  const [tab, setTab] = useState<"layout" | "adjust">("layout")
  const [adjust, setAdjust] = useState<Adjust>(NEUTRAL)
  const [einkPreview, setEinkPreview] = useState(false)
  // Downscaled source pixels, and the canvas holding them with `adjust` applied
  const baseRef = useRef<ImageData | null>(null)
  const adjCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const adjKeyRef = useRef("")

  const frame = (() => {
    const fh = CH * FRAME_H_RATIO
    const fw = fh * aspect
    return { x: (CW - fw) / 2, y: (CH - fh) / 2, w: fw, h: fh }
  })()
  // Real display pixel space (what the server renders into)
  const DW = aspect >= 1 ? 2560 : 1440
  const DH = aspect >= 1 ? 1440 : 2560
  const k = frame.w / DW // canvas px per display px

  // ─── Init: load image, restore or default to contain-fit ─────────────────
  useEffect(() => {
    if (!open) return
    setImgReady(false)
    setSampling(false)
    setSelected(true)
    setBg(initial?.bg ?? "#000000")
    setRadius(initial?.radius ?? 0)
    setBorderColor(initial?.border?.color ?? "#ffffff")
    setBorderWidth(initial?.border?.width ?? 0)
    setAspectLock(true)
    setAdjust({ ...NEUTRAL, ...initial?.adjust })
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      imgRef.current = img
      const ps = Math.min(1, PREVIEW_MAX / Math.max(img.width, img.height))
      const pc = document.createElement("canvas")
      pc.width = Math.max(1, Math.round(img.width * ps))
      pc.height = Math.max(1, Math.round(img.height * ps))
      const pctx = pc.getContext("2d", { willReadFrequently: true })!
      pctx.drawImage(img, 0, 0, pc.width, pc.height)
      baseRef.current = pctx.getImageData(0, 0, pc.width, pc.height)
      adjCanvasRef.current = pc
      adjKeyRef.current = ""
      const fh = CH * FRAME_H_RATIO
      const fw = fh * aspect
      const fx = (CW - fw) / 2, fy = (CH - fh) / 2
      if (initial?.mode === "transform" && initial.offset && Number.isFinite(initial.scaleX)) {
        const sx = initial.scaleX ?? 1
        const sy = initial.scaleY ?? sx
        setXf({
          w: Math.max(8, sx * fw),
          h: Math.max(8, sy * fh),
          cx: fx + fw / 2 + (initial.offset.x ?? 0) * fw,
          cy: fy + fh / 2 + (initial.offset.y ?? 0) * fh,
          rot: initial.rotation ?? 0,
        })
      } else {
        const s = Math.min(fw / img.width, fh / img.height)
        setXf({ cx: fx + fw / 2, cy: fy + fh / 2, w: img.width * s, h: img.height * s, rot: 0 })
      }
      setImgReady(true)
    }
    img.src = imageUrl
  }, [open, imageUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Geometry helpers ────────────────────────────────────────────────────
  const rad = (deg: number) => (deg * Math.PI) / 180
  const toLocal = useCallback((px: number, py: number, t: Xform) => {
    const c = Math.cos(-rad(t.rot)), s = Math.sin(-rad(t.rot))
    const dx = px - t.cx, dy = py - t.cy
    return { x: dx * c - dy * s, y: dx * s + dy * c }
  }, [])
  const toCanvas = useCallback((lx: number, ly: number, t: Xform) => {
    const c = Math.cos(rad(t.rot)), s = Math.sin(rad(t.rot))
    return { x: t.cx + lx * c - ly * s, y: t.cy + lx * s + ly * c }
  }, [])
  const corners = useCallback((t: Xform) => (
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => toCanvas((sx * t.w) / 2, (sy * t.h) / 2, t))
  ), [toCanvas])
  const bbox = (t: Xform) => {
    const bw = Math.abs(t.w * Math.cos(rad(t.rot))) + Math.abs(t.h * Math.sin(rad(t.rot)))
    const bh = Math.abs(t.w * Math.sin(rad(t.rot))) + Math.abs(t.h * Math.cos(rad(t.rot)))
    return { bw, bh }
  }

  // ─── Draw ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!open || !canvas || !imgReady || !img) return

    // Re-run the tone adjustment (same math the server applies on push) only
    // when it changes; sharpen is full-resolution only, so it isn't part of it
    const base = baseRef.current
    const adjCanvas = adjCanvasRef.current
    const adjKey = [adjust.brightness, adjust.contrast, adjust.saturation, adjust.midtones].join()
    if (base && adjCanvas && adjKeyRef.current !== adjKey) {
      const px = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
      adjustPixels(px.data, 4, adjust)
      adjCanvas.getContext("2d")!.putImageData(px, 0, 0)
      adjKeyRef.current = adjKey
    }
    const src = adjCanvas ?? img
    canvas.width = CW
    canvas.height = CH
    const ctx = canvas.getContext("2d")!

    ctx.fillStyle = "#141414"
    ctx.fillRect(0, 0, CW, CH)

    const r = Math.max(0, Math.min(radius * k, Math.min(xf.w, xf.h) / 2))
    const bwPx = Math.max(0, borderWidth * k)
    const drawImage = (c: CanvasRenderingContext2D) => {
      c.save()
      c.translate(xf.cx, xf.cy)
      c.rotate(rad(xf.rot))
      c.beginPath()
      c.roundRect(-xf.w / 2, -xf.h / 2, xf.w, xf.h, r)
      c.save()
      c.clip()
      c.drawImage(src, -xf.w / 2, -xf.h / 2, xf.w, xf.h)
      c.restore()
      if (bwPx > 0) {
        c.lineWidth = bwPx
        c.strokeStyle = borderColor
        c.beginPath()
        c.roundRect(-xf.w / 2 + bwPx / 2, -xf.h / 2 + bwPx / 2, xf.w - bwPx, xf.h - bwPx, Math.max(0, r - bwPx / 2))
        c.stroke()
      }
      c.restore()
    }

    // Outside the frame: ghosted; inside: bg + full-strength image
    ctx.globalAlpha = 0.3
    drawImage(ctx)
    ctx.globalAlpha = 1
    if (einkPreview && !sampling) {
      // Render the frame offscreen, dither it to the panel palette, then
      // average back to workspace pixels and draw it 1:1
      const s = Math.max(1, Math.min(3, Math.floor(Math.sqrt(SIM_PIXELS / (frame.w * frame.h)))))
      const fw = Math.ceil(frame.w), fh = Math.ceil(frame.h)
      const off = document.createElement("canvas")
      off.width = fw * s
      off.height = fh * s
      const oc = off.getContext("2d", { willReadFrequently: true })!
      oc.scale(s, s)
      oc.translate(-frame.x, -frame.y)
      oc.fillStyle = bg
      oc.fillRect(frame.x, frame.y, fw, fh)
      drawImage(oc)
      const px = oc.getImageData(0, 0, off.width, off.height)
      ditherToPanel(px.data, px.width, px.height)
      const small = boxDownscale(px.data, px.width, px.height, s)
      const sim = document.createElement("canvas")
      sim.width = small.width
      sim.height = small.height
      sim.getContext("2d")!.putImageData(new ImageData(small.data, small.width, small.height), 0, 0)
      ctx.save()
      ctx.beginPath()
      ctx.rect(frame.x, frame.y, frame.w, frame.h)
      ctx.clip()
      ctx.drawImage(sim, frame.x, frame.y)
      ctx.restore()
    } else {
      ctx.save()
      ctx.beginPath()
      ctx.rect(frame.x, frame.y, frame.w, frame.h)
      ctx.clip()
      ctx.fillStyle = bg
      ctx.fillRect(frame.x, frame.y, frame.w, frame.h)
      drawImage(ctx)
      ctx.restore()
    }

    ctx.strokeStyle = "rgba(255,255,255,0.85)"
    ctx.lineWidth = 1.5
    ctx.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1)

    if (selected) {
      const pts = corners(xf)
      ctx.strokeStyle = "rgba(99,179,237,0.9)"
      ctx.lineWidth = 1
      ctx.beginPath()
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
      ctx.closePath()
      ctx.stroke()
      for (const p of pts) {
        ctx.fillStyle = "#fff"
        ctx.strokeStyle = "rgba(0,0,0,0.6)"
        ctx.fillRect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE)
        ctx.strokeRect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE)
      }
    }
  }, [open, imgReady, adjust, einkPreview, sampling, xf, bg, radius, borderColor, borderWidth, k, selected, frame.x, frame.y, frame.w, frame.h, corners])

  // ─── Pointer interaction ─────────────────────────────────────────────────
  const canvasPoint = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * CW,
      y: ((e.clientY - rect.top) / rect.height) * CH,
    }
  }

  const hitTest = (p: { x: number; y: number }) => {
    const pts = corners(xf)
    let nearest = -1, nd = Infinity
    pts.forEach((c, i) => {
      const d = Math.hypot(p.x - c.x, p.y - c.y)
      if (d < nd) { nd = d; nearest = i }
    })
    const local = toLocal(p.x, p.y, xf)
    const inside = Math.abs(local.x) <= xf.w / 2 && Math.abs(local.y) <= xf.h / 2
    if (nd <= GRAB) return { type: "corner" as const, corner: nearest }
    if (!inside && nd <= ROTATE_ZONE) return { type: "rotate" as const }
    if (inside) return { type: "inside" as const }
    return { type: "none" as const }
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!imgReady || !canvasRef.current) return
    const p = canvasPoint(e)
    if (sampling) {
      const ctx = canvasRef.current.getContext("2d")!
      const px = ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data
      setBg(`#${[px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, "0")).join("")}`)
      setSampling(false)
      return
    }
    const hit = hitTest(p)
    // Deselected: only a click on the image itself reselects (and starts a move)
    if (!selected) {
      if (hit.type === "inside" || hit.type === "corner") {
        setSelected(true)
        dragRef.current = { kind: "move", start: p, base: { x: xf.cx, y: xf.cy } }
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      }
      return
    }
    if (hit.type === "corner") {
      const pts = corners(xf)
      const anchor = pts[(hit.corner + 2) % 4]
      const la = toLocal(anchor.x, anchor.y, xf)
      const lc = toLocal(pts[hit.corner].x, pts[hit.corner].y, xf)
      dragRef.current = {
        kind: "scale", corner: hit.corner, anchor,
        sign: { x: Math.sign(lc.x - la.x) || 1, y: Math.sign(lc.y - la.y) || 1 },
      }
    } else if (hit.type === "rotate") {
      dragRef.current = { kind: "rotate", lastAngle: Math.atan2(p.y - xf.cy, p.x - xf.cx) }
    } else if (hit.type === "inside") {
      dragRef.current = { kind: "move", start: p, base: { x: xf.cx, y: xf.cy } }
    } else {
      setSelected(false)
      return
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!imgReady || !canvasRef.current) return
    const p = canvasPoint(e)
    const drag = dragRef.current
    if (!drag) {
      if (sampling) { setCursor("crosshair"); return }
      const hit = hitTest(p)
      setCursor(
        !selected ? (hit.type === "inside" || hit.type === "corner" ? "move" : "default")
        : hit.type === "corner" ? "nwse-resize"
        : hit.type === "rotate" ? ROTATE_CURSOR
        : hit.type === "inside" ? "move"
        : "default")
      return
    }
    if (drag.kind === "move") {
      setXf(t => ({ ...t, cx: drag.base.x + (p.x - drag.start.x), cy: drag.base.y + (p.y - drag.start.y) }))
    } else if (drag.kind === "rotate") {
      const angle = Math.atan2(p.y - xf.cy, p.x - xf.cx)
      const delta = ((angle - drag.lastAngle) * 180) / Math.PI
      dragRef.current = { ...drag, lastAngle: angle }
      setXf(t => ({ ...t, rot: t.rot + delta }))
    } else {
      setXf(t => {
        const la = toLocal(drag.anchor.x, drag.anchor.y, t)
        const lp = toLocal(p.x, p.y, t)
        let dw = Math.max(12, (lp.x - la.x) * drag.sign.x)
        let dh = Math.max(12, (lp.y - la.y) * drag.sign.y)
        let w = dw, h = dh
        if (aspectLock) {
          const s = Math.max(dw / t.w, dh / t.h)
          w = t.w * s
          h = t.h * s
        }
        const lcNew = { x: la.x + w * drag.sign.x, y: la.y + h * drag.sign.y }
        const centerLocal = { x: (la.x + lcNew.x) / 2, y: (la.y + lcNew.y) / 2 }
        const c = toCanvas(centerLocal.x, centerLocal.y, t)
        return { ...t, w, h, cx: c.x, cy: c.y }
      })
    }
  }

  const handlePointerUp = () => { dragRef.current = null }

  if (!open) return null

  // ─── Sidebar value mapping (display pixels) ──────────────────────────────
  const posX = (xf.cx - xf.w / 2 - frame.x) / k
  const posY = (xf.cy - xf.h / 2 - frame.y) / k
  const sizeW = xf.w / k
  const sizeH = xf.h / k
  const rotDisplay = ((xf.rot % 360) + 360) % 360

  const setX = (v: number) => setXf(t => ({ ...t, cx: frame.x + v * k + t.w / 2 }))
  const setY = (v: number) => setXf(t => ({ ...t, cy: frame.y + v * k + t.h / 2 }))
  const setW = (v: number) => setXf(t => {
    const w = Math.max(4, v * k)
    return aspectLock ? { ...t, w, h: t.h * (w / t.w) } : { ...t, w }
  })
  const setH = (v: number) => setXf(t => {
    const h = Math.max(4, v * k)
    return aspectLock ? { ...t, h, w: t.w * (h / t.h) } : { ...t, h }
  })
  const setRot = (v: number) => setXf(t => ({ ...t, rot: v }))

  const align = (which: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") => setXf(t => {
    const { bw, bh } = bbox(t)
    switch (which) {
      case "left": return { ...t, cx: frame.x + bw / 2 }
      case "hcenter": return { ...t, cx: frame.x + frame.w / 2 }
      case "right": return { ...t, cx: frame.x + frame.w - bw / 2 }
      case "top": return { ...t, cy: frame.y + bh / 2 }
      case "vcenter": return { ...t, cy: frame.y + frame.h / 2 }
      case "bottom": return { ...t, cy: frame.y + frame.h - bh / 2 }
    }
  })

  const result: LightboxResult = {
    mode: "transform",
    rotation: rotDisplay,
    crop: null,
    scaleX: xf.w / frame.w,
    scaleY: xf.h / frame.h,
    offset: {
      x: (xf.cx - (frame.x + frame.w / 2)) / frame.w,
      y: (xf.cy - (frame.y + frame.h / 2)) / frame.h,
    },
    bg,
    radius: Math.max(0, radius),
    border: borderWidth > 0 ? { color: borderColor, width: borderWidth } : null,
    adjust: sanitizeAdjust(adjust),
  }
  const adjustActive = ADJUST_KEYS.some(key => adjust[key] !== 0)
  const activePreset = PRESETS.find(p => ADJUST_KEYS.every(key => p.adjust[key] === adjust[key]))?.name

  const alignBtn = (which: Parameters<typeof align>[0], title: string, icon: React.ReactNode) => (
    <button
      className="flex h-7 flex-1 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      title={title} onClick={() => align(which)}
    >
      {icon}
    </button>
  )

  // Portal to <body>; deliberately NOT dismissed by outside clicks — Cancel/X only.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-[min(94vw,920px)] rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div>
            <p className="text-sm font-semibold leading-tight">{title}</p>
            <p className="text-[11px] text-muted-foreground">
              Drag to position · corner nodes scale · hover outside a corner to rotate
            </p>
          </div>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Workspace + properties sidebar */}
        <div className="flex">
          <div className="relative flex-1 bg-[#141414] min-w-0">
            <canvas
              ref={canvasRef}
              className="w-full block touch-none"
              style={{ aspectRatio: `${CW} / ${CH}`, cursor }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            />
            {!imgReady && (
              <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
            <button
              className={`absolute top-2 right-2 flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] backdrop-blur-sm transition-colors ${
                einkPreview
                  ? "border-primary/60 bg-primary/25 text-white"
                  : "border-white/15 bg-black/40 text-white/70 hover:text-white"
              }`}
              title="Approximate how the 6-color e-paper panel will render the frame (dithered to its palette)"
              onClick={() => setEinkPreview(v => !v)}
            >
              {einkPreview ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              E-ink preview
            </button>
          </div>

          {/* Sidebar height follows the workspace; its content scrolls */}
          <div className="relative w-[224px] shrink-0 border-l border-border">
            <div className="absolute inset-0 flex flex-col">
              <div className="flex gap-0.5 rounded-lg border border-border p-0.5 mx-3 mt-3">
                {(["layout", "adjust"] as const).map(t => (
                  <button
                    key={t}
                    className={`flex h-6 flex-1 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors ${
                      tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => setTab(t)}
                  >
                    {t === "layout" ? "Layout" : "Adjust"}
                    {t === "adjust" && adjustActive && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                  </button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
                {tab === "layout" ? (
                  <>
                    {/* Position */}
                    <div className="space-y-2">
                      <SectionLabel>Position</SectionLabel>
                      <div className="flex items-center gap-1">
                        <div className="flex flex-1 items-center rounded-lg border border-border p-0.5 gap-0.5">
                          {alignBtn("left", "Align left edge", <AlignStartVertical className="h-3.5 w-3.5" />)}
                          {alignBtn("hcenter", "Align horizontal center", <AlignCenterVertical className="h-3.5 w-3.5" />)}
                          {alignBtn("right", "Align right edge", <AlignEndVertical className="h-3.5 w-3.5" />)}
                        </div>
                        <div className="flex flex-1 items-center rounded-lg border border-border p-0.5 gap-0.5">
                          {alignBtn("top", "Align top edge", <AlignStartHorizontal className="h-3.5 w-3.5" />)}
                          {alignBtn("vcenter", "Align vertical middle", <AlignCenterHorizontal className="h-3.5 w-3.5" />)}
                          {alignBtn("bottom", "Align bottom edge", <AlignEndHorizontal className="h-3.5 w-3.5" />)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <NumField label="X" value={posX} onCommit={setX} />
                        <NumField label="Y" value={posY} onCommit={setY} />
                      </div>
                      <div className="flex items-center">
                        <NumField label="W" value={sizeW} onCommit={setW} />
                        <button
                          className={`flex h-7 w-6 shrink-0 items-center justify-center transition-colors ${
                            aspectLock ? "text-foreground" : "text-muted-foreground/50 hover:text-foreground"
                          }`}
                          title={aspectLock ? "Aspect ratio linked — click to unlink" : "Aspect ratio unlinked — click to link"}
                          onClick={() => setAspectLock(v => !v)}
                        >
                          {aspectLock ? <Link2 className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5" />}
                        </button>
                        <NumField label="H" value={sizeH} onCommit={setH} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <NumField label="∠" value={rotDisplay} onCommit={setRot} width="w-[72px]" step={1} live />
                        <span className="text-[10px] text-muted-foreground">degrees</span>
                      </div>
                    </div>

                    {/* Appearance */}
                    <div className="space-y-2">
                      <SectionLabel>Appearance</SectionLabel>
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[11px] text-muted-foreground">Background</span>
                        <div className="flex items-center gap-1.5">
                          <ColorPicker value={bg} onChange={setBg} title="Background color" />
                          <button
                            className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                              sampling ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                            }`}
                            title="Sample a color from the image"
                            onClick={() => setSampling(s => !s)}
                          >
                            <Pipette className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[11px] text-muted-foreground">Radius</span>
                        <NumField label="" value={radius} onCommit={v => setRadius(Math.max(0, v))} width="w-[88px]" live />
                      </div>
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[11px] text-muted-foreground">Border</span>
                        <div className="flex items-center gap-1.5">
                          <ColorPicker
                            value={borderColor}
                            onChange={c => {
                              setBorderColor(c)
                              // Picking a color implies wanting a border — give it width
                              setBorderWidth(w => w > 0 ? w : 8)
                            }}
                            title="Border color"
                          />
                          <NumField label="" value={borderWidth} onCommit={v => setBorderWidth(Math.max(0, v))} width="w-[64px]" live />
                        </div>
                      </div>
                      {sampling && <p className="text-[10px] text-primary">Click the image to sample…</p>}
                    </div>
                  </>
                ) : (
                  <>
                    {/* Adjust */}
                    <div className="space-y-2">
                      <SectionLabel>E-ink presets</SectionLabel>
                      <div className="grid grid-cols-4 gap-0.5 rounded-lg border border-border p-0.5">
                        {PRESETS.map(p => (
                          <button
                            key={p.name}
                            title={p.title}
                            className={`h-6 rounded-md text-[11px] transition-colors ${
                              activePreset === p.name ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                            }`}
                            onClick={() => setAdjust(p.adjust)}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <SectionLabel>Tone</SectionLabel>
                        {adjustActive && (
                          <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setAdjust(NEUTRAL)}>
                            Reset
                          </button>
                        )}
                      </div>
                      {SLIDERS.map(s => (
                        <AdjustSlider
                          key={s.key} label={s.label} title={s.title} min={s.min} value={adjust[s.key]}
                          onChange={v => setAdjust(a => ({ ...a, [s.key]: v }))}
                        />
                      ))}
                    </div>

                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      Applied to the image only, not the background or border. Turn on <span className="text-foreground">E-ink preview</span> to
                      see an approximation of the panel's muted 6-color output. Double-click a slider to reset it.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
          <p className="text-[10px] text-muted-foreground">Values are display pixels ({DW}×{DH})</p>
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button size="sm" className="h-8 text-xs gap-1.5" disabled={applying || !imgReady} onClick={() => onApply(result)}>
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Apply
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Frame aspect for a display: canvas footprint (rotation-aware) */
export function displayAspect(d: { canvasWidth: number; canvasHeight: number; rotation?: number }) {
  const rotated = (((d.rotation ?? 0) % 180) + 180) % 180 === 90
  const w = rotated ? d.canvasHeight : d.canvasWidth
  const h = rotated ? d.canvasWidth : d.canvasHeight
  return h > 0 ? w / h : 9 / 16
}
