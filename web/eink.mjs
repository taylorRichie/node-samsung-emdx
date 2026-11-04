// Tone/color adjustment and e-paper simulation, shared by the server renderer
// (server.mjs) and the editor preview (LightboxEditor) so the preview and the
// pushed image run the same per-pixel math.

export const ADJUST_KEYS = ['brightness', 'contrast', 'saturation', 'midtones', 'sharpen'];

/** Clamp an adjustment to its ranges; null when it would change nothing */
export function sanitizeAdjust(a) {
  if (!a || typeof a !== 'object') return null;
  const clamp = (v, lo, hi) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : 0;
  const out = {
    brightness: clamp(a.brightness, -100, 100),
    contrast: clamp(a.contrast, -100, 100),
    saturation: clamp(a.saturation, -100, 100),
    midtones: clamp(a.midtones, -100, 100),
    sharpen: clamp(a.sharpen, 0, 100),
  };
  return ADJUST_KEYS.some(k => out[k] !== 0) ? out : null;
}

const to8 = (v) => v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);

/**
 * Brightness → contrast → midtones (one per-channel LUT), then saturation, on
 * 8-bit sRGB pixels in place. `channels` is the pixel stride (3 or 4); alpha
 * is left alone. Sharpening is separate — see sharpenOptions().
 */
export function adjustPixels(data, channels, a) {
  const bright = (a.brightness ?? 0) / 100 * 0.5;
  const contrast = Math.pow(2, (a.contrast ?? 0) / 100 * 1.5);
  const gamma = Math.pow(2, -(a.midtones ?? 0) / 100);
  const sat = 1 + (a.saturation ?? 0) / 100;

  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = Math.max(0, Math.min(1, (i / 255 + bright - 0.5) * contrast + 0.5));
    lut[i] = Math.pow(v, gamma) * 255;
  }

  for (let i = 0; i < data.length; i += channels) {
    const r = lut[data[i]], g = lut[data[i + 1]], b = lut[data[i + 2]];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = to8(l + (r - l) * sat);
    data[i + 1] = to8(l + (g - l) * sat);
    data[i + 2] = to8(l + (b - l) * sat);
  }
}

/**
 * sharp.sharpen() options for a 0–100 amount, or null for none. Flat areas get
 * little sharpening so the panel's dithering doesn't turn it into grain.
 */
export function sharpenOptions(amount) {
  const t = (amount ?? 0) / 100;
  if (!(t > 0)) return null;
  return { sigma: 0.8 + t * 0.7, m1: t * 0.5, m2: t * 3 };
}

// Approximate 6-color (E Ink Spectra 6) panel. Pixels are matched against the
// nominal colors the controller targets, then painted with the as-rendered
// colors, so the preview shows the panel's muted gamut and paper-grey white.
export const PANEL_PALETTE = [
  { name: 'black', nominal: [0, 0, 0], panel: [28, 28, 32] },
  { name: 'white', nominal: [255, 255, 255], panel: [218, 220, 214] },
  { name: 'yellow', nominal: [255, 255, 0], panel: [222, 200, 40] },
  { name: 'red', nominal: [255, 0, 0], panel: [160, 40, 35] },
  { name: 'blue', nominal: [0, 0, 255], panel: [40, 65, 150] },
  { name: 'green', nominal: [0, 255, 0], panel: [55, 100, 65] },
];

/** Serpentine Floyd–Steinberg dither of RGBA pixels to PANEL_PALETTE, in place */
export function ditherToPanel(data, width, height) {
  const P = PANEL_PALETTE;
  const buf = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; j < data.length; i += 3, j += 4) {
    buf[i] = data[j]; buf[i + 1] = data[j + 1]; buf[i + 2] = data[j + 2];
  }
  const spread = (x, y, er, eg, eb, w) => {
    if (x < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    buf[i] += er * w; buf[i + 1] += eg * w; buf[i + 2] += eb * w;
  };

  for (let y = 0; y < height; y++) {
    const dir = y & 1 ? -1 : 1;
    for (let k = 0; k < width; k++) {
      const x = dir === 1 ? k : width - 1 - k;
      const i = (y * width + x) * 3;
      // Clamp accumulated error so it can't run away in saturated regions
      const r = Math.max(0, Math.min(255, buf[i]));
      const g = Math.max(0, Math.min(255, buf[i + 1]));
      const b = Math.max(0, Math.min(255, buf[i + 2]));

      // Nearest nominal color by "redmean" weighted distance
      let best = 0, bestD = Infinity;
      for (let p = 0; p < P.length; p++) {
        const [pr, pg, pb] = P[p].nominal;
        const rm = (r + pr) / 2, dr = r - pr, dg = g - pg, db = b - pb;
        const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
        if (d < bestD) { bestD = d; best = p; }
      }

      const [nr, ng, nb] = P[best].nominal;
      const er = r - nr, eg = g - ng, eb = b - nb;
      spread(x + dir, y, er, eg, eb, 7 / 16);
      spread(x - dir, y + 1, er, eg, eb, 3 / 16);
      spread(x, y + 1, er, eg, eb, 5 / 16);
      spread(x + dir, y + 1, er, eg, eb, 1 / 16);

      const o = (y * width + x) * 4;
      const [cr, cg, cb] = P[best].panel;
      data[o] = cr; data[o + 1] = cg; data[o + 2] = cb; data[o + 3] = 255;
    }
  }
}

/**
 * Average each s×s block of RGBA pixels into one — the panel's dots blending
 * at viewing distance. Done by hand because a canvas downscale of a dither
 * pattern aliases into streaks.
 */
export function boxDownscale(data, width, height, s) {
  const w = Math.floor(width / s), h = Math.floor(height / s), n = s * s;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < s; dy++) {
        let i = ((y * s + dy) * width + x * s) * 4;
        for (let dx = 0; dx < s; dx++, i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}
