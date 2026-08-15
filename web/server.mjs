import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import getLocalIp from '@loxjs/node-local-ip';
import sharp from 'sharp';
import { Device, discover } from '../lib/index.mjs';
import { fetchFromProvider, downloadImage, BUILT_IN_PROVIDERS } from './providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rootEnv = path.join(__dirname, '..', '.env');
if (fs.existsSync(rootEnv) && !process.env.DISPLAY_HOST) {
  const { config } = await import('dotenv');
  config({ path: rootEnv });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const PORT = parseInt(process.env.PORT || '3001', 10);
const localIp = getLocalIp();

const pendingImages = new Map();

// ─── Per-Display Storage ──────────────────────────────────────────────────────

const DISPLAYS_DIR = path.join(__dirname, '.displays');
const DISPLAYS_JSON = path.join(DISPLAYS_DIR, 'displays.json');

function ensureDisplaysDir() {
  fs.mkdirSync(DISPLAYS_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadDisplays() { return readJson(DISPLAYS_JSON, []); }
function saveDisplays(displays) { ensureDisplaysDir(); writeJson(DISPLAYS_JSON, displays); }
function getDisplay(id) { return loadDisplays().find(d => d.id === id) || null; }

function displayDir(id) { return path.join(DISPLAYS_DIR, id); }
function displayImagesDir(id) { return path.join(displayDir(id), 'images'); }
function ensureDisplayDir(id) { fs.mkdirSync(displayImagesDir(id), { recursive: true }); }
function getDisplayLastImagePath(id) { return path.join(displayDir(id), 'last-push.jpg'); }

function loadDisplayQueue(id) {
  return readJson(path.join(displayDir(id), 'queue.json'), { images: [], currentIndex: 0 });
}
function saveDisplayQueue(id, queue) {
  ensureDisplayDir(id); writeJson(path.join(displayDir(id), 'queue.json'), queue);
}

const SCHEDULE_DEFAULTS = {
  enabled: false, by: 'time', hour: 8, minute: 0, repeat: 'daily',
  intervalValue: 1, intervalUnit: 'days', nextWakeAt: null,
};
function loadDisplaySchedule(id) {
  return { ...SCHEDULE_DEFAULTS, ...readJson(path.join(displayDir(id), 'schedule.json'), {}) };
}
function saveDisplaySchedule(id, schedule) {
  ensureDisplayDir(id); writeJson(path.join(displayDir(id), 'schedule.json'), schedule);
}

const INTERVAL_UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 };
function scheduleIntervalMs(schedule) {
  const v = Math.max(1, Number(schedule.intervalValue) || 1);
  return v * (INTERVAL_UNIT_MS[schedule.intervalUnit] || INTERVAL_UNIT_MS.days);
}
// Interval wakes are due at nextWakeAt; the RTC alarm is time-of-day only, so
// for intervals over 24h the display "relay-wakes" daily and is put straight
// back to sleep until the due time arrives (see pollForWake).
function isIntervalSchedule(schedule) { return schedule.by === 'interval'; }
function advanceIntervalWake(displayId) {
  const schedule = loadDisplaySchedule(displayId);
  if (!isIntervalSchedule(schedule) || !schedule.enabled) return;
  schedule.nextWakeAt = Date.now() + scheduleIntervalMs(schedule);
  saveDisplaySchedule(displayId, schedule);
  console.log(`   ⏭  [${displayId.slice(0, 8)}] Next interval wake: ${new Date(schedule.nextWakeAt).toLocaleString()}`);
}

function loadDisplayProviders(id) {
  return readJson(path.join(displayDir(id), 'providers.json'), {
    sourceMode: 'queue', activeProvider: 'nasa-iotd', customProviders: [],
  });
}
function saveDisplayProviders(id, config) {
  ensureDisplayDir(id); writeJson(path.join(displayDir(id), 'providers.json'), config);
}

function loadDisplayMode(id) {
  const saved = readJson(path.join(displayDir(id), 'mode.json'), { mode: 'manual' });
  return saved.mode === 'scheduled' ? 'scheduled' : 'manual';
}
function saveDisplayMode(id, mode) {
  ensureDisplayDir(id); writeJson(path.join(displayDir(id), 'mode.json'), { mode: mode === 'scheduled' ? 'scheduled' : 'manual' });
}

function getAllDisplayProviders(displayId) {
  const config = loadDisplayProviders(displayId);
  return [...BUILT_IN_PROVIDERS, ...config.customProviders];
}

// ─── Migration from single-display .queue/ ────────────────────────────────────

function migrateFromSingleDisplay() {
  if (fs.existsSync(DISPLAYS_JSON)) return;

  const oldQueueDir = path.join(__dirname, '.queue');
  const oldLastImage = path.join(__dirname, '.last-push.jpg');
  const host = process.env.DISPLAY_HOST || '';
  const pin = process.env.DISPLAY_PIN || '';
  const mac = process.env.DISPLAY_MAC || '';
  const sleepAfter = parseInt(process.env.DISPLAY_SLEEP_AFTER || '20', 10);

  if (!host && !fs.existsSync(oldQueueDir)) {
    ensureDisplaysDir();
    saveDisplays([]);
    return;
  }

  const id = randomUUID();
  const display = {
    id, name: 'Display 1', host, pin, mac, sleepAfter,
    canvasX: 100, canvasY: 50, canvasWidth: 180, canvasHeight: 320,
  };

  ensureDisplaysDir();
  ensureDisplayDir(id);
  saveDisplays([display]);

  if (fs.existsSync(oldQueueDir)) {
    for (const file of ['queue.json', 'schedule.json', 'providers.json', 'mode.json']) {
      const src = path.join(oldQueueDir, file);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(displayDir(id), file));
    }
    const oldImagesDir = path.join(oldQueueDir, 'images');
    if (fs.existsSync(oldImagesDir)) {
      for (const img of fs.readdirSync(oldImagesDir)) {
        fs.copyFileSync(path.join(oldImagesDir, img), path.join(displayImagesDir(id), img));
      }
    }
  }

  if (fs.existsSync(oldLastImage)) {
    fs.copyFileSync(oldLastImage, getDisplayLastImagePath(id));
  }

  console.log(`📦 Migrated single-display data → "${display.name}" (${id.slice(0, 8)})`);
}

migrateFromSingleDisplay();

// ─── Per-Display Sleep Timers ─────────────────────────────────────────────────

const sleepTimers = new Map();

function cancelSleepTimer(displayId) {
  const entry = sleepTimers.get(displayId);
  if (entry) {
    clearTimeout(entry.timer);
    sleepTimers.delete(displayId);
    console.log(`   ⏰ [${displayId.slice(0, 8)}] Sleep timer cancelled`);
  }
}

function getSleepTimerInfo(displayId) {
  const entry = sleepTimers.get(displayId);
  if (!entry) return null;
  return { sleepAt: entry.info.sleepAt, remainingMs: Math.max(0, entry.info.sleepAt - Date.now()), minutes: entry.info.minutes };
}

function scheduleSleep(displayId, { host, pin, mac, minutes, sleepMode = 'manual' }) {
  cancelSleepTimer(displayId);
  if (!minutes || minutes <= 0) return;

  const sleepAt = Date.now() + minutes * 60_000;
  const info = { sleepAt, minutes, sleepMode };
  console.log(`   ⏰ [${displayId.slice(0, 8)}] Will ${sleepMode}-sleep in ${minutes}m`);

  const timer = setTimeout(async () => {
    sleepTimers.delete(displayId);
    await performSleep(displayId, { host, pin, mac, sleepMode });
  }, minutes * 60_000);

  sleepTimers.set(displayId, { timer, info });
}

async function performSleep(displayId, { host, pin, mac, sleepMode }) {
  console.log(`\n💤 [${displayId.slice(0, 8)}] Performing ${sleepMode} sleep...`);
  try {
    const device = new Device({ host, mac: mac || undefined, pin });
    await device.connect();

    if (sleepMode === 'scheduled') {
      const schedule = loadDisplaySchedule(displayId);
      if (schedule.enabled && isIntervalSchedule(schedule)) {
        // Interval mode: alarm at the due time's hh:mm, repeating DAILY as a
        // self-healing fallback — if the server misses the rendezvous (asleep,
        // restarting, MDC session busy), the display retries at the same time
        // tomorrow instead of sleeping forever with no alarm armed. Intervals
        // over 24h produce relay wakes that pollForWake puts straight back to
        // sleep; a successful push re-arms the alarm at the next due hh:mm.
        let next = schedule.nextWakeAt;
        if (!next || next <= Date.now()) {
          next = Date.now() + scheduleIntervalMs(schedule);
          schedule.nextWakeAt = next;
          saveDisplaySchedule(displayId, schedule);
        }
        const d = new Date(next);
        await device.setOnTimer({ enabled: true, repeat: 0x02, hour: d.getHours(), minute: d.getMinutes() }).catch(() => {});
        console.log(`   ⏰ On Timer (interval): ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} daily — due ${d.toLocaleString()}`);
      } else if (schedule.enabled) {
        const repeatCode = { daily: 0x02, weekdays: 0x03, once: 0x01 }[schedule.repeat] || 0x02;
        await device.setOnTimer({ enabled: true, repeat: repeatCode, hour: schedule.hour, minute: schedule.minute }).catch(() => {});
        console.log(`   ⏰ On Timer: ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} (${schedule.repeat})`);
      }
      await device.setNetworkStandby({ enabled: false }).catch(() => {});
    } else if (sleepMode === 'deep') {
      await device.setNetworkStandby({ enabled: false }).catch(() => {});
    } else {
      await device.setNetworkStandby({ enabled: true }).catch(() => {});
    }

    await device.setPower({ power: false });
    await device.disconnect();
    console.log(`   ✅ Display powered off (${sleepMode})`);

    if (sleepMode === 'scheduled') startWakePoller(displayId);
  } catch (err) {
    console.error(`   ❌ Failed to power off: ${err.message}`);
    // Keep watching even when the sleep itself failed — the display is still
    // on scheduled duty and the poller is its only way back into the cycle
    if (sleepMode === 'scheduled') startWakePoller(displayId);
  }
}

// ─── Push Helpers ─────────────────────────────────────────────────────────────

async function pushImageToDisplay({ imageBuffer, host, pin, mac, displayId, lastImageBuffer, skipHistory = false }) {
  const pushId = randomUUID().toUpperCase();
  const fileId = randomUUID().toUpperCase();
  const fileName = `${fileId}.jpg`;
  const imageUrl = `http://${localIp}:${PORT}/api/display-content/${pushId}/image`;
  const contentUrl = `http://${localIp}:${PORT}/api/display-content/${pushId}/content.json`;

  const tag = displayId ? ` [${displayId.slice(0, 8)}]` : '';
  console.log(`\n🖼  Push ${pushId}${tag}`);
  console.log(`   Image: ${(imageBuffer.length / 1024).toFixed(0)} KB → ${host}`);

  const imageServed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingImages.delete(pushId);
      reject(new Error('Display did not download the image within 30 seconds'));
    }, 30_000);

    pendingImages.set(pushId, {
      imageBuffer,
      contentJson: {
        schedule: [{
          start_date: '1970-01-01', stop_date: '2999-12-31', start_time: '00:00:00',
          contents: [{
            image_url: imageUrl, file_id: fileId,
            file_path: `/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents/${fileId}/${fileName}`,
            duration: 91326, file_size: `${imageBuffer.length}`, file_name: fileName,
          }],
        }],
        name: 'node-samsung-emdx', version: 1,
        create_time: new Date().toISOString().replace('T', ' ').slice(0, 19),
        id: fileId, program_id: 'com.samsung.ios.ePaper',
        content_type: 'ImageContent', deploy_type: 'MOBILE',
      },
      resolve: () => { clearTimeout(timeout); resolve(undefined); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    });
  });

  const device = new Device({ host, mac: mac || undefined, pin });
  console.log('   🔄 Connecting...');
  await device.connect();
  console.log('   ✅ Connected');
  await device.setNetworkStandby({ enabled: true }).catch(() => {});
  console.log(`   🔄 Setting content download → ${contentUrl}`);
  await device.setContentDownload({ url: contentUrl });
  await device.disconnect();
  console.log('   ✅ Waiting for display to download...');
  await imageServed;
  console.log('   🎉 Done!');

  // last-push.jpg stores the PRESENTATION image (file orientation) — the
  // payload may carry an extra calibration rotation the previews shouldn't see
  if (displayId) {
    const lastPath = getDisplayLastImagePath(displayId);
    if (!skipHistory) archiveLastImage(displayId, lastPath);
    fs.writeFile(lastPath, lastImageBuffer ?? imageBuffer, () => {});
  }
  return pushId;
}

// ─── Image history ───────────────────────────────────────────────────────────
// Every replaced presentation image is kept (newest first, capped) so the UI
// can show a dimmed "History" strip below the current image.

const HISTORY_LIMIT = 24;
function historyDir(id) { return path.join(displayDir(id), 'history'); }

function archiveLastImage(displayId, lastPath) {
  try {
    if (!fs.existsSync(lastPath)) return;
    const dir = historyDir(displayId);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(lastPath, path.join(dir, `${Date.now()}.jpg`));
    const files = fs.readdirSync(dir).filter(f => /^\d+\.jpg$/.test(f)).sort();
    while (files.length > HISTORY_LIMIT) fs.rmSync(path.join(dir, files.shift()), { force: true });
  } catch { /* history is best-effort */ }
}

async function applyOutputRotation(imageBuffer, outputRotation) {
  const raw = Number(outputRotation);
  const normalized = Number.isFinite(raw) ? ((raw % 360) + 360) % 360 : 0;
  if (normalized === 0) return imageBuffer;
  return sharp(imageBuffer).rotate(normalized).jpeg({ quality: 85 }).toBuffer();
}

// Push a presentation image (file orientation = up). The display's calibration
// (upRotation) is applied to the device payload only — previews stay honest.
async function pushPresentation(displayId, { host, pin, mac }, presentationBuffer, { skipHistory = false } = {}) {
  const display = getDisplay(displayId);
  const up = Number.isFinite(display?.upRotation) ? display.upRotation : 0;
  const payload = await applyOutputRotation(presentationBuffer, up);
  return pushImageToDisplay({ imageBuffer: payload, host, pin, mac, displayId, lastImageBuffer: presentationBuffer, skipHistory });
}

// Per-queue-image presentation override: rotate (90° steps), then crop in the
// rotated image's pixel space (matches react-easy-crop's convention).
async function applyQueueEdit(buffer, edit) {
  if (!edit) return buffer;
  let buf = buffer;
  const rot = [90, 180, 270].includes(edit.rotation) ? edit.rotation : 0;
  if (rot) buf = await sharp(buf).rotate(rot).jpeg({ quality: 92 }).toBuffer();
  const c = edit.crop;
  if (c && [c.x, c.y, c.width, c.height].every(Number.isFinite)) {
    const meta = await sharp(buf).metadata();
    const left = Math.max(0, Math.min(Math.round(c.x), meta.width - 1));
    const top = Math.max(0, Math.min(Math.round(c.y), meta.height - 1));
    const width = Math.max(1, Math.min(Math.round(c.width), meta.width - left));
    const height = Math.max(1, Math.min(Math.round(c.height), meta.height - top));
    buf = await sharp(buf).extract({ left, top, width, height }).jpeg({ quality: 88 }).toBuffer();
  }
  return buf;
}

// Cover-fit an image to the display's frame aspect: fill and crop (centered)
// rather than letterbox. Used for feed images the user hasn't curated.
async function coverCropToDisplay(buffer, display) {
  try {
    const rotated = (((display?.rotation ?? 0) % 180) + 180) % 180 === 90;
    const fw = rotated ? display.canvasHeight : display.canvasWidth;
    const fh = rotated ? display.canvasWidth : display.canvasHeight;
    if (!fw || !fh) return buffer;
    const target = fw / fh;
    const meta = await sharp(buffer).metadata();
    const cur = meta.width / meta.height;
    if (Math.abs(cur - target) / target < 0.02) return buffer;
    let width = meta.width, height = meta.height, left = 0, top = 0;
    if (cur > target) {
      width = Math.round(meta.height * target);
      left = Math.round((meta.width - width) / 2);
    } else {
      height = Math.round(meta.width / target);
      top = Math.round((meta.height - height) / 2);
    }
    return await sharp(buffer).extract({ left, top, width, height }).jpeg({ quality: 88 }).toBuffer();
  } catch {
    return buffer;
  }
}

async function pushNextQueueImage(displayId, { host, pin, mac }, imageId = null) {
  const display = getDisplay(displayId);
  const queue = loadDisplayQueue(displayId);
  if (queue.images.length === 0) throw new Error('Queue is empty');

  const idx = imageId
    ? queue.images.findIndex(img => img.id === imageId)
    : queue.currentIndex % queue.images.length;
  if (idx === -1) throw new Error('Image not in queue');
  const entry = queue.images[idx];
  const imgPath = path.join(displayImagesDir(displayId), entry.filename);
  if (!fs.existsSync(imgPath)) {
    queue.currentIndex = (idx + 1) % queue.images.length;
    saveDisplayQueue(displayId, queue);
    throw new Error(`Queue image missing: ${entry.filename}`);
  }

  let imageBuffer = fs.readFileSync(imgPath);
  imageBuffer = await applyQueueEdit(imageBuffer, entry.edit);

  await pushPresentation(displayId, { host, pin, mac }, imageBuffer);

  const queueAfterPush = loadDisplayQueue(displayId);
  if (queueAfterPush.images.length > 0) {
    // Rotation continues from the image that was just shown
    const shownIdx = imageId ? queueAfterPush.images.findIndex(img => img.id === imageId) : -1;
    const baseIdx = shownIdx !== -1 ? shownIdx : queueAfterPush.currentIndex;
    queueAfterPush.currentIndex = (baseIdx + 1) % queueAfterPush.images.length;
    saveDisplayQueue(displayId, queueAfterPush);
  }

  const sleepAfter = display?.sleepAfter ?? 20;
  if (sleepAfter > 0) scheduleSleep(displayId, { host, pin, mac, minutes: sleepAfter, sleepMode: 'scheduled' });
  return { entry, index: idx + 1, total: queue.images.length };
}

// ─── Per-Display Wake Pollers ─────────────────────────────────────────────────

const wakePollers = new Map();

function startWakePoller(displayId) {
  if (wakePollers.has(displayId)) return;
  if (loadDisplayMode(displayId) !== 'scheduled') return;
  const schedule = loadDisplaySchedule(displayId);
  if (!schedule.enabled) return;

  console.log(`   🔄 [${displayId.slice(0, 8)}] Wake poller started`);
  const interval = setInterval(() => pollForWake(displayId), 30_000);
  wakePollers.set(displayId, { interval, running: false });
}

function stopWakePoller(displayId) {
  const entry = wakePollers.get(displayId);
  if (entry) {
    clearInterval(entry.interval);
    wakePollers.delete(displayId);
    console.log(`   ℹ️  [${displayId.slice(0, 8)}] Wake poller stopped`);
  }
}

async function pollForWake(displayId) {
  const entry = wakePollers.get(displayId);
  if (!entry || entry.running) return;
  entry.running = true;

  try {
    if (loadDisplayMode(displayId) !== 'scheduled') { stopWakePoller(displayId); return; }

    const display = getDisplay(displayId);
    if (!display || !display.host || !display.pin) return;
    const { host, pin, mac } = display;

    try {
      const device = new Device({ host, mac: mac || undefined, pin });
      await device.connect({ timeout: 3_000 });
      await device.disconnect();
    } catch { return; }

    console.log(`\n🔔 [${displayId.slice(0, 8)}] Wake poller: display is online!`);
    stopWakePoller(displayId);

    // Interval schedules over 24h ride on daily relay wakes: if the wake isn't
    // due yet, put the display straight back to sleep without touching the image.
    const schedule = loadDisplaySchedule(displayId);
    if (schedule.enabled && isIntervalSchedule(schedule) && schedule.nextWakeAt && Date.now() < schedule.nextWakeAt - 90_000) {
      console.log(`   💤 Relay wake — next image due ${new Date(schedule.nextWakeAt).toLocaleString()}, back to sleep`);
      await performSleep(displayId, { host, pin, mac, sleepMode: 'scheduled' });
      return;
    }

    const providerConfig = loadDisplayProviders(displayId);

    if (providerConfig.sourceMode === 'provider') {
      const allProviders = getAllDisplayProviders(displayId);
      const provider = allProviders.find(p => p.id === providerConfig.activeProvider);
      if (!provider) { console.log('   ⚠️  Active provider not found'); return; }
      const result = await fetchFromProvider(provider);
      let imageBuffer = await downloadImage(result.imageUrl);
      imageBuffer = await coverCropToDisplay(imageBuffer, display);
      await pushPresentation(displayId, { host, pin, mac }, imageBuffer);
      console.log(`   ✅ Provider image pushed: "${result.title}"`);
      const sleepAfter = display.sleepAfter ?? 20;
      if (sleepAfter > 0) scheduleSleep(displayId, { host, pin, mac, minutes: sleepAfter, sleepMode: 'scheduled' });
    } else {
      const result = await pushNextQueueImage(displayId, { host, pin, mac });
      console.log(`   ✅ Queue image ${result.index}/${result.total} pushed`);
    }
    advanceIntervalWake(displayId);
  } catch (err) {
    console.error(`   ❌ Wake poller push failed: ${err.message}`);
    // The poller was stopped when the display came online — restart it so a
    // failed push retries on the next tick instead of stalling the cycle
    startWakePoller(displayId);
  } finally {
    const e = wakePollers.get(displayId);
    if (e) e.running = false;
  }
}

// Resume pollers on startup
for (const display of loadDisplays()) {
  const schedule = loadDisplaySchedule(display.id);
  if (schedule.enabled && loadDisplayMode(display.id) === 'scheduled') {
    console.log(`📅 [${display.id.slice(0, 8)}] Resuming wake poller for "${display.name}"`);
    startWakePoller(display.id);
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── Display CRUD ────────────────────────────────────────────────────────────

app.get('/api/displays', (_req, res) => res.json(loadDisplays()));

app.post('/api/displays', (req, res) => {
  const { name, host, pin, mac, sleepAfter, canvasX, canvasY, canvasWidth, canvasHeight } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const id = randomUUID();
  const display = {
    id, name, host: host || '', pin: pin || '', mac: mac || '',
    sleepAfter: sleepAfter ?? 20,
    canvasX: canvasX ?? 100, canvasY: canvasY ?? 50,
    canvasWidth: canvasWidth ?? 180, canvasHeight: canvasHeight ?? 320,
  };
  const displays = loadDisplays();
  displays.push(display);
  saveDisplays(displays);
  ensureDisplayDir(id);
  console.log(`📺 Display added: "${name}" (${id.slice(0, 8)})`);
  res.json(display);
});

app.put('/api/displays/:id', (req, res) => {
  const displays = loadDisplays();
  const idx = displays.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Display not found' });

  for (const key of ['name', 'host', 'pin', 'mac', 'sleepAfter', 'canvasX', 'canvasY', 'canvasWidth', 'canvasHeight', 'rotation', 'upRotation', 'upLocked', 'sceneId', 'quad', 'plane']) {
    if (req.body[key] !== undefined) displays[idx][key] = req.body[key];
  }
  saveDisplays(displays);
  res.json(displays[idx]);
});

app.delete('/api/displays/:id', (req, res) => {
  const displayId = req.params.id;
  stopWakePoller(displayId);
  cancelSleepTimer(displayId);

  const displays = loadDisplays();
  const filtered = displays.filter(d => d.id !== displayId);
  if (filtered.length === displays.length) return res.status(404).json({ error: 'Display not found' });
  saveDisplays(filtered);

  const dir = displayDir(displayId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`📺 Display removed: ${displayId.slice(0, 8)}`);
  res.json({ success: true });
});

// ─── Environment scenes (background images on the canvas) ────────────────────

const SCENES_JSON = path.join(DISPLAYS_DIR, 'scenes.json');
const SCENES_DIR = path.join(DISPLAYS_DIR, 'scenes');
function loadScenes() { return readJson(SCENES_JSON, []); }
function saveScenes(scenes) { ensureDisplaysDir(); writeJson(SCENES_JSON, scenes); }
function sceneImagePath(id) { return path.join(SCENES_DIR, `${path.basename(id)}.jpg`); }
function sceneDepthPath(id) { return path.join(SCENES_DIR, `${path.basename(id)}.depth.png`); }

// Depth maps power perspective inference; computed in the background at upload
const sceneDepthJobs = new Map();
function startSceneDepth(id) {
  if (sceneDepthJobs.has(id)) return sceneDepthJobs.get(id);
  const job = (async () => {
    const { ensureSceneDepth } = await import('./depth.mjs');
    await ensureSceneDepth(sceneImagePath(id), sceneDepthPath(id));
    console.log(`🗺️  Depth map ready for scene ${id.slice(0, 8)}`);
  })().catch(err => {
    sceneDepthJobs.delete(id);
    console.error(`⚠️  Depth map failed for scene ${id.slice(0, 8)}: ${err.message}`);
    throw err;
  });
  sceneDepthJobs.set(id, job);
  return job;
}

app.get('/api/scenes', (_req, res) => res.json(loadScenes()));

app.post('/api/scenes', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'image is required' });
    const id = randomUUID();
    fs.mkdirSync(SCENES_DIR, { recursive: true });
    const buffer = await sharp(req.file.buffer).rotate().jpeg({ quality: 88 }).toBuffer();
    const meta = await sharp(buffer).metadata();
    fs.writeFileSync(path.join(SCENES_DIR, `${id}.jpg`), buffer);

    // Scale natural size down to a sane canvas footprint
    const maxDim = 1100;
    const scale = Math.min(1, maxDim / Math.max(meta.width, meta.height));
    const width = Math.round(meta.width * scale);
    const height = Math.round(meta.height * scale);
    const canvasX = Math.round(Number(req.body.canvasX ?? 0) - width / 2);
    const canvasY = Math.round(Number(req.body.canvasY ?? 0) - height / 2);

    const scene = { id, canvasX, canvasY, canvasWidth: width, canvasHeight: height };
    const scenes = loadScenes();
    scenes.push(scene);
    saveScenes(scenes);
    console.log(`🖼️  Scene added: ${id.slice(0, 8)} (${width}x${height})`);
    startSceneDepth(id); // warm the depth map for perspective inference
    res.json(scene);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/scenes/:id', (req, res) => {
  const scenes = loadScenes();
  const idx = scenes.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Scene not found' });
  for (const key of ['canvasX', 'canvasY', 'canvasWidth', 'canvasHeight', 'locked']) {
    if (req.body[key] !== undefined) scenes[idx][key] = req.body[key];
  }
  saveScenes(scenes);
  res.json(scenes[idx]);
});

app.delete('/api/scenes/:id', (req, res) => {
  const scenes = loadScenes();
  const filtered = scenes.filter(s => s.id !== req.params.id);
  if (filtered.length === scenes.length) return res.status(404).json({ error: 'Scene not found' });
  saveScenes(filtered);
  const img = sceneImagePath(req.params.id);
  if (fs.existsSync(img)) fs.rmSync(img);
  const depth = sceneDepthPath(req.params.id);
  if (fs.existsSync(depth)) fs.rmSync(depth);
  sceneDepthJobs.delete(req.params.id);
  // Detach any displays that were placed on this scene
  const displays = loadDisplays();
  let changed = false;
  for (const d of displays) {
    if (d.sceneId === req.params.id) { d.sceneId = null; d.quad = null; changed = true; }
  }
  if (changed) saveDisplays(displays);
  res.json({ success: true });
});

// Infer a perspective quad from the scene's depth map.
// Body: { x, y, w, h } — drop center (scene-relative canvas units) + display size.
// Returns { quad } or { quad: null } when inference isn't possible (caller falls back).
app.post('/api/scenes/:id/infer', async (req, res) => {
  const scene = loadScenes().find(s => s.id === req.params.id);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  const { x, y, w, h, prevPlane } = req.body;
  if (![x, y, w, h].every(Number.isFinite)) return res.status(400).json({ error: 'x, y, w, h required' });
  try {
    await startSceneDepth(scene.id);
    const { inferQuadFromDepth } = await import('./depth.mjs');
    const result = await inferQuadFromDepth(sceneDepthPath(scene.id), scene, { x, y }, { w, h }, prevPlane);
    res.json(result ?? { quad: null, plane: null, samePlane: false });
  } catch (err) {
    console.error(`⚠️  Perspective inference failed: ${err.message}`);
    res.json({ quad: null, plane: null, samePlane: false });
  }
});

app.get('/api/scenes/:id/image', (req, res) => {
  const img = path.join(SCENES_DIR, `${path.basename(req.params.id)}.jpg`);
  if (!fs.existsSync(img)) return res.status(404).json({ error: 'Not found' });
  // res.sendFile refuses paths under dot-directories (.displays), so stream it
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'no-cache');
  fs.createReadStream(img).pipe(res);
});

// ─── Network discovery ───────────────────────────────────────────────────────

app.get('/api/discover', async (_req, res) => {
  try {
    console.log('🔍 Scanning network for EMDX displays...');
    const found = await discover({ timeout: 5_000 });
    const displays = loadDisplays();
    const results = found.map(d => {
      const existing = displays.find(x => x.host === d.host);
      return {
        ...d,
        alreadyAdded: !!existing,
        existingName: existing?.name || null,
      };
    });
    console.log(`🔍 Discovery found ${results.length} display(s)`);
    res.json(results);
  } catch (err) {
    console.error(`❌ Discovery failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Display content endpoints (called by Samsung hardware) ─────────────────

app.get('/api/display-content/:id/content.json', (req, res) => {
  const entry = pendingImages.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  console.log(`  📥 Display fetching content.json for ${req.params.id}`);
  res.header('Content-Type', 'application/json');
  res.send(JSON.stringify(entry.contentJson).replaceAll('/', '\\/'));
  req.once('close', () => console.log('  ✅ content.json served'));
});

app.get('/api/display-content/:id/image', (req, res) => {
  const entry = pendingImages.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  console.log(`  📥 Display downloading image for ${req.params.id}`);
  res.header('Content-Type', 'image/jpeg');
  res.send(entry.imageBuffer);
  req.once('close', () => {
    console.log('  ✅ Image served to display');
    pendingImages.delete(req.params.id);
    entry.resolve();
  });
});

// ─── Per-display middleware ──────────────────────────────────────────────────

function resolveDisplay(req, res, next) {
  const display = getDisplay(req.params.displayId);
  if (!display) return res.status(404).json({ error: 'Display not found' });
  req.display = display;
  next();
}

// ─── Per-display: Status ────────────────────────────────────────────────────

app.get('/api/displays/:displayId/status', resolveDisplay, async (req, res) => {
  const { host, pin, mac } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin configured' });
  try {
    const device = new Device({ host, mac: mac || undefined, pin });
    await device.connect();
    // Probe sequentially with small gaps — the EM32DX drops responses when
    // several MDC commands arrive back-to-back.
    const power = await device.getPowerState().catch(() => null);
    const battery = await device.getBatteryState().catch(() => null);
    const deviceName = await device.getDeviceName().catch(() => null);
    const networkStandby = await device.getNetworkStandby().catch(() => null);
    const serialNumber = await device.getSerialNumber().catch(() => null);
    const softwareVersion = await device.getSoftwareVersion().catch(() => null);
    await device.disconnect();
    res.json({ power, battery, deviceName, networkStandby, serialNumber, softwareVersion, sleepTimer: getSleepTimerInfo(req.params.displayId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Per-display: Push ──────────────────────────────────────────────────────

app.post('/api/displays/:displayId/push', resolveDisplay, upload.single('image'), async (req, res) => {
  try {
    const displayId = req.params.displayId;
    const { host, pin, mac } = req.display;
    const sleepAfter = parseInt(req.body.sleepAfter || '0', 10);
    let imageBuffer = req.file?.buffer;
    if (!imageBuffer) return res.status(400).json({ error: 'No image provided' });
    if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });

    // Normalize to JPEG honoring the file's own orientation (EXIF). The image
    // is presented exactly as the file is — calibration happens at payload time.
    imageBuffer = await sharp(imageBuffer).rotate().jpeg({ quality: 88 }).toBuffer();

    cancelSleepTimer(displayId);
    stopWakePoller(displayId);

    if (mac) {
      const d = new Device({ host, mac, pin });
      await d.wakeup();
      await new Promise(r => setTimeout(r, 1000));
    }

    const pushId = await pushPresentation(displayId, { host, pin, mac }, imageBuffer);

    if (sleepAfter > 0) {
      scheduleSleep(displayId, { host, pin, mac, minutes: sleepAfter, sleepMode: req.body.sleepMode || 'manual' });
    }
    res.json({ success: true, pushId });
  } catch (err) {
    console.error('   ❌ Push failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Per-display: Last Image ────────────────────────────────────────────────

app.get('/api/displays/:displayId/last-image', resolveDisplay, (req, res) => {
  const imgPath = getDisplayLastImagePath(req.params.displayId);
  if (!fs.existsSync(imgPath)) return res.status(404).end();
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'no-cache');
  fs.createReadStream(imgPath).pipe(res);
});

// Previously displayed images, newest first
app.get('/api/displays/:displayId/history', resolveDisplay, (req, res) => {
  const dir = historyDir(req.params.displayId);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d+\.jpg$/.test(f)); } catch { /* none yet */ }
  const images = files
    .map(f => ({ id: f.replace(/\.jpg$/, ''), ts: Number(f.replace(/\.jpg$/, '')) }))
    .sort((a, b) => b.ts - a.ts);
  res.json({ images });
});

app.get('/api/displays/:displayId/history/:imageId', resolveDisplay, (req, res) => {
  if (!/^\d+$/.test(req.params.imageId)) return res.status(400).end();
  const imgPath = path.join(historyDir(req.params.displayId), `${req.params.imageId}.jpg`);
  if (!fs.existsSync(imgPath)) return res.status(404).end();
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'max-age=31536000, immutable');
  fs.createReadStream(imgPath).pipe(res);
});

// ─── Per-display: Wake / Sleep ──────────────────────────────────────────────

app.post('/api/displays/:displayId/wake', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host && !mac) return res.status(400).json({ error: 'host or MAC required' });

  try {
    cancelSleepTimer(displayId);
    stopWakePoller(displayId);
    let method = 'unknown';

    if (host && pin) {
      try {
        const device = new Device({ host, mac: mac || undefined, pin });
        await device.connect({ timeout: 5_000 });
        await device.setPower({ power: true });
        await device.disconnect();
        method = 'mdc';
      } catch { /* display may be in deep sleep */ }
    }

    if (method !== 'mdc' && mac) {
      const device = new Device({ host, mac, pin });
      await device.wakeup();
      method = 'wol';
      if (host && pin) {
        setTimeout(async () => {
          try {
            const d = new Device({ host, mac, pin });
            await d.connect({ timeout: 15_000 });
            await d.setNetworkStandby({ enabled: true }).catch(() => {});
            await d.disconnect();
          } catch { /* not ready yet */ }
        }, 5_000);
      }
    }

    if (method === 'unknown') return res.status(400).json({ error: 'Could not wake display' });
    res.json({ success: true, method });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/displays/:displayId/sleep', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  const sleepMode = req.body?.sleepMode || 'manual';
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });
  try {
    cancelSleepTimer(displayId);
    stopWakePoller(displayId);
    await performSleep(displayId, { host, pin, mac, sleepMode });
    res.json({ success: true, mode: sleepMode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/displays/:displayId/sleep/force', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });
  try {
    saveDisplayMode(displayId, 'manual');
    cancelSleepTimer(displayId);
    stopWakePoller(displayId);
    await performSleep(displayId, { host, pin, mac, sleepMode: 'deep' });
    res.json({ success: true, mode: 'deep' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Per-display: Rotation calibration ──────────────────────────────────────
// Push a giant up-arrow through the normal rotation pipeline; the user reports
// which way it actually points on the glass, and the delta becomes upRotation.

function calibrationBackupPath(id) { return path.join(displayDir(id), 'calibration-restore.jpg'); }

// The arrow is rendered in the aspect the user *intends* for this display, so
// "up" on the test image means "up in the world" for the orientation they chose.
function makeCalibrationArrow(orientation = 'portrait') {
  const [W, H] = orientation === 'landscape' ? [2560, 1440] : [1440, 2560];
  const s = Math.min(W, H);
  const cx = W / 2, cy = H / 2;
  const ah = H * 0.75;
  const head = ah * 0.45, headW = s * 0.72, shaftW = s * 0.25;
  const top = cy - ah / 2, base = top + head, bot = cy + ah / 2;
  const pts = [
    [cx, top], [cx + headW / 2, base], [cx + shaftW / 2, base],
    [cx + shaftW / 2, bot], [cx - shaftW / 2, bot], [cx - shaftW / 2, base],
    [cx - headW / 2, base],
  ].map(p => p.map(Math.round).join(',')).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="100%" height="100%" fill="white"/>
    <polygon points="${pts}" fill="black"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

function frameOrientation(display) {
  return (((display?.rotation ?? 0) % 180) + 180) % 180 === 90 ? 'landscape' : 'portrait';
}

app.post('/api/displays/:displayId/calibrate/start', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });
  try {
    cancelSleepTimer(displayId);
    stopWakePoller(displayId);

    // Keep a copy of what's on the glass so we can put it back afterwards
    const last = getDisplayLastImagePath(displayId);
    if (fs.existsSync(last)) fs.copyFileSync(last, calibrationBackupPath(displayId));
    else fs.rmSync(calibrationBackupPath(displayId), { force: true });

    // The canvas frame is the user's intended orientation — render the arrow
    // for that aspect so "up" on the test image means up in their intended view
    const buf = await makeCalibrationArrow(frameOrientation(req.display));

    if (mac) {
      const d = new Device({ host, mac, pin });
      await d.wakeup();
      await new Promise(r => setTimeout(r, 1000));
    }
    // Arrow goes out as a normal presentation image — calibration applies to
    // the payload, so the glass shows where the current setting really points
    await pushPresentation(displayId, { host, pin, mac }, buf, { skipHistory: true });
    console.log(`🎯 [${displayId.slice(0, 8)}] Calibration arrow pushed (upRotation ${req.display.upRotation ?? 0})`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Body: { observed: 0|90|180|270 } — the direction the arrow points in reality
// (null/absent = cancel: restore the previous image without changing anything).
app.post('/api/displays/:displayId/calibrate/finish', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });
  try {
    const observed = req.body?.observed;
    const displays = loadDisplays();
    const d = displays.find(x => x.id === displayId);
    const oldUp = Number.isFinite(d.upRotation) ? d.upRotation : 0;
    let newUp = oldUp;

    if ([0, 90, 180, 270].includes(observed)) {
      // Arrow was sent as "up"; it showed at `observed`. The panel therefore adds
      // (observed - oldUp) — compensate so future content lands upright.
      newUp = ((oldUp - observed) % 360 + 360) % 360;
      d.upRotation = newUp;
      d.upLocked = true;
      saveDisplays(displays);
      console.log(`🎯 [${displayId.slice(0, 8)}] Calibrated: observed ${observed}° → upRotation ${newUp} (locked)`);
    }

    // Restore the previous presentation image; the push pipeline applies the
    // (possibly new) calibration, so it lands upright automatically
    const backup = calibrationBackupPath(displayId);
    if (fs.existsSync(backup)) {
      const buf = fs.readFileSync(backup);
      await pushPresentation(displayId, { host, pin, mac }, buf, { skipHistory: true });
      fs.rmSync(backup, { force: true });
      const sleepAfter = d.sleepAfter ?? 20;
      const mode = loadDisplayMode(displayId);
      if (sleepAfter > 0) scheduleSleep(displayId, { host, pin, mac, minutes: sleepAfter, sleepMode: mode === 'scheduled' ? 'scheduled' : 'manual' });
    }
    res.json({ success: true, upRotation: newUp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Per-display: Mode ──────────────────────────────────────────────────────

app.get('/api/displays/:displayId/mode', resolveDisplay, (req, res) => {
  res.json({ mode: loadDisplayMode(req.params.displayId) });
});

app.post('/api/displays/:displayId/mode', resolveDisplay, (req, res) => {
  const displayId = req.params.displayId;
  const mode = req.body?.mode === 'scheduled' ? 'scheduled' : 'manual';
  saveDisplayMode(displayId, mode);
  if (mode === 'manual') { cancelSleepTimer(displayId); stopWakePoller(displayId); }
  else { const s = loadDisplaySchedule(displayId); if (s.enabled) startWakePoller(displayId); }
  res.json({ success: true, mode });
});

// ─── Per-display: Queue ─────────────────────────────────────────────────────

app.get('/api/displays/:displayId/queue', resolveDisplay, (req, res) => {
  res.json(loadDisplayQueue(req.params.displayId));
});

app.post('/api/displays/:displayId/queue', resolveDisplay, upload.single('image'), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: 'No image provided' });
  const displayId = req.params.displayId;
  ensureDisplayDir(displayId);
  const id = randomUUID();
  const filename = `${id}.jpg`;
  // Normalize arbitrary uploads (PNG/HEIC/EXIF-rotated) to a clean JPEG in the
  // file's own orientation; presentation overrides live in `edit`
  const buffer = await sharp(req.file.buffer).rotate().jpeg({ quality: 88 }).toBuffer().catch(() => req.file.buffer);
  fs.writeFileSync(path.join(displayImagesDir(displayId), filename), buffer);
  const queue = loadDisplayQueue(displayId);
  queue.images.push({ id, filename, addedAt: new Date().toISOString(), edit: null });
  saveDisplayQueue(displayId, queue);
  console.log(`📋 [${displayId.slice(0, 8)}] Queue: +1 image (${queue.images.length} total)`);
  res.json({ success: true, id, count: queue.images.length });
});

app.post('/api/displays/:displayId/queue/push-next', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });
  try {
    cancelSleepTimer(displayId);
    stopWakePoller(displayId);
    const result = await pushNextQueueImage(displayId, { host, pin, mac });
    res.json({ success: true, id: result.entry.id, filename: result.entry.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/displays/:displayId/queue/reorder', resolveDisplay, (req, res) => {
  const { ids, currentIndex } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const displayId = req.params.displayId;
  const queue = loadDisplayQueue(displayId);
  const byId = new Map(queue.images.map(img => [img.id, img]));
  queue.images = ids.map(id => byId.get(id)).filter(Boolean);
  if (Number.isInteger(currentIndex)) queue.currentIndex = Math.max(0, Math.min(queue.images.length - 1, currentIndex));
  if (queue.currentIndex >= queue.images.length) queue.currentIndex = 0;
  saveDisplayQueue(displayId, queue);
  res.json({ success: true });
});

// Push a specific queue image now (rotation continues from it)
app.post('/api/displays/:displayId/queue/:imageId/push', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });
  try {
    cancelSleepTimer(displayId);
    stopWakePoller(displayId);
    const result = await pushNextQueueImage(displayId, { host, pin, mac }, req.params.imageId);
    res.json({ success: true, id: result.entry.id, filename: result.entry.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/displays/:displayId/queue/:imageId', resolveDisplay, (req, res) => {
  const displayId = req.params.displayId;
  const queue = loadDisplayQueue(displayId);
  const idx = queue.images.findIndex(img => img.id === req.params.imageId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = queue.images.splice(idx, 1);
  if (queue.currentIndex >= queue.images.length) queue.currentIndex = 0;
  saveDisplayQueue(displayId, queue);
  fs.unlink(path.join(displayImagesDir(displayId), removed.filename), () => {});
  res.json({ success: true });
});

app.get('/api/displays/:displayId/queue/image/:imageId', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const queue = loadDisplayQueue(displayId);
  const entry = queue.images.find(img => img.id === req.params.imageId);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const imgPath = path.join(displayImagesDir(displayId), entry.filename);
  if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Image file missing' });
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'public, max-age=86400');
  // ?edited=1 → preview with the presentation override applied (cache-bust
  // with the entry's editedAt when requesting)
  if (req.query.edited === '1' && entry.edit) {
    try {
      const buf = await applyQueueEdit(fs.readFileSync(imgPath), entry.edit);
      return res.send(buf);
    } catch { /* fall through to the raw file */ }
  }
  fs.createReadStream(imgPath).pipe(res);
});

// Presentation override for a queued image: how it should be displayed.
// Body: { rotation: 0|90|180|270, crop: {x,y,width,height}|null }
app.put('/api/displays/:displayId/queue/:imageId/edit', resolveDisplay, (req, res) => {
  const displayId = req.params.displayId;
  const queue = loadDisplayQueue(displayId);
  const entry = queue.images.find(img => img.id === req.params.imageId);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const { rotation, crop } = req.body ?? {};
  const rot = [0, 90, 180, 270].includes(rotation) ? rotation : 0;
  const validCrop = crop && [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
    : null;
  entry.edit = (rot === 0 && !validCrop) ? null : { rotation: rot, crop: validCrop };
  entry.editedAt = new Date().toISOString();
  saveDisplayQueue(displayId, queue);
  res.json({ success: true, edit: entry.edit });
});

// ─── Per-display: Schedule ──────────────────────────────────────────────────

app.get('/api/displays/:displayId/schedule', resolveDisplay, (req, res) => {
  res.json(loadDisplaySchedule(req.params.displayId));
});

app.post('/api/displays/:displayId/schedule', resolveDisplay, (req, res) => {
  const displayId = req.params.displayId;
  const { enabled, by, hour, minute, repeat, intervalValue, intervalUnit } = req.body;
  const schedule = loadDisplaySchedule(displayId);
  if (typeof enabled === 'boolean') schedule.enabled = enabled;
  if (by && ['time', 'interval'].includes(by)) schedule.by = by;
  if (typeof hour === 'number') schedule.hour = Math.max(0, Math.min(23, hour));
  if (typeof minute === 'number') schedule.minute = Math.max(0, Math.min(59, minute));
  if (repeat && ['daily', 'weekdays', 'once'].includes(repeat)) schedule.repeat = repeat;
  if (typeof intervalValue === 'number') schedule.intervalValue = Math.max(1, Math.round(intervalValue));
  if (intervalUnit && Object.hasOwn(INTERVAL_UNIT_MS, intervalUnit)) schedule.intervalUnit = intervalUnit;
  // Any edit to an enabled interval schedule restarts the countdown from now
  schedule.nextWakeAt = schedule.enabled && isIntervalSchedule(schedule)
    ? Date.now() + scheduleIntervalMs(schedule)
    : null;
  saveDisplaySchedule(displayId, schedule);
  if (schedule.enabled && loadDisplayMode(displayId) === 'scheduled') startWakePoller(displayId);
  else stopWakePoller(displayId);
  console.log(`📅 [${displayId.slice(0, 8)}] Schedule: ${schedule.enabled ? 'ON' : 'OFF'} — ${isIntervalSchedule(schedule)
    ? `every ${schedule.intervalValue} ${schedule.intervalUnit}`
    : `at ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} (${schedule.repeat})`}`);
  res.json({ success: true, schedule });
});

// Upcoming wake times (epoch ms) — used for "image will display at ..." captions
app.get('/api/displays/:displayId/schedule/upcoming', resolveDisplay, (req, res) => {
  const count = Math.max(1, Math.min(100, parseInt(req.query.count, 10) || 10));
  const displayId = req.params.displayId;
  const schedule = loadDisplaySchedule(displayId);
  if (!schedule.enabled || loadDisplayMode(displayId) !== 'scheduled') return res.json({ times: [] });

  const times = [];
  if (isIntervalSchedule(schedule)) {
    const step = scheduleIntervalMs(schedule);
    let t = schedule.nextWakeAt && schedule.nextWakeAt > Date.now() ? schedule.nextWakeAt : Date.now() + step;
    for (let i = 0; i < count; i++) { times.push(t); t += step; }
  } else {
    const d = new Date();
    d.setHours(schedule.hour, schedule.minute, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    for (let guard = 0; times.length < count && guard < count * 8; guard++) {
      const day = d.getDay();
      if (schedule.repeat !== 'weekdays' || (day >= 1 && day <= 5)) times.push(d.getTime());
      if (schedule.repeat === 'once') break;
      d.setDate(d.getDate() + 1);
    }
  }
  res.json({ times });
});

// ─── Per-display: Providers ─────────────────────────────────────────────────

app.get('/api/displays/:displayId/providers', resolveDisplay, (req, res) => {
  const config = loadDisplayProviders(req.params.displayId);
  res.json({ sourceMode: config.sourceMode, activeProvider: config.activeProvider, providers: getAllDisplayProviders(req.params.displayId) });
});

app.put('/api/displays/:displayId/providers/active', resolveDisplay, (req, res) => {
  const displayId = req.params.displayId;
  const { sourceMode, activeProvider } = req.body;
  const config = loadDisplayProviders(displayId);
  if (sourceMode && ['queue', 'provider'].includes(sourceMode)) config.sourceMode = sourceMode;
  if (activeProvider) config.activeProvider = activeProvider;
  saveDisplayProviders(displayId, config);
  res.json({ success: true });
});

app.post('/api/displays/:displayId/providers', resolveDisplay, async (req, res) => {
  const { name, feedUrl } = req.body;
  if (!name || !feedUrl) return res.status(400).json({ error: 'name and feedUrl required' });
  try {
    const result = await fetchFromProvider({ id: 'validation', name, feedUrl, builtin: false });
    if (!result.imageUrl) return res.status(400).json({ error: 'Feed parsed but no image found.' });
  } catch (err) {
    return res.status(400).json({ error: `Feed validation failed: ${err.message}` });
  }
  const displayId = req.params.displayId;
  const config = loadDisplayProviders(displayId);
  const id = `custom-${randomUUID().slice(0, 8)}`;
  config.customProviders.push({ id, name, feedUrl, builtin: false });
  saveDisplayProviders(displayId, config);
  res.json({ success: true, id });
});

app.delete('/api/displays/:displayId/providers/:providerId', resolveDisplay, (req, res) => {
  if (BUILT_IN_PROVIDERS.some(p => p.id === req.params.providerId)) return res.status(400).json({ error: 'Cannot delete built-in provider' });
  const displayId = req.params.displayId;
  const config = loadDisplayProviders(displayId);
  config.customProviders = config.customProviders.filter(p => p.id !== req.params.providerId);
  if (config.activeProvider === req.params.providerId) config.activeProvider = 'nasa-iotd';
  saveDisplayProviders(displayId, config);
  res.json({ success: true });
});

app.get('/api/displays/:displayId/providers/:providerId/preview', resolveDisplay, async (req, res) => {
  const allProviders = getAllDisplayProviders(req.params.displayId);
  const provider = allProviders.find(p => p.id === req.params.providerId);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  try { res.json(await fetchFromProvider(provider)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/displays/:displayId/providers/apply', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });

  const config = loadDisplayProviders(displayId);
  const provider = getAllDisplayProviders(displayId).find(p => p.id === config.activeProvider);
  if (!provider) return res.status(404).json({ error: 'Active provider not found' });

  try {
    const result = await fetchFromProvider(provider);
    if (!result.imageUrl) return res.status(400).json({ error: 'Provider returned no image' });
    const imgRes = await fetch(result.imageUrl, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
    let imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    imageBuffer = await coverCropToDisplay(imageBuffer, getDisplay(displayId));

    cancelSleepTimer(displayId);
    stopWakePoller(displayId);

    if (mac) { const d = new Device({ host, mac, pin }); await d.wakeup(); await new Promise(r => setTimeout(r, 1000)); }

    const pushId = await pushPresentation(displayId, { host, pin, mac }, imageBuffer);
    const display = getDisplay(displayId);
    const sleepAfter = display?.sleepAfter ?? 20;
    if (sleepAfter > 0) scheduleSleep(displayId, { host, pin, mac, minutes: sleepAfter, sleepMode: req.body?.sleepMode || 'manual' });
    res.json({ success: true, pushId, title: result.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Static frontend (production) ────────────────────────────────────────────

const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  const n = loadDisplays().length;
  console.log(`\n🚀 Samsung EMDX Web Server (${n} display${n !== 1 ? 's' : ''})`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIp}:${PORT}\n`);
});
