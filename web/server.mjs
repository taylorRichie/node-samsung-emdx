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

function cancelSleepTimer() {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
    sleepTimerInfo = null;
    console.log('   ⏰ Sleep timer cancelled');
  }
}

function scheduleSleep({ host, pin, mac, minutes }) {
  cancelSleepTimer();
  if (!minutes || minutes <= 0) return;

  const sleepAt = Date.now() + minutes * 60_000;
  sleepTimerInfo = { sleepAt, minutes };

  console.log(`   ⏰ Display will sleep in ${minutes} minutes`);

  sleepTimer = setTimeout(async () => {
    sleepTimer = null;
    sleepTimerInfo = null;

    console.log('\n💤 Sleep timer fired — powering off display...');
    try {
      const device = new Device({ host, mac: mac || undefined, pin });
      await device.connect();
      await device.setNetworkStandby({ enabled: false }).catch(() => {});
      console.log('   📡 Network standby disabled (true deep sleep)');
      await device.setPower({ power: false });
      await device.disconnect();
      console.log('   ✅ Display powered off — use WoL to wake\n');
    } catch (err) {
      console.error(`   ❌ Failed to power off: ${err.message}\n`);
    }
  }, minutes * 60_000);
}

const app = express();
app.use(express.json());

app.get('/api/defaults', (_req, res) => {
  res.json(displayDefaults);
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
        resolve: () => {
          clearTimeout(timeout);
          resolve(undefined);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });

    const device = new Device({ host, mac: mac || undefined, pin });

    if (mac) {
      console.log('   🔄 Waking device...');
      await device.wakeup();
      await new Promise(r => setTimeout(r, 1000));
    }

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

    if (sleepAfter > 0) {
      scheduleSleep({ host, pin, mac, minutes: sleepAfter });
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
  if (!mac) return res.status(400).json({ error: 'MAC address required for Wake-on-LAN' });

  try {
    cancelSleepTimer();
    const device = new Device({ host, mac, pin });
    await device.wakeup();
    console.log(`\n⏰ Wake-on-LAN sent to ${mac}`);

    // Wait for device to boot, then re-enable network standby for MDC access
    setTimeout(async () => {
      try {
        const d = new Device({ host, mac, pin });
        await d.connect({ timeout: 15_000 });
        await d.setNetworkStandby({ enabled: true }).catch(() => {});
        await d.disconnect();
        console.log(`   📡 Network standby re-enabled on ${host}`);
      } catch {
        // Device may not be ready yet — that's fine, push will handle it
      }
    }, 5_000);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sleep', async (req, res) => {
  const { host, pin, mac } = req.body;
  if (!host || !pin) return res.status(400).json({ error: 'host and pin required' });

  try {
    cancelSleepTimer();
    const device = new Device({ host, mac: mac || undefined, pin });
    await device.connect();
    await device.setNetworkStandby({ enabled: false }).catch(() => {});
    console.log(`\n💤 Network standby disabled for ${host}`);
    await device.setPower({ power: false });
    await device.disconnect();
    console.log(`   Display powered off — use WoL to wake`);
    res.json({ success: true });
  } catch (err) {
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
