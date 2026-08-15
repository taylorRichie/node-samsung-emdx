import { useRef, useState, useCallback, useEffect, useMemo } from "react"
import {
  Plus, Maximize, ZoomIn, ZoomOut, ImagePlus, ScanSearch, Lock, LockOpen, Trash2,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { DisplayTile, footprint } from "@/components/DisplayTile"
import { DisplayHUD, type HudMode, type FtSub } from "@/components/DisplayHUD"
import { DisplayListPanel } from "@/components/DisplayListPanel"
import { rectToQuadMatrix, inferQuad, quadBounds, translateQuad } from "@/lib/perspective"
import type { DisplayConfig, DisplayStatus, Scene, Quad } from "@/lib/types"

interface DisplayCanvasProps {
  displays: DisplayConfig[]
  scenes: Scene[]
  statuses: Record<string, DisplayStatus | null>
  lastImageTimestamps: Record<string, number>
  /** Display whose settings modal is open — rendered flat (perspective released) */
  settingsOpenId: string | null
  onOpenSettings: (displayId: string) => void
  /** Reports the single-selected display (null when none / multi) */
  onActiveDisplayChange?: (displayId: string | null) => void
  onPatchDisplay: (displayId: string, patch: Partial<DisplayConfig>) => void
  onPatchScene: (sceneId: string, patch: Partial<Scene>) => void
  onSceneUpload: (file: File, canvasX: number, canvasY: number) => void
  onSceneDelete: (sceneId: string) => void
  onAddDisplay: () => void
  /** Show/hide the left display list panel (toggled from the app header) */
  listOpen: boolean
}

const MIN_ZOOM = 0.15
const MAX_ZOOM = 3
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

type View = { x: number; y: number; zoom: number }
type TileDrag = { id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean }
type QuadDrag = { id: string; sceneId: string; startX: number; startY: number; origQuad: Quad; moved: boolean }
type NodeDrag = { id: string; sceneId: string; corner: number; startX: number; startY: number; origQuad: Quad; moved: boolean }
type QuadScaleDrag = { id: string; corner: number; startX: number; startY: number; origQuad: Quad }
type FlatScaleDrag = { id: string; corner: number; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number }
type SceneDrag = { id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean }
type SceneResize = { id: string; startX: number; startY: number; origW: number; origH: number }
type PanDrag = { startX: number; startY: number; origX: number; origY: number }

export function DisplayCanvas({
  displays, scenes, statuses, lastImageTimestamps, settingsOpenId,
  onOpenSettings, onActiveDisplayChange, onPatchDisplay, onPatchScene, onSceneUpload, onSceneDelete, onAddDisplay, listOpen,
}: DisplayCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 })

  // Multi-selection: displays and scenes. Single-selection UIs (display HUD,
  // scene bar) derive from exactly-one-selected states.
  const [selDisplayIds, setSelDisplayIds] = useState<string[]>([])
  const [selSceneIds, setSelSceneIds] = useState<string[]>([])
  const selectedId = selDisplayIds.length === 1 && selSceneIds.length === 0 ? selDisplayIds[0] : null
  const selectedSceneId = selSceneIds.length === 1 && selDisplayIds.length === 0 ? selSceneIds[0] : null
  const isMulti = selDisplayIds.length + selSceneIds.length > 1
  const setSelectedId = useCallback((id: string | null) => {
    if (id) { setSelDisplayIds([id]); setSelSceneIds([]) }
    else { setSelDisplayIds([]); setSelSceneIds([]) }
  }, [])
  const setSelectedSceneId = useCallback((id: string | null) => {
    if (id) { setSelSceneIds([id]); setSelDisplayIds([]) }
    else setSelSceneIds([])
  }, [])
  // Interaction mode for the selected display (Move / Scale / Free Transform),
  // free-transform sub-mode, and the selected corner node for arrow-key work
  const [mode, setMode] = useState<HudMode>("move")
  const [ftSub, setFtSub] = useState<FtSub>("constrained")
  const [nodeSel, setNodeSel] = useState<{ displayId: string; corner: number } | null>(null)
  // Inline delete confirmation in the scene context bar
  const [sceneDeleteConfirm, setSceneDeleteConfirm] = useState<string | null>(null)
  useEffect(() => { setNodeSel(null); setMode("move"); setFtSub("constrained") }, [selectedId])
  useEffect(() => { setSceneDeleteConfirm(null) }, [selectedSceneId])
  useEffect(() => { onActiveDisplayChange?.(selectedId) }, [selectedId, onActiveDisplayChange])
  // Spacebar-held pan and marquee selection
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [groupDrag, setGroupDrag] = useState<{ startX: number; startY: number; moved: boolean } | null>(null)
  const [groupDelta, setGroupDelta] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 })

  const [tileDrag, setTileDrag] = useState<TileDrag | null>(null)
  const [tilePos, setTilePos] = useState<{ x: number; y: number } | null>(null)
  const [quadDrag, setQuadDrag] = useState<QuadDrag | null>(null)
  const [nodeDrag, setNodeDrag] = useState<NodeDrag | null>(null)
  const [quadScale, setQuadScale] = useState<QuadScaleDrag | null>(null)
  const [flatScale, setFlatScale] = useState<FlatScaleDrag | null>(null)
  const [flatScaleLive, setFlatScaleLive] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [liveQuad, setLiveQuad] = useState<Quad | null>(null)
  const [sceneDrag, setSceneDrag] = useState<SceneDrag | null>(null)
  const [scenePos, setScenePos] = useState<{ x: number; y: number } | null>(null)
  const [sceneResize, setSceneResize] = useState<SceneResize | null>(null)
  const [sceneSize, setSceneSize] = useState<{ w: number; h: number } | null>(null)
  const [panDrag, setPanDrag] = useState<PanDrag | null>(null)
  const [fileOver, setFileOver] = useState(false)

  const didInitialFit = useRef(false)
  const draggedRef = useRef(false)

  const sceneById = useMemo(() => new Map(scenes.map(s => [s.id, s])), [scenes])

  // ─── Coordinate helpers ──────────────────────────────────────────────────
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect()
    return {
      x: (clientX - rect.left - view.x) / view.zoom,
      y: (clientY - rect.top - view.y) / view.zoom,
    }
  }, [view])

  const sceneAt = useCallback((x: number, y: number): Scene | null => {
    // Topmost scene wins (later in the array renders on top)
    for (let i = scenes.length - 1; i >= 0; i--) {
      const s = scenes[i]
      const sx = sceneDrag?.id === s.id && scenePos ? scenePos.x : s.canvasX
      const sy = sceneDrag?.id === s.id && scenePos ? scenePos.y : s.canvasY
      if (x >= sx && x <= sx + s.canvasWidth && y >= sy && y <= sy + s.canvasHeight) return s
    }
    return null
  }, [scenes, sceneDrag, scenePos])

  // ─── Fit view ────────────────────────────────────────────────────────────
  const fitToContent = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const rects: { x: number; y: number; w: number; h: number }[] = []
    for (const s of scenes) rects.push({ x: s.canvasX, y: s.canvasY, w: s.canvasWidth, h: s.canvasHeight })
    for (const d of displays) {
      if (d.sceneId && d.quad && sceneById.has(d.sceneId)) continue // inside a scene rect already
      const f = footprint(d)
      rects.push({ x: d.canvasX, y: d.canvasY, w: f.w, h: f.h })
    }
    if (rects.length === 0) { setView({ x: 0, y: 0, zoom: 1 }); return }
    const minX = Math.min(...rects.map(r => r.x))
    const minY = Math.min(...rects.map(r => r.y))
    const maxX = Math.max(...rects.map(r => r.x + r.w))
    const maxY = Math.max(...rects.map(r => r.y + r.h))
    const pad = 120
    const zoom = clamp(Math.min(
      (el.clientWidth - pad) / (maxX - minX),
      (el.clientHeight - pad) / (maxY - minY),
    ), MIN_ZOOM, 1)
    setView({
      x: (el.clientWidth - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: (el.clientHeight - (maxY - minY) * zoom) / 2 - minY * zoom,
      zoom,
    })
  }, [displays, scenes, sceneById])

  useEffect(() => {
    if (!didInitialFit.current && (displays.length > 0 || scenes.length > 0)) {
      didInitialFit.current = true
      fitToContent()
    }
  }, [displays, scenes, fitToContent])

  // ─── Drag starts ─────────────────────────────────────────────────────────
  // Group drag: any selected member drags the whole multi-selection
  const startGroupDrag = useCallback((e: React.MouseEvent) => {
    draggedRef.current = false
    setGroupDrag({ startX: e.clientX, startY: e.clientY, moved: false })
    setGroupDelta({ dx: 0, dy: 0 })
  }, [])

  const handleTileMouseDown = useCallback((e: React.MouseEvent, display: DisplayConfig) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    if (isMulti && selDisplayIds.includes(display.id)) { startGroupDrag(e); return }
    draggedRef.current = false
    const scene = display.sceneId ? sceneById.get(display.sceneId) : null
    if (scene && display.quad && settingsOpenId !== display.id) {
      setQuadDrag({ id: display.id, sceneId: scene.id, startX: e.clientX, startY: e.clientY, origQuad: display.quad, moved: false })
      setLiveQuad(display.quad)
    } else {
      setTileDrag({ id: display.id, startX: e.clientX, startY: e.clientY, origX: display.canvasX, origY: display.canvasY, moved: false })
      setTilePos({ x: display.canvasX, y: display.canvasY })
    }
  }, [sceneById, settingsOpenId, isMulti, selDisplayIds, startGroupDrag])

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, display: DisplayConfig, corner: number) => {
    if (e.button !== 0 || !display.quad || !display.sceneId) return
    e.preventDefault()
    e.stopPropagation()
    if (mode === "scale") {
      setQuadScale({ id: display.id, corner, startX: e.clientX, startY: e.clientY, origQuad: display.quad })
      setLiveQuad(display.quad)
    } else {
      setNodeDrag({ id: display.id, sceneId: display.sceneId, corner, startX: e.clientX, startY: e.clientY, origQuad: display.quad, moved: false })
      setLiveQuad(display.quad)
    }
  }, [mode])

  const handleFlatCornerMouseDown = useCallback((e: React.MouseEvent, display: DisplayConfig, corner: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const f = footprint(display)
    setFlatScale({ id: display.id, corner, startX: e.clientX, startY: e.clientY, origX: display.canvasX, origY: display.canvasY, origW: f.w, origH: f.h })
    setFlatScaleLive({ x: display.canvasX, y: display.canvasY, w: f.w, h: f.h })
  }, [])

  const handleSceneMouseDown = useCallback((e: React.MouseEvent, scene: Scene) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    if (isMulti && selSceneIds.includes(scene.id)) { startGroupDrag(e); return }
    draggedRef.current = false
    setSelectedSceneId(scene.id)
    if (scene.locked) return // locked: select only, never drag
    setSceneDrag({ id: scene.id, startX: e.clientX, startY: e.clientY, origX: scene.canvasX, origY: scene.canvasY, moved: false })
    setScenePos({ x: scene.canvasX, y: scene.canvasY })
  }, [isMulti, selSceneIds, startGroupDrag, setSelectedSceneId])

  const handleSceneResizeMouseDown = useCallback((e: React.MouseEvent, scene: Scene) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSceneResize({ id: scene.id, startX: e.clientX, startY: e.clientY, origW: scene.canvasWidth, origH: scene.canvasHeight })
    setSceneSize({ w: scene.canvasWidth, h: scene.canvasHeight })
  }, [])

  const handleBackgroundMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (spaceHeld) {
      setPanDrag({ startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y })
      return
    }
    // Plain drag on the background draws a selection marquee
    setSelectedId(null)
    const p = toCanvas(e.clientX, e.clientY)
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }, [view.x, view.y, spaceHeld, toCanvas, setSelectedId])


  // Depth-based perspective inference: apply a fallback immediately, then
  // replace it with the depth-map answer when the server responds.
  const inferPerspective = useCallback((displayId: string, scene: Scene, cx: number, cy: number, fw: number, fh: number, opts?: { fallbackQuad?: Quad, immediate?: Partial<DisplayConfig>, prevPlane?: DisplayConfig["plane"] }) => {
    const fallback = opts?.fallbackQuad ?? inferQuad(cx, cy, fw, fh, scene)
    onPatchDisplay(displayId, { sceneId: scene.id, quad: fallback, ...opts?.immediate })
    fetch(`/api/scenes/${scene.id}/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: cx - scene.canvasX, y: cy - scene.canvasY, w: fw, h: fh, prevPlane: opts?.prevPlane ?? undefined }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        // Same wall as before → keep the (translated) quad the user is looking
        // at; mini adjustments shouldn't bounce the perspective around.
        if (data.samePlane && opts?.fallbackQuad) {
          if (data.plane) onPatchDisplay(displayId, { plane: data.plane })
          return
        }
        if (data.quad) onPatchDisplay(displayId, { quad: data.quad, plane: data.plane ?? null })
      })
      .catch(() => {})
  }, [onPatchDisplay])

  // ─── Drag move / end ─────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const dxs = (start: number) => (e.clientX - start) / view.zoom
    const dys = (start: number) => (e.clientY - start) / view.zoom

    if (tileDrag) {
      const moved = tileDrag.moved || Math.abs(e.clientX - tileDrag.startX) > 4 || Math.abs(e.clientY - tileDrag.startY) > 4
      if (moved && !tileDrag.moved) { draggedRef.current = true; setTileDrag({ ...tileDrag, moved: true }) }
      setTilePos({ x: tileDrag.origX + dxs(tileDrag.startX), y: tileDrag.origY + dys(tileDrag.startY) })
    } else if (quadDrag) {
      const moved = quadDrag.moved || Math.abs(e.clientX - quadDrag.startX) > 4 || Math.abs(e.clientY - quadDrag.startY) > 4
      if (moved && !quadDrag.moved) { draggedRef.current = true; setQuadDrag({ ...quadDrag, moved: true }) }
      setLiveQuad(translateQuad(quadDrag.origQuad, dxs(quadDrag.startX), dys(quadDrag.startY)))
    } else if (nodeDrag) {
      if (!nodeDrag.moved && Math.abs(e.clientX - nodeDrag.startX) <= 3 && Math.abs(e.clientY - nodeDrag.startY) <= 3) return
      if (!nodeDrag.moved) setNodeDrag({ ...nodeDrag, moved: true })
      draggedRef.current = true
      // Free Transform. Free sub-mode: the dragged corner moves alone, fully
      // individual. Constrained sub-mode: vertical-only, with the corner's
      // vertical partner counter-moving (verticals stay vertical).
      const c = nodeDrag.corner
      const dy = dys(nodeDrag.startY)
      if (ftSub === "free") {
        const dx = dxs(nodeDrag.startX)
        setLiveQuad(nodeDrag.origQuad.map((p, i) =>
          i === c ? { x: p.x + dx, y: p.y + dy } : p
        ) as Quad)
      } else {
        const partner = [3, 2, 1, 0][c]
        setLiveQuad(nodeDrag.origQuad.map((p, i) => {
          if (i === c) return { x: p.x, y: p.y + dy }
          if (i === partner) return { x: p.x, y: p.y - dy }
          return p
        }) as Quad)
      }
    } else if (quadScale) {
      draggedRef.current = true
      // Uniform scale about the quad center — all angles and aspect preserved
      const o = quadScale.origQuad
      const c0 = { x: (o[0].x + o[1].x + o[2].x + o[3].x) / 4, y: (o[0].y + o[1].y + o[2].y + o[3].y) / 4 }
      const grab = o[quadScale.corner]
      const dirX = grab.x - c0.x, dirY = grab.y - c0.y
      const len2 = dirX * dirX + dirY * dirY
      if (len2 < 1) return
      const f = clamp(1 + (dxs(quadScale.startX) * dirX + dys(quadScale.startY) * dirY) / len2, 0.2, 5)
      setLiveQuad(o.map(p => ({ x: c0.x + (p.x - c0.x) * f, y: c0.y + (p.y - c0.y) * f })) as Quad)
    } else if (flatScale) {
      draggedRef.current = true
      // Uniform scale of a flat tile about its center
      const dirX = (flatScale.corner === 1 || flatScale.corner === 2 ? 1 : -1) * flatScale.origW / 2
      const dirY = (flatScale.corner >= 2 ? 1 : -1) * flatScale.origH / 2
      const len2 = dirX * dirX + dirY * dirY
      const f = clamp(1 + (dxs(flatScale.startX) * dirX + dys(flatScale.startY) * dirY) / len2, 0.2, 5)
      const w = flatScale.origW * f, h = flatScale.origH * f
      setFlatScaleLive({
        x: flatScale.origX + (flatScale.origW - w) / 2,
        y: flatScale.origY + (flatScale.origH - h) / 2,
        w, h,
      })
    } else if (sceneDrag) {
      const moved = sceneDrag.moved || Math.abs(e.clientX - sceneDrag.startX) > 4 || Math.abs(e.clientY - sceneDrag.startY) > 4
      if (moved && !sceneDrag.moved) setSceneDrag({ ...sceneDrag, moved: true })
      setScenePos({ x: sceneDrag.origX + dxs(sceneDrag.startX), y: sceneDrag.origY + dys(sceneDrag.startY) })
    } else if (sceneResize) {
      const f = clamp((sceneResize.origW + dxs(sceneResize.startX)) / sceneResize.origW, 0.2, 5)
      setSceneSize({ w: Math.round(sceneResize.origW * f), h: Math.round(sceneResize.origH * f) })
    } else if (groupDrag) {
      const moved = groupDrag.moved || Math.abs(e.clientX - groupDrag.startX) > 4 || Math.abs(e.clientY - groupDrag.startY) > 4
      if (moved && !groupDrag.moved) { draggedRef.current = true; setGroupDrag({ ...groupDrag, moved: true }) }
      setGroupDelta({ dx: dxs(groupDrag.startX), dy: dys(groupDrag.startY) })
    } else if (marquee) {
      const p = toCanvas(e.clientX, e.clientY)
      setMarquee({ ...marquee, x1: p.x, y1: p.y })
    } else if (panDrag) {
      setView(v => ({ ...v, x: panDrag.origX + (e.clientX - panDrag.startX), y: panDrag.origY + (e.clientY - panDrag.startY) }))
    }
  }, [tileDrag, quadDrag, nodeDrag, quadScale, flatScale, ftSub, sceneDrag, sceneResize, panDrag, groupDrag, marquee, toCanvas, view.zoom])

  const handleMouseUp = useCallback(() => {
    if (tileDrag && tilePos && tileDrag.moved) {
      const display = displays.find(d => d.id === tileDrag.id)
      if (display) {
        const f = footprint(display)
        const cx = tilePos.x + f.w / 2
        const cy = tilePos.y + f.h / 2
        const scene = sceneAt(cx, cy)
        if (scene && settingsOpenId !== display.id) {
          // Dropped onto an environment — infer perspective from its depth map
          inferPerspective(display.id, scene, cx, cy, f.w, f.h, {
            immediate: { canvasX: Math.round(tilePos.x), canvasY: Math.round(tilePos.y) },
          })
        } else {
          onPatchDisplay(display.id, { canvasX: Math.round(tilePos.x), canvasY: Math.round(tilePos.y) })
        }
      }
    }
    if (quadDrag && liveQuad && quadDrag.moved) {
      const display = displays.find(d => d.id === quadDrag.id)
      const oldScene = sceneById.get(quadDrag.sceneId)
      if (display && oldScene) {
        const b = quadBounds(liveQuad)
        const cx = oldScene.canvasX + (b.minX + b.maxX) / 2
        const cy = oldScene.canvasY + (b.minY + b.maxY) / 2
        const scene = sceneAt(cx, cy)
        if (!scene) {
          // Dragged off the environment — release perspective
          const f = footprint(display)
          onPatchDisplay(display.id, {
            sceneId: null, quad: null,
            canvasX: Math.round(cx - f.w / 2), canvasY: Math.round(cy - f.h / 2),
          })
        } else {
          // Repositioned on an environment — re-infer perspective at the new
          // spot (the translated quad shows until the depth answer lands)
          const f2 = footprint(display)
          const dx = oldScene.canvasX - scene.canvasX
          const dy = oldScene.canvasY - scene.canvasY
          inferPerspective(display.id, scene, cx, cy, f2.w, f2.h, {
            fallbackQuad: translateQuad(liveQuad, dx, dy),
            prevPlane: scene.id === quadDrag.sceneId ? display.plane : undefined,
            immediate: {
              canvasX: Math.round(cx - f2.w / 2), canvasY: Math.round(cy - f2.h / 2),
            },
          })
        }
      }
    }
    if (nodeDrag) {
      if (nodeDrag.moved && liveQuad) onPatchDisplay(nodeDrag.id, { quad: liveQuad })
      // Click or drag both leave the node selected for arrow-key adjustment
      setNodeSel({ displayId: nodeDrag.id, corner: nodeDrag.corner })
    }
    if (quadScale && liveQuad) {
      onPatchDisplay(quadScale.id, { quad: liveQuad })
    }
    if (flatScale && flatScaleLive) {
      const d = displays.find(x => x.id === flatScale.id)
      const rotated = d ? (((d.rotation ?? 0) % 180) + 180) % 180 === 90 : false
      onPatchDisplay(flatScale.id, {
        canvasX: Math.round(flatScaleLive.x), canvasY: Math.round(flatScaleLive.y),
        canvasWidth: Math.round(rotated ? flatScaleLive.h : flatScaleLive.w),
        canvasHeight: Math.round(rotated ? flatScaleLive.w : flatScaleLive.h),
      })
    }
    if (sceneDrag && scenePos && sceneDrag.moved) {
      onPatchScene(sceneDrag.id, { canvasX: Math.round(scenePos.x), canvasY: Math.round(scenePos.y) })
    }
    if (sceneResize && sceneSize) {
      const f = sceneSize.w / sceneResize.origW
      onPatchScene(sceneResize.id, { canvasWidth: sceneSize.w, canvasHeight: sceneSize.h })
      // Keep attached displays glued: scale their quads by the same factor
      for (const d of displays) {
        if (d.sceneId === sceneResize.id && d.quad) {
          onPatchDisplay(d.id, { quad: d.quad.map(p => ({ x: p.x * f, y: p.y * f })) as Quad })
        }
      }
    }
    if (marquee) {
      // Resolve the marquee into a multi-selection
      const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1)
      const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1)
      if (x1 - x0 > 3 || y1 - y0 > 3) {
        const hit = (x: number, y: number, w: number, h: number) => x < x1 && x + w > x0 && y < y1 && y + h > y0
        const sIds = scenes.filter(s => hit(s.canvasX, s.canvasY, s.canvasWidth, s.canvasHeight)).map(s => s.id)
        const dIds = displays.filter(d => {
          if (d.sceneId && d.quad && sceneById.has(d.sceneId)) {
            const sc = sceneById.get(d.sceneId)!
            const b = quadBounds(d.quad)
            return hit(sc.canvasX + b.minX, sc.canvasY + b.minY, b.maxX - b.minX, b.maxY - b.minY)
          }
          const f = footprint(d)
          return hit(d.canvasX, d.canvasY, f.w, f.h)
        }).map(d => d.id)
        setSelSceneIds(sIds)
        setSelDisplayIds(dIds)
      }
    }
    if (groupDrag && groupDrag.moved) {
      const { dx, dy } = groupDelta
      for (const s of scenes) {
        if (selSceneIds.includes(s.id) && !s.locked) {
          onPatchScene(s.id, { canvasX: Math.round(s.canvasX + dx), canvasY: Math.round(s.canvasY + dy) })
        }
      }
      for (const d of displays) {
        if (!selDisplayIds.includes(d.id)) continue
        if (d.sceneId && d.quad && sceneById.has(d.sceneId)) {
          // Attached displays ride with their scene when it's also selected
          const sc = sceneById.get(d.sceneId)!
          if (selSceneIds.includes(sc.id)) continue
          if (!sc.locked || !selSceneIds.includes(sc.id)) {
            onPatchDisplay(d.id, { quad: translateQuad(d.quad, dx, dy) })
          }
        } else {
          onPatchDisplay(d.id, { canvasX: Math.round(d.canvasX + dx), canvasY: Math.round(d.canvasY + dy) })
        }
      }
    }
    setTileDrag(null); setTilePos(null)
    setQuadDrag(null); setNodeDrag(null); setLiveQuad(null)
    setQuadScale(null); setFlatScale(null); setFlatScaleLive(null)
    setSceneDrag(null); setScenePos(null)
    setSceneResize(null); setSceneSize(null)
    setMarquee(null); setGroupDrag(null); setGroupDelta({ dx: 0, dy: 0 })
    setPanDrag(null)
  }, [tileDrag, tilePos, quadDrag, nodeDrag, quadScale, flatScale, flatScaleLive, liveQuad, sceneDrag, scenePos, sceneResize, sceneSize,
      marquee, groupDrag, groupDelta, scenes, selSceneIds, selDisplayIds,
      displays, sceneById, sceneAt, settingsOpenId, onPatchDisplay, onPatchScene, inferPerspective])

  // ─── Click / double-click ────────────────────────────────────────────────
  const handleTileClick = useCallback((e: React.MouseEvent, displayId: string) => {
    e.stopPropagation()
    if (draggedRef.current) { draggedRef.current = false; return }
    setSelectedId(displayId); setSelectedSceneId(null)
    if (e.detail >= 2) onOpenSettings(displayId)
  }, [onOpenSettings, setSelectedId, setSelectedSceneId])

  // ─── Keyboard: node-pair angle adjust, display nudge, escape ─────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpenId) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return

      if (e.key === "Escape") {
        e.preventDefault()
        if (sceneDeleteConfirm) setSceneDeleteConfirm(null)
        else if (nodeSel) setNodeSel(null)
        else if (selectedId && mode !== "move") setMode("move")
        else setSelectedId(null) // clears any selection, single or multi
        return
      }
      // Delete a selected canvas image (confirmation shows in its context bar)
      if ((e.key === "Delete" || e.key === "Backspace") && selectedSceneId) {
        e.preventDefault()
        setSceneDeleteConfirm(selectedSceneId)
        return
      }
      if (!selectedId) return

      let dx = 0, dy = 0
      if (e.key === "ArrowLeft") dx = -1
      else if (e.key === "ArrowRight") dx = 1
      else if (e.key === "ArrowUp") dy = -1
      else if (e.key === "ArrowDown") dy = 1
      else return

      const d = displays.find(x => x.id === selectedId)
      if (!d) return
      const onScene = !!(d.sceneId && d.quad && sceneById.has(d.sceneId))

      if (mode === "scale") {
        // ↑/↓ finely scale about the center; angles and aspect preserved
        e.preventDefault()
        if (dy === 0) return
        const f = dy < 0 ? (e.shiftKey ? 1.05 : 1.01) : (e.shiftKey ? 1 / 1.05 : 1 / 1.01)
        if (onScene && d.quad) {
          const o = d.quad
          const c0 = { x: (o[0].x + o[1].x + o[2].x + o[3].x) / 4, y: (o[0].y + o[1].y + o[2].y + o[3].y) / 4 }
          onPatchDisplay(d.id, { quad: o.map(p => ({ x: c0.x + (p.x - c0.x) * f, y: c0.y + (p.y - c0.y) * f })) as Quad })
        } else {
          const fp = footprint(d)
          const w = fp.w * f, h = fp.h * f
          const rotated = (((d.rotation ?? 0) % 180) + 180) % 180 === 90
          onPatchDisplay(d.id, {
            canvasX: Math.round(d.canvasX + (fp.w - w) / 2),
            canvasY: Math.round(d.canvasY + (fp.h - h) / 2),
            canvasWidth: Math.round(rotated ? h : w),
            canvasHeight: Math.round(rotated ? w : h),
          })
        }
        return
      }

      if (mode === "free") {
        // A selected corner node. Free sub-mode: arrows move that corner alone.
        // Constrained: vertical-only, with the vertical partner counter-moving.
        if (!(nodeSel && nodeSel.displayId === d.id && onScene && d.quad)) { e.preventDefault(); return }
        if (dx !== 0 && ftSub !== "free") { e.preventDefault(); return }
        e.preventDefault()
        const step = e.shiftKey ? 5 : 1
        const c = nodeSel.corner
        let quad: Quad
        if (ftSub === "free") {
          quad = d.quad.map((p, i) =>
            i === c ? { x: p.x + dx * step, y: p.y + dy * step } : p
          ) as Quad
        } else {
          const partner = [3, 2, 1, 0][c]
          quad = d.quad.map((p, i) => {
            if (i === c) return { x: p.x, y: p.y + dy * step }
            if (i === partner) return { x: p.x, y: p.y - dy * step }
            return p
          }) as Quad
        }
        onPatchDisplay(d.id, { quad })
        return
      }

      // Move mode: nudge the whole display
      e.preventDefault()
      const step = e.shiftKey ? 10 : 2
      if (onScene && d.quad) {
        onPatchDisplay(d.id, { quad: translateQuad(d.quad, dx * step, dy * step) })
      } else {
        onPatchDisplay(d.id, { canvasX: d.canvasX + dx * step, canvasY: d.canvasY + dy * step })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectedId, setSelectedId, settingsOpenId, displays, sceneById, onPatchDisplay, nodeSel, mode, ftSub, selectedSceneId, sceneDeleteConfirm])

  // ─── Spacebar: hold to pan ───────────────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space") return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
      e.preventDefault()
      setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => { if (e.code === "Space") setSpaceHeld(false) }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up) }
  }, [])

  // ─── Trackpad navigation: two-finger scroll pans, pinch zooms ────────────
  // macOS trackpads report pinch as a wheel event with ctrlKey set; plain
  // two-finger scrolls arrive as regular wheel deltas.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        // Pinch (or ctrl/cmd+scroll) → zoom about the cursor
        const rect = el.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        setView(v => {
          // Pinch deltas are small and frequent; a ctrl+mouse-wheel notch is
          // ±120 — clamp so one notch doesn't triple the zoom
          const factor = Math.exp(-clamp(e.deltaY, -50, 50) * 0.01)
          const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)
          const k = zoom / v.zoom
          return { zoom, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k }
        })
      } else {
        // Two-finger scroll → pan
        setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // Zoom the view so a canvas-space rect fits centered, 24px from the edges
  const zoomToBounds = useCallback((bx: number, by: number, bw: number, bh: number) => {
    const el = containerRef.current
    if (!el || bw <= 0 || bh <= 0) return
    const pad = 24
    const zoom = clamp(Math.min(
      (el.clientWidth - pad * 2) / bw,
      (el.clientHeight - pad * 2) / bh,
    ), MIN_ZOOM, MAX_ZOOM)
    setView({
      zoom,
      x: (el.clientWidth - bw * zoom) / 2 - bx * zoom,
      y: (el.clientHeight - bh * zoom) / 2 - by * zoom,
    })
  }, [])
  const zoomToScene = useCallback((scene: Scene) => {
    zoomToBounds(scene.canvasX, scene.canvasY, scene.canvasWidth, scene.canvasHeight)
  }, [zoomToBounds])

  // Jump the view to a display (from the left panel). Wall-mounted displays
  // frame their whole environment for context; flat ones get a roomy margin.
  const gotoDisplay = useCallback((displayId: string) => {
    const d = displays.find(x => x.id === displayId)
    if (!d) return
    setSelectedId(displayId)
    const scene = d.sceneId && d.quad ? sceneById.get(d.sceneId) : null
    if (scene) { zoomToScene(scene); return }
    const f = footprint(d)
    const mx = f.w * 1.5, my = f.h * 1.5
    zoomToBounds(d.canvasX - mx, d.canvasY - my, f.w + mx * 2, f.h + my * 2)
  }, [displays, sceneById, setSelectedId, zoomToScene, zoomToBounds])

  // ─── Selection bounds, align & distribute (multi-selection) ─────────────
  const selectionBounds = useCallback(() => {
    const rects: { x: number; y: number; w: number; h: number }[] = []
    for (const s of scenes) {
      if (selSceneIds.includes(s.id)) rects.push({ x: s.canvasX, y: s.canvasY, w: s.canvasWidth, h: s.canvasHeight })
    }
    for (const d of displays) {
      if (!selDisplayIds.includes(d.id)) continue
      if (d.sceneId && d.quad && sceneById.has(d.sceneId)) {
        const sc = sceneById.get(d.sceneId)!
        const b = quadBounds(d.quad)
        rects.push({ x: sc.canvasX + b.minX, y: sc.canvasY + b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY })
      } else {
        const f = footprint(d)
        rects.push({ x: d.canvasX, y: d.canvasY, w: f.w, h: f.h })
      }
    }
    if (rects.length === 0) return null
    const minX = Math.min(...rects.map(r => r.x))
    const minY = Math.min(...rects.map(r => r.y))
    const maxX = Math.max(...rects.map(r => r.x + r.w))
    const maxY = Math.max(...rects.map(r => r.y + r.h))
    return { minX, minY, maxX, maxY }
  }, [scenes, displays, selSceneIds, selDisplayIds, sceneById])

  // Alignable items: scenes (unlocked) and flat displays. Displays glued to a
  // wall stay glued — align/distribute skips them.
  type AlignItem = { kind: "scene" | "flat"; id: string; x: number; y: number; w: number; h: number }
  const alignItems = useCallback((): AlignItem[] => {
    const items: AlignItem[] = []
    for (const s of scenes) {
      if (selSceneIds.includes(s.id) && !s.locked) {
        items.push({ kind: "scene", id: s.id, x: s.canvasX, y: s.canvasY, w: s.canvasWidth, h: s.canvasHeight })
      }
    }
    for (const d of displays) {
      if (!selDisplayIds.includes(d.id)) continue
      if (d.sceneId && d.quad && sceneById.has(d.sceneId)) continue
      const f = footprint(d)
      items.push({ kind: "flat", id: d.id, x: d.canvasX, y: d.canvasY, w: f.w, h: f.h })
    }
    return items
  }, [scenes, displays, selSceneIds, selDisplayIds, sceneById])

  const moveItem = useCallback((it: AlignItem, nx: number, ny: number) => {
    const patch = { canvasX: Math.round(nx), canvasY: Math.round(ny) }
    if (it.kind === "scene") onPatchScene(it.id, patch)
    else onPatchDisplay(it.id, patch)
  }, [onPatchScene, onPatchDisplay])

  const alignSelection = useCallback((edge: "left" | "centerH" | "right" | "top" | "middleV" | "bottom") => {
    const items = alignItems()
    if (items.length < 2) return
    const minX = Math.min(...items.map(i => i.x))
    const maxX = Math.max(...items.map(i => i.x + i.w))
    const minY = Math.min(...items.map(i => i.y))
    const maxY = Math.max(...items.map(i => i.y + i.h))
    for (const it of items) {
      let nx = it.x, ny = it.y
      if (edge === "left") nx = minX
      else if (edge === "centerH") nx = (minX + maxX) / 2 - it.w / 2
      else if (edge === "right") nx = maxX - it.w
      else if (edge === "top") ny = minY
      else if (edge === "middleV") ny = (minY + maxY) / 2 - it.h / 2
      else if (edge === "bottom") ny = maxY - it.h
      if (nx !== it.x || ny !== it.y) moveItem(it, nx, ny)
    }
  }, [alignItems, moveItem])

  const distributeSelection = useCallback((axis: "h" | "v") => {
    const items = alignItems()
    if (items.length < 3) return
    if (axis === "h") {
      const sorted = [...items].sort((a, b) => a.x - b.x)
      const span = Math.max(...sorted.map(i => i.x + i.w)) - sorted[0].x
      const totalW = sorted.reduce((s, i) => s + i.w, 0)
      const gap = (span - totalW) / (sorted.length - 1)
      let cur = sorted[0].x
      for (const it of sorted) { moveItem(it, cur, it.y); cur += it.w + gap }
    } else {
      const sorted = [...items].sort((a, b) => a.y - b.y)
      const span = Math.max(...sorted.map(i => i.y + i.h)) - sorted[0].y
      const totalH = sorted.reduce((s, i) => s + i.h, 0)
      const gap = (span - totalH) / (sorted.length - 1)
      let cur = sorted[0].y
      for (const it of sorted) { moveItem(it, it.x, cur); cur += it.h + gap }
    }
  }, [alignItems, moveItem])

  const zoomBy = (factor: number) => {
    const el = containerRef.current
    if (!el) return
    const mx = el.clientWidth / 2
    const my = el.clientHeight / 2
    setView(v => {
      const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      const k = zoom / v.zoom
      return { zoom, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k }
    })
  }

  // ─── Environment JPG drag & drop ─────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setFileOver(true) }
  }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setFileOver(false)
    const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith("image/"))
    if (!file) return
    const { x, y } = toCanvas(e.clientX, e.clientY)
    onSceneUpload(file, Math.round(x), Math.round(y))
  }, [toCanvas, onSceneUpload])

  // ─── Render helpers ──────────────────────────────────────────────────────
  const selected = displays.find(d => d.id === selectedId) ?? null
  const selectedScene = selected?.sceneId ? sceneById.get(selected.sceneId) : null
  const selectedQuad = selected && liveQuad && (quadDrag?.id === selected.id || nodeDrag?.id === selected.id || quadScale?.id === selected.id)
    ? liveQuad
    : selected?.quad ?? null
  const selectedOnScene = !!(selected && selectedScene && selectedQuad && settingsOpenId !== selected.id)

  // HUD anchor in canvas coordinates
  let hudAnchor: { x: number; y: number } | null = null
  if (selected) {
    if (selectedOnScene && selectedScene && selectedQuad) {
      const sx = sceneDrag?.id === selectedScene.id && scenePos ? scenePos.x : selectedScene.canvasX
      const sy = sceneDrag?.id === selectedScene.id && scenePos ? scenePos.y : selectedScene.canvasY
      const b = quadBounds(selectedQuad)
      hudAnchor = { x: sx + (b.minX + b.maxX) / 2, y: sy + b.minY }
    } else {
      const f = footprint(selected)
      const x = tileDrag?.id === selected.id && tilePos ? tilePos.x : selected.canvasX
      const y = tileDrag?.id === selected.id && tilePos ? tilePos.y : selected.canvasY
      hudAnchor = { x: x + f.w / 2, y: y - 34 } // clear the header bar
    }
  }

  const renderPerspectiveDisplay = (display: DisplayConfig, scene: Scene) => {
    const isDraggingThis = quadDrag?.id === display.id || nodeDrag?.id === display.id || quadScale?.id === display.id
    let quad = isDraggingThis && liveQuad ? liveQuad : display.quad!
    // Group drag: translate the quad when its scene isn't part of the group
    if (groupDrag?.moved && selDisplayIds.includes(display.id) && !selSceneIds.includes(scene.id)) {
      quad = translateQuad(quad, groupDelta.dx, groupDelta.dy)
    }
    const resizeF = sceneResize?.id === scene.id && sceneSize ? sceneSize.w / sceneResize.origW : 1
    const q = resizeF !== 1 ? quad.map(p => ({ x: p.x * resizeF, y: p.y * resizeF })) as Quad : quad
    const f = footprint(display)
    const inGroup = groupDrag?.moved && selSceneIds.includes(scene.id) && !scene.locked
    const sx = (sceneDrag?.id === scene.id && scenePos ? scenePos.x : scene.canvasX) + (inGroup ? groupDelta.dx : 0)
    const sy = (sceneDrag?.id === scene.id && scenePos ? scenePos.y : scene.canvasY) + (inGroup ? groupDelta.dy : 0)
    const ts = lastImageTimestamps[display.id] || 0
    const isSelected = selectedId === display.id

    return (
      <div key={display.id} className={`absolute ${isDraggingThis ? "z-50" : "z-10"}`} style={{ left: sx, top: sy }}>
        <div
          style={{
            width: f.w, height: f.h,
            transform: rectToQuadMatrix(f.w, f.h, q),
            transformOrigin: "0 0",
            cursor: isDraggingThis ? "grabbing" : "grab",
          }}
          onMouseDown={e => handleTileMouseDown(e, display)}
          onClick={e => handleTileClick(e, display.id)}
        >
          <DisplayTile
            display={display}
            status={statuses[display.id] ?? null}
            lastImageUrl={display.host ? `/api/displays/${display.id}/last-image?t=${ts}` : null}
            selected={isSelected}
            perspective
            width={f.w}
            height={f.h}
          />
        </div>

        {/* Corner nodes: scale handles in Scale mode, editable in Free Transform */}
        {isSelected && (mode === "scale" || mode === "free") && q.map((p, i) => {
          const isPicked = mode === "free" && nodeSel?.displayId === display.id && nodeSel.corner === i
          return (
            <div
              key={i}
              className={`absolute z-[70] border-2 shadow-md transition-transform ${
                mode === "scale" ? "rounded-sm" : "rounded-full"
              } ${
                isPicked
                  ? "bg-amber-400 border-background scale-125 ring-2 ring-amber-400/50"
                  : "bg-primary border-background hover:scale-125"
              }`}
              style={{
                left: p.x, top: p.y,
                width: 12 / view.zoom, height: 12 / view.zoom,
                transform: "translate(-50%, -50%)",
                cursor: mode === "scale" ? "nwse-resize" : "crosshair",
              }}
              onMouseDown={e => handleNodeMouseDown(e, display, i)}
            />
          )
        })}
      </div>
    )
  }

  const renderFlatDisplay = (display: DisplayConfig) => {
    const isDragging = tileDrag?.id === display.id
    const isScaling = flatScale?.id === display.id && flatScaleLive
    const inGroup = groupDrag?.moved && selDisplayIds.includes(display.id)
    const f0 = footprint(display)
    const x = (isScaling ? flatScaleLive.x : isDragging && tilePos ? tilePos.x : display.canvasX) + (inGroup ? groupDelta.dx : 0)
    const y = (isScaling ? flatScaleLive.y : isDragging && tilePos ? tilePos.y : display.canvasY) + (inGroup ? groupDelta.dy : 0)
    const f = isScaling ? { w: flatScaleLive.w, h: flatScaleLive.h } : f0
    const ts = lastImageTimestamps[display.id] || 0
    const isSelected = selectedId === display.id
    // Highlight the scene we're hovering while dragging
    const overScene = isDragging && tilePos ? sceneAt(x + f.w / 2, y + f.h / 2) : null

    return (
      <div
        key={display.id}
        className={`absolute select-none ${isDragging || isScaling ? "z-50" : "z-10"}`}
        style={{ left: x, top: y, cursor: isDragging ? "grabbing" : "grab" }}
        onMouseDown={e => handleTileMouseDown(e, display)}
        onClick={e => handleTileClick(e, display.id)}
      >
        <div
          className={isMulti && selDisplayIds.includes(display.id) ? "ring-2 ring-primary rounded-[4px]" : ""}
          style={overScene ? { filter: "drop-shadow(0 0 12px hsl(var(--primary)))" } : undefined}
        >
          <DisplayTile
            display={display}
            status={statuses[display.id] ?? null}
            lastImageUrl={display.host ? `/api/displays/${display.id}/last-image?t=${ts}` : null}
            selected={isSelected}
            width={f.w}
            height={f.h}
          />
        </div>

        {/* Corner scale handles (Scale mode) */}
        {isSelected && mode === "scale" && [
          { cx: 0, cy: 0 }, { cx: f.w, cy: 0 }, { cx: f.w, cy: f.h }, { cx: 0, cy: f.h },
        ].map((p, i) => (
          <div
            key={i}
            className="absolute z-[70] rounded-sm border-2 bg-primary border-background shadow-md hover:scale-125 transition-transform"
            style={{
              left: p.cx, top: p.cy,
              width: 12 / view.zoom, height: 12 / view.zoom,
              transform: "translate(-50%, -50%)",
              cursor: "nwse-resize",
            }}
            onMouseDown={e => handleFlatCornerMouseDown(e, display, i)}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden bg-muted/10"
      style={{ cursor: panDrag ? "grabbing" : spaceHeld ? "grab" : marquee ? "crosshair" : "default", touchAction: "none" }}
      onMouseDown={handleBackgroundMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDragOver={handleDragOver}
      onDragLeave={() => setFileOver(false)}
      onDrop={handleDrop}
    >
      {/* Grid backdrop */}
      <div
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle, currentColor 1px, transparent 1px)",
          backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      />

      {/* Transformed canvas plane */}
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        {/* Environment scenes */}
        {scenes.map(scene => {
          const inGroup = groupDrag?.moved && selSceneIds.includes(scene.id) && !scene.locked
          const x = (sceneDrag?.id === scene.id && scenePos ? scenePos.x : scene.canvasX) + (inGroup ? groupDelta.dx : 0)
          const y = (sceneDrag?.id === scene.id && scenePos ? scenePos.y : scene.canvasY) + (inGroup ? groupDelta.dy : 0)
          const w = sceneResize?.id === scene.id && sceneSize ? sceneSize.w : scene.canvasWidth
          const h = sceneResize?.id === scene.id && sceneSize ? sceneSize.h : scene.canvasHeight
          const isSceneSelected = selSceneIds.includes(scene.id)
          return (
            <div
              key={scene.id}
              className={`group/scene absolute z-0 rounded-md ${isSceneSelected ? "ring-2 ring-primary" : ""}`}
              style={{
                left: x, top: y, width: w, height: h,
                cursor: scene.locked ? "default" : sceneDrag?.id === scene.id ? "grabbing" : "grab",
              }}
              onMouseDown={e => handleSceneMouseDown(e, scene)}
            >
              <img
                src={`/api/scenes/${scene.id}/image`}
                alt="Environment"
                draggable={false}
                className="w-full h-full object-fill rounded-md shadow-2xl select-none"
              />
              {/* Resize handle (hidden when locked) */}
              {!scene.locked && (
                <div
                  className={`absolute transition-opacity rounded-sm bg-primary border-2 border-background shadow-md ${
                    isSceneSelected ? "opacity-100" : "opacity-0 group-hover/scene:opacity-100"
                  }`}
                  style={{ bottom: -6 / view.zoom, right: -6 / view.zoom, width: 14 / view.zoom, height: 14 / view.zoom, cursor: "nwse-resize" }}
                  onMouseDown={e => handleSceneResizeMouseDown(e, scene)}
                  title="Resize environment"
                />
              )}
            </div>
          )
        })}

        {/* Scene context bar */}
        {(() => {
          const sc = scenes.find(s => s.id === selectedSceneId)
          if (!sc || sceneDrag || sceneResize) return null
          return (
            <div
              className="absolute z-[60]"
              style={{
                left: sc.canvasX + sc.canvasWidth / 2,
                top: sc.canvasY,
                transform: `translate(-50%, -100%) scale(${1 / view.zoom}) translateY(-12px)`,
                transformOrigin: "50% 100%",
              }}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/90 backdrop-blur-md shadow-xl px-1 py-1">
                {sceneDeleteConfirm === sc.id ? (
                  <>
                    <span className="text-xs px-1.5 whitespace-nowrap">Remove this image from the canvas?</span>
                    <button
                      className="rounded-md bg-destructive text-destructive-foreground text-xs font-medium px-2 py-1 hover:bg-destructive/90 transition-colors"
                      onClick={() => { setSceneDeleteConfirm(null); setSelectedSceneId(null); onSceneDelete(sc.id) }}
                    >
                      Remove
                    </button>
                    <button
                      className="rounded-md text-xs px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      onClick={() => setSceneDeleteConfirm(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      title="Zoom to fit this image"
                      onClick={() => zoomToScene(sc)}
                    >
                      <ScanSearch className="h-4 w-4" />
                    </button>
                    <button
                      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                        sc.locked
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-accent"
                      }`}
                      title={sc.locked ? "Unlock (allow moving/resizing)" : "Lock in place"}
                      onClick={() => onPatchScene(sc.id, { locked: !sc.locked })}
                    >
                      {sc.locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
                    </button>
                    <div className="w-px h-4 bg-border mx-0.5" />
                    <button
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                      title="Remove image from canvas (Delete)"
                      onClick={() => setSceneDeleteConfirm(sc.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })()}

        {/* Displays in perspective (on scenes) */}
        {displays
          .filter(d => d.sceneId && d.quad && sceneById.has(d.sceneId) && settingsOpenId !== d.id)
          .map(d => renderPerspectiveDisplay(d, sceneById.get(d.sceneId!)!))}

        {/* Flat displays (plus any with settings open — perspective released) */}
        {displays
          .filter(d => !(d.sceneId && d.quad && sceneById.has(d.sceneId)) || settingsOpenId === d.id)
          .map(renderFlatDisplay)}

        {/* Marquee selection rectangle */}
        {marquee && (
          <div
            className="absolute z-[90] border border-primary/70 bg-primary/10 pointer-events-none"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
              borderWidth: 1 / view.zoom,
            }}
          />
        )}

        {/* Group context bar (multi-selection): align, distribute, zoom-to-fit */}
        {(() => {
          if (!isMulti || groupDrag || marquee || tileDrag || quadDrag || sceneDrag || panDrag) return null
          const b = selectionBounds()
          if (!b) return null
          const canDistribute = alignItems().length >= 3
          const btn = "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          return (
            <div
              className="absolute z-[60]"
              style={{
                left: (b.minX + b.maxX) / 2,
                top: b.minY,
                transform: `translate(-50%, -100%) scale(${1 / view.zoom}) translateY(-12px)`,
                transformOrigin: "50% 100%",
              }}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/90 backdrop-blur-md shadow-xl px-1 py-1">
                <button className={btn} title="Align left" onClick={() => alignSelection("left")}><AlignStartVertical className="h-4 w-4" /></button>
                <button className={btn} title="Align horizontal center" onClick={() => alignSelection("centerH")}><AlignCenterVertical className="h-4 w-4" /></button>
                <button className={btn} title="Align right" onClick={() => alignSelection("right")}><AlignEndVertical className="h-4 w-4" /></button>
                <div className="w-px h-4 bg-border mx-0.5" />
                <button className={btn} title="Align top" onClick={() => alignSelection("top")}><AlignStartHorizontal className="h-4 w-4" /></button>
                <button className={btn} title="Align vertical middle" onClick={() => alignSelection("middleV")}><AlignCenterHorizontal className="h-4 w-4" /></button>
                <button className={btn} title="Align bottom" onClick={() => alignSelection("bottom")}><AlignEndHorizontal className="h-4 w-4" /></button>
                {canDistribute && (
                  <>
                    <div className="w-px h-4 bg-border mx-0.5" />
                    <button className={btn} title="Distribute horizontally" onClick={() => distributeSelection("h")}><AlignHorizontalDistributeCenter className="h-4 w-4" /></button>
                    <button className={btn} title="Distribute vertically" onClick={() => distributeSelection("v")}><AlignVerticalDistributeCenter className="h-4 w-4" /></button>
                  </>
                )}
                <div className="w-px h-4 bg-border mx-0.5" />
                <button
                  className={btn}
                  title="Zoom to selection"
                  onClick={() => { const bb = selectionBounds(); if (bb) zoomToBounds(bb.minX, bb.minY, bb.maxX - bb.minX, bb.maxY - bb.minY) }}
                >
                  <ScanSearch className="h-4 w-4" />
                </button>
              </div>
            </div>
          )
        })()}

        {/* HUD context menu above the selected display */}
        {selected && hudAnchor && !tileDrag && !quadDrag && !nodeDrag && !quadScale && !flatScale && (
          <DisplayHUD
            x={hudAnchor.x}
            y={hudAnchor.y}
            zoom={view.zoom}
            onScene={selectedOnScene}
            mode={mode}
            onMode={m => { setMode(m); if (m !== "free") setNodeSel(null) }}
            ftSub={ftSub}
            onFtSub={setFtSub}
            orientation={((selected.rotation ?? 0) % 180 + 180) % 180 === 90 ? "landscape" : "portrait"}
            onOrientation={o => {
              const rot = o === "landscape" ? 90 : 0
              if (rot === (((selected.rotation ?? 0) % 180 + 180) % 180)) return
              const fw = o === "landscape" ? selected.canvasHeight : selected.canvasWidth
              const fh = o === "landscape" ? selected.canvasWidth : selected.canvasHeight
              if (selectedOnScene && selectedScene && selectedQuad) {
                // Re-infer at the same spot with the new frame footprint so the
                // orientation switch respects the depth map
                const b = quadBounds(selectedQuad)
                inferPerspective(selected.id, selectedScene,
                  selectedScene.canvasX + (b.minX + b.maxX) / 2,
                  selectedScene.canvasY + (b.minY + b.maxY) / 2,
                  fw, fh, { immediate: { rotation: rot } })
              } else {
                onPatchDisplay(selected.id, { rotation: rot })
              }
            }}
            onSettings={() => onOpenSettings(selected.id)}
          />
        )}
      </div>

      {/* Display list panel (left, under the header) */}
      {listOpen && (
        <DisplayListPanel
          displays={displays}
          statuses={statuses}
          lastImageTimestamps={lastImageTimestamps}
          selectedId={selectedId}
          onGoto={gotoDisplay}
          onSettings={id => { setSelectedId(id); onOpenSettings(id) }}
          onAdd={onAddDisplay}
        />
      )}

      {/* File-drop overlay */}
      {fileOver && (
        <div className="absolute inset-0 z-[80] flex items-center justify-center bg-primary/10 border-4 border-dashed border-primary/50 pointer-events-none">
          <div className="flex items-center gap-2 rounded-xl bg-background/90 backdrop-blur-md border border-border px-4 py-3 shadow-xl">
            <ImagePlus className="h-5 w-5 text-primary" />
            <span className="text-sm font-medium">Drop to add environment</span>
          </div>
        </div>
      )}

      {/* Empty state */}
      {displays.length === 0 && scenes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground pointer-events-none">
          <p className="text-sm mb-3">No displays configured</p>
          <Button variant="outline" className="gap-2 pointer-events-auto" onClick={onAddDisplay}>
            <Plus className="h-4 w-4" /> Add Your First Display
          </Button>
        </div>
      )}

      {/* Zoom / fit controls */}
      <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-xl border border-border bg-background/70 backdrop-blur-md px-1.5 py-1 shadow-lg">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => zoomBy(1 / 1.2)} title="Zoom out">
          <ZoomOut className="h-4 w-4" />
        </Button>
        <button
          className="text-xs tabular-nums text-muted-foreground hover:text-foreground w-12 text-center"
          onClick={() => setView(v => ({ ...v, zoom: 1 }))}
          title="Reset zoom to 100%"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => zoomBy(1.2)} title="Zoom in">
          <ZoomIn className="h-4 w-4" />
        </Button>
        <div className="w-px h-5 bg-border mx-0.5" />
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fitToContent} title="Fit all">
          <Maximize className="h-4 w-4" />
        </Button>
      </div>

      {/* Hint */}
      <p className="absolute bottom-4 left-4 text-[11px] text-muted-foreground/60 pointer-events-none">
        Click to select · drag to multi-select · scroll to pan, pinch to zoom · double-click for settings · drop a JPG for an environment
      </p>
    </div>
  )
}
