import { useState, useCallback, useEffect } from "react"
import { createPortal } from "react-dom"
import Cropper from "react-easy-crop"
import type { Area, Point } from "react-easy-crop"
import { Check, Loader2, RotateCw, X, ZoomIn } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import type { QueueEdit } from "@/lib/types"

export interface LightboxResult {
  rotation: number
  crop: { x: number; y: number; width: number; height: number }
}

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

/**
 * Lightboxed presentation tuner. Adjusts how an image is shown — rotation,
 * scale, and crop placement — without touching the image file itself.
 */
export function LightboxEditor({ open, imageUrl, aspect, title, initial, applying, onApply, onClose }: LightboxEditorProps) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [areaPixels, setAreaPixels] = useState<Area | null>(null)

  useEffect(() => {
    if (!open) return
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setRotation(initial?.rotation ?? 0)
    setAreaPixels(initial?.crop ?? null)
  }, [open, imageUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  const onCropComplete = useCallback((_: Area, pixels: Area) => setAreaPixels(pixels), [])

  if (!open) return null

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
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Cropper */}
        <div className="relative h-[52vh] min-h-[320px] bg-black">
          <Cropper
            image={imageUrl}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={aspect}
            initialCroppedAreaPixels={initial?.crop ?? undefined}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>

        {/* Controls */}
        <div className="flex items-center gap-4 px-4 py-3 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 h-8 text-xs shrink-0"
            onClick={() => setRotation(r => (r + 90) % 360)}
          >
            <RotateCw className="h-3.5 w-3.5" /> Rotate <span className="tabular-nums text-muted-foreground">{rotation}°</span>
          </Button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <ZoomIn className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Slider value={[zoom]} onValueChange={([v]) => setZoom(v)} min={1} max={3} step={0.05} />
            <span className="text-xs text-muted-foreground tabular-nums w-9 text-right shrink-0">{zoom.toFixed(1)}x</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose} disabled={applying}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs gap-1.5"
              disabled={applying || !areaPixels}
              onClick={() => areaPixels && onApply({
                rotation,
                crop: { x: areaPixels.x, y: areaPixels.y, width: areaPixels.width, height: areaPixels.height },
              })}
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
