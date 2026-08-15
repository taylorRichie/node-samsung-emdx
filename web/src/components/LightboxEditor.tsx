import { useState, useCallback, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import Cropper from "react-easy-crop"
import type { Area, Point } from "react-easy-crop"
import { Check, Crop, Expand, Loader2, Maximize2, Pipette, RotateCw, X, ZoomIn } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import type { QueueEdit } from "@/lib/types"

export type LightboxResult = QueueEdit

interface LightboxEditorProps {
  open: boolean
  /** Source image (raw file orientation — overrides are applied on top) */
  imageUrl: string
  /** Crop box aspect: the display frame's aspect */
  aspect: number
  title: string
  /** Existing override to resume from (queue items) */
  initial?: QueueEdit | null
  /** Busy state while the caller applies the result */
  applying?: boolean
  onApply: (result: LightboxResult) => void
  onClose: () => void
}

type EditMode = "crop" | "fit" | "stretch"

/**
 * Lightboxed presentation tuner. Three mapping modes:
 *  - Crop: pan/zoom the art to fill the frame (react-easy-crop)
 *  - Fit: whole art in-frame, draggable, letterboxed in a chosen color;
 *    zooming below 1× shrinks the art further into the letterbox
 *  - Stretch: force the art to the frame's aspect
 * Rotation is a 90° step + a fine slider. The letterbox color can be picked
 * or sampled from the image itself.
 */
export function LightboxEditor({ open, imageUrl, aspect, title, initial, applying, onApply, onClose }: LightboxEditorProps) {
  const [mode, setMode] = useState<EditMode>("crop")
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [cropZoom, setCropZoom] = useState(1)
  const [areaPixels, setAreaPixels] = useState<Area | null>(null)

  const [rotStep, setRotStep] = useState(0)   // 0/90/180/270
  const [rotFine, setRotFine] = useState(0)   // -45..45
  const rotation = ((rotStep + rotFine) % 360 + 360) % 360

  const [fitZoom, setFitZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [bg, setBg] = useState("#000000")
  const [sampling, setSampling] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgReady, setImgReady] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; base: { x: number; y: number } } | null>(null)

  useEffect(() => {
    if (!open) return
    const init = initial ?? null
    setMode((init?.mode as EditMode) ?? "crop")
    setCrop({ x: 0, y: 0 })
    setCropZoom(1)
    setAreaPixels(init?.crop ?? null)
    const rot = init?.rotation ?? 0
    const step = Math.round(rot / 90) * 90
    setRotStep(((step % 360) + 360) % 360)
    setRotFine(rot - step > 45 ? rot - step - 360 : rot - step)
    setFitZoom(init?.zoom ?? 1)
    setOffset(init?.offset ?? { x: 0, y: 0 })
    setBg(init?.bg ?? "#000000")
    setSampling(false)
  }, [open, imageUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load the source image once for the canvas preview
  useEffect(() => {
    if (!open) return
    setImgReady(false)
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => { imgRef.current = img; setImgReady(true) }
    img.src = imageUrl
  }, [open, imageUrl])

  // ─── Fit / Stretch canvas preview (mirrors the server's render math) ─────
  useEffect(() => {
    if (mode === "crop" || !imgReady || !canvasRef.current || !imgRef.current) return
    const canvas = canvasRef.current
    const FW = 720
    const FH = Math.round(FW / aspect)
    canvas.width = FW
    canvas.height = FH
    const ctx = canvas.getContext("2d")!
    const img = imgRef.current

    // Rotate into a bounding-box canvas (matches sharp's rotate output)
    const rad = (rotation * Math.PI) / 180
    const bw = Math.abs(img.width * Math.cos(rad)) + Math.abs(img.height * Math.sin(rad))
    const bh = Math.abs(img.width * Math.sin(rad)) + Math.abs(img.height * Math.cos(rad))
    const off = document.createElement("canvas")
    off.width = Math.max(1, Math.round(bw))
    off.height = Math.max(1, Math.round(bh))
    const octx = off.getContext("2d")!
    octx.fillStyle = bg
    octx.fillRect(0, 0, off.width, off.height)
    octx.translate(off.width / 2, off.height / 2)
    octx.rotate(rad)
    octx.drawImage(img, -img.width / 2, -img.height / 2)

    ctx.fillStyle = bg
    ctx.fillRect(0, 0, FW, FH)
    if (mode === "stretch") {
      ctx.drawImage(off, 0, 0, FW, FH)
    } else {
      const scale = Math.min(FW / off.width, FH / off.height) * fitZoom
      const sw = off.width * scale
      const sh = off.height * scale
      ctx.drawImage(off, (FW - sw) / 2 + offset.x * FW, (FH - sh) / 2 + offset.y * FH, sw, sh)
    }
  }, [mode, imgReady, rotation, fitZoom, offset, bg, aspect])

  const onCropComplete = useCallback((_: Area, pixels: Area) => setAreaPixels(pixels), [])

  // ─── Fit-mode dragging + color sampling ──────────────────────────────────
  const canvasPos = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width),
      y: ((e.clientY - rect.top) / rect.height),
    }
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!canvasRef.current) return
    if (sampling) {
      const p = canvasPos(e)
      const ctx = canvasRef.current.getContext("2d")!
      const px = ctx.getImageData(
        Math.round(p.x * canvasRef.current.width),
        Math.round(p.y * canvasRef.current.height), 1, 1).data
      setBg(`#${[px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, "0")).join("")}`)
      setSampling(false)
      return
    }
    if (mode !== "fit") return
    dragRef.current = { startX: e.clientX, startY: e.clientY, base: offset };
    (e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    setOffset({
      x: dragRef.current.base.x + (e.clientX - dragRef.current.startX) / rect.width,
      y: dragRef.current.base.y + (e.clientY - dragRef.current.startY) / rect.height,
    })
  }
  const handlePointerUp = () => { dragRef.current = null }

  if (!open) return null

  const modeBtn = (m: EditMode, label: string, icon: React.ReactNode) => (
    <button
      key={m}
      className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
        mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
      onClick={() => setMode(m)}
    >
      {icon} {label}
    </button>
  )

  const result: LightboxResult = {
    mode,
    rotation,
    crop: mode === "crop" && areaPixels
      ? { x: areaPixels.x, y: areaPixels.y, width: areaPixels.width, height: areaPixels.height }
      : null,
    zoom: fitZoom,
    offset,
    bg,
  }

  // Portal to <body>: the rail panels are CSS-transformed, which would
  // otherwise turn this fixed overlay into a child of the panel box
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-[min(92vw,680px)] rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div>
            <p className="text-sm font-semibold leading-tight">{title}</p>
            <p className="text-[11px] text-muted-foreground">Presentation only — the image file is untouched</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-border p-0.5 gap-0.5 w-[260px]">
              {modeBtn("crop", "Crop", <Crop className="h-3.5 w-3.5" />)}
              {modeBtn("fit", "Fit", <Maximize2 className="h-3.5 w-3.5" />)}
              {modeBtn("stretch", "Stretch", <Expand className="h-3.5 w-3.5" />)}
            </div>
            <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Preview */}
        <div className="relative h-[52vh] min-h-[320px] bg-black flex items-center justify-center">
          {mode === "crop" ? (
            <Cropper
              image={imageUrl}
              crop={crop}
              zoom={cropZoom}
              rotation={rotation}
              aspect={aspect}
              initialCroppedAreaPixels={initial?.mode !== "fit" && initial?.mode !== "stretch" ? initial?.crop ?? undefined : undefined}
              onCropChange={setCrop}
              onZoomChange={setCropZoom}
              onCropComplete={onCropComplete}
            />
          ) : (
            <canvas
              ref={canvasRef}
              className={`max-h-full max-w-full border border-border/50 ${sampling ? "cursor-crosshair" : mode === "fit" ? "cursor-grab active:cursor-grabbing" : ""}`}
              style={{ aspectRatio: String(aspect), height: "100%" }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            />
          )}
        </div>

        {/* Controls */}
        <div className="space-y-2.5 px-4 py-3 border-t border-border">
          <div className="flex items-center gap-3">
            {/* Rotation: 90° step + fine slider */}
            <Button
              variant="outline" size="sm" className="gap-1.5 h-8 text-xs shrink-0 w-[104px]"
              onClick={() => setRotStep(r => (r + 90) % 360)}
            >
              <RotateCw className="h-3.5 w-3.5" /> <span className="tabular-nums">{Math.round(rotation)}°</span>
            </Button>
            <div className="flex items-center gap-2 flex-1 min-w-0" title="Fine rotation">
              <Slider value={[rotFine]} onValueChange={([v]) => setRotFine(v)} min={-45} max={45} step={0.5} />
              <button
                className="text-[10px] text-muted-foreground hover:text-foreground tabular-nums w-10 text-right shrink-0"
                title="Reset fine rotation"
                onClick={() => setRotFine(0)}
              >
                {rotFine > 0 ? "+" : ""}{rotFine.toFixed(1)}°
              </button>
            </div>
            {/* Zoom */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <ZoomIn className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {mode === "crop" ? (
                <Slider value={[cropZoom]} onValueChange={([v]) => setCropZoom(v)} min={1} max={3} step={0.05} />
              ) : (
                <Slider value={[fitZoom]} onValueChange={([v]) => setFitZoom(v)} min={0.1} max={3} step={0.05} disabled={mode === "stretch"} />
              )}
              <span className="text-xs text-muted-foreground tabular-nums w-9 text-right shrink-0">
                {(mode === "crop" ? cropZoom : fitZoom).toFixed(1)}x
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Letterbox color */}
            <div className={`flex items-center gap-1.5 ${mode === "crop" ? "opacity-40 pointer-events-none" : ""}`}>
              <span className="text-[11px] text-muted-foreground">Letterbox</span>
              <input
                type="color" value={bg}
                onChange={e => setBg(e.target.value)}
                className="h-7 w-9 rounded-md border border-border bg-transparent cursor-pointer p-0.5"
                title="Letterbox color"
              />
              <button
                className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                  sampling ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
                title="Sample a color from the image"
                onClick={() => setSampling(s => !s)}
              >
                <Pipette className="h-3.5 w-3.5" />
              </button>
              {sampling && <span className="text-[11px] text-primary">Click the image…</span>}
            </div>
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose} disabled={applying}>
              Cancel
            </Button>
            <Button
              size="sm" className="h-8 text-xs gap-1.5"
              disabled={applying || (mode === "crop" && !areaPixels)}
              onClick={() => onApply(result)}
            >
              {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Apply
            </Button>
          </div>
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
