import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import getLocalIp from '@loxjs/node-local-ip';
import sharp from 'sharp';
import { Device } from '../lib/index.mjs';
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

function loadDisplaySchedule(id) {
  return readJson(path.join(displayDir(id), 'schedule.json'), { enabled: false, hour: 8, minute: 0, repeat: 'daily' });
}
function saveDisplaySchedule(id, schedule) {
  ensureDisplayDir(id); writeJson(path.join(displayDir(id), 'schedule.json'), schedule);
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
      if (schedule.enabled) {
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
  }
}

// ─── Push Helpers ─────────────────────────────────────────────────────────────

async function pushImageToDisplay({ imageBuffer, host, pin, mac, displayId }) {
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

  if (displayId) fs.writeFile(getDisplayLastImagePath(displayId), imageBuffer, () => {});
  return pushId;
}

async function applyOutputRotation(imageBuffer, outputRotation) {
  const raw = Number(outputRotation);
  const normalized = Number.isFinite(raw) ? ((raw % 360) + 360) % 360 : 0;
  if (normalized === 0) return imageBuffer;
  return sharp(imageBuffer).rotate(normalized).jpeg({ quality: 85 }).toBuffer();
}

async function pushNextQueueImage(displayId, { host, pin, mac }) {
  const display = getDisplay(displayId);
  const queue = loadDisplayQueue(displayId);
  if (queue.images.length === 0) throw new Error('Queue is empty');

  const idx = queue.currentIndex % queue.images.length;
  const entry = queue.images[idx];
  const imgPath = path.join(displayImagesDir(displayId), entry.filename);
  if (!fs.existsSync(imgPath)) {
    queue.currentIndex = (idx + 1) % queue.images.length;
    saveDisplayQueue(displayId, queue);
    throw new Error(`Queue image missing: ${entry.filename}`);
  }

  let imageBuffer = fs.readFileSync(imgPath);
  const rot = Number.isFinite(Number(entry.outputRotation)) ? Number(entry.outputRotation) : 90;
  imageBuffer = await applyOutputRotation(imageBuffer, rot);

  await pushImageToDisplay({ imageBuffer, host, pin, mac, displayId });

  const queueAfterPush = loadDisplayQueue(displayId);
  if (queueAfterPush.images.length > 0) {
    queueAfterPush.currentIndex = (queueAfterPush.currentIndex + 1) % queueAfterPush.images.length;
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

    const providerConfig = loadDisplayProviders(displayId);

    if (providerConfig.sourceMode === 'provider') {
      const allProviders = getAllDisplayProviders(displayId);
      const provider = allProviders.find(p => p.id === providerConfig.activeProvider);
      if (!provider) { console.log('   ⚠️  Active provider not found'); return; }
      const result = await fetchFromProvider(provider);
      const imageBuffer = await downloadImage(result.imageUrl);
      await pushImageToDisplay({ imageBuffer, host, pin, mac, displayId });
      console.log(`   ✅ Provider image pushed: "${result.title}"`);
      const sleepAfter = display.sleepAfter ?? 20;
      if (sleepAfter > 0) scheduleSleep(displayId, { host, pin, mac, minutes: sleepAfter, sleepMode: 'scheduled' });
    } else {
      const result = await pushNextQueueImage(displayId, { host, pin, mac });
      console.log(`   ✅ Queue image ${result.index}/${result.total} pushed`);
    }
  } catch (err) {
    console.error(`   ❌ Wake poller push failed: ${err.message}`);
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

  for (const key of ['name', 'host', 'pin', 'mac', 'sleepAfter', 'canvasX', 'canvasY', 'canvasWidth', 'canvasHeight']) {
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
    const [power, battery, deviceName, serialNumber, softwareVersion] = await Promise.all([
      device.getPowerState().catch(() => null),
      device.getBatteryState().catch(() => null),
      device.getDeviceName().catch(() => null),
      device.getSerialNumber().catch(() => null),
      device.getSoftwareVersion().catch(() => null),
    ]);
    await device.disconnect();
    res.json({ power, battery, deviceName, serialNumber, softwareVersion, sleepTimer: getSleepTimerInfo(req.params.displayId) });
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
    const imageBuffer = req.file?.buffer;
    if (!imageBuffer) return res.status(400).json({ error: 'No image provided' });
    if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });

    cancelSleepTimer(displayId);
    stopWakePoller(displayId);

    if (mac) {
      const d = new Device({ host, mac, pin });
      await d.wakeup();
      await new Promise(r => setTimeout(r, 1000));
    }

    const pushId = await pushImageToDisplay({ imageBuffer, host, pin, mac, displayId });

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

app.post('/api/displays/:displayId/queue', resolveDisplay, upload.single('image'), (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: 'No image provided' });
  const displayId = req.params.displayId;
  ensureDisplayDir(displayId);
  const id = randomUUID();
  const filename = `${id}.jpg`;
  const rawRot = Number.parseInt(req.body?.outputRotation ?? '', 10);
  const outputRotation = [0, 90, 180, 270].includes(rawRot) ? rawRot : 90;
  fs.writeFileSync(path.join(displayImagesDir(displayId), filename), req.file.buffer);
  const queue = loadDisplayQueue(displayId);
  queue.images.push({ id, filename, addedAt: new Date().toISOString(), outputRotation });
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
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const displayId = req.params.displayId;
  const queue = loadDisplayQueue(displayId);
  const byId = new Map(queue.images.map(img => [img.id, img]));
  queue.images = ids.map(id => byId.get(id)).filter(Boolean);
  if (queue.currentIndex >= queue.images.length) queue.currentIndex = 0;
  saveDisplayQueue(displayId, queue);
  res.json({ success: true });
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

app.get('/api/displays/:displayId/queue/image/:imageId', resolveDisplay, (req, res) => {
  const displayId = req.params.displayId;
  const queue = loadDisplayQueue(displayId);
  const entry = queue.images.find(img => img.id === req.params.imageId);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const imgPath = path.join(displayImagesDir(displayId), entry.filename);
  if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Image file missing' });
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(imgPath).pipe(res);
});

// ─── Per-display: Schedule ──────────────────────────────────────────────────

app.get('/api/displays/:displayId/schedule', resolveDisplay, (req, res) => {
  res.json(loadDisplaySchedule(req.params.displayId));
});

app.post('/api/displays/:displayId/schedule', resolveDisplay, (req, res) => {
  const displayId = req.params.displayId;
  const { enabled, hour, minute, repeat } = req.body;
  const schedule = loadDisplaySchedule(displayId);
  if (typeof enabled === 'boolean') schedule.enabled = enabled;
  if (typeof hour === 'number') schedule.hour = Math.max(0, Math.min(23, hour));
  if (typeof minute === 'number') schedule.minute = Math.max(0, Math.min(59, minute));
  if (repeat && ['daily', 'weekdays', 'once'].includes(repeat)) schedule.repeat = repeat;
  saveDisplaySchedule(displayId, schedule);
  if (schedule.enabled && loadDisplayMode(displayId) === 'scheduled') startWakePoller(displayId);
  else stopWakePoller(displayId);
  console.log(`📅 [${displayId.slice(0, 8)}] Schedule: ${schedule.enabled ? 'ON' : 'OFF'} at ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} (${schedule.repeat})`);
  res.json({ success: true, schedule });
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
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

    cancelSleepTimer(displayId);
    stopWakePoller(displayId);

    if (mac) { const d = new Device({ host, mac, pin }); await d.wakeup(); await new Promise(r => setTimeout(r, 1000)); }

    const pushId = await pushImageToDisplay({ imageBuffer, host, pin, mac, displayId });
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
