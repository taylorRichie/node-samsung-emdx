// Laying a group's displays out as one wall, for spanning an image across
// them. Shared by the server (sends from the API) and the web app (the span
// designer), so both cut the same slices.

// EM32DX: 2560 × 1440 pixels, each 0.272 mm, in a frame about 14 mm wide
export const PIXEL_PITCH_MM = 0.272;
export const DEFAULT_GAP = { bezelMm: 14, spaceXMm: 0, spaceYMm: 0 };

export const mmToPx = (mm) => Math.round(Math.max(0, mm) / PIXEL_PITCH_MM);

export const sameMembers = (a, b) => a.length === b.length && a.every(id => b.includes(id));

const isLandscape = (d) => (((d.rotation ?? 0) % 180) + 180) % 180 === 90;

/** The panel in pixels, following the display's orientation */
export function panelSize(d) {
  return isLandscape(d) ? { w: 2560, h: 1440 } : { w: 1440, h: 2560 };
}

/** Where a display sits on the canvas, whether it's flat or placed on a photo */
export function canvasRect(d, sceneById) {
  const scene = d.sceneId && d.quad ? sceneById.get(d.sceneId) : undefined;
  if (scene && d.quad) {
    const xs = d.quad.map(p => p.x), ys = d.quad.map(p => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { x: scene.canvasX + minX, y: scene.canvasY + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }
  const landscape = isLandscape(d);
  return {
    x: d.canvasX, y: d.canvasY,
    w: landscape ? d.canvasHeight : d.canvasWidth,
    h: landscape ? d.canvasWidth : d.canvasHeight,
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** A raw offset, pulled to the start, middle or end of the room when it's close */
function place(raw, room, tolerance) {
  const near = [0, room / 2, room].reduce((a, b) => (Math.abs(raw - b) < Math.abs(raw - a) ? b : a));
  return Math.round(clamp(Math.abs(raw - near) <= tolerance ? near : raw, 0, room));
}

/**
 * Lays a group's displays out as one wall, in panel pixels. The arrangement
 * comes from the canvas: displays whose middles share a band are a row, read
 * left to right. Screens sit a frame-and-gap apart, so the picture carries on
 * behind the frames as it would through a window.
 * Returns { width, height, screens: [{ id, x, y, w, h }], rows, gapX, gapY, bezelPx }.
 */
export function wallLayout(members, scenes, gap) {
  const sceneById = new Map(scenes.map(s => [s.id, s]));
  const bezelPx = mmToPx(gap.bezelMm);
  const gapX = mmToPx(gap.bezelMm * 2 + gap.spaceXMm);
  const gapY = mmToPx(gap.bezelMm * 2 + gap.spaceYMm);
  if (members.length === 0) return { width: 1, height: 1, screens: [], rows: 0, gapX, gapY, bezelPx };

  const items = members
    .map(d => ({ id: d.id, r: canvasRect(d, sceneById), ...panelSize(d) }))
    .sort((a, b) => (a.r.y + a.r.h / 2) - (b.r.y + b.r.h / 2));

  // A display whose middle falls within a row's height joins that row
  const bands = [];
  for (const it of items) {
    const band = bands[bands.length - 1];
    const mid = it.r.y + it.r.h / 2;
    if (band && mid >= band.top && mid <= band.bottom) {
      band.items.push(it);
      band.top = Math.min(band.top, it.r.y);
      band.bottom = Math.max(band.bottom, it.r.y + it.r.h);
    } else {
      bands.push({ items: [it], top: it.r.y, bottom: it.r.y + it.r.h });
    }
  }

  const rows = bands.map(band => {
    band.items.sort((a, b) => (a.r.x + a.r.w / 2) - (b.r.x + b.r.w / 2));
    return {
      ...band,
      width: band.items.reduce((sum, it) => sum + it.w, 0) + gapX * (band.items.length - 1),
      height: Math.max(...band.items.map(it => it.h)),
      left: Math.min(...band.items.map(it => it.r.x)),
      right: Math.max(...band.items.map(it => it.r.x + it.r.w)),
    };
  });
  const width = Math.max(...rows.map(r => r.width));
  const height = rows.reduce((sum, r) => sum + r.height, 0) + gapY * (rows.length - 1);

  // A narrower row keeps its place under the widest one: flush left, centered
  // or flush right when it's near one of those, in proportion otherwise. A
  // shorter screen in a row lines up with its neighbours the same way. Centers
  // are compared, since the canvas isn't to scale: tiles sit further apart
  // there than the displays do on the wall.
  const widest = rows.find(r => r.width === width);
  const widestMid = (widest.left + widest.right) / 2;
  const perUnit = width / Math.max(1, widest.right - widest.left);
  const screens = [];
  let y = 0;
  for (const row of rows) {
    const rowMid = (row.left + row.right) / 2;
    const room = width - row.width;
    let x = place(room / 2 + (rowMid - widestMid) * perUnit, room, width * 0.08);
    const vUnit = row.height / Math.max(1, row.bottom - row.top);
    const rowCenterY = (row.top + row.bottom) / 2;
    for (const it of row.items) {
      const vRoom = row.height - it.h;
      const dy = place(vRoom / 2 + (it.r.y + it.r.h / 2 - rowCenterY) * vUnit, vRoom, row.height * 0.2);
      screens.push({ id: it.id, x, y: y + dy, w: it.w, h: it.h });
      x += it.w + gapX;
    }
    y += row.height + gapY;
  }
  return { width, height, screens, rows: rows.length, gapX, gapY, bezelPx };
}

/**
 * A free-transform edit placing an image of iw × ih on a W × H frame, as the
 * designer would: 'fill' covers it, 'fit' shows all of it, 'stretch' fills it
 * ignoring proportions.
 */
export function sizedEdit(iw, ih, W, H, fit = 'fill', bg = '#000000') {
  if (fit === 'stretch') return { mode: 'transform', rotation: 0, scaleX: 1, scaleY: 1, offset: { x: 0, y: 0 }, bg };
  const s = fit === 'fit' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
  return { mode: 'transform', rotation: 0, scaleX: (iw * s) / W, scaleY: (ih * s) / H, offset: { x: 0, y: 0 }, bg };
}

/** A new group starts with the frames and gaps of the one used last */
export function latestGap(groups) {
  const recent = [...groups].sort((a, b) => (b.span?.updatedAt ?? '').localeCompare(a.span?.updatedAt ?? ''))[0];
  return recent?.gap ?? DEFAULT_GAP;
}

export function nextGroupName(groups) {
  for (let n = 1; ; n++) if (!groups.some(g => g.name === `Group ${n}`)) return `Group ${n}`;
}
