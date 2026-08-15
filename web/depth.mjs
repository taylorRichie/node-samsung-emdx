// Depth-map-based perspective inference for environment scenes.
//
// Pipeline: Depth Anything V2 (small) runs once per scene upload and produces a
// relative inverse-depth map. When a display is dropped, we sample the depth
// patch under it, unproject to 3D with an assumed pinhole camera, least-squares
// fit a plane, and project the display rectangle onto that plane — so the quad
// leans the way the actual wall in the photo does.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

let depthPipePromise = null;
async function getDepthPipe() {
  if (!depthPipePromise) {
    depthPipePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small');
    })();
  }
  return depthPipePromise;
}

/** Compute and cache a depth map PNG for a scene image. Returns the depth file path. */
export async function computeSceneDepth(sceneImagePath, depthPngPath) {
  const { RawImage } = await import('@huggingface/transformers');
  const pipe = await getDepthPipe();
  const image = await RawImage.read(sceneImagePath);
  const out = await pipe(image);
  // out.depth: RawImage, single channel, 0-255, same size as input (255 = closest)
  const d = out.depth;
  await sharp(Buffer.from(d.data), { raw: { width: d.width, height: d.height, channels: 1 } })
    .png()
    .toFile(depthPngPath);
  return depthPngPath;
}

async function loadDepth(depthPngPath) {
  const { data, info } = await sharp(depthPngPath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// 3x3 linear solve (Cramer's rule) for the plane normal equations
function solve3(A, b) {
  const det = (m) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return null;
  const col = (m, i, v) => { const c = m.slice(); c[i] = v[0]; c[i + 3] = v[1]; c[i + 6] = v[2]; return c; };
  return [det(col(A, 0, b)) / D, det(col(A, 1, b)) / D, det(col(A, 2, b)) / D];
}

const norm3 = (v) => Math.hypot(v[0], v[1], v[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale3 = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Infer a perspective quad for a display dropped on a scene.
 *
 * @param depthPngPath cached depth map for the scene image
 * @param scene   { canvasWidth, canvasHeight } scene size in canvas units
 * @param drop    { x, y } drop center in scene-relative canvas units
 * @param display { w, h } display footprint in canvas units
 * @param prevPlane { p, r } plane the display currently sits on, if any —
 *        used to report whether the new position is on the same surface.
 * @returns { quad, plane, samePlane } with quad [[TL,TR,BR,BL]] in
 *          scene-relative canvas units, or null if the fit is unreliable
 *          (caller should fall back to flat placement).
 */
export async function inferQuadFromDepth(depthPngPath, scene, drop, display, prevPlane) {
  const depth = await loadDepth(depthPngPath);
  const sx = depth.width / scene.canvasWidth;
  const sy = depth.height / scene.canvasHeight;

  // Assumed pinhole camera (typical photo FOV ~62°)
  const f = 0.83 * depth.width;
  const cx = depth.width / 2;
  const cy = depth.height / 2;

  // Inverse depth in [0.12, 1] (closer = bigger). The affine mapping is an
  // arbitrary choice (monocular depth is relative), tuned to look right.
  const toInvd = (d8) => 0.12 + 0.88 * (d8 / 255);

  const px = drop.x * sx;
  const py = drop.y * sy;
  const W = depth.width, H = depth.height;

  // For any 3D plane, inverse depth is LINEAR in pixel coordinates, so fit
  // invd = p·u + q·v + r directly in image space. (Fitting Z=f(X,Y) on
  // unprojected points folds over on near-grazing walls and flips the plane.)
  const fit = (pts) => {
    let suu = 0, suv = 0, su = 0, svv = 0, sv = 0, s1 = pts.length, bu = 0, bv = 0, b1 = 0;
    for (const [u, v, d] of pts) {
      suu += u * u; suv += u * v; su += u; svv += v * v; sv += v;
      bu += u * d; bv += v * d; b1 += d;
    }
    return solve3([suu, suv, su, suv, svv, sv, su, sv, s1], [bu, bv, b1]);
  };

  // ── Rough scene model: a grid of local disparity planes ──────────────────
  // Each cell gets its own plane fit; the surface under the drop point is then
  // found by region-growing over cells whose planes agree. The final fit pools
  // samples from the whole coherent surface (e.g. the entire wall), which is
  // far more stable than fitting only the patch under the cursor.
  const CELL = Math.max(24, Math.round(Math.min(W, H) / 26));
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL);
  const cellAt = (gx, gy) => {
    const x0 = gx * CELL, y0 = gy * CELL;
    const pts = [];
    const S = 6;
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < S; j++) {
        const u = Math.min(W - 1, Math.round(x0 + ((i + 0.5) / S) * CELL));
        const v = Math.min(H - 1, Math.round(y0 + ((j + 0.5) / S) * CELL));
        pts.push([u - px, v - py, toInvd(depth.data[v * W + u])]);
      }
    }
    const sol = fit(pts);
    if (!sol) return null;
    let se = 0;
    for (const [u, v, d] of pts) se += (sol[0] * u + sol[1] * v + sol[2] - d) ** 2;
    return { sol, rms: Math.sqrt(se / pts.length), cx: x0 + CELL / 2 - px, cy: y0 + CELL / 2 - py };
  };

  const startGx = Math.min(gw - 1, Math.max(0, Math.floor(px / CELL)));
  const startGy = Math.min(gh - 1, Math.max(0, Math.floor(py / CELL)));
  const start = cellAt(startGx, startGy);
  if (!start) return null;

  // Two cells belong to the same surface if their disparity gradients agree
  // and each plane predicts the other's disparity at its center.
  const sameSurface = (a, b) => {
    const gradDiff = Math.hypot(a.sol[0] - b.sol[0], a.sol[1] - b.sol[1]);
    const gradMag = Math.hypot(a.sol[0], a.sol[1]);
    if (gradDiff > Math.max(4e-4, gradMag * 0.45)) return false;
    const predAatB = a.sol[0] * b.cx + a.sol[1] * b.cy + a.sol[2];
    const actualB = b.sol[0] * b.cx + b.sol[1] * b.cy + b.sol[2];
    return Math.abs(predAatB - actualB) < 0.035;
  };

  // BFS region-grow, bounded to a radius around the drop point
  const maxR = Math.max(display.w * sx, display.h * sy) * 2.4;
  const visited = new Set([startGy * gw + startGx]);
  const region = [start];
  const queue = [[startGx, startGy]];
  while (queue.length) {
    const [gx, gy] = queue.shift();
    for (const [dx2, dy2] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx2, ny = gy + dy2;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const key = ny * gw + nx;
      if (visited.has(key)) continue;
      visited.add(key);
      const ccx = nx * CELL + CELL / 2 - px, ccy = ny * CELL + CELL / 2 - py;
      if (Math.hypot(ccx, ccy) > maxR) continue;
      const cell = cellAt(nx, ny);
      if (!cell || !sameSurface(start, cell)) continue;
      region.push(cell);
      queue.push([nx, ny]);
    }
  }

  // Pool samples from the coherent region (denser near the drop point)
  const samples = [];
  for (const cell of region) {
    const S = 5;
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < S; j++) {
        const u = Math.round(cell.cx + px - CELL / 2 + ((i + 0.5) / S) * CELL);
        const v = Math.round(cell.cy + py - CELL / 2 + ((j + 0.5) / S) * CELL);
        if (u < 0 || v < 0 || u >= W || v >= H) continue;
        samples.push([u - px, v - py, toInvd(depth.data[v * W + u])]);
      }
    }
  }
  if (samples.length < 32) return null;

  let sol = fit(samples);
  if (!sol) return null;
  const residual = (s, m) => Math.abs(m[0] * s[0] + m[1] * s[1] + m[2] - s[2]);
  const resids = samples.map(s => residual(s, sol)).sort((x, y) => x - y);
  const cutoff = resids[Math.floor(resids.length * 0.8)] * 2 + 1e-9;
  const inliers = samples.filter(s => residual(s, sol) <= cutoff);
  if (inliers.length >= 32) sol = fit(inliers) ?? sol;

  // Zero-roll camera assumption: vertical world lines project to vertical
  // image lines (true for the vast majority of photos). For our disparity
  // plane that means dropping the v-term (compensating r so depth at the drop
  // point is unchanged). Everything downstream then comes out exact: the
  // quad's left/right edges are perfectly vertical and its top/bottom edges
  // converge to the wall's true vanishing point.
  const p = sol[0];
  const invdAtDrop = sol[2]; // samples were centered on the drop point
  const q = 0;
  const r = invdAtDrop - p * px;

  // Fit quality: residual large relative to the disparity spread → cluttered
  // area, not a wall; let the caller fall back to flat placement.
  const ds = samples.map(s => s[2]);
  const dSpread = Math.max(...ds) - Math.min(...ds);
  const medResid = resids[Math.floor(resids.length / 2)];
  if (medResid > Math.max(0.012, dSpread * 0.35)) return null;

  // Plane in 3D from the disparity plane: (pf)X + (qf)Y + (p·cx + q·cy + r)Z = 1
  // Camera-facing normal is the negation (frontal wall: p=q=0, r>0 → n=(0,0,-1)).
  let n = [-p * f, -q * f, -(p * cx + q * cy + r)];
  const nLen = norm3(n);
  if (nLen < 1e-9) return null;
  n = scale3(n, 1 / nLen);
  if (n[2] > 0) n = scale3(n, -1);

  // Clamp obliqueness: cap the tilt at ~68° (keep the lean direction, limit
  // the angle) so near-grazing walls don't degenerate the projection.
  const MIN_COS = 0.37;
  const cosTilt = -n[2];
  if (cosTilt < MIN_COS) {
    const xyLen = Math.hypot(n[0], n[1]);
    if (xyLen < 1e-9) return null;
    const s = Math.sqrt(1 - MIN_COS * MIN_COS) / xyLen;
    n = [n[0] * s, n[1] * s, -MIN_COS];
  }

  // Center of the display on the plane along the drop ray
  const invd0 = p * px + q * py + r;
  if (!(invd0 > 1e-6)) return null;
  const Z0 = 1 / invd0;
  const xn = (px - cx) / f;
  const yn = (py - cy) / f;
  const C = [xn * Z0, yn * Z0, Z0];

  // In-plane axes: up = world-up projected onto the plane, right = up × n
  let up = add3([0, -1, 0], scale3(n, -dot3([0, -1, 0], n)));
  const upLen = norm3(up);
  if (upLen < 1e-6) return null;
  up = scale3(up, 1 / upLen);
  let right = cross(up, n);
  right = scale3(right, 1 / norm3(right));
  if (right[0] < 0) right = scale3(right, -1);

  // Physical size that keeps the on-screen footprint ≈ the flat tile size
  const wW = (display.w * sx * Z0) / f;
  const hW = (display.h * sy * Z0) / f;

  const corners3 = [
    add3(C, add3(scale3(right, -wW / 2), scale3(up, hW / 2))),  // TL (up is -Y…)
    add3(C, add3(scale3(right, wW / 2), scale3(up, hW / 2))),   // TR
    add3(C, add3(scale3(right, wW / 2), scale3(up, -hW / 2))),  // BR
    add3(C, add3(scale3(right, -wW / 2), scale3(up, -hW / 2))), // BL
  ];

  const quad = corners3.map(([X, Y, Z]) => {
    if (!(Z > 0)) return null;
    return { x: ((f * X) / Z + cx) / sx, y: ((f * Y) / Z + cy) / sy };
  });
  if (quad.some(p => p == null)) return null;

  // Sanity: reject wildly degenerate quads
  const xsQ = quad.map(p => p.x), ysQ = quad.map(p => p.y);
  const qw = Math.max(...xsQ) - Math.min(...xsQ);
  const qh = Math.max(...ysQ) - Math.min(...ysQ);
  if (qw < display.w * 0.3 || qw > display.w * 3 || qh < display.h * 0.3 || qh > display.h * 3) return null;

  // Thin-sliver guard: bounds can look fine while the parallelogram itself has
  // collapsed, so check the actual (shoelace) area against the flat footprint.
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a2 = quad[i], b2 = quad[(i + 1) % 4];
    area += a2.x * b2.y - b2.x * a2.y;
  }
  if (Math.abs(area) / 2 < display.w * display.h * 0.25) return null;

  // Is the new position on the same plane the display already sits on?
  // (Callers use this to skip perspective changes for same-wall nudges.)
  const plane = { p, r };
  let samePlane = false;
  if (prevPlane && Number.isFinite(prevPlane.p) && Number.isFinite(prevPlane.r)) {
    const invdPrev = prevPlane.p * px + prevPlane.r;
    samePlane =
      Math.abs(prevPlane.p - p) <= Math.max(4e-4, Math.abs(p) * 0.45) &&
      Math.abs(invdPrev - invdAtDrop) < 0.035;
  }

  return { quad, plane, samePlane };
}

/** Ensure a scene's depth map exists (compute lazily if missing). */
export async function ensureSceneDepth(sceneImagePath, depthPngPath) {
  if (fs.existsSync(depthPngPath)) return depthPngPath;
  fs.mkdirSync(path.dirname(depthPngPath), { recursive: true });
  return computeSceneDepth(sceneImagePath, depthPngPath);
}
