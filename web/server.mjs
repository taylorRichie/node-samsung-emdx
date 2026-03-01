import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import getPort from 'get-port';
import getLocalIp from '@loxjs/node-local-ip';
import { Device } from '../lib/index.mjs';
import { fetchFromProvider, downloadImage, BUILT_IN_PROVIDERS } from './providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from project root if not already loaded
const rootEnv = path.join(__dirname, '..', '.env');
if (fs.existsSync(rootEnv) && !process.env.DISPLAY_HOST) {
  const { config } = await import('dotenv');
  config({ path: rootEnv });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const PORT = parseInt(process.env.PORT || '3001', 10);
const localIp = getLocalIp();

const displayDefaults = {
  host: process.env.DISPLAY_HOST || '',
  pin: process.env.DISPLAY_PIN || '',
  mac: process.env.DISPLAY_MAC || '',
  sleepAfter: parseInt(process.env.DISPLAY_SLEEP_AFTER || '20', 10),
};

const pendingImages = new Map();
const lastImagePath = path.join(__dirname, '.last-push.jpg');
let sleepTimer = null;
let sleepTimerInfo = null;

// ─── Queue & Schedule Storage ────────────────────────────────────────────────

const QUEUE_DIR = path.join(__dirname, '.queue');
const QUEUE_JSON = path.join(QUEUE_DIR, 'queue.json');
const SCHEDULE_JSON = path.join(QUEUE_DIR, 'schedule.json');
const PROVIDERS_JSON = path.join(QUEUE_DIR, 'providers.json');
const MODE_JSON = path.join(QUEUE_DIR, 'mode.json');
const QUEUE_IMAGES_DIR = path.join(QUEUE_DIR, 'images');

function ensureQueueDir() {
  fs.mkdirSync(QUEUE_IMAGES_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureQueueDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadQueue() {
  return readJson(QUEUE_JSON, { images: [], currentIndex: 0 });
}

function saveQueue(queue) {
  writeJson(QUEUE_JSON, queue);
}

function loadSchedule() {
  return readJson(SCHEDULE_JSON, { enabled: false, hour: 8, minute: 0, repeat: 'daily' });
}

function saveSchedule(schedule) {
  writeJson(SCHEDULE_JSON, schedule);
}

function loadProviderConfig() {
  const defaults = {
    sourceMode: 'queue',
    activeProvider: 'nasa-iotd',
    customProviders: [],
  };
  return readJson(PROVIDERS_JSON, defaults);
}

function saveProviderConfig(config) {
  writeJson(PROVIDERS_JSON, config);
}

function loadMode() {
  const saved = readJson(MODE_JSON, { mode: 'manual' });
  return saved.mode === 'scheduled' ? 'scheduled' : 'manual';
}

function saveMode(mode) {
  writeJson(MODE_JSON, { mode: mode === 'scheduled' ? 'scheduled' : 'manual' });
}

function getAllProviders() {
  const config = loadProviderConfig();
  return [...BUILT_IN_PROVIDERS, ...config.customProviders];
}

ensureQueueDir();

// ─── Sleep Timer ─────────────────────────────────────────────────────────────

function cancelSleepTimer() {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
    sleepTimerInfo = null;
    console.log('   ⏰ Sleep timer cancelled');
  }
}

function scheduleSleep({ host, pin, mac, minutes, sleepMode = 'manual' }) {
  cancelSleepTimer();
  if (!minutes || minutes <= 0) return;

  const sleepAt = Date.now() + minutes * 60_000;
  sleepTimerInfo = { sleepAt, minutes, sleepMode };

  console.log(`   ⏰ Display will ${sleepMode}-sleep in ${minutes} minutes`);

  sleepTimer = setTimeout(async () => {
    sleepTimer = null;
    sleepTimerInfo = null;
    await performSleep({ host, pin, mac, sleepMode });
  }, minutes * 60_000);
}

async function performSleep({ host, pin, mac, sleepMode }) {
  console.log(`\n💤 Performing ${sleepMode} sleep...`);
  try {
    const device = new Device({ host, mac: mac || undefined, pin });
    await device.connect();

    if (sleepMode === 'scheduled') {
      const schedule = loadSchedule();
      if (schedule.enabled) {
        const repeatCode = { daily: 0x02, weekdays: 0x03, once: 0x01 }[schedule.repeat] || 0x02;
        await device.setOnTimer({ enabled: true, repeat: repeatCode, hour: schedule.hour, minute: schedule.minute }).catch(() => {});
        console.log(`   ⏰ On Timer set: ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} (${schedule.repeat})`);
      }
      await device.setNetworkStandby({ enabled: false }).catch(() => {});
      console.log('   📡 Network standby disabled (scheduled deep sleep)');
    } else if (sleepMode === 'deep') {
      await device.setNetworkStandby({ enabled: false }).catch(() => {});
      console.log('   📡 Network standby disabled (forced deep sleep)');
    } else {
      await device.setNetworkStandby({ enabled: true }).catch(() => {});
      console.log('   📡 Network standby kept ON (manual sleep)');
    }

    await device.setPower({ power: false });
    await device.disconnect();
    console.log(`   ✅ Display powered off (${sleepMode})\n`);

    if (sleepMode === 'scheduled') {
      startWakePoller();
    }
  } catch (err) {
    console.error(`   ❌ Failed to power off: ${err.message}\n`);
  }
}


// ─── Internal push helper (used by both API and wake poller) ─────────────────

async function pushImageToDisplay({ imageBuffer, host, pin, mac }) {
  const pushId = randomUUID().toUpperCase();
  const fileId = randomUUID().toUpperCase();
  const fileName = `${fileId}.jpg`;
  const imageUrl = `http://${localIp}:${PORT}/api/display-content/${pushId}/image`;
  const contentUrl = `http://${localIp}:${PORT}/api/display-content/${pushId}/content.json`;

  console.log(`\n🖼  Push ${pushId}`);
  console.log(`   Image: ${(imageBuffer.length / 1024).toFixed(0)} KB`);
  console.log(`   Display: ${host}`);

  const imageServed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingImages.delete(pushId);
      reject(new Error('Display did not download the image within 30 seconds'));
    }, 30_000);

    pendingImages.set(pushId, {
      imageBuffer,
      contentJson: {
        schedule: [{
          start_date: '1970-01-01',
          stop_date: '2999-12-31',
          start_time: '00:00:00',
          contents: [{
            image_url: imageUrl,
            file_id: fileId,
            file_path: `/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents/${fileId}/${fileName}`,
            duration: 91326,
            file_size: `${imageBuffer.length}`,
            file_name: fileName,
          }],
        }],
        name: 'node-samsung-emdx',
        version: 1,
        create_time: new Date().toISOString().replace('T', ' ').slice(0, 19),
        id: fileId,
        program_id: 'com.samsung.ios.ePaper',
        content_type: 'ImageContent',
        deploy_type: 'MOBILE',
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
  console.log('   ✅ Content URL set, waiting for display to download...');

  await imageServed;
  console.log('   🎉 Done!');

  fs.writeFile(lastImagePath, imageBuffer, () => {});
  return pushId;
}

// ─── Wake Poller ─────────────────────────────────────────────────────────────

let wakePollerInterval = null;
let wakePollerRunning = false;

function startWakePoller() {
  if (wakePollerInterval) return;

  if (loadMode() !== 'scheduled') {
    console.log('   ℹ️  Wake poller not started (manual mode)');
    return;
  }

  const schedule = loadSchedule();
  if (!schedule.enabled) {
    console.log('   ℹ️  Wake poller not started (schedule disabled)');
    return;
  }

  console.log('   🔄 Wake poller started (checking every 30s)');
  wakePollerInterval = setInterval(pollForWake, 30_000);
}

function stopWakePoller() {
  if (wakePollerInterval) {
    clearInterval(wakePollerInterval);
    wakePollerInterval = null;
    console.log('   ℹ️  Wake poller stopped');
  }
}

async function pollForWake() {
  if (wakePollerRunning) return;
  wakePollerRunning = true;

  try {
    if (loadMode() !== 'scheduled') {
      stopWakePoller();
      return;
    }

    const { host, pin, mac } = displayDefaults;
    if (!host || !pin) return;

    try {
      const device = new Device({ host, mac: mac || undefined, pin });
      await device.connect({ timeout: 3_000 });
      await device.disconnect();
    } catch {
      return;
    }

    console.log('\n🔔 Wake poller: display is online!');
    stopWakePoller();

    const providerConfig = loadProviderConfig();
    let imageBuffer;

    if (providerConfig.sourceMode === 'provider') {
      const allProviders = getAllProviders();
      const provider = allProviders.find(p => p.id === providerConfig.activeProvider);
      if (!provider) {
        console.log('   ⚠️  Active provider not found, skipping');
        return;
      }
      console.log(`   📡 Fetching from ${provider.name}...`);
      const result = await fetchFromProvider(provider);
      console.log(`   📷 "${result.title}"`);
      imageBuffer = await downloadImage(result.imageUrl);
    } else {
      const queue = loadQueue();
      if (queue.images.length === 0) {
        console.log('   ⚠️  Queue is empty, nothing to push');
        return;
      }
      const idx = queue.currentIndex % queue.images.length;
      const entry = queue.images[idx];
      const imgPath = path.join(QUEUE_IMAGES_DIR, entry.filename);
      if (!fs.existsSync(imgPath)) {
        console.log(`   ⚠️  Queue image missing: ${entry.filename}`);
        queue.currentIndex = (idx + 1) % queue.images.length;
        saveQueue(queue);
        return;
      }
      imageBuffer = fs.readFileSync(imgPath);
      console.log(`   📷 Queue image ${idx + 1}/${queue.images.length}: ${entry.filename}`);
    }

    await pushImageToDisplay({ imageBuffer, host, pin, mac });
    console.log('   ✅ Image pushed via wake poller');

    if (providerConfig.sourceMode !== 'provider') {
      const queueAfterPush = loadQueue();
      if (queueAfterPush.images.length > 0) {
        queueAfterPush.currentIndex = (queueAfterPush.currentIndex + 1) % queueAfterPush.images.length;
        saveQueue(queueAfterPush);
      }
    }

    const sleepAfter = displayDefaults.sleepAfter ?? 20;
    if (sleepAfter > 0) {
      scheduleSleep({ host, pin, mac, minutes: sleepAfter, sleepMode: 'scheduled' });
    }
  } catch (err) {
    console.error(`   ❌ Wake poller push failed: ${err.message}`);
  } finally {
    wakePollerRunning = false;
  }
}

// Resume poller on server start if schedule is active
const startupSchedule = loadSchedule();
if (startupSchedule.enabled && loadMode() === 'scheduled') {
  console.log('📅 Resuming wake poller from saved schedule');
  startWakePoller();
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/api/defaults', (_req, res) => {
  res.json(displayDefaults);
});

app.get('/api/mode', (_req, res) => {
  res.json({ mode: loadMode() });
});

app.post('/api/mode', (req, res) => {
  const mode = req.body?.mode === 'scheduled' ? 'scheduled' : 'manual';
  saveMode(mode);

  if (mode === 'manual') {
    cancelSleepTimer();
    stopWakePoller();
  } else {
    const schedule = loadSchedule();
    if (schedule.enabled) startWakePoller();
  }

  res.json({ success: true, mode });
});

// --- Display content endpoints (called by the Samsung display) ---

app.get('/api/display-content/:id/content.json', (req, res) => {
  const entry = pendingImages.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  console.log(`  📥 Display fetching content.json for ${req.params.id}`);

  res.header('Content-Type', 'application/json');
  res.send(JSON.stringify(entry.contentJson).replaceAll('/', '\\/'));

  req.once('close', () => {
    console.log(`  ✅ content.json served`);
  });
});

app.get('/api/display-content/:id/image', (req, res) => {
  const entry = pendingImages.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  console.log(`  📥 Display downloading image for ${req.params.id}`);

  res.header('Content-Type', 'image/jpeg');
  res.send(entry.imageBuffer);

  req.once('close', () => {
    console.log(`  ✅ Image served to display`);
    pendingImages.delete(req.params.id);
    entry.resolve();
  });
});

// --- Push API (called by the web frontend) ---

app.post('/api/push', upload.single('image'), async (req, res) => {
  try {
    const { host, pin, mac } = req.body;
    const sleepAfter = parseInt(req.body.sleepAfter || '0', 10);
    const imageBuffer = req.file?.buffer;

    if (!imageBuffer) return res.status(400).json({ error: 'No image provided' });
    if (!host) return res.status(400).json({ error: 'No host provided' });
    if (!pin) return res.status(400).json({ error: 'No pin provided' });

    cancelSleepTimer();
    stopWakePoller();

    if (mac) {
      console.log('   🔄 Waking device...');
      const d = new Device({ host, mac, pin });
      await d.wakeup();
      await new Promise(r => setTimeout(r, 1000));
    }

    const pushId = await pushImageToDisplay({ imageBuffer, host, pin, mac });

    if (sleepAfter > 0) {
      const sleepMode = req.body.sleepMode || 'manual';
      scheduleSleep({ host, pin, mac, minutes: sleepAfter, sleepMode });
    }

    res.json({ success: true, pushId });
  } catch (err) {
    console.error('   ❌ Push failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/last-image', (req, res) => {
  if (!fs.existsSync(lastImagePath)) return res.status(404).end();
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'no-cache');
  fs.createReadStream(lastImagePath).pipe(res);
});

// --- Display control endpoints ---

app.get('/api/status', async (req, res) => {
  const { host, pin, mac } = req.query;
  if (!host || !pin) return res.status(400).json({ error: 'host and pin query params required' });

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

    res.json({
      power,
      battery,
      deviceName,
      serialNumber,
      softwareVersion,
      sleepTimer: sleepTimerInfo ? {
        sleepAt: sleepTimerInfo.sleepAt,
        remainingMs: Math.max(0, sleepTimerInfo.sleepAt - Date.now()),
        minutes: sleepTimerInfo.minutes,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wake', async (req, res) => {
  const { host, pin, mac } = req.body;
  if (!host && !mac) return res.status(400).json({ error: 'host or MAC address required' });

  try {
    cancelSleepTimer();
    stopWakePoller();
    let method = 'unknown';

    if (host && pin) {
      try {
        console.log(`\n⏰ Trying MDC power-on for ${host}...`);
        const device = new Device({ host, mac: mac || undefined, pin });
        await device.connect({ timeout: 5_000 });
        await device.setPower({ power: true });
        await device.disconnect();
        method = 'mdc';
        console.log(`   ✅ Display woken via MDC power-on`);
      } catch {
        console.log(`   ⚠️  MDC connection failed (display may be in deep sleep)`);
      }
    }

    if (method !== 'mdc' && mac) {
      const device = new Device({ host, mac, pin });
      await device.wakeup();
      method = 'wol';
      console.log(`   📡 Wake-on-LAN sent to ${mac}`);

      if (host && pin) {
        setTimeout(async () => {
          try {
            const d = new Device({ host, mac, pin });
            await d.connect({ timeout: 15_000 });
            await d.setNetworkStandby({ enabled: true }).catch(() => {});
            await d.disconnect();
            console.log(`   📡 Network standby re-enabled on ${host}`);
          } catch {
            // Device may not be ready yet
          }
        }, 5_000);
      }
    }

    if (method === 'unknown') {
      return res.status(400).json({ error: 'Could not wake display — no MAC for WoL and MDC failed' });
    }

    res.json({ success: true, method });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sleep', async (req, res) => {
  const { host, pin, mac, sleepMode } = req.body;
  if (!host || !pin) return res.status(400).json({ error: 'host and pin required' });

  try {
    cancelSleepTimer();
    stopWakePoller();
    await performSleep({ host, pin, mac, sleepMode: sleepMode || 'manual' });
    res.json({ success: true, mode: sleepMode || 'manual' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sleep/force', async (req, res) => {
  const { host, pin, mac } = req.body;
  if (!host || !pin) return res.status(400).json({ error: 'host and pin required' });

  try {
    saveMode('manual');
    cancelSleepTimer();
    stopWakePoller();
    await performSleep({ host, pin, mac, sleepMode: 'deep' });
    res.json({ success: true, mode: 'deep' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/poller/stop', (_req, res) => {
  saveMode('manual');
  cancelSleepTimer();
  stopWakePoller();
  console.log('🛑 Poller + sleep timer halted (switched to manual mode)');
  res.json({ success: true });
});

// --- Queue endpoints ---

app.get('/api/queue', (_req, res) => {
  const queue = loadQueue();
  res.json(queue);
});

app.post('/api/queue', upload.single('image'), (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: 'No image provided' });

  ensureQueueDir();
  const id = randomUUID();
  const filename = `${id}.jpg`;
  fs.writeFileSync(path.join(QUEUE_IMAGES_DIR, filename), req.file.buffer);

  const queue = loadQueue();
  queue.images.push({ id, filename, addedAt: new Date().toISOString() });
  saveQueue(queue);

  console.log(`📋 Queue: added image ${id} (${queue.images.length} total)`);
  res.json({ success: true, id, count: queue.images.length });
});

app.put('/api/queue/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });

  const queue = loadQueue();
  const byId = new Map(queue.images.map(img => [img.id, img]));
  const reordered = ids.map(id => byId.get(id)).filter(Boolean);
  queue.images = reordered;
  if (queue.currentIndex >= queue.images.length) queue.currentIndex = 0;
  saveQueue(queue);

  res.json({ success: true });
});

app.delete('/api/queue/:id', (req, res) => {
  const queue = loadQueue();
  const idx = queue.images.findIndex(img => img.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [removed] = queue.images.splice(idx, 1);
  if (queue.currentIndex >= queue.images.length) queue.currentIndex = 0;
  saveQueue(queue);

  const imgPath = path.join(QUEUE_IMAGES_DIR, removed.filename);
  fs.unlink(imgPath, () => {});

  console.log(`📋 Queue: removed image ${req.params.id} (${queue.images.length} remaining)`);
  res.json({ success: true });
});

app.get('/api/queue/image/:id', (req, res) => {
  const queue = loadQueue();
  const entry = queue.images.find(img => img.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  const imgPath = path.join(QUEUE_IMAGES_DIR, entry.filename);
  if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Image file missing' });

  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(imgPath).pipe(res);
});

// --- Schedule endpoints ---

app.get('/api/schedule', (_req, res) => {
  res.json(loadSchedule());
});

app.post('/api/schedule', (req, res) => {
  const { enabled, hour, minute, repeat } = req.body;
  const schedule = loadSchedule();
  if (typeof enabled === 'boolean') schedule.enabled = enabled;
  if (typeof hour === 'number') schedule.hour = Math.max(0, Math.min(23, hour));
  if (typeof minute === 'number') schedule.minute = Math.max(0, Math.min(59, minute));
  if (repeat && ['daily', 'weekdays', 'once'].includes(repeat)) schedule.repeat = repeat;
  saveSchedule(schedule);

  if (schedule.enabled) {
    startWakePoller();
  } else {
    stopWakePoller();
  }

  console.log(`📅 Schedule updated: ${schedule.enabled ? 'ON' : 'OFF'} at ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} (${schedule.repeat})`);
  res.json({ success: true, schedule });
});

// --- Provider endpoints ---

app.get('/api/providers', (_req, res) => {
  const config = loadProviderConfig();
  res.json({
    sourceMode: config.sourceMode,
    activeProvider: config.activeProvider,
    providers: getAllProviders(),
  });
});

app.put('/api/providers/active', (req, res) => {
  const { sourceMode, activeProvider } = req.body;
  const config = loadProviderConfig();
  if (sourceMode && ['queue', 'provider'].includes(sourceMode)) config.sourceMode = sourceMode;
  if (activeProvider) config.activeProvider = activeProvider;
  saveProviderConfig(config);
  res.json({ success: true });
});

app.post('/api/providers', async (req, res) => {
  const { name, feedUrl } = req.body;
  if (!name || !feedUrl) return res.status(400).json({ error: 'name and feedUrl required' });

  try {
    const testProvider = { id: 'validation', name, feedUrl, builtin: false };
    const result = await fetchFromProvider(testProvider);
    if (!result.imageUrl) {
      return res.status(400).json({ error: 'Feed parsed but no image found. Check that the feed contains image content.' });
    }
    console.log(`📡 Feed validated: "${result.title}" from ${name}`);
  } catch (err) {
    console.error(`📡 Feed validation failed for ${feedUrl}: ${err.message}`);
    return res.status(400).json({ error: `Feed validation failed: ${err.message}` });
  }

  const config = loadProviderConfig();
  const id = `custom-${randomUUID().slice(0, 8)}`;
  config.customProviders.push({ id, name, feedUrl, builtin: false });
  saveProviderConfig(config);

  console.log(`📡 Provider added: ${name} (${id})`);
  res.json({ success: true, id });
});

app.delete('/api/providers/:id', (req, res) => {
  if (BUILT_IN_PROVIDERS.some(p => p.id === req.params.id)) {
    return res.status(400).json({ error: 'Cannot delete built-in provider' });
  }
  const config = loadProviderConfig();
  config.customProviders = config.customProviders.filter(p => p.id !== req.params.id);
  if (config.activeProvider === req.params.id) config.activeProvider = 'nasa-iotd';
  saveProviderConfig(config);
  res.json({ success: true });
});

app.get('/api/providers/:id/preview', async (req, res) => {
  const allProviders = getAllProviders();
  const provider = allProviders.find(p => p.id === req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });

  try {
    const result = await fetchFromProvider(provider);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/providers/apply', async (req, res) => {
  const { host, pin, mac, sleepAfter: rawSleep, sleepMode } = req.body;
  if (!host || !pin) return res.status(400).json({ error: 'host and pin required' });

  const config = loadProviderConfig();
  const allProviders = getAllProviders();
  const provider = allProviders.find(p => p.id === config.activeProvider);
  if (!provider) return res.status(404).json({ error: 'Active provider not found' });

  try {
    const result = await fetchFromProvider(provider);
    if (!result.imageUrl) return res.status(400).json({ error: 'Provider returned no image' });

    console.log(`📡 Applying provider image: "${result.title}" from ${provider.name}`);
    const imgRes = await fetch(result.imageUrl, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

    cancelSleepTimer();
    stopWakePoller();

    if (mac) {
      const d = new Device({ host, mac, pin });
      await d.wakeup();
      await new Promise(r => setTimeout(r, 1000));
    }

    const pushId = await pushImageToDisplay({ imageBuffer, host, pin, mac });
    const sleepAfter = parseInt(rawSleep || '0', 10);
    if (sleepAfter > 0) {
      scheduleSleep({ host, pin, mac, minutes: sleepAfter, sleepMode: sleepMode || 'manual' });
    }

    res.json({ success: true, pushId, title: result.title });
  } catch (err) {
    console.error('   ❌ Provider apply failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Static frontend (production) ---

const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`\n🚀 Samsung EMDX Web Server`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIp}:${PORT}`);
  console.log(`   Display will fetch images from: ${localIp}:${PORT}\n`);
});
