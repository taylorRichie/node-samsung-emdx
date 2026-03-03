import { useRef, useState, useCallback } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DisplayTile } from "@/components/DisplayTile"
import type { DisplayConfig, DisplayStatus } from "@/lib/types"

interface DisplayCanvasProps {
  displays: DisplayConfig[]
  statuses: Record<string, DisplayStatus | null>
  lastImageTimestamps: Record<string, number>
  onSettingsClick: (displayId: string) => void
  onPositionChange: (displayId: string, x: number, y: number) => void
  onAddDisplay: () => void
}

export function DisplayCanvas({
  displays, statuses, lastImageTimestamps,
  onSettingsClick, onPositionChange, onAddDisplay,
}: DisplayCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null)
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent, display: DisplayConfig) => {
    if ((e.target as HTMLElement).closest("button")) return
    e.preventDefault()
    setDragging({ id: display.id, startX: e.clientX, startY: e.clientY, origX: display.canvasX, origY: display.canvasY })
    setDragPos({ x: display.canvasX, y: display.canvasY })
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return
    const dx = e.clientX - dragging.startX
    const dy = e.clientY - dragging.startY
    setDragPos({ x: dragging.origX + dx, y: dragging.origY + dy })
  }, [dragging])

  const handleMouseUp = useCallback(() => {
    if (dragging && dragPos) {
      const dx = Math.abs(dragPos.x - dragging.origX)
      const dy = Math.abs(dragPos.y - dragging.origY)
      if (dx > 5 || dy > 5) {
        onPositionChange(dragging.id, Math.max(0, dragPos.x), Math.max(0, dragPos.y))
      }
    }
    setDragging(null)
    setDragPos(null)
  }, [dragging, dragPos, onPositionChange])

  const maxX = Math.max(800, ...displays.map(d => d.canvasX + d.canvasWidth + 40))
  const maxY = Math.max(500, ...displays.map(d => d.canvasY + d.canvasHeight + 40))

  return (
    <div
      ref={canvasRef}
      className="relative border border-border rounded-xl bg-muted/20 overflow-auto"
      style={{ minHeight: maxY, minWidth: "100%" }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Grid pattern */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: "radial-gradient(circle, currentColor 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }} />

      {displays.map(display => {
        const isDragging = dragging?.id === display.id
        const x = isDragging && dragPos ? dragPos.x : display.canvasX
        const y = isDragging && dragPos ? dragPos.y : display.canvasY
        const ts = lastImageTimestamps[display.id] || 0

        return (
          <div
            key={display.id}
            className={`absolute select-none ${isDragging ? "z-50 scale-105" : "z-10"} transition-shadow`}
            style={{ left: x, top: y, cursor: isDragging ? "grabbing" : "grab" }}
            onMouseDown={e => handleMouseDown(e, display)}
          >
            <DisplayTile
              display={display}
              status={statuses[display.id] ?? null}
              lastImageUrl={display.host ? `/api/displays/${display.id}/last-image?t=${ts}` : null}
              onSettingsClick={() => {
                if (!isDragging) onSettingsClick(display.id)
              }}
            />
          </div>
        )
      })}

      {displays.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
          <p className="text-sm mb-3">No displays configured</p>
          <Button variant="outline" className="gap-2" onClick={onAddDisplay}>
            <Plus className="h-4 w-4" /> Add Your First Display
          </Button>
        </div>
      )}

      {displays.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="absolute bottom-3 right-3 gap-1.5 z-20 bg-background/80 backdrop-blur-sm"
          onClick={onAddDisplay}
        >
          <Plus className="h-3.5 w-3.5" /> Add Display
        </Button>
      )}
    </div>
  )
}
