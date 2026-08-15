import type { Point, Quad, Scene } from "./types"

// ─── Homography: map a w×h rect onto an arbitrary quad via CSS matrix3d ──────
// Adjugate-based 2D projective mapping (no matrix solver needed).

type M3 = number[] // 9 entries, row-major 3x3

function adjugate(m: M3): M3 {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ]
}

function multiply(a: M3, b: M3): M3 {
  const c = new Array(9).fill(0)
  for (let r = 0; r < 3; r++)
    for (let k = 0; k < 3; k++)
      for (let col = 0; col < 3; col++)
        c[r * 3 + col] += a[r * 3 + k] * b[k * 3 + col]
  return c
}

function basisToPoints(p1: Point, p2: Point, p3: Point, p4: Point): M3 {
  const m: M3 = [p1.x, p2.x, p3.x, p1.y, p2.y, p3.y, 1, 1, 1]
  const adj = adjugate(m)
  const v = [
    adj[0] * p4.x + adj[1] * p4.y + adj[2],
    adj[3] * p4.x + adj[4] * p4.y + adj[5],
    adj[6] * p4.x + adj[7] * p4.y + adj[8],
  ]
  return multiply(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]])
}

/**
 * CSS matrix3d() string that maps the rect (0,0)-(w,h) onto `quad`
 * (quad points in the same coordinate space the element lives in).
 */
export function rectToQuadMatrix(w: number, h: number, quad: Quad): string {
  const src = basisToPoints({ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h })
  // basisToPoints order: p1,p2,p3 columns + p4 scaling — keep same corner order
  const dst = basisToPoints(quad[0], quad[1], quad[2], quad[3])
  const t = multiply(dst, adjugate(src))
  for (let i = 0; i < 9; i++) t[i] /= t[8]
  // Expand 3x3 homography into 4x4 column-major matrix3d
  const m = [
    t[0], t[3], 0, t[6],
    t[1], t[4], 0, t[7],
    0, 0, 1, 0,
    t[2], t[5], 0, t[8],
  ]
  return `matrix3d(${m.map(v => v.toFixed(6)).join(",")})`
}

// ─── Perspective inference ───────────────────────────────────────────────────
// Heuristic: treat the scene photo as a room shot roughly straight-on. A display
// dropped near the horizontal center sits flat; toward the edges the wall
// recedes, so the outer edge of the display shrinks and foreshortens.

export function inferQuad(centerX: number, centerY: number, w: number, h: number, scene: Scene): Quad {
  // Position within the scene, -1 (left edge) .. 1 (right edge)
  const t = Math.max(-1, Math.min(1, ((centerX - scene.canvasX) / scene.canvasWidth) * 2 - 1))
  const cx = centerX - scene.canvasX
  const cy = centerY - scene.canvasY

  const lean = Math.abs(t)
  const dir = Math.sign(t) // +1: right side of photo → right edge is "far"

  // Foreshorten width, shrink the far edge vertically, lift the far edge a touch
  const width = w * (1 - 0.12 * lean)
  const nearH = h
  const farH = h * (1 - 0.22 * lean)
  const farLift = h * 0.03 * lean

  const halfW = width / 2
  const leftFar = dir < 0
  const lH = leftFar ? farH : nearH
  const rH = leftFar ? nearH : farH
  const lLift = leftFar ? farLift : 0
  const rLift = leftFar ? 0 : farLift

  return [
    { x: cx - halfW, y: cy - lH / 2 - lLift }, // TL
    { x: cx + halfW, y: cy - rH / 2 - rLift }, // TR
    { x: cx + halfW, y: cy + rH / 2 - rLift }, // BR
    { x: cx - halfW, y: cy + lH / 2 - lLift }, // BL
  ]
}

export function quadBounds(quad: Quad): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(...quad.map(p => p.x)),
    minY: Math.min(...quad.map(p => p.y)),
    maxX: Math.max(...quad.map(p => p.x)),
    maxY: Math.max(...quad.map(p => p.y)),
  }
}

export function quadCenter(quad: Quad): Point {
  return {
    x: quad.reduce((s, p) => s + p.x, 0) / 4,
    y: quad.reduce((s, p) => s + p.y, 0) / 4,
  }
}

export function translateQuad(quad: Quad, dx: number, dy: number): Quad {
  return quad.map(p => ({ x: p.x + dx, y: p.y + dy })) as Quad
}
