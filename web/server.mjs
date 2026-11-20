import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { Device, discover, SETTINGS } from '../lib/index.mjs';
import { fetchFromProvider, downloadImage, BUILT_IN_PROVIDERS } from './providers.mjs';
import { DEFAULT_PROFILE, PROFILES, adjustPixels, isNeutralAdjust, profileAdjust, sanitizeAdjust, sharpenOptions } from './eink.mjs';
import { sameMembers, sizedEdit, wallLayout } from './span.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const PORT = parseInt(process.env.PORT || '3001', 10);
// Identifies this process, so the address check can tell it reached us
const SERVER_ID = randomUUID();

const pendingImages = new Map();

// ─── Per-Display Storage ──────────────────────────────────────────────────────

// Where the app keeps things. By default beside this file (web/.displays and
// so on). EMDX_DATA_DIR moves the app's own data: displays, queues, groups,
// uploaded artwork (a Home Assistant add-on keeps it in /data).
// EMDX_GALLERY_DIR is the read-only artwork folder, and EMDX_CACHE_DIR holds
// thumbnails and the depth model, which can always be made again.
const fromEnv = (name, fallback) => (process.env[name] ? path.resolve(process.env[name]) : fallback);
const DISPLAYS_DIR = fromEnv('EMDX_DATA_DIR', path.join(__dirname, '.displays'));
const CACHE_DIR = fromEnv('EMDX_CACHE_DIR', null);
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

// An error that answers the request with its own status
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// A route whose thrown errors answer the request (RequestError's status, or 500)
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    if (!(err instanceof RequestError)) console.error(`   ❌ ${req.method} ${req.path}: ${err.message}`);
    if (!res.headersSent) res.status(err.status ?? 500).json({ error: err.message });
  }
};

function loadDisplays() { return readJson(DISPLAYS_JSON, []); }
function saveDisplays(displays) { ensureDisplaysDir(); writeJson(DISPLAYS_JSON, displays); }
function getDisplay(id) { return loadDisplays().find(d => d.id === id) || null; }

// Minutes a display stays awake after a push. The board and Wi-Fi run the whole
// time, so this is most of what a push costs in battery.
const DEFAULT_SLEEP_AFTER = 2;
// A display woken from the app stays up at least this long, so there's time
// to change its settings or send it something
const WAKE_MINUTES = 10;

// Network standby keeps the display's Wi-Fi listening so Wake-on-LAN works,
// at a steady battery cost. Deep sleep is the default; a display opts in by
// choosing Network standby as its sleep mode in this app.
function prefersStandby(displayId) {
  return getDisplay(displayId)?.sleepMode === 'standby';
}

// How long a push waits for a sleeping display. Wake-on-LAN brings one in
// network standby up within a minute or so; one in deep sleep needs someone
// to press its button.
const WAKE_WAIT_STANDBY_MS = 90_000;
const WAKE_WAIT_DEEP_MS = 180_000;

// Opens an MDC session, waking the display first if it's asleep. Every try
// sends Wake-on-LAN (when there's a MAC) and then connects. One that's still
// booting, or shutting down (it answers ping but refuses MDC), just gets
// another try. A wrong PIN fails straight away.
async function connectWhenAwake({ host, pin, mac, displayId, waitMs: wait }) {
  const standby = displayId ? prefersStandby(displayId) : true;
  const waitMs = wait ?? (standby ? WAKE_WAIT_STANDBY_MS : WAKE_WAIT_DEEP_MS);
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    const device = new Device({ host, mac: mac || undefined, pin });
    try {
      await device.connect({ timeout: 5_000 });
      if (attempt) console.log(`   ✅ Awake after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}`);
      return device;
    } catch (err) {
      if (/Authentication Failed/.test(err.message)) throw err;
      if (Date.now() > deadline) {
        const seconds = Math.round(waitMs / 1000);
        if (!standby) throw new Error(`The display didn't wake within ${seconds} seconds. It's in deep sleep, which can't be woken over the network: press its power button and send again, or set its sleep mode to Network standby.`);
        if (!mac) throw new Error(`The display didn't answer within ${seconds} seconds, and it has no MAC address set, so Wake-on-LAN couldn't be sent. Add its MAC address in its settings.`);
        throw new Error(`The display didn't wake within ${seconds} seconds of Wake-on-LAN. Check its MAC address in its settings, or press its power button.`);
      }
      if (attempt === 0) {
        console.log(`   💤 Asleep: ${standby && mac ? 'sending Wake-on-LAN and waiting' : 'waiting for its power button'} (up to ${Math.round(waitMs / 1000)}s)`);
      }
      if (mac) await device.wakeup().catch(() => {});
      await new Promise(r => setTimeout(r, 3_000));
    }
  }
}

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

// A schedule wakes the display at set times of day, on chosen days, or every
// so often (optionally only between two times of day). Times are this
// server's local time, which follows the time zone in Settings.
const SCHEDULE_DEFAULTS = {
  enabled: false, by: 'times', times: ['08:00'], days: [0, 1, 2, 3, 4, 5, 6],
  intervalValue: 1, intervalUnit: 'days', between: null,
  // Managed here: the next wake (epoch ms), and whether the display took the
  // wake timer last time it was set ('set' | 'refused')
  nextWakeAt: null, wakeTimer: null,
};
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const minutesOf = (t) => { const m = HHMM.exec(t ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// Older schedules held one time and a repeat: daily, weekdays or once
function migrateSchedule(saved) {
  if (saved.by !== 'time') return saved;
  const { hour = 8, minute = 0, repeat, by: _by, ...rest } = saved;
  return { ...rest, by: 'times', times: [hhmm(hour, minute)], days: repeat === 'weekdays' ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6] };
}
function loadDisplaySchedule(id) {
  return { ...SCHEDULE_DEFAULTS, ...migrateSchedule(readJson(path.join(displayDir(id), 'schedule.json'), {})) };
}
function saveDisplaySchedule(id, schedule) {
  ensureDisplayDir(id); writeJson(path.join(displayDir(id), 'schedule.json'), schedule);
}

const INTERVAL_UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 };
function scheduleIntervalMs(schedule) {
  const v = Math.max(1, Number(schedule.intervalValue) || 1);
  return v * (INTERVAL_UNIT_MS[schedule.intervalUnit] || INTERVAL_UNIT_MS.days);
}

// A day's wake times in minutes after midnight: the listed ones, or an
// interval's within its window. null for an interval with no window, which
// just rolls on from the last wake.
function wakeMinutes(schedule) {
  if (schedule.by !== 'interval') {
    return [...new Set((schedule.times ?? []).map(minutesOf).filter(m => m !== null))].sort((a, b) => a - b);
  }
  const from = minutesOf(schedule.between?.from), to = minutesOf(schedule.between?.to);
  const step = Math.round(scheduleIntervalMs(schedule) / 60_000);
  // A window within the day only applies to wakes more often than daily
  if (from === null || to === null || step >= 1440) return null;
  const end = to >= from ? to : to + 1440; // a window can run past midnight
  const out = new Set();
  for (let m = from; m <= end; m += step) out.add(m % 1440);
  return [...out].sort((a, b) => a - b);
}

// The first wake after `from` (epoch ms), or null when there isn't one
function nextWakeAfter(schedule, from = Date.now()) {
  if (!schedule.enabled) return null;
  const times = wakeMinutes(schedule);
  if (times === null) return from + scheduleIntervalMs(schedule);
  if (!times.length) return null;
  const days = schedule.days?.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (days.includes(day.getDay())) {
      for (const m of times) {
        const t = new Date(day);
        t.setHours(Math.floor(m / 60), m % 60, 0, 0);
        if (t.getTime() > from) return t.getTime();
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

function upcomingWakes(schedule, count) {
  const out = [];
  let t = schedule.nextWakeAt && schedule.nextWakeAt > Date.now() ? schedule.nextWakeAt : nextWakeAfter(schedule);
  while (t && out.length < count) {
    out.push(t);
    t = nextWakeAfter(schedule, t);
  }
  return out;
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

// ─── App settings ─────────────────────────────────────────────────────────────
// Set from the web UI and stored alongside the displays.

const APP_SETTINGS_JSON = path.join(DISPLAYS_DIR, 'app-settings.json');

function loadAppSettings() {
  return readJson(APP_SETTINGS_JSON, {});
}

// Wake timers are set from server-local time, so the process runs in the
// user's zone. Node picks up a change to TZ at runtime.
function applyTimeZone() {
  const { timeZone } = loadAppSettings();
  if (timeZone) process.env.TZ = timeZone;
}
applyTimeZone();

// This machine's LAN address, or null if it can't be known: inside Docker's
// bridge network the only address is the container's own, which the display
// can't reach.
function detectAddress(displayHost) {
  const addresses = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(lo|docker|br-|veth|utun|tun|awdl|llw|bridge)/.test(name))
    .flatMap(([, list]) => list.filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address));

  const isBridged = fs.existsSync('/.dockerenv')
    && addresses.every(a => /^(172\.(1[6-9]|2\d|3[01])\.|192\.168\.65\.)/.test(a));
  if (isBridged) return null;

  const subnet = (ip) => ip.split('.').slice(0, 3).join('.');
  return addresses.find(a => displayHost && subnet(a) === subnet(displayHost)) ?? addresses[0] ?? null;
}

// Where a display should fetch pushed images from
function serverAddress(displayHost) {
  return loadAppSettings().serverAddress || detectAddress(displayHost);
}

// ─── Migration from single-display .queue/ ────────────────────────────────────

function migrateFromSingleDisplay() {
  if (fs.existsSync(DISPLAYS_JSON)) return;

  const oldQueueDir = path.join(__dirname, '.queue');
  const oldLastImage = path.join(__dirname, '.last-push.jpg');

  if (!fs.existsSync(oldQueueDir)) {
    ensureDisplaysDir();
    saveDisplays([]);
    return;
  }

  const id = randomUUID();
  const display = {
    id, name: 'Display 1', host: '', pin: '', mac: '', sleepAfter: DEFAULT_SLEEP_AFTER,
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

// MDC sessions in progress, per display. The display takes one connection at a
// time, so the background check leaves a display alone while it's busy.
const busy = new Map();
async function withBusy(displayId, task) {
  busy.set(displayId, (busy.get(displayId) ?? 0) + 1);
  try {
    return await task();
  } finally {
    const n = (busy.get(displayId) ?? 1) - 1;
    if (n > 0) busy.set(displayId, n);
    else busy.delete(displayId);
  }
}

// A route handler that holds the display's session while it runs
const busyRoute = handler => (req, res) => withBusy(req.params.displayId, () => handler(req, res));

// When each display was last sent to sleep. It stays reachable for a couple of
// minutes while it shuts down, which the background check mustn't mistake for
// it waking up again.
const lastSleep = new Map();

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

async function performSleep(displayId, options) {
  lastSleep.set(displayId, Date.now());
  return withBusy(displayId, () => sleepDisplay(displayId, options));
}

async function sleepDisplay(displayId, { host, pin, mac, sleepMode }) {
  console.log(`\n💤 [${displayId.slice(0, 8)}] Performing ${sleepMode} sleep...`);
  try {
    const device = new Device({ host, mac: mac || undefined, pin });
    try {
      await device.connect();
    } catch (err) {
      // "Sleep when content finishes" usually gets there first. Refused means
      // it's shutting down, a timeout that it's already off; either way the
      // sleep mode it uses was set when the image was sent.
      if (err.code === 'ECONNREFUSED' || /timed out/i.test(err.message)) {
        console.log('   ✅ Already asleep');
        noteStatus(displayId, null);
        return;
      }
      throw err;
    }

    if (sleepMode === 'scheduled') {
      await armWakeTimer(device, displayId, mac);
      await device.setNetworkStandby({ enabled: prefersStandby(displayId) }).catch(() => {});
    } else if (sleepMode === 'deep') {
      await device.setNetworkStandby({ enabled: false }).catch(() => {});
    } else {
      await device.setNetworkStandby({ enabled: prefersStandby(displayId) }).catch(() => {});
    }

    recordBattery(displayId, await device.getBatteryState().catch(() => null), 'sleep');
    await device.setPower({ power: false });
    await device.disconnect();
    console.log(`   ✅ Display powered off (${sleepMode})`);
    noteStatus(displayId, null);
  } catch (err) {
    console.error(`   ❌ Failed to power off: ${err.message}`);
  }
}

// A display this server can't wake over the network (deep sleep, or no MAC
// address) gets its own wake timer set for the schedule's next time.
// Firmware 1130.7 refuses that timer; the schedule notes it, so the app can
// say the display won't wake by itself.
async function armWakeTimer(device, displayId, mac) {
  const schedule = loadDisplaySchedule(displayId);
  if (!schedule.enabled || !schedule.nextWakeAt || loadDisplayMode(displayId) !== 'scheduled') return;
  if (prefersStandby(displayId) && mac) return;
  const d = new Date(schedule.nextWakeAt);
  let wakeTimer = 'set';
  try {
    await device.setOnTimer({ enabled: true, repeat: 0x02, hour: d.getHours(), minute: d.getMinutes() });
    console.log(`   ⏰ Wake timer: ${hhmm(d.getHours(), d.getMinutes())}`);
  } catch {
    wakeTimer = 'refused';
    console.log('   ⚠️  The display refused its wake timer, so it won\'t wake by itself');
  }
  const fresh = loadDisplaySchedule(displayId);
  if (fresh.wakeTimer !== wakeTimer) saveDisplaySchedule(displayId, { ...fresh, wakeTimer });
}

// ─── Push Helpers ─────────────────────────────────────────────────────────────

function pushImageToDisplay(options) {
  return options.displayId ? withBusy(options.displayId, () => pushImageNow(options)) : pushImageNow(options);
}

async function pushImageNow({ imageBuffer, host, pin, mac, displayId, lastImageBuffer, wakeWaitMs }) {
  const address = serverAddress(host);
  if (!address) throw new Error("This server's address isn't set, so the display can't download images. Add it in Settings (gear icon, top right).");

  const pushId = randomUUID().toUpperCase();
  const fileId = randomUUID().toUpperCase();
  const fileName = `${fileId}.jpg`;
  const imageUrl = `http://${address}:${PORT}/api/display-content/${pushId}/image`;
  const contentUrl = `http://${address}:${PORT}/api/display-content/${pushId}/content.json`;

  const tag = displayId ? ` [${displayId.slice(0, 8)}]` : '';
  console.log(`\n🖼  Push ${pushId}${tag}`);
  console.log(`   Image: ${(imageBuffer.length / 1024).toFixed(0)} KB → ${host}`);

  // Started once the display has been told to download: waking it can take
  // minutes, the download itself only seconds
  let downloadTimer;
  const imageServed = new Promise((resolve, reject) => {
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
      resolve: () => { clearTimeout(downloadTimer); resolve(undefined); },
      reject: (err) => { clearTimeout(downloadTimer); reject(err); },
    });
  });
  // Awaited below. A push that fails before then rejects it with nobody
  // listening, which would otherwise crash the server and lose every pending
  // sleep timer.
  imageServed.catch(() => {});

  let device = null;
  let battery = null;
  try {
    console.log('   🔄 Connecting...');
    device = await connectWhenAwake({ host, pin, mac, displayId, waitMs: wakeWaitMs });
    console.log('   ✅ Connected');
    // Also the mode the display uses if its own sleep timer fires first
    await device.setNetworkStandby({ enabled: displayId ? prefersStandby(displayId) : true }).catch(() => {});
    battery = await device.getBatteryState().catch(() => null);
    // Start the entry at the display's current minute, or a display holding a
    // newer entry won't draw it. Its clock is set right first if it's out.
    const { start, clock } = await readDisplayClock(device, { sync: loadAppSettings().syncClocks !== false });
    Object.assign(pendingImages.get(pushId)?.contentJson.schedule[0] ?? {}, start);
    if (displayId) noteStatus(displayId, { clock });
    console.log(`   🗓  Entry starts ${start.start_date} ${start.start_time}`);
    console.log(`   🔄 Setting content download → ${contentUrl}`);
    await device.setContentDownload({ url: contentUrl });
    await device.disconnect();
  } catch (err) {
    pendingImages.get(pushId)?.reject(err);
    pendingImages.delete(pushId);
    await device?.disconnect().catch(() => {});
    throw err;
  }
  downloadTimer = setTimeout(() => {
    pendingImages.get(pushId)?.reject(new Error(`Display did not download the image within 30 seconds. It was told to fetch from ${address}:${PORT}, so check that's this server's current address in Settings (gear icon, top right).`));
    pendingImages.delete(pushId);
  }, 30_000);
  recordBattery(displayId, battery, 'push');
  console.log('   ✅ Waiting for display to download...');
  await imageServed;
  console.log('   🎉 Done!');

  // last-push.jpg stores the PRESENTATION image (file orientation) — the
  // payload may carry an extra calibration rotation the previews shouldn't see
  if (displayId) {
    const lastPath = getDisplayLastImagePath(displayId);
    noteStatus(displayId, battery ? { battery } : {});
    // Broadcast the push only once the new image is on disk — otherwise
    // clients refetch the thumbnail and get the previous bytes
    fs.writeFile(lastPath, lastImageBuffer ?? imageBuffer, () => notePush(displayId));
  }
  return pushId;
}

// ─── Display clock ───────────────────────────────────────────────────────────
// The display keeps its own time, to the minute, and that time decides when a
// sent image starts. readDisplayClock reads it against this server's clock.
// With sync, one more than a minute and a half out is set to this server's
// time, as Samsung's app does at the start of every session.

const pad2 = n => String(n).padStart(2, '0');
const localStamp = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function clockToDate(c) {
  const valid = c && c.year >= 2020 && c.month >= 1 && c.month <= 12 && c.day >= 1 && c.day <= 31
    && c.hour >= 0 && c.hour <= 12 && c.minute >= 0 && c.minute <= 59;
  return valid ? new Date(c.year, c.month - 1, c.day, (c.hour % 12) + (c.pm ? 12 : 0), c.minute) : null;
}

async function readDisplayClock(device, { sync = false } = {}) {
  const c = await device.getSetting('clock').catch(() => null);
  const shown = clockToDate(c);
  const now = new Date();
  // Whole minutes on the display, so anything under a minute is rounding
  const drift = shown ? Math.round((shown.getTime() - now.getTime()) / 1000) : null;
  let synced = false;
  if (sync && (drift === null || Math.abs(drift) >= 90)) {
    try {
      await device.setSetting('clock', 'now');
      synced = true;
      console.log(`   🕑 Clock was ${drift === null ? 'unreadable' : `${Math.round(drift / 60)} min out`}; set to ${now.toLocaleTimeString()}`);
    } catch { /* it keeps its own time */ }
  }
  const at = synced || !shown ? new Date() : shown;
  return {
    start: { start_date: `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`, start_time: `${pad2(at.getHours())}:${pad2(at.getMinutes())}:00` },
    clock: {
      // The display's own reading, as local time, and how far it was from this server
      time: shown ? localStamp(shown) : null,
      drift: synced ? 0 : drift,
      ...(synced ? { syncedFrom: drift } : {}),
      checkedAt: Date.now(),
    },
  };
}

// ─── Current image source + edit (non-destructive) ──────────────────────────
// last-push.jpg is the RENDERED presentation (for thumbnails/history). The
// original art and its transform are kept separately so the editor always
// reworks the original — repositioning is never baked into the source.

function currentSourcePath(id) { return path.join(displayDir(id), 'current-source.jpg'); }
function currentEditPath(id) { return path.join(displayDir(id), 'current-edit.json'); }

function setCurrentSource(displayId, buffer, edit = null) {
  try {
    ensureDisplayDir(displayId);
    fs.writeFileSync(currentSourcePath(displayId), buffer);
    writeJson(currentEditPath(displayId), { edit });
  } catch { /* best effort */ }
}

function setCurrentEdit(displayId, edit) {
  try { ensureDisplayDir(displayId); writeJson(currentEditPath(displayId), { edit }); }
  catch { /* best effort */ }
}

function getCurrentEdit(displayId) {
  return readJson(currentEditPath(displayId), { edit: null }).edit ?? null;
}

async function applyOutputRotation(imageBuffer, outputRotation) {
  const raw = Number(outputRotation);
  const normalized = Number.isFinite(raw) ? ((raw % 360) + 360) % 360 : 0;
  if (normalized === 0) return imageBuffer;
  return sharp(imageBuffer).rotate(normalized).jpeg({ quality: 85 }).toBuffer();
}

// Push a presentation image (file orientation = up). The display's calibration
// (upRotation) is applied to the device payload only — previews stay honest.
async function pushPresentation(displayId, { host, pin, mac }, presentationBuffer, { wakeWaitMs } = {}) {
  const display = getDisplay(displayId);
  const up = Number.isFinite(display?.upRotation) ? display.upRotation : 0;
  const payload = await applyOutputRotation(presentationBuffer, up);
  return pushImageToDisplay({ imageBuffer: payload, host, pin, mac, displayId, lastImageBuffer: presentationBuffer, wakeWaitMs });
}

// ─── Delivery queue ──────────────────────────────────────────────────────────
// Every image bound for a display goes through here, and is kept on disk
// until the display has it. The first attempt wakes the display if it can. A
// display that can't be reached keeps its image waiting: it goes out as soon
// as the display is seen awake (the background check, its button, its own
// wake timer) or on the next timed retry, which sends Wake-on-LAN again. One
// image waits per display: a newer one replaces one that hasn't gone yet.
// Errors that retrying can't fix, like a wrong PIN, stop until a setting
// changes or someone retries.

const RETRY_STEPS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000];
// How long an attempt waits for a display it can't wake (deep sleep, or no MAC
// address): long enough to catch one whose button was just pressed
const UNWAKEABLE_WAIT_MS = 20_000;

const deliveryRuns = new Map();   // displayId → the running attempt loop
const deliveryTimers = new Map(); // displayId → next timed retry
const firstAttempts = new Map();  // deliveryId → resolve, for callers waiting on it

function outboxDir(id) { return path.join(displayDir(id), 'outbox'); }
function outboxImage(id, deliveryId) { return path.join(outboxDir(id), `${path.basename(deliveryId)}.jpg`); }
function loadDelivery(id) { return readJson(path.join(outboxDir(id), 'delivery.json'), null); }

const publicDelivery = (d) => d && {
  id: d.id, label: d.label, source: d.source, state: d.state, attempts: d.attempts,
  createdAt: d.createdAt, lastAttemptAt: d.lastAttemptAt, nextAttemptAt: d.nextAttemptAt, error: d.error,
};

function saveDelivery(displayId, delivery) {
  writeJson(path.join(outboxDir(displayId), 'delivery.json'), delivery);
  sseBroadcast({ type: 'delivery', displayId, delivery: publicDelivery(delivery) });
}

// Saves an attempt's progress, unless a newer image has taken its place
function updateDelivery(displayId, delivery) {
  if (loadDelivery(displayId)?.id === delivery.id) saveDelivery(displayId, delivery);
}

function clearDelivery(displayId, deliveryId = null) {
  const current = loadDelivery(displayId);
  if (deliveryId) fs.rmSync(outboxImage(displayId, deliveryId), { force: true });
  if (!current || (deliveryId && current.id !== deliveryId)) return;
  fs.rmSync(path.join(outboxDir(displayId), 'delivery.json'), { force: true });
  fs.rmSync(outboxImage(displayId, current.id), { force: true });
  clearTimeout(deliveryTimers.get(displayId));
  deliveryTimers.delete(displayId);
  sseBroadcast({ type: 'delivery', displayId, delivery: null });
}

const hasWaitingDelivery = (id) => ['pending', 'sending'].includes(loadDelivery(id)?.state);

function settleFirstAttempt(deliveryId, outcome) {
  const resolve = firstAttempts.get(deliveryId);
  if (resolve) { firstAttempts.delete(deliveryId); resolve(outcome); }
}

/**
 * Queues an image for a display and starts sending it. Resolves once the
 * first attempt is over, or at once with wait: false, as
 * { state: 'delivered' | 'queued' | 'failed', delivery, message }.
 * opts: { label, source, sleepAfter (minutes, else the display's own),
 *         sleepMode (else what the display's mode calls for), wait }
 */
async function deliver(displayId, buffer, opts = {}) {
  const previous = loadDelivery(displayId);
  const delivery = {
    id: randomUUID(), createdAt: Date.now(), label: opts.label ?? null, source: opts.source ?? 'push',
    state: 'pending', attempts: 0, lastAttemptAt: null, nextAttemptAt: Date.now(), error: null,
    sleepAfter: Number.isInteger(opts.sleepAfter) ? opts.sleepAfter : null, sleepMode: opts.sleepMode ?? null,
  };
  fs.mkdirSync(outboxDir(displayId), { recursive: true });
  fs.writeFileSync(outboxImage(displayId, delivery.id), buffer);
  saveDelivery(displayId, delivery);
  if (previous) {
    if (previous.state !== 'sending') fs.rmSync(outboxImage(displayId, previous.id), { force: true });
    settleFirstAttempt(previous.id, { state: 'replaced', delivery: publicDelivery(previous), message: 'A newer image replaced this one before it was sent' });
  }
  const outcome = new Promise(resolve => firstAttempts.set(delivery.id, resolve));
  kickDelivery(displayId);
  if (opts.wait === false) return { state: 'queued', delivery: publicDelivery(delivery), message: 'Queued' };
  return outcome;
}

// Starts (or joins) the attempt loop for a display. now: the display was just
// seen awake, so a timed wait is skipped.
function kickDelivery(displayId, { now = false } = {}) {
  if (now) {
    const d = loadDelivery(displayId);
    if (d?.state === 'pending' && d.nextAttemptAt > Date.now()) saveDelivery(displayId, { ...d, nextAttemptAt: Date.now() });
  }
  if (deliveryRuns.has(displayId)) return deliveryRuns.get(displayId);
  clearTimeout(deliveryTimers.get(displayId));
  deliveryTimers.delete(displayId);
  const run = runDeliveries(displayId)
    .catch(err => console.error(`   ❌ [${displayId.slice(0, 8)}] Delivery: ${err.message}`))
    .finally(() => deliveryRuns.delete(displayId));
  deliveryRuns.set(displayId, run);
  return run;
}

async function runDeliveries(displayId) {
  for (;;) {
    const delivery = loadDelivery(displayId);
    if (!delivery || delivery.state === 'failed') return;
    const display = getDisplay(displayId);
    if (!display) { clearDelivery(displayId); return; }
    if (delivery.state === 'pending' && delivery.nextAttemptAt > Date.now()) {
      const wait = delivery.nextAttemptAt - Date.now();
      deliveryTimers.set(displayId, setTimeout(() => kickDelivery(displayId), wait));
      return;
    }
    await attemptDelivery(displayId, display, delivery);
    const after = loadDelivery(displayId);
    // Stop once nothing is waiting, or this one is waiting for its retry; go
    // round again for a newer image that arrived during the attempt
    if (!after || (after.id === delivery.id && after.state !== 'sending')) {
      if (after?.state === 'pending') deliveryTimers.set(displayId, setTimeout(() => kickDelivery(displayId), after.nextAttemptAt - Date.now()));
      return;
    }
  }
}

class NeedsAttention extends Error {}

function describeFailure(err, displayId, display) {
  const msg = err.message || String(err);
  if (err instanceof NeedsAttention) return { retry: false, message: msg };
  if (/Authentication Failed: Blocked/.test(msg)) return { retry: false, message: 'The display is refusing connections after wrong PINs. Check the PIN in its settings, then retry.' };
  if (/Authentication Failed/.test(msg)) return { retry: false, message: 'The display rejected the PIN. Fix it in its settings, then retry.' };
  if (/address isn't set/.test(msg)) return { retry: false, message: msg };
  if (/did not download/.test(msg)) return { retry: true, message: msg };
  if (prefersStandby(displayId) && display.mac) return { retry: true, message: "It didn't answer Wake-on-LAN yet. Trying again shortly." };
  if (prefersStandby(displayId)) return { retry: true, message: "Asleep, and it has no MAC address, so it can't be woken over the network. It gets the image when it next wakes, or add its MAC address in its settings." };
  return { retry: true, message: "Asleep in deep sleep, which can't be woken over the network. It gets the image when it next wakes: press its power button, or wait for its own wake." };
}

async function attemptDelivery(displayId, display, delivery) {
  const first = delivery.attempts === 0;
  Object.assign(delivery, { state: 'sending', attempts: delivery.attempts + 1, lastAttemptAt: Date.now(), error: null });
  updateDelivery(displayId, delivery);
  const { host, pin, mac } = display;
  const tag = `[${displayId.slice(0, 8)}]`;
  try {
    if (!host || !pin) throw new NeedsAttention('It has no IP address or PIN yet. Add them in its settings.');
    const buffer = fs.readFileSync(outboxImage(displayId, delivery.id));
    cancelSleepTimer(displayId);
    const canWake = prefersStandby(displayId) && !!mac;
    const wakeWaitMs = canWake ? (first ? WAKE_WAIT_STANDBY_MS : 60_000) : (first ? UNWAKEABLE_WAIT_MS : 8_000);
    await pushPresentation(displayId, { host, pin, mac }, buffer, { wakeWaitMs });

    clearDelivery(displayId, delivery.id);
    console.log(`   📬 ${tag} Delivered "${delivery.label ?? delivery.source}" after ${delivery.attempts} attempt${delivery.attempts === 1 ? '' : 's'}`);
    sseBroadcast({ type: 'delivered', displayId, delivery: publicDelivery({ ...delivery, state: 'delivered' }) });
    settleFirstAttempt(delivery.id, { state: 'delivered', delivery: publicDelivery({ ...delivery, state: 'delivered' }) });
    const minutes = delivery.sleepAfter ?? awakeMinutes(getDisplay(displayId) ?? display);
    if (minutes > 0) scheduleSleep(displayId, { host, pin, mac, minutes, sleepMode: delivery.sleepMode ?? sleepModeFor(displayId) });
  } catch (err) {
    const { retry, message } = describeFailure(err, displayId, display);
    // Couldn't connect at all: it's asleep or out of reach, whatever the last check said
    if (retry && !/did not download/.test(err.message)) noteStatus(displayId, null);
    const step = RETRY_STEPS_MS[Math.min(delivery.attempts - 1, RETRY_STEPS_MS.length - 1)];
    Object.assign(delivery, retry
      ? { state: 'pending', nextAttemptAt: Date.now() + step, error: message }
      : { state: 'failed', nextAttemptAt: null, error: message });
    updateDelivery(displayId, delivery);
    console.log(`   📭 ${tag} ${retry ? `Waiting, retry in ${Math.round(step / 1000)}s` : 'Stopped'}: ${message}`);
    settleFirstAttempt(delivery.id, { state: retry ? 'queued' : 'failed', delivery: publicDelivery(delivery), message });
  }
}

// After a setting that could fix a stopped delivery changes: try it again
function retryStopped(displayId = null) {
  for (const d of displayId ? [getDisplay(displayId)].filter(Boolean) : loadDisplays()) {
    const delivery = loadDelivery(d.id);
    if (delivery?.state !== 'failed') continue;
    saveDelivery(d.id, { ...delivery, state: 'pending', attempts: 0, nextAttemptAt: Date.now(), error: null });
    kickDelivery(d.id);
  }
}

// Answers a send: 200 when the display has it, 202 when it's queued for later
function sendOutcome(res, outcome, extra = {}) {
  const { state, delivery, message } = outcome;
  if (state === 'delivered') return res.json({ success: true, delivered: true, ...extra });
  if (state === 'queued' || state === 'replaced') {
    return res.status(202).json({ success: true, delivered: false, queued: state === 'queued', message, delivery, ...extra });
  }
  return res.status(502).json({ error: message, delivered: false, delivery, ...extra });
}

// Presentation override renderer. Three modes:
//  - crop (default/legacy): rotate, then crop in the rotated image's pixel
//    space (react-easy-crop convention)
//  - fit: rotate, scale (contain × zoom — zoom < 1 shrinks the art), position
//    by normalized offset, letterbox with `bg`
//  - stretch: rotate, then force-fill the display frame ignoring aspect
function frameDims(display) {
  return frameOrientation(display) === 'landscape' ? [2560, 1440] : [1440, 2560];
}

// Tone/color adjustment (same per-pixel math as the editor preview), then an
// optional unsharp mask at output resolution. Returns a sharp pipeline.
async function adjusted(img, adjust) {
  if (isNeutralAdjust(adjust)) return img;
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  adjustPixels(data, 4, adjust);
  const out = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
  const sharpen = sharpenOptions(adjust.sharpen);
  return sharpen ? out.sharpen(sharpen) : out;
}

// The image's own look, or the default profile for one that never chose
function toneFor(edit) {
  return edit?.adjust ?? profileAdjust(loadAppSettings().defaultProfile);
}

// How an image with no layout of its own is sized to the panel: 'fit' shows
// all of it, with bars of `background` around it; 'fill' covers the panel and
// crops what's over; 'stretch' fills it ignoring proportions
const FITS = ['fit', 'fill', 'stretch'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function fitFor({ fit, background } = {}) {
  const settings = loadAppSettings();
  return {
    fit: FITS.includes(fit) ? fit : FITS.includes(settings.imageFit) ? settings.imageFit : 'fit',
    background: HEX_COLOR.test(background ?? '') ? background : HEX_COLOR.test(settings.imageBackground ?? '') ? settings.imageBackground : '#000000',
  };
}

// An image as it comes in (any format, rotated by its EXIF), as a JPEG in its
// own orientation. Overly large ones are brought down to a sensible size.
async function normalizeImage(buffer, { maxSide = 8192 } = {}) {
  return sharp(buffer).rotate()
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92 }).toBuffer();
}

// Everything bound for the panel comes through here, so an image gets the
// default profile however it arrived, and leaves at the panel's exact size.
// Calibration images skip it on purpose. sizing: { fit, background } for an
// image with no edit of its own; the app's settings otherwise.
async function applyQueueEdit(buffer, edit, display = null, sizing = {}) {
  const adjust = !edit && sizing.profile ? profileAdjust(sizing.profile) : toneFor(edit);
  if (!edit) {
    // Sized first because sharpening is meant to happen at output resolution
    const [FW, FH] = frameDims(display);
    const { fit, background } = fitFor(sizing);
    if (fit !== 'fit') {
      const sized = sharp(buffer).rotate().resize(FW, FH, { fit: fit === 'fill' ? 'cover' : 'fill' });
      return (await adjusted(sized, adjust)).removeAlpha().jpeg({ quality: 90 }).toBuffer();
    }
    // Tone the art, not the bars around it
    const inside = await (await adjusted(sharp(buffer).rotate().resize(FW, FH, { fit: 'inside' }), adjust)).removeAlpha().png().toBuffer();
    return sharp({ create: { width: FW, height: FH, channels: 3, background } })
      .composite([{ input: inside, gravity: 'centre' }])
      .jpeg({ quality: 90 }).toBuffer();
  }
  const bg = /^#[0-9a-fA-F]{6}$/.test(edit.bg || '') ? edit.bg : '#000000';
  const rot = Number.isFinite(edit.rotation) ? ((edit.rotation % 360) + 360) % 360 : 0;
  const mode = ['fit', 'stretch', 'transform'].includes(edit.mode) ? edit.mode : 'crop';

  if (mode === 'transform') {
    const [FW, FH] = frameDims(display);
    return (await transformOnto(buffer, edit, FW, FH, adjust)).jpeg({ quality: 88 }).toBuffer();
  }

  let buf = buffer;
  if (rot) buf = await sharp(buf).rotate(rot, { background: bg }).jpeg({ quality: 92 }).toBuffer();
  if (!isNeutralAdjust(adjust)) buf = await (await adjusted(sharp(buf), adjust)).removeAlpha().jpeg({ quality: 92 }).toBuffer();

  if (mode === 'crop') {
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

  const [FW, FH] = frameDims(display);
  if (mode === 'stretch') {
    return sharp(buf).resize(FW, FH, { fit: 'fill' }).jpeg({ quality: 88 }).toBuffer();
  }


  // fit
  const meta = await sharp(buf).metadata();
  const zoom = Number.isFinite(edit.zoom) && edit.zoom > 0 ? edit.zoom : 1;
  const off = edit.offset && Number.isFinite(edit.offset.x) && Number.isFinite(edit.offset.y)
    ? edit.offset : { x: 0, y: 0 };
  const scale = Math.min(FW / meta.width, FH / meta.height) * zoom;
  const sw = Math.max(1, Math.round(meta.width * scale));
  const sh = Math.max(1, Math.round(meta.height * scale));
  const left = Math.round((FW - sw) / 2 + off.x * FW);
  const top = Math.round((FH - sh) / 2 + off.y * FH);

  // Clip the scaled art to its intersection with the frame before compositing
  const sx = Math.max(0, -left), sy = Math.max(0, -top);
  const vw = Math.min(sw - sx, FW - Math.max(0, left));
  const vh = Math.min(sh - sy, FH - Math.max(0, top));
  const canvas = sharp({ create: { width: FW, height: FH, channels: 3, background: bg } });
  if (vw <= 0 || vh <= 0) return canvas.jpeg({ quality: 88 }).toBuffer();

  const scaled = await sharp(buf).resize(sw, sh, { fit: 'fill' })
    .extract({ left: sx, top: sy, width: vw, height: vh }).toBuffer();
  return canvas
    .composite([{ input: scaled, left: Math.max(0, left), top: Math.max(0, top) }])
    .jpeg({ quality: 88 }).toBuffer();
}

// Free transform onto an FW × FH canvas: scale the source to (scaleX·FW ×
// scaleY·FH), rotate, then place its center at frame center + offset,
// mirroring the editor. The canvas is one display's frame, or a whole group's
// wall when an image spans several. Returns the unencoded pipeline.
async function transformOnto(buffer, edit, FW, FH, adjust) {
  const bg = /^#[0-9a-fA-F]{6}$/.test(edit.bg || '') ? edit.bg : '#000000';
  const rot = Number.isFinite(edit.rotation) ? ((edit.rotation % 360) + 360) % 360 : 0;
  const sX = Number.isFinite(edit.scaleX) && edit.scaleX > 0 ? edit.scaleX : 1;
  const sY = Number.isFinite(edit.scaleY) && edit.scaleY > 0 ? edit.scaleY : sX;
  const o = edit.offset && Number.isFinite(edit.offset.x) && Number.isFinite(edit.offset.y)
    ? edit.offset : { x: 0, y: 0 };
  const sw0 = Math.max(1, Math.round(FW * sX));
  const sh0 = Math.max(1, Math.round(FH * sY));
  const sized = await adjusted(sharp(buffer).resize(sw0, sh0, { fit: 'fill' }), adjust);
  let art = await sized.ensureAlpha().png().toBuffer();

  // Corner radius (dest-in mask) and border (stroked overlay), both in
  // display pixels — the same units the editor sidebar shows
  const radius = Math.max(0, Math.min(Number(edit.radius) || 0, Math.min(sw0, sh0) / 2));
  const border = edit.border && /^#[0-9a-fA-F]{6}$/.test(edit.border.color || '') && edit.border.width > 0
    ? { color: edit.border.color, width: Math.min(edit.border.width, 200) } : null;
  if (radius > 0 || border) {
    const composites = [];
    if (radius > 0) {
      const mask = Buffer.from(
        `<svg width="${sw0}" height="${sh0}"><rect width="${sw0}" height="${sh0}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`);
      composites.push({ input: mask, blend: 'dest-in' });
    }
    if (border) {
      const bw2 = border.width;
      const stroke = Buffer.from(
        `<svg width="${sw0}" height="${sh0}"><rect x="${bw2 / 2}" y="${bw2 / 2}" width="${sw0 - bw2}" height="${sh0 - bw2}" rx="${Math.max(0, radius - bw2 / 2)}" ry="${Math.max(0, radius - bw2 / 2)}" fill="none" stroke="${border.color}" stroke-width="${bw2}"/></svg>`);
      composites.push({ input: stroke, blend: 'over' });
    }
    art = await sharp(art).composite(composites).png().toBuffer();
  }

  if (rot) art = await sharp(art).rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const m = await sharp(art).metadata();
  const left = Math.round(FW / 2 + o.x * FW - m.width / 2);
  const top = Math.round(FH / 2 + o.y * FH - m.height / 2);
  const sx2 = Math.max(0, -left), sy2 = Math.max(0, -top);
  const vw = Math.min(m.width - sx2, FW - Math.max(0, left));
  const vh = Math.min(m.height - sy2, FH - Math.max(0, top));
  const canvas = sharp({ create: { width: FW, height: FH, channels: 3, background: bg } });
  if (vw <= 0 || vh <= 0) return canvas;
  const clipped = await sharp(art).extract({ left: sx2, top: sy2, width: vw, height: vh }).toBuffer();
  return canvas.composite([{ input: clipped, left: Math.max(0, left), top: Math.max(0, top) }]);
}

// Queues the queue's next image (or a given one) for the display. The queue
// moves on straight away, whether or not the display can be reached yet.
// opts: { source, wait, fit, background }
async function pushNextQueueImage(displayId, imageId = null, opts = {}) {
  const display = getDisplay(displayId);
  const queue = loadDisplayQueue(displayId);
  if (queue.images.length === 0) throw new RequestError('The queue is empty', 409);

  const idx = imageId
    ? queue.images.findIndex(img => img.id === imageId)
    : queue.currentIndex % queue.images.length;
  if (idx === -1) throw new RequestError('That image is not in the queue', 404);
  const entry = queue.images[idx];
  const imgPath = path.join(displayImagesDir(displayId), entry.filename);
  if (!fs.existsSync(imgPath)) {
    queue.currentIndex = (idx + 1) % queue.images.length;
    saveDisplayQueue(displayId, queue);
    throw new Error(`Queue image missing: ${entry.filename}`);
  }

  const originalBuffer = fs.readFileSync(imgPath);
  setCurrentSource(displayId, originalBuffer, entry.edit ?? null);
  const rendered = await applyQueueEdit(originalBuffer, entry.edit, display, opts);

  // Rotation continues from the image that was just sent
  queue.currentIndex = (idx + 1) % queue.images.length;
  saveDisplayQueue(displayId, queue);

  const label = entry.source ? galleryTitle(String(entry.source).split('/').pop()) : `Queue image ${idx + 1} of ${queue.images.length}`;
  const outcome = await deliver(displayId, rendered, { label, source: opts.source ?? 'queue', wait: opts.wait });
  return { entry, index: idx + 1, total: queue.images.length, outcome };
}

// ─── Status cache + event stream ─────────────────────────────────────────────
// The server is the single source of truth for display state: every MDC
// interaction (poller probe, push, sleep, status read) updates this cache,
// and connected clients receive changes over SSE — so every open browser
// shows the same reality without issuing its own MDC probes.

const statusCache = new Map(); // displayId → { status: object|null, updatedAt }
const sseClients = new Set();
// Displays that didn't answer last time. The sweep leaves them alone: in deep
// sleep they can't answer, and in network standby a probe may wake the Wi-Fi.
// Anything that reaches the display again (a push, a wake, a status refresh,
// the wake poller) clears this through noteStatus.
const unreachable = new Set();

function sseBroadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* dropped client; close handler cleans up */ }
  }
}

// status: object (reachable, merged over previous fields) or null (unreachable)
function noteStatus(displayId, status) {
  if (status === null) unreachable.add(displayId);
  else unreachable.delete(displayId);
  // Awake: an image waiting for it can go now
  if (status !== null && !deliveryRuns.has(displayId) && hasWaitingDelivery(displayId)) {
    setImmediate(() => kickDelivery(displayId, { now: true }));
  }
  const prev = statusCache.get(displayId);
  const merged = status === null ? null : {
    power: null, battery: null, deviceName: null, networkStandby: null,
    ...(prev?.status || {}),
    ...status,
    sleepTimer: getSleepTimerInfo(displayId),
  };
  const changed = JSON.stringify(prev?.status ?? null) !== JSON.stringify(merged);
  // The clock's last reading, serial and firmware outlive the display going to sleep
  const lastClock = merged?.clock ?? prev?.lastClock ?? null;
  const info = {
    serialNumber: merged?.serialNumber ?? prev?.info?.serialNumber ?? null,
    softwareVersion: merged?.softwareVersion ?? prev?.info?.softwareVersion ?? null,
  };
  statusCache.set(displayId, { status: merged, updatedAt: Date.now(), lastClock, info });
  if (changed) sseBroadcast({ type: 'status', displayId, status: merged });
}

// Displays, groups, a schedule or the settings changed, for clients that
// mirror them (Home Assistant). what: displays | groups | schedule | settings
function noteChange(what, displayId = null) {
  sseBroadcast({ type: 'changed', what, ...(displayId ? { displayId } : {}) });
}

function notePush(displayId) {
  sseBroadcast({ type: 'push', displayId, ts: Date.now() });
}

// ─── Battery log ─────────────────────────────────────────────────────────────
// One line per reading: { ts, level, charging, event }. Pushes and sleeps
// always log; status reads only when the level or charging state changed.
// The reading taken just before a sleep, against the next one after waking,
// shows what the display uses while asleep.

const BATTERY_LOG_MAX = 5000;

function batteryLogPath(id) { return path.join(displayDir(id), 'battery-log.jsonl'); }

function readBatteryLog(id) {
  let lines = [];
  try { lines = fs.readFileSync(batteryLogPath(id), 'utf-8').split('\n'); } catch { /* none yet */ }
  return lines.flatMap(line => {
    try { return line ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

function recordBattery(displayId, battery, event) {
  if (!displayId || !Number.isInteger(battery?.level)) return;
  const entries = readBatteryLog(displayId);
  const last = entries.at(-1);
  if (event === 'status' && last?.level === battery.level && last?.charging === battery.charging) return;
  entries.push({ ts: Date.now(), level: battery.level, charging: battery.charging, event });
  lastBattery.set(displayId, { level: battery.level, charging: battery.charging, at: Date.now() });
  ensureDisplayDir(displayId);
  fs.writeFileSync(batteryLogPath(displayId), entries.slice(-BATTERY_LOG_MAX).map(e => JSON.stringify(e)).join('\n') + '\n');
}

// Percent used per day, overall since the last charge and while asleep.
// Either is null until it covers at least an hour.
function summarizeBattery(entries) {
  const DAY = 86_400_000;
  const rate = (used, ms) => (ms >= 3_600_000 ? { days: ms / DAY, used, perDay: used / (ms / DAY) } : null);

  let asleepUsed = 0, asleepMs = 0;
  for (let i = 0; i + 1 < entries.length; i++) {
    const [a, b] = [entries[i], entries[i + 1]];
    if (a.event !== 'sleep' || a.charging || b.charging || b.level > a.level) continue;
    asleepUsed += a.level - b.level;
    asleepMs += b.ts - a.ts;
  }

  // Walk back from the latest reading until it charged in between
  const last = entries.at(-1);
  let first = entries.length - 1;
  while (first > 0 && !entries[first - 1].charging && entries[first - 1].level >= entries[first].level) first--;
  const sinceCharge = last && !last.charging
    ? rate(entries[first].level - last.level, last.ts - entries[first].ts)
    : null;

  return { sinceCharge, asleep: rate(asleepUsed, asleepMs) };
}

// ─── Sleep safety net ────────────────────────────────────────────────────────
// A display that's awake with no sleep timer stays up until its own timer, if
// it has one. That happens after this server restarts (timers live in memory)
// and after a push that failed once the display was awake. Calibration keeps
// it awake on purpose while you look at the arrow.

const calibrations = new Map(); // displayId → started at
const CALIBRATION_GRACE_MS = 15 * 60_000;

// The sleep a display on its schedule takes arms its wake timer for the next time
const sleepModeFor = (displayId) => (loadDisplayMode(displayId) === 'scheduled' ? 'scheduled' : 'manual');

function armIdleSleep({ id, host, pin, mac }) {
  if (sleepTimers.has(id) || deliveryRuns.has(id)) return;
  if (Date.now() - (calibrations.get(id) ?? 0) < CALIBRATION_GRACE_MS) return;
  scheduleSleep(id, { host, pin, mac, minutes: awakeMinutes(getDisplay(id)), sleepMode: sleepModeFor(id) });
}

// Settings work keeps an awake display up: restart a pending sleep timer
function extendSleepTimer(displayId) {
  const entry = sleepTimers.get(displayId);
  const display = getDisplay(displayId);
  if (!entry || !display) return;
  const { host, pin, mac } = display;
  scheduleSleep(displayId, { host, pin, mac, minutes: entry.info.minutes, sleepMode: entry.info.sleepMode });
}

// Minutes a display stays awake after an image: its own setting, but on a
// schedule never more than half the time until its next wake, or it would
// still be up when that comes round
function awakeMinutes(display) {
  let minutes = display?.sleepAfter ?? DEFAULT_SLEEP_AFTER;
  if (!display || minutes <= 0) return minutes;
  const schedule = loadDisplaySchedule(display.id);
  if (schedule.enabled && schedule.nextWakeAt && loadDisplayMode(display.id) === 'scheduled') {
    const half = Math.floor((schedule.nextWakeAt - Date.now()) / 120_000);
    minutes = Math.min(minutes, Math.max(1, half));
  }
  return minutes;
}

// A display stays reachable for a couple of minutes after a power-off, which
// the background check mustn't mistake for it waking up again
const SHUTDOWN_GRACE_MS = 150_000;

// Background check, every minute: one connection attempt to each display the
// server isn't already handling. A sleeping display doesn't answer, which costs
// it one packet; pinging every 20 s for 25 min didn't wake one. A display that
// answers is sent any image waiting for it. One that answers when nothing here
// woke it (its daily refresh, its button, its own wake timer, or a sleep that
// didn't take) is put back to sleep after its sleep-after time. Displays with
// a sleep pending, a session in progress, or a sleep sent in the last couple
// of minutes are left alone. Sequential with spacing: the EM32DX takes one
// MDC session at a time.
const SWEEP_MS = 60_000;
async function sweepStatuses() {
  for (const display of loadDisplays()) {
    const { id, host, pin, mac } = display;
    if (!host || !pin) continue;
    if (sleepTimers.has(id) || busy.get(id) || deliveryRuns.has(id)) continue;
    if (Date.now() - (lastSleep.get(id) ?? 0) < SHUTDOWN_GRACE_MS) continue;
    const expectedAsleep = unreachable.has(id);
    let awake = false;
    await withBusy(id, async () => {
      try {
        const device = new Device({ host, mac: mac || undefined, pin });
        await device.connect({ timeout: 3_000 });
        const battery = await device.getBatteryState().catch(() => null);
        const networkStandby = await device.getNetworkStandby().catch(() => null);
        const orientation = await device.getSetting('orientation').catch(() => null);
        const { clock } = await readDisplayClock(device);
        await device.disconnect();
        noteStatus(id, { battery, networkStandby, clock });
        recordBattery(id, battery, 'status');
        syncOrientation(id, orientation);
        if (expectedAsleep) {
          console.log(`\n👀 [${id.slice(0, 8)}] Awake without this app waking it (battery ${battery?.level ?? '?'}%)`);
        }
        awake = true;
      } catch {
        noteStatus(id, null);
      }
    });
    // Its session is closed now, so a waiting image can go straight out
    if (awake && !hasWaitingDelivery(id)) armIdleSleep(display);
    await new Promise(r => setTimeout(r, 500));
  }
}
let sweeping = false;
const sweepOnce = () => {
  if (sweeping) return;
  sweeping = true;
  sweepStatuses().finally(() => { sweeping = false; });
};
setInterval(sweepOnce, SWEEP_MS);
setTimeout(sweepOnce, 10_000); // first look shortly after boot

// ─── Scheduler ───────────────────────────────────────────────────────────────
// A display on its schedule gets its next image (from its queue or its feed)
// at each wake time. This server keeps the time: when one comes round it
// queues the image, and delivery reaches the display. One in network standby
// with a MAC address is woken over the network, which works on any firmware.
// One in deep sleep can only wake itself, on the wake timer set as it went to
// sleep; firmware 1130.7 refuses that timer, so such a display gets its image
// when it next wakes for some other reason (its button, its daily refresh).

const scheduleTimers = new Map();
const MAX_TIMER_MS = 6 * 3_600_000; // re-check at least this often

function armSchedule(displayId) {
  clearTimeout(scheduleTimers.get(displayId));
  scheduleTimers.delete(displayId);
  const display = getDisplay(displayId);
  const schedule = loadDisplaySchedule(displayId);
  const on = display && schedule.enabled && loadDisplayMode(displayId) === 'scheduled';
  if (!on) {
    if (schedule.nextWakeAt) saveDisplaySchedule(displayId, { ...schedule, nextWakeAt: null });
    return;
  }
  // A wake missed while this server was down is caught up once, straight away
  if (!schedule.nextWakeAt) {
    schedule.nextWakeAt = nextWakeAfter(schedule);
    saveDisplaySchedule(displayId, schedule);
  }
  if (!schedule.nextWakeAt) return;
  const delay = Math.max(0, schedule.nextWakeAt - Date.now());
  scheduleTimers.set(displayId, setTimeout(
    () => (delay > MAX_TIMER_MS ? armSchedule(displayId) : runScheduledWake(displayId)),
    Math.min(delay, MAX_TIMER_MS),
  ));
}

async function runScheduledWake(displayId) {
  scheduleTimers.delete(displayId);
  const schedule = loadDisplaySchedule(displayId);
  const due = schedule.nextWakeAt;
  // On to the next time first, so nothing that goes wrong here stalls the schedule
  schedule.nextWakeAt = nextWakeAfter(schedule, Math.max(Date.now(), due ?? 0));
  saveDisplaySchedule(displayId, schedule);
  armSchedule(displayId);
  noteChange('schedule', displayId);

  const display = getDisplay(displayId);
  if (!display) return;
  console.log(`\n📅 [${displayId.slice(0, 8)}] Scheduled wake for "${display.name}" (due ${new Date(due ?? Date.now()).toLocaleString()})`);
  try {
    const providers = loadDisplayProviders(displayId);
    if (providers.sourceMode === 'provider') {
      const provider = getAllDisplayProviders(displayId).find(p => p.id === providers.activeProvider);
      if (!provider) throw new Error('Its feed is no longer available');
      const result = await fetchFromProvider(provider);
      if (!result.imageUrl) throw new Error('Its feed returned no image');
      const source = await normalizeImage(await downloadImage(result.imageUrl));
      setCurrentSource(displayId, source, null);
      const rendered = await applyQueueEdit(source, null, display, { fit: 'fill' });
      deliver(displayId, rendered, { label: result.title || provider.name, source: 'schedule', wait: false });
    } else {
      await pushNextQueueImage(displayId, null, { source: 'schedule', wait: false });
    }
  } catch (err) {
    console.error(`   ❌ Scheduled image: ${err.message}`);
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
// Room for an image sent as base64
app.use(express.json({ limit: '40mb' }));

// ─── Display CRUD ────────────────────────────────────────────────────────────

app.get('/api/displays', (_req, res) => res.json(loadDisplays()));

// ─── App settings ───────────────────────────────────────────────────────────

function appSettingsResponse() {
  const { serverAddress: saved, timeZone, defaultProfile, syncClocks } = loadAppSettings();
  const { fit, background } = fitFor();
  return {
    serverAddress: saved || null,
    detectedAddress: detectAddress(loadDisplays()[0]?.host),
    timeZone: timeZone || null,
    defaultProfile: defaultProfile ?? DEFAULT_PROFILE,
    imageFit: fit,
    imageBackground: background,
    syncClocks: syncClocks !== false,
    port: PORT,
  };
}

// Fetches this server through the given address. It can't prove the display
// can reach it, but it does catch a mistyped or out-of-date address.
async function addressReachesThisServer(address) {
  try {
    const res = await fetch(`http://${address}:${PORT}/api/server-check`, { signal: AbortSignal.timeout(2_500) });
    return (await res.json()).id === SERVER_ID;
  } catch {
    return false;
  }
}

app.get('/api/server-check', (_req, res) => res.json({ id: SERVER_ID }));

app.get('/api/app-settings', (_req, res) => res.json(appSettingsResponse()));

// Body: { serverAddress?, timeZone?, defaultProfile?, imageFit?, imageBackground?,
// syncClocks? }. An empty serverAddress goes back to detection.
app.put('/api/app-settings', async (req, res) => {
  const { serverAddress: address, timeZone, defaultProfile, imageFit, imageBackground, syncClocks } = req.body ?? {};
  const settings = loadAppSettings();

  if (address !== undefined) {
    const value = String(address).trim();
    if (value && !/^[a-zA-Z0-9.-]+$/.test(value)) {
      return res.status(400).json({ error: 'Enter an IP address, like 192.168.1.20' });
    }
    settings.serverAddress = value;
  }
  if (timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: String(timeZone) });
    } catch {
      return res.status(400).json({ error: `Unknown time zone: ${timeZone}` });
    }
    settings.timeZone = String(timeZone);
  }
  if (defaultProfile !== undefined) {
    if (!PROFILES.some(p => p.id === defaultProfile)) {
      return res.status(400).json({ error: `Unknown profile: ${defaultProfile}` });
    }
    settings.defaultProfile = defaultProfile;
  }
  if (imageFit !== undefined) {
    if (!FITS.includes(imageFit)) return res.status(400).json({ error: `imageFit must be one of: ${FITS.join(', ')}` });
    settings.imageFit = imageFit;
  }
  if (imageBackground !== undefined) {
    if (!HEX_COLOR.test(imageBackground)) return res.status(400).json({ error: 'imageBackground must be a color like #ffffff' });
    settings.imageBackground = imageBackground;
  }
  if (syncClocks !== undefined) settings.syncClocks = syncClocks !== false;

  writeJson(APP_SETTINGS_JSON, settings);
  applyTimeZone();
  // A new address or time zone could be what stopped deliveries needed, and
  // moves schedule times
  if (address !== undefined) retryStopped();
  if (timeZone !== undefined) for (const d of loadDisplays()) {
    const schedule = loadDisplaySchedule(d.id);
    if (schedule.enabled) { saveDisplaySchedule(d.id, { ...schedule, nextWakeAt: nextWakeAfter(schedule) }); armSchedule(d.id); }
  }
  noteChange('settings');
  const reachable = address && settings.serverAddress ? await addressReachesThisServer(settings.serverAddress) : null;
  res.json({ ...appSettingsResponse(), reachable });
});

app.post('/api/displays', (req, res) => {
  const { name, host, pin, mac, sleepAfter, canvasX, canvasY, canvasWidth, canvasHeight } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const displays = loadDisplays();
  // Beside the existing displays, not stacked on top of them
  const nextX = displays.reduce((x, d) => Math.max(x, (d.canvasX ?? 0) + Math.max(d.canvasWidth ?? 0, d.canvasHeight ?? 0) + 40), 100);

  const id = randomUUID();
  const display = {
    id, name, host: host || '', pin: pin || '', mac: mac || '',
    sleepAfter: sleepAfter ?? DEFAULT_SLEEP_AFTER,
    canvasX: canvasX ?? nextX, canvasY: canvasY ?? 50,
    canvasWidth: canvasWidth ?? 180, canvasHeight: canvasHeight ?? 320,
  };
  displays.push(display);
  saveDisplays(displays);
  ensureDisplayDir(id);
  console.log(`📺 Display added: "${name}" (${id.slice(0, 8)})`);
  noteChange('displays', id);
  res.json(display);
});

// Registered before /api/displays/:id so "reorder" isn't captured as an id
app.put('/api/displays/reorder', (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const displays = loadDisplays();
  const byId = new Map(displays.map(d => [d.id, d]));
  const ordered = ids.map(id => byId.get(id)).filter(Boolean);
  for (const d of displays) if (!ordered.includes(d)) ordered.push(d);
  saveDisplays(ordered);
  noteChange('displays');
  res.json({ success: true });
});

app.put('/api/displays/:id', (req, res) => {
  const displays = loadDisplays();
  const idx = displays.findIndex(d => d.id === findDisplay(req.params.id)?.id);
  if (idx === -1) return res.status(404).json({ error: 'Display not found' });

  for (const key of ['name', 'host', 'pin', 'mac', 'sleepAfter', 'canvasX', 'canvasY', 'canvasWidth', 'canvasHeight', 'rotation', 'upRotation', 'upLocked', 'sceneId', 'quad', 'plane']) {
    if (req.body[key] !== undefined) displays[idx][key] = req.body[key];
  }
  saveDisplays(displays);
  // New connection details could be what a stopped delivery needed
  if (['host', 'pin', 'mac'].some(k => req.body[k] !== undefined)) retryStopped(displays[idx].id);
  noteChange('displays', displays[idx].id);
  res.json(displays[idx]);
});

app.delete('/api/displays/:id', (req, res) => {
  const displayId = findDisplay(req.params.id)?.id ?? req.params.id;
  cancelSleepTimer(displayId);
  clearTimeout(scheduleTimers.get(displayId));
  scheduleTimers.delete(displayId);
  clearTimeout(deliveryTimers.get(displayId));
  deliveryTimers.delete(displayId);

  const displays = loadDisplays();
  const filtered = displays.filter(d => d.id !== displayId);
  if (filtered.length === displays.length) return res.status(404).json({ error: 'Display not found' });
  saveDisplays(filtered);

  // Groups lose the display; one left with a single display can't span
  // anything, so it goes too
  const groups = loadGroups();
  if (groups.some(g => g.displayIds.includes(displayId))) {
    const kept = groups
      .map(g => ({ ...g, displayIds: g.displayIds.filter(id => id !== displayId) }))
      .filter(g => g.displayIds.length >= 2);
    for (const g of groups) if (!kept.some(k => k.id === g.id)) fs.rmSync(groupDir(g.id), { recursive: true, force: true });
    saveGroups(kept);
  }

  const dir = displayDir(displayId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`📺 Display removed: ${displayId.slice(0, 8)}`);
  noteChange('displays', displayId);
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

// A display by its id, or by its name (any case, or as a slug: "living-room")
function findDisplay(ref) {
  const displays = loadDisplays();
  const key = String(ref ?? '').trim().toLowerCase();
  return displays.find(d => d.id === ref) ?? displays.find(d => d.name.toLowerCase() === key || slug(d.name) === key) ?? null;
}

function resolveDisplay(req, res, next) {
  const display = findDisplay(req.params.displayId);
  if (!display) return res.status(404).json({ error: 'Display not found' });
  // Handlers after this one go by the id
  req.params.displayId = display.id;
  req.display = display;
  next();
}

// ─── Per-display: Status ────────────────────────────────────────────────────

app.get('/api/displays/:displayId/status', resolveDisplay, busyRoute(async (req, res) => {
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
    const orientation = await device.getSetting('orientation').catch(() => null);
    await device.disconnect();
    noteStatus(req.params.displayId, { power, battery, deviceName, networkStandby, serialNumber, softwareVersion });
    recordBattery(req.params.displayId, battery, 'status');
    syncOrientation(req.params.displayId, orientation);
    armIdleSleep(req.display);
    res.json({ power, battery, deviceName, networkStandby, serialNumber, softwareVersion, sleepTimer: getSleepTimerInfo(req.params.displayId) });
  } catch (err) {
    noteStatus(req.params.displayId, null);
    res.status(500).json({ error: err.message });
  }
}));

// Battery readings this server has taken, newest last, with drain per day.
// Read from disk only, so it works while the display sleeps.
app.get('/api/displays/:displayId/battery-log', resolveDisplay, (req, res) => {
  const entries = readBatteryLog(req.params.displayId);
  res.json({ ...summarizeBattery(entries), entries: entries.slice(-500) });
});

// ─── Per-display: Orientation ───────────────────────────────────────────────
// Portrait/landscape is one setting shared by the viewer and the display, and
// it decides the size images are rendered at. The display is the source of
// truth, so this runs whenever it accepts or reports an orientation.

function syncOrientation(displayId, orientation) {
  const displays = loadDisplays();
  const display = displays.find(d => d.id === displayId);
  if (!orientation || !display || frameOrientation(display) === orientation) return;
  display.rotation = orientation === 'landscape' ? 90 : 0;
  saveDisplays(displays);
  sseBroadcast({ type: 'display', displayId, patch: { rotation: display.rotation } });
}

// ─── Per-display: Device settings ───────────────────────────────────────────
// These live on the display itself, so it has to be awake. It only takes one
// MDC session at a time, so requests for the same display run in turn.

const settingsQueues = new Map();

function settingsInTurn(displayId, task) {
  const run = (settingsQueues.get(displayId) ?? Promise.resolve()).catch(() => {}).then(() => withBusy(displayId, task));
  settingsQueues.set(displayId, run);
  return run;
}

async function withDevice({ host, pin, mac }, task) {
  const device = new Device({ host, mac: mac || undefined, pin });
  await device.connect({ timeout: 8_000 });
  try {
    return await task(device);
  } finally {
    await device.disconnect();
  }
}

// Socket errors carry a code; everything else (wrong PIN, timeouts) reads fine as is
const settingsError = (err) => (err.code ? "Couldn't reach the display. It may be asleep." : err.message);

app.get('/api/displays/:displayId/settings', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin configured' });
  try {
    const result = await settingsInTurn(displayId, () => withDevice(getDisplay(displayId), async device => ({
      settings: await device.getSettings(),
      timeZones: await device.getTimeZones().catch(() => []),
    })));
    extendSleepTimer(displayId);
    syncOrientation(displayId, result.settings.orientation);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: settingsError(err) });
  }
});

// Body: any of the names in SETTINGS, e.g. { orientation: 'portrait' }. Applied
// in SETTINGS order, so a PIN change is always the last write of the session.
app.put('/api/displays/:displayId/settings', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin configured' });

  const changes = req.body ?? {};
  const names = Object.keys(SETTINGS).filter(name => changes[name] !== undefined);
  if (!names.length) return res.status(400).json({ error: 'No known settings in request' });
  try {
    for (const name of names) SETTINGS[name].encode(changes[name]);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    await settingsInTurn(displayId, () => withDevice(getDisplay(displayId), async device => {
      for (const name of names) await device.setSetting(name, changes[name]);
      // Save inside the turn, so the next queued request logs in with the new PIN.
      // The sleep mode is kept too: pushes and sleeps set it from here.
      if (changes.pin || changes.sleepMode) {
        const displays = loadDisplays();
        const display = displays.find(d => d.id === displayId);
        if (changes.pin) display.pin = changes.pin;
        if (changes.sleepMode) display.sleepMode = changes.sleepMode;
        saveDisplays(displays);
      }
    }));
    extendSleepTimer(displayId);
    // Keep the status every client shows in step with what just changed
    if (changes.sleepMode) noteStatus(displayId, { networkStandby: changes.sleepMode === 'standby' });
    if (changes.deviceName) noteStatus(displayId, { deviceName: changes.deviceName });
    if (changes.orientation) syncOrientation(displayId, changes.orientation);
    if (changes.pin || changes.sleepMode) retryStopped(displayId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: settingsError(err) });
  }
});

// Cached statuses — instant, no MDC traffic
app.get('/api/statuses', (_req, res) => {
  const out = {};
  for (const [id, v] of statusCache) out[id] = v.status;
  res.json(out);
});

// Live event stream: status changes + pushes, with a snapshot on connect
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // keep nginx from buffering the stream
  });
  const snapshot = {};
  for (const [id, v] of statusCache) snapshot[id] = v.status;
  res.write(`data: ${JSON.stringify({ type: 'snapshot', statuses: snapshot })}\n\n`);
  sseClients.add(res);
  const keepalive = setInterval(() => { try { res.write(':ka\n\n'); } catch { /* closing */ } }, 25_000);
  req.on('close', () => { clearInterval(keepalive); sseClients.delete(res); });
});

// ─── Sending: what a request carries ────────────────────────────────────────

const parseJsonField = (value, name) => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new RequestError(`${name} must be JSON`); }
};

// The image a request carries, as a JPEG in its own orientation: an uploaded
// `image` file, a `url` to download, a library item (`gallery`, as
// "category/file.jpg") or `base64` (plain or a data: URL). null when none.
async function imageFromRequest(req) {
  const body = req.body ?? {};
  let buffer = req.file?.buffer ?? null;
  let label = req.file?.originalname ?? null;
  if (!buffer && body.url) {
    if (!/^https?:\/\//i.test(body.url)) throw new RequestError('url must start with http:// or https://');
    try { buffer = await downloadImage(body.url); }
    catch (err) { throw new RequestError(`Couldn't download the image: ${err.message}`); }
    label = decodeURIComponent(new URL(body.url).pathname.split('/').pop() || '') || 'Image from a link';
  }
  if (!buffer && body.gallery) {
    const file = galleryFilePath(String(body.gallery));
    if (!file) throw new RequestError(`No artwork "${body.gallery}" in the library`, 404);
    buffer = fs.readFileSync(file);
    label = galleryTitle(path.basename(file));
  }
  if (!buffer && body.base64) {
    buffer = Buffer.from(String(body.base64).replace(/^data:[^,]*,/, ''), 'base64');
    label = 'Uploaded image';
  }
  if (!buffer) return null;
  try { return { image: await normalizeImage(buffer), label }; }
  catch { throw new RequestError("That image couldn't be read. JPEG, PNG, WebP, GIF, TIFF and AVIF work."); }
}

// Options any send takes: wait, sleepAfter, sleepMode, fit, background, profile
function sendOptions(body = {}) {
  const b = body ?? {};
  const opts = { wait: !(b.wait === false || b.wait === 'false' || b.wait === '0') };
  if (b.sleepAfter !== undefined && b.sleepAfter !== '') {
    opts.sleepAfter = parseInt(b.sleepAfter, 10);
    if (!Number.isInteger(opts.sleepAfter) || opts.sleepAfter < 0) throw new RequestError('sleepAfter must be minutes, 0 or more');
  }
  if (b.sleepMode !== undefined) {
    if (!['manual', 'scheduled', 'deep'].includes(b.sleepMode)) throw new RequestError('sleepMode must be manual, scheduled or deep');
    opts.sleepMode = b.sleepMode;
  }
  if (b.fit !== undefined && b.fit !== '') {
    if (!FITS.includes(b.fit)) throw new RequestError(`fit must be one of: ${FITS.join(', ')}`);
    opts.fit = b.fit;
  }
  if (b.background !== undefined && b.background !== '') {
    if (!HEX_COLOR.test(b.background)) throw new RequestError('background must be a color like #ffffff');
    opts.background = b.background;
  }
  if (b.profile !== undefined && b.profile !== '') {
    if (!PROFILES.some(p => p.id === b.profile)) throw new RequestError(`profile must be one of: ${PROFILES.map(p => p.id).join(', ')}`);
    opts.profile = b.profile;
  }
  return opts;
}

// ─── Per-display: Push ──────────────────────────────────────────────────────

// Body: multipart with an `image` file, or JSON { "url": "http://…" } (what
// Home Assistant's rest_command sends). Optional: sleepAfter (minutes; the
// display's own setting otherwise) and edit. A sleeping display is woken
// first, so this can take a while: up to 90 s in network standby, 3 min in
// deep sleep while it waits for the power button.
app.post('/api/displays/:displayId/push', resolveDisplay, upload.single('image'), handle(async (req, res) => {
  const displayId = req.params.displayId;
  const opts = sendOptions(req.body);
  const sent = await imageFromRequest(req);
  if (!sent) throw new RequestError('No image: send an image file, or JSON with url, gallery or base64');
  const edit = req.body?.edit ? sanitizeEdit(parseJsonField(req.body.edit, 'edit')) : null;
  setCurrentSource(displayId, sent.image, edit);
  const rendered = await applyQueueEdit(sent.image, edit, req.display, opts);
  sendOutcome(res, await deliver(displayId, rendered, { ...opts, label: sent.label, source: 'push' }));
}));

// ─── Per-display: Last Image ────────────────────────────────────────────────

app.get('/api/displays/:displayId/last-image', resolveDisplay, (req, res) => {
  const imgPath = getDisplayLastImagePath(req.params.displayId);
  if (!fs.existsSync(imgPath)) return res.status(404).end();
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'no-cache');
  fs.createReadStream(imgPath).pipe(res);
});

// Original art behind the current presentation (for the non-destructive editor)
app.get('/api/displays/:displayId/current-source', resolveDisplay, (req, res) => {
  const p = currentSourcePath(req.params.displayId);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'no-cache');
  fs.createReadStream(p).pipe(res);
});

app.get('/api/displays/:displayId/current-edit', resolveDisplay, (req, res) => {
  res.json({ edit: getCurrentEdit(req.params.displayId) });
});

// ─── Per-display: Wake / Sleep ──────────────────────────────────────────────

app.post('/api/displays/:displayId/wake', resolveDisplay, busyRoute(async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host && !mac) return res.status(400).json({ error: 'host or MAC required' });

  try {
    cancelSleepTimer(displayId);

    if (!host || !pin) {
      // Nothing to confirm it with: send the packet and hope
      await new Device({ host, mac, pin }).wakeup();
      return res.json({ success: true, method: 'wol', confirmed: false });
    }

    // Keep sending Wake-on-LAN and trying until it answers, the way Samsung's
    // app does, and only report success once it really is awake
    const device = await connectWhenAwake({ host, pin, mac, displayId });
    await device.setPower({ power: true }).catch(() => {});
    await device.setNetworkStandby({ enabled: prefersStandby(displayId) }).catch(() => {});
    recordBattery(displayId, await device.getBatteryState().catch(() => null), 'status');
    await device.disconnect();
    noteStatus(displayId, {});

    // Back to sleep if nothing else happens: a push or settings change restarts this
    const sleepAfter = req.display.sleepAfter ?? DEFAULT_SLEEP_AFTER;
    if (sleepAfter > 0) {
      scheduleSleep(displayId, {
        host, pin, mac, minutes: Math.max(sleepAfter, WAKE_MINUTES),
        sleepMode: loadDisplayMode(displayId) === 'scheduled' ? 'scheduled' : 'manual',
      });
    }
    res.json({ success: true, method: 'wol', confirmed: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Makes the display offer its Bluetooth setup service, so the browser can
// change its Wi-Fi (see docs/BLE.md). Samsung's app does the same before a
// Wi-Fi change. Wakes the display first, and keeps it up long enough to finish.
app.post('/api/displays/:displayId/bluetooth', resolveDisplay, busyRoute(async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });
  try {
    cancelSleepTimer(displayId);
    const device = await connectWhenAwake({ host, pin, mac, displayId });
    try {
      await device.turnOnBluetooth();
    } finally {
      await device.disconnect().catch(() => {});
    }
    noteStatus(displayId, {});
    console.log(`📶 [${displayId.slice(0, 8)}] Bluetooth setup turned on`);
    scheduleSleep(displayId, { host, pin, mac, minutes: WAKE_MINUTES, sleepMode: loadDisplayMode(displayId) === 'scheduled' ? 'scheduled' : 'manual' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.post('/api/displays/:displayId/sleep', resolveDisplay, async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  const sleepMode = req.body?.sleepMode || 'manual';
  if (!host || !pin) return res.status(400).json({ error: 'Display has no host/pin' });
  try {
    cancelSleepTimer(displayId);
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
    calibrations.set(displayId, Date.now());

    // Keep a copy of what's on the glass so we can put it back afterwards
    const last = getDisplayLastImagePath(displayId);
    if (fs.existsSync(last)) fs.copyFileSync(last, calibrationBackupPath(displayId));
    else fs.rmSync(calibrationBackupPath(displayId), { force: true });

    // The canvas frame is the user's intended orientation — render the arrow
    // for that aspect so "up" on the test image means up in their intended view
    const buf = await makeCalibrationArrow(frameOrientation(req.display));

    // Arrow goes out as a normal presentation image — calibration applies to
    // the payload, so the glass shows where the current setting really points
    await pushPresentation(displayId, { host, pin, mac }, buf);
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
  calibrations.delete(displayId);
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
      await pushPresentation(displayId, { host, pin, mac }, buf);
      fs.rmSync(backup, { force: true });
      const sleepAfter = d.sleepAfter ?? DEFAULT_SLEEP_AFTER;
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
  if (mode === 'manual') cancelSleepTimer(displayId);
  armSchedule(displayId);
  noteChange('schedule', displayId);
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

app.post('/api/displays/:displayId/queue/push-next', resolveDisplay, handle(async (req, res) => {
  const { entry, outcome } = await pushNextQueueImage(req.params.displayId, null, sendOptions(req.body));
  sendOutcome(res, outcome, { id: entry.id, filename: entry.filename });
}));

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
app.post('/api/displays/:displayId/queue/:imageId/push', resolveDisplay, handle(async (req, res) => {
  const { entry, outcome } = await pushNextQueueImage(req.params.displayId, req.params.imageId, sendOptions(req.body));
  sendOutcome(res, outcome, { id: entry.id, filename: entry.filename });
}));

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
      const buf = await applyQueueEdit(fs.readFileSync(imgPath), entry.edit, req.display);
      return res.send(buf);
    } catch { /* fall through to the raw file */ }
  }
  fs.createReadStream(imgPath).pipe(res);
});

// Presentation override for a queued image: how it should be displayed.
// Body: { mode?: 'crop'|'fit'|'stretch', rotation: degrees,
//         crop: {x,y,width,height}|null, zoom?, offset?: {x,y}, bg?: '#rrggbb',
//         adjust?: {brightness, contrast, saturation, midtones, sharpen} }
function sanitizeEdit(body) {
  const { mode, rotation, crop, zoom, scaleX, scaleY, offset, bg, radius, border, adjust } = body ?? {};
  const m = ['fit', 'stretch', 'transform'].includes(mode) ? mode : 'crop';
  const rot = Number.isFinite(rotation) ? ((rotation % 360) + 360) % 360 : 0;
  const validCrop = crop && [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
    : null;
  const clampScale = (v, fallback) => Number.isFinite(v) && v > 0 ? Math.min(v, 20) : fallback;
  const edit = {
    mode: m,
    rotation: rot,
    crop: m === 'crop' ? validCrop : null,
    zoom: clampScale(zoom, 1),
    scaleX: clampScale(scaleX, 1),
    scaleY: clampScale(scaleY, clampScale(scaleX, 1)),
    offset: offset && Number.isFinite(offset.x) && Number.isFinite(offset.y)
      ? { x: Math.max(-4, Math.min(4, offset.x)), y: Math.max(-4, Math.min(4, offset.y)) }
      : { x: 0, y: 0 },
    bg: /^#[0-9a-fA-F]{6}$/.test(bg || '') ? bg : '#000000',
    radius: Number.isFinite(radius) ? Math.max(0, Math.min(radius, 1280)) : 0,
    border: border && /^#[0-9a-fA-F]{6}$/.test(border.color || '') && Number.isFinite(border.width) && border.width > 0
      ? { color: border.color, width: Math.min(border.width, 200) }
      : null,
    adjust: sanitizeAdjust(adjust),
  };
  const isNoop = m === 'crop' && rot === 0 && !validCrop && !edit.adjust;
  return isNoop ? null : edit;
}

app.put('/api/displays/:displayId/queue/:imageId/edit', resolveDisplay, (req, res) => {
  const displayId = req.params.displayId;
  const queue = loadDisplayQueue(displayId);
  const entry = queue.images.find(img => img.id === req.params.imageId);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  entry.edit = sanitizeEdit(req.body);
  entry.editedAt = new Date().toISOString();
  saveDisplayQueue(displayId, queue);
  res.json({ success: true, edit: entry.edit });
});

// Re-render the CURRENT image with an edit and push it (properties panel's
// tune flow) — the edit is applied server-side against last-push.jpg
app.post('/api/displays/:displayId/push-edit', resolveDisplay, handle(async (req, res) => {
  const displayId = req.params.displayId;
  // Displays that predate source tracking adopt their current rendered image
  // as the source on first edit — from then on edits stay non-destructive
  if (!fs.existsSync(currentSourcePath(displayId))) {
    const lastPath = getDisplayLastImagePath(displayId);
    if (!fs.existsSync(lastPath)) throw new RequestError('No current image', 404);
    setCurrentSource(displayId, fs.readFileSync(lastPath), null);
  }
  const opts = sendOptions(req.body);
  const edit = sanitizeEdit(req.body?.edit ?? req.body);
  const rendered = await applyQueueEdit(fs.readFileSync(currentSourcePath(displayId)), edit, req.display, opts);
  setCurrentEdit(displayId, edit);
  sendOutcome(res, await deliver(displayId, rendered, { ...opts, label: 'Edited image', source: 'edit' }));
}));

// ─── Display groups: one image spanned across several displays ──────────────
// A group is a set of displays hung together. Its image is laid out on one big
// "wall" covering every screen plus the frames and gaps between them, then cut
// into a slice per display. The picture carries on behind the frames, so lines
// stay straight from one screen to the next. The browser works out the wall
// from how the displays are arranged on the canvas and sends it with the image.

const GROUPS_JSON = path.join(DISPLAYS_DIR, 'groups.json');
function loadGroups() { return readJson(GROUPS_JSON, []); }
function saveGroups(groups) { ensureDisplaysDir(); writeJson(GROUPS_JSON, groups); }
function groupDir(id) { return path.join(DISPLAYS_DIR, 'groups', path.basename(id)); }
function groupSourcePath(id) { return path.join(groupDir(id), 'source.jpg'); }

// Millimetres. The EMDX frame is about 14 mm from the picture to the edge.
const DEFAULT_GAP = { bezelMm: 14, spaceXMm: 0, spaceYMm: 0 };
function sanitizeGap(gap, fallback = DEFAULT_GAP) {
  const mm = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(2000, Math.round(v * 10) / 10)) : d);
  return {
    bezelMm: mm(gap?.bezelMm, fallback.bezelMm),
    spaceXMm: mm(gap?.spaceXMm, fallback.spaceXMm),
    spaceYMm: mm(gap?.spaceYMm, fallback.spaceYMm),
  };
}

const groupName = (value) => String(value ?? '').trim().slice(0, 80);

function nextGroupName(groups) {
  for (let n = 1; ; n++) if (!groups.some(g => g.name === `Group ${n}`)) return `Group ${n}`;
}

// A group by its id, or by its name (any case)
function findGroup(ref) {
  const groups = loadGroups();
  const key = String(ref ?? '').trim().toLowerCase();
  return groups.find(g => g.id === ref) ?? groups.find(g => g.name.toLowerCase() === key || slug(g.name) === key) ?? null;
}

// The wall for a group as its displays sit on the canvas now
function currentLayout(group) {
  const displays = loadDisplays().filter(d => group.displayIds.includes(d.id));
  const { width, height, screens } = wallLayout(displays, loadScenes(), group.gap ?? DEFAULT_GAP);
  return { width, height, screens };
}

// What a display's own designer opens a slice with: the slice exactly as sent,
// filling the frame, and no second dose of tone (the span already had one)
const SLICE_EDIT = {
  mode: 'transform', rotation: 0, crop: null, zoom: 1, scaleX: 1, scaleY: 1, offset: { x: 0, y: 0 },
  bg: '#000000', radius: 0, border: null,
  adjust: { brightness: 0, contrast: 0, saturation: 0, midtones: 0, sharpen: 0 },
};

// The wall as the browser laid it out, checked against the group and each
// display's current orientation. Positions and sizes are panel pixels.
function validateLayout(layout, group) {
  if (!layout || typeof layout !== 'object') throw new RequestError('layout is required');
  const { width: W, height: H } = layout;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1 || W > 40_000 || H > 40_000 || W * H > 200e6) {
    throw new RequestError('The wall is too large');
  }
  const displays = new Map(loadDisplays().map(d => [d.id, d]));
  const members = group.displayIds.filter(id => displays.has(id));
  const screens = Array.isArray(layout.screens) ? layout.screens : [];
  const seen = new Set();
  for (const s of screens) {
    const display = displays.get(s?.id);
    if (!display || !members.includes(s.id) || seen.has(s.id)) throw new RequestError("The layout doesn't match this group's displays", 409);
    seen.add(s.id);
    const [FW, FH] = frameDims(display);
    if (s.w !== FW || s.h !== FH) {
      throw new RequestError(`${display.name} changed orientation while this was open. Close the designer and open it again.`, 409);
    }
    if (![s.x, s.y].every(Number.isInteger) || s.x < 0 || s.y < 0 || s.x + s.w > W || s.y + s.h > H) {
      throw new RequestError(`${display.name} falls outside the wall`);
    }
  }
  if (members.some(id => !seen.has(id))) throw new RequestError("The layout doesn't match this group's displays", 409);
  return { width: W, height: H, screens: screens.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })) };
}

// Lays the image out on the wall, then cuts out each screen's slice
async function renderSpan(buffer, edit, layout) {
  const wall = await transformOnto(buffer, edit, layout.width, layout.height, toneFor(edit));
  const { data, info } = await wall.raw().toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  const slices = new Map();
  for (const s of layout.screens) {
    slices.set(s.id, await sharp(data, { raw })
      .extract({ left: s.x, top: s.y, width: s.w, height: s.h })
      .jpeg({ quality: 90 }).toBuffer());
  }
  return slices;
}

app.get('/api/groups', (_req, res) => res.json(loadGroups()));

// Body: { displayIds, name?, gap? }. A group of exactly these displays is
// reused, so sending to the same selection twice doesn't make a second one.
app.post('/api/groups', (req, res) => {
  const known = new Set(loadDisplays().map(d => d.id));
  const ids = Array.isArray(req.body?.displayIds) ? req.body.displayIds : [];
  const displayIds = [...new Set(ids)].filter(id => known.has(id));
  if (displayIds.length < 2) return res.status(400).json({ error: 'A group needs at least two displays' });

  const groups = loadGroups();
  let group = groups.find(g => sameMembers(g.displayIds, displayIds));
  if (group) {
    if (groupName(req.body?.name)) group.name = groupName(req.body.name);
    if (req.body?.gap) group.gap = sanitizeGap(req.body.gap, group.gap);
  } else {
    group = {
      id: randomUUID(),
      name: groupName(req.body?.name) || nextGroupName(groups),
      displayIds,
      gap: sanitizeGap(req.body?.gap),
      span: null,
    };
    groups.push(group);
    console.log(`🧩 Group added: "${group.name}" (${displayIds.length} displays)`);
  }
  saveGroups(groups);
  noteChange('groups');
  res.json(group);
});

// Body: { name?, gap? }. Membership is what a group is, so it doesn't change.
app.put('/api/groups/:id', (req, res) => {
  const groups = loadGroups();
  const found = findGroup(req.params.id);
  const group = found && groups.find(g => g.id === found.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (req.body?.name !== undefined) {
    if (!groupName(req.body.name)) return res.status(400).json({ error: 'Give the group a name' });
    group.name = groupName(req.body.name);
  }
  if (req.body?.gap !== undefined) group.gap = sanitizeGap(req.body.gap, group.gap);
  saveGroups(groups);
  noteChange('groups');
  res.json(group);
});

// Forgets the group and its image. The displays, and what's on them, stay.
app.delete('/api/groups/:id', (req, res) => {
  const group = findGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  saveGroups(loadGroups().filter(g => g.id !== group.id));
  fs.rmSync(groupDir(group.id), { recursive: true, force: true });
  noteChange('groups');
  res.json({ success: true });
});

// The original image behind the group's last span, for editing it again
app.get('/api/groups/:id/source', (req, res) => {
  const group = findGroup(req.params.id);
  const p = group && groupSourcePath(group.id);
  if (!p || !fs.existsSync(p)) return res.status(404).end();
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'no-cache');
  fs.createReadStream(p).pipe(res);
});

// Spans an image across the group's displays and sends every slice at once.
// The image: an `image` file (multipart), or `url`, `gallery` or `base64`; with
// none, the group's last image is sent again. The web app sends its `edit` and
// `layout` (JSON, or JSON strings in multipart). Without them the wall is laid
// out from the canvas as it is now, and the image placed by `fit` (fill, the
// default, or fit / stretch, on `background`). `only` (display ids) resends
// just those slices, to retry the ones that failed. With `wait` (the
// default) it answers once each display has had its first attempt:
// { sent, queued, results: [{ displayId, name, ok, state, error? }] }
app.post('/api/groups/:id/span', upload.single('image'), handle(async (req, res) => {
  const group = findGroup(req.params.id);
  if (!group) throw new RequestError('Group not found', 404);
  const body = req.body ?? {};
  const opts = sendOptions(body);
  const only = parseJsonField(body.only, 'only');
  const sent = await imageFromRequest(req);

  let layout = parseJsonField(body.layout, 'layout');
  let edit = parseJsonField(body.edit, 'edit');
  if (!layout) layout = !sent && group.span ? group.span.layout : currentLayout(group);
  layout = validateLayout(layout, group);
  if (edit) edit = sanitizeEdit(edit);
  else if (sent) {
    const { width, height } = await sharp(sent.image).metadata();
    const { background } = fitFor(opts);
    edit = sanitizeEdit({ ...sizedEdit(width, height, layout.width, layout.height, opts.fit ?? 'fill', background), adjust: opts.profile ? profileAdjust(opts.profile) : undefined });
  } else edit = group.span?.edit ? sanitizeEdit(group.span.edit) : null;
  if (!edit) throw new RequestError('Send an image to span');

  let source;
  if (sent) source = sent.image;
  else if (fs.existsSync(groupSourcePath(group.id))) source = fs.readFileSync(groupSourcePath(group.id));
  else throw new RequestError('No image provided');

  let slices;
  try { slices = await renderSpan(source, edit, layout); }
  catch (err) { throw new Error(`Couldn't lay out the image: ${err.message}`); }

  // Kept before sending, so a display that misses it can be retried with the same design
  fs.mkdirSync(groupDir(group.id), { recursive: true });
  if (sent) fs.writeFileSync(groupSourcePath(group.id), source);
  const groups = loadGroups();
  const saved = groups.find(g => g.id === group.id);
  if (saved) {
    saved.span = { edit, layout, updatedAt: new Date().toISOString() };
    saveGroups(groups);
  }

  const displays = new Map(loadDisplays().map(d => [d.id, d]));
  const targets = layout.screens.map(s => s.id).filter(id => !Array.isArray(only) || only.includes(id));
  console.log(`\n🧩 Span "${group.name}": ${layout.width}×${layout.height} → ${targets.length} display${targets.length === 1 ? '' : 's'}`);

  const results = await Promise.all(targets.map(async (displayId) => {
    const display = displays.get(displayId);
    const slice = slices.get(displayId);
    setCurrentSource(displayId, slice, SLICE_EDIT);
    const outcome = await deliver(displayId, slice, { ...opts, label: `Spanned across ${group.name}`, source: 'span' });
    return {
      displayId, name: display.name, state: outcome.state, ok: outcome.state === 'delivered',
      ...(outcome.state === 'failed' ? { error: outcome.message } : outcome.state === 'delivered' ? {} : { message: outcome.message }),
    };
  }));
  res.json({
    groupId: group.id,
    sent: results.filter(r => r.state === 'delivered').length,
    queued: results.filter(r => r.state === 'queued').length,
    results,
  });
}));

// ─── Gallery library ────────────────────────────────────────────────────────
// The artwork the UI browses and queues from, as <category>/<name>.jpg. Two
// places make one library: web/.gallery (a folder from the host, read-only in
// Docker) and artwork uploaded in the app, kept with the app's data. An
// uploaded piece can be deleted again; the folder's can't. Thumbnails are
// made on demand and cached on disk.

const GALLERY_DIR = fromEnv('EMDX_GALLERY_DIR', path.join(__dirname, '.gallery'));
const ARTWORK_DIR = path.join(DISPLAYS_DIR, 'artwork');
const GALLERY_THUMBS = CACHE_DIR ? path.join(CACHE_DIR, 'thumbs') : path.join(__dirname, '.gallery-thumbs');
const galleryPart = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) && !s.includes('..');
const isImageFile = (f) => /\.(jpe?g|png|webp)$/i.test(f);

// Lowercase words joined by dashes, safe as a file or category name
function slug(text, fallback = '') {
  const out = String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || fallback;
}

function galleryTitle(file) {
  return file.replace(/\.(jpe?g|png|webp)$/i, '').split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

// The file behind a library id ("category/file.jpg"); uploads first
function galleryFilePath(id) {
  const [category, file, extra] = String(id).split('/');
  if (extra !== undefined || !galleryPart(category) || !galleryPart(file)) return null;
  for (const root of [ARTWORK_DIR, GALLERY_DIR]) {
    const p = path.join(root, category, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function listGallery() {
  const byId = new Map();
  // The folder library first, so an upload with the same id wins
  for (const [root, uploaded] of [[GALLERY_DIR, false], [ARTWORK_DIR, true]]) {
    let cats = [];
    try { cats = fs.readdirSync(root).filter(c => galleryPart(c) && fs.statSync(path.join(root, c)).isDirectory()); }
    catch { continue; }
    for (const cat of cats) {
      for (const f of fs.readdirSync(path.join(root, cat)).filter(f => galleryPart(f) && isImageFile(f))) {
        byId.set(`${cat}/${f}`, { id: `${cat}/${f}`, category: cat, file: f, title: galleryTitle(f), uploaded });
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

app.get('/api/gallery', (_req, res) => res.json({ items: listGallery() }));

app.get('/api/gallery/image/:category/:file', async (req, res) => {
  const { category, file } = req.params;
  const imgPath = galleryFilePath(`${category}/${file}`);
  if (!imgPath) return res.status(galleryPart(category) && galleryPart(file) ? 404 : 400).end();
  res.header('Content-Type', 'image/jpeg');
  res.header('Cache-Control', 'public, max-age=604800');
  const w = parseInt(req.query.w, 10);
  if (Number.isFinite(w) && w > 0 && w <= 1200) {
    const thumbPath = path.join(GALLERY_THUMBS, category, `${file}.w${w}.jpg`);
    try {
      if (!fs.existsSync(thumbPath)) {
        fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
        await sharp(imgPath).rotate().resize({ width: w }).jpeg({ quality: 78 }).toFile(thumbPath);
      }
      return fs.createReadStream(thumbPath).pipe(res);
    } catch { /* fall through to the original */ }
  }
  fs.createReadStream(imgPath).pipe(res);
});

// Adds artwork to the library. Multipart: one or more `images` files and an
// optional `category` (any text; "uploads" when left out). Each is stored as
// a JPEG named after its file. Answers { items } with the new pieces.
const uploadArtwork = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 20 } });
app.post('/api/gallery', uploadArtwork.array('images', 20), handle(async (req, res) => {
  const files = req.files ?? [];
  if (!files.length) throw new RequestError('No images: send them as `images` in a multipart form');
  const category = slug(req.body?.category, 'uploads');
  const dir = path.join(ARTWORK_DIR, category);
  fs.mkdirSync(dir, { recursive: true });
  const added = [], failed = [];
  for (const f of files) {
    let image;
    try { image = await normalizeImage(f.buffer); }
    catch { failed.push(f.originalname); continue; }
    const base = slug(path.parse(f.originalname || '').name, 'artwork');
    let name = `${base}.jpg`;
    for (let n = 2; galleryFilePath(`${category}/${name}`); n++) name = `${base}-${n}.jpg`;
    fs.writeFileSync(path.join(dir, name), image);
    added.push({ id: `${category}/${name}`, category, file: name, title: galleryTitle(name), uploaded: true });
  }
  if (!added.length) throw new RequestError(`Couldn't read ${failed.length === 1 ? 'that image' : 'those images'}. JPEG, PNG, WebP, GIF, TIFF and AVIF work.`);
  console.log(`🖼  Library: +${added.length} in "${category}"${failed.length ? ` (${failed.length} unreadable)` : ''}`);
  res.json({ items: added, failed });
}));

// Removes uploaded artwork. The folder library's pieces can't be deleted here.
app.delete('/api/gallery/:category/:file', handle(async (req, res) => {
  const { category, file } = req.params;
  if (!galleryPart(category) || !galleryPart(file)) throw new RequestError('Not a library item');
  const p = path.join(ARTWORK_DIR, category, file);
  if (!fs.existsSync(p)) {
    throw galleryFilePath(`${category}/${file}`)
      ? new RequestError("That piece is in the library folder, so it can't be deleted from the app", 403)
      : new RequestError('Not found', 404);
  }
  fs.rmSync(p, { force: true });
  const thumbs = path.join(GALLERY_THUMBS, category);
  try { for (const t of fs.readdirSync(thumbs)) if (t.startsWith(`${file}.w`)) fs.rmSync(path.join(thumbs, t), { force: true }); }
  catch { /* no thumbnails */ }
  try { if (!fs.readdirSync(path.join(ARTWORK_DIR, category)).length) fs.rmdirSync(path.join(ARTWORK_DIR, category)); }
  catch { /* still in use */ }
  res.json({ success: true });
}));

// Bulk add gallery items to a display's queue. Body: { ids: ["cat/file.jpg"] }
app.post('/api/displays/:displayId/queue/from-gallery', resolveDisplay, (req, res) => {
  const displayId = req.params.displayId;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'ids array required' });
  ensureDisplayDir(displayId);
  const queue = loadDisplayQueue(displayId);
  let added = 0;
  for (const gid of ids) {
    const src = galleryFilePath(gid);
    if (!src) continue;
    const id = randomUUID();
    const filename = `${id}.jpg`;
    fs.copyFileSync(src, path.join(displayImagesDir(displayId), filename));
    queue.images.push({ id, filename, addedAt: new Date().toISOString(), edit: null, source: gid });
    added++;
  }
  saveDisplayQueue(displayId, queue);
  console.log(`📋 [${displayId.slice(0, 8)}] Queue: +${added} from gallery (${queue.images.length} total)`);
  res.json({ success: true, added, count: queue.images.length });
});

// ─── Per-display: Schedule ──────────────────────────────────────────────────

// How the display gets woken for its schedule: over the network (network
// standby with a MAC address), or by its own wake timer
function scheduleResponse(displayId) {
  const display = getDisplay(displayId);
  const schedule = loadDisplaySchedule(displayId);
  return {
    ...schedule,
    mode: loadDisplayMode(displayId),
    wakeMethod: prefersStandby(displayId) && display?.mac ? 'network' : 'timer',
  };
}

app.get('/api/displays/:displayId/schedule', resolveDisplay, (req, res) => {
  res.json(scheduleResponse(req.params.displayId));
});

// Body (any of): { enabled, by: 'times' | 'interval', times: ["HH:MM", …],
// days: [0-6, Sunday is 0], intervalValue, intervalUnit, between: { from, to } | null }
app.post('/api/displays/:displayId/schedule', resolveDisplay, handle(async (req, res) => {
  const displayId = req.params.displayId;
  const b = req.body ?? {};
  const schedule = loadDisplaySchedule(displayId);
  if (typeof b.enabled === 'boolean') schedule.enabled = b.enabled;
  if (b.by !== undefined) {
    if (!['times', 'interval', 'time'].includes(b.by)) throw new RequestError('by must be times or interval');
    schedule.by = b.by === 'time' ? 'times' : b.by;
  }
  if (b.times !== undefined) {
    const times = Array.isArray(b.times) ? [...new Set(b.times.map(String).filter(t => HHMM.test(t)))].sort() : [];
    if (!times.length) throw new RequestError('Add at least one time, as HH:MM');
    schedule.times = times.slice(0, 48);
  } else if (Number.isInteger(b.hour) && Number.isInteger(b.minute)) {
    // The single time older clients send
    schedule.times = [hhmm(Math.max(0, Math.min(23, b.hour)), Math.max(0, Math.min(59, b.minute)))];
  }
  if (b.days !== undefined) {
    const days = Array.isArray(b.days) ? [...new Set(b.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    if (!days.length) throw new RequestError('Pick at least one day');
    schedule.days = days;
  }
  if (b.intervalValue !== undefined) schedule.intervalValue = Math.max(1, Math.round(Number(b.intervalValue) || 1));
  if (b.intervalUnit !== undefined) {
    if (!Object.hasOwn(INTERVAL_UNIT_MS, b.intervalUnit)) throw new RequestError('intervalUnit must be minutes, hours, days or weeks');
    schedule.intervalUnit = b.intervalUnit;
  }
  if (b.between !== undefined) {
    if (b.between === null) schedule.between = null;
    else if (HHMM.test(b.between?.from ?? '') && HHMM.test(b.between?.to ?? '')) schedule.between = { from: b.between.from, to: b.between.to };
    else throw new RequestError('between needs from and to, as HH:MM');
  }
  // Counting starts again from now
  schedule.nextWakeAt = nextWakeAfter(schedule);
  saveDisplaySchedule(displayId, schedule);
  armSchedule(displayId);
  const next = loadDisplaySchedule(displayId).nextWakeAt;
  console.log(`📅 [${displayId.slice(0, 8)}] Schedule ${schedule.enabled ? 'on' : 'off'}${next ? `, next wake ${new Date(next).toLocaleString()}` : ''}`);
  noteChange('schedule', displayId);
  res.json({ success: true, schedule: scheduleResponse(displayId) });
}));

// Upcoming wake times (epoch ms) — used for "image will display at ..." captions
// Upcoming wake times (epoch ms), for "shows at …" captions
app.get('/api/displays/:displayId/schedule/upcoming', resolveDisplay, (req, res) => {
  const count = Math.max(1, Math.min(100, parseInt(req.query.count, 10) || 10));
  const displayId = req.params.displayId;
  const schedule = loadDisplaySchedule(displayId);
  if (!schedule.enabled || loadDisplayMode(displayId) !== 'scheduled') return res.json({ times: [] });
  res.json({ times: upcomingWakes(schedule, count) });
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

app.post('/api/displays/:displayId/providers/apply', resolveDisplay, handle(async (req, res) => {
  const displayId = req.params.displayId;
  const config = loadDisplayProviders(displayId);
  const provider = getAllDisplayProviders(displayId).find(p => p.id === config.activeProvider);
  if (!provider) throw new RequestError('Active provider not found', 404);
  const result = await fetchFromProvider(provider);
  if (!result.imageUrl) throw new RequestError('Provider returned no image');
  const source = await normalizeImage(await downloadImage(result.imageUrl));
  setCurrentSource(displayId, source, null);
  const opts = sendOptions(req.body);
  // Feed images cover the panel unless asked otherwise
  const rendered = await applyQueueEdit(source, null, req.display, { fit: 'fill', ...opts });
  sendOutcome(res, await deliver(displayId, rendered, { ...opts, label: result.title || provider.name, source: 'feed' }), { title: result.title });
}));

// ─── Per-display: Delivery ──────────────────────────────────────────────────
// The image waiting to reach a display, if any:
// { id, label, source, state: pending | sending | failed, attempts, createdAt,
//   lastAttemptAt, nextAttemptAt, error }

app.get('/api/deliveries', (_req, res) => {
  const out = {};
  for (const d of loadDisplays()) out[d.id] = publicDelivery(loadDelivery(d.id));
  res.json(out);
});

app.get('/api/displays/:displayId/delivery', resolveDisplay, (req, res) => {
  res.json({ delivery: publicDelivery(loadDelivery(req.params.displayId)) });
});

// Tries again now, waking the display as a fresh send would. Answers like a send.
app.post('/api/displays/:displayId/delivery/retry', resolveDisplay, handle(async (req, res) => {
  const displayId = req.params.displayId;
  const delivery = loadDelivery(displayId);
  if (!delivery) throw new RequestError('Nothing is waiting to be sent', 404);
  if (delivery.state === 'sending') return res.status(202).json({ success: true, delivered: false, queued: true, message: 'Already sending', delivery: publicDelivery(delivery) });
  saveDelivery(displayId, { ...delivery, state: 'pending', attempts: 0, nextAttemptAt: Date.now(), error: null });
  const outcome = new Promise(resolve => firstAttempts.set(delivery.id, resolve));
  kickDelivery(displayId);
  sendOutcome(res, sendOptions(req.body).wait ? await outcome : { state: 'queued', delivery: publicDelivery(loadDelivery(displayId)), message: 'Queued' });
}));

// Drops the waiting image. What's on the display stays.
app.delete('/api/displays/:displayId/delivery', resolveDisplay, (req, res) => {
  const delivery = loadDelivery(req.params.displayId);
  if (!delivery) return res.status(404).json({ error: 'Nothing is waiting to be sent' });
  clearDelivery(req.params.displayId);
  settleFirstAttempt(delivery.id, { state: 'failed', delivery: publicDelivery({ ...delivery, state: 'cancelled' }), message: 'Cancelled' });
  console.log(`   🗑  [${req.params.displayId.slice(0, 8)}] Waiting image cancelled`);
  res.json({ success: true });
});

// ─── Per-display: Clock ─────────────────────────────────────────────────────
// What time the display thinks it is: { time (its local time, to the minute),
// serverTime, drift (seconds it's ahead, negative when behind), checkedAt }.
// It's read when the display is awake; asleep, the last reading is returned
// with cached: true. ?wake=1 wakes it to read it fresh.

function clockResponse(displayId, clock, cached) {
  return { ...clock, serverTime: localStamp(new Date()), timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone, cached };
}

app.get('/api/displays/:displayId/clock', resolveDisplay, busyRoute(handle(async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host || !pin) throw new RequestError('It has no IP address or PIN yet');
  try {
    const device = req.query.wake === '1'
      ? await connectWhenAwake({ host, pin, mac, displayId })
      : await (async () => { const d = new Device({ host, mac: mac || undefined, pin }); await d.connect({ timeout: 4_000 }); return d; })();
    const { clock } = await readDisplayClock(device);
    await device.disconnect();
    noteStatus(displayId, { clock });
    res.json(clockResponse(displayId, clock, false));
  } catch (err) {
    if (/Authentication Failed/.test(err.message)) throw new RequestError('The display rejected the PIN', 502);
    const last = statusCache.get(displayId)?.lastClock;
    if (last) return res.json(clockResponse(displayId, last, true));
    throw new RequestError("It's asleep and its clock hasn't been read yet. Add ?wake=1 to wake it.", 409);
  }
})));

// Sets the display's clock to this server's time, waking it first if it can.
app.post('/api/displays/:displayId/clock/sync', resolveDisplay, busyRoute(handle(async (req, res) => {
  const displayId = req.params.displayId;
  const { host, pin, mac } = req.display;
  if (!host || !pin) throw new RequestError('It has no IP address or PIN yet');
  const device = await connectWhenAwake({ host, pin, mac, displayId, waitMs: prefersStandby(displayId) && mac ? WAKE_WAIT_STANDBY_MS : UNWAKEABLE_WAIT_MS })
    .catch(err => { throw new RequestError(`Couldn't reach it: ${describeFailure(err, displayId, req.display).message}`, 409); });
  try {
    await device.setSetting('clock', 'now');
    const { clock } = await readDisplayClock(device);
    noteStatus(displayId, { clock });
    console.log(`🕑 [${displayId.slice(0, 8)}] Clock synced`);
    res.json(clockResponse(displayId, clock, false));
  } finally {
    await device.disconnect().catch(() => {});
  }
  extendSleepTimer(displayId);
})));

// ─── Everything at once ─────────────────────────────────────────────────────
// One call for dashboards and Home Assistant: every display with its status,
// last known battery, clock, waiting image and schedule, and every group. It
// reads what this server already knows, so it never wakes a display.

const lastBattery = new Map();
function lastBatteryReading(id) {
  if (!lastBattery.has(id)) {
    const last = readBatteryLog(id).at(-1);
    lastBattery.set(id, last ? { level: last.level, charging: last.charging, at: last.ts } : null);
  }
  return lastBattery.get(id);
}

function lastImageAt(id) {
  try { return fs.statSync(getDisplayLastImagePath(id)).mtimeMs; } catch { return null; }
}

app.get('/api/state', (_req, res) => {
  const displays = loadDisplays().map(d => {
    const status = statusCache.get(d.id)?.status ?? null;
    const schedule = loadDisplaySchedule(d.id);
    const queue = loadDisplayQueue(d.id);
    return {
      id: d.id,
      name: d.name,
      slug: slug(d.name),
      host: d.host || null,
      connected: !!(d.host && d.pin),
      serialNumber: statusCache.get(d.id)?.info?.serialNumber ?? null,
      softwareVersion: statusCache.get(d.id)?.info?.softwareVersion ?? null,
      orientation: frameOrientation(d),
      awake: !!status,
      sleepMode: prefersStandby(d.id) ? 'standby' : 'deep',
      sleepAt: status?.sleepTimer?.sleepAt ?? null,
      battery: lastBatteryReading(d.id),
      clock: status?.clock ?? statusCache.get(d.id)?.lastClock ?? null,
      lastImageAt: lastImageAt(d.id),
      delivery: publicDelivery(loadDelivery(d.id)),
      queue: { count: queue.images.length, next: queue.images.length ? (queue.currentIndex % queue.images.length) + 1 : null },
      schedule: {
        enabled: schedule.enabled && loadDisplayMode(d.id) === 'scheduled',
        nextWakeAt: schedule.nextWakeAt,
        wakeTimer: schedule.wakeTimer,
      },
    };
  });
  const groups = loadGroups().map(g => ({
    id: g.id, name: g.name, slug: slug(g.name), displayIds: g.displayIds, lastSpanAt: g.span ? Date.parse(g.span.updatedAt) : null,
  }));
  res.json({ server: { address: serverAddress(loadDisplays()[0]?.host) ?? null, port: PORT, time: Date.now() }, displays, groups });
});

// ─── Static frontend (production) ────────────────────────────────────────────

// Every URL in the web app is relative, resolved against the <base> set here.
// That's / on its own, or the path Home Assistant's ingress serves it under
// (the add-on's sidebar panel), which the proxy names in X-Ingress-Path.
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  const indexHtml = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');
  const sendIndex = (req, res) => {
    const prefix = String(req.headers['x-ingress-path'] ?? '').replace(/[^A-Za-z0-9/_.-]/g, '').replace(/\/+$/, '');
    res.header('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml.replace('<head>', `<head>\n    <base href="${prefix}/">`));
  };
  app.get('/', sendIndex);
  app.use(express.static(distPath, { index: false }));
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    sendIndex(req, res);
  });
}

// After a restart: schedules carry on, and waiting images go out again
for (const display of loadDisplays()) {
  armSchedule(display.id);
  const delivery = loadDelivery(display.id);
  if (delivery && delivery.state !== 'failed') {
    saveDelivery(display.id, { ...delivery, state: 'pending', nextAttemptAt: Date.now() + 15_000 });
    console.log(`📬 [${display.id.slice(0, 8)}] "${delivery.label ?? delivery.source}" is still waiting to be sent`);
    kickDelivery(display.id);
  }
}

app.listen(PORT, () => {
  const n = loadDisplays().length;
  console.log(`\n🚀 Samsung EMDX Web Server (${n} display${n !== 1 ? 's' : ''})`);
  console.log(`   Local:   http://localhost:${PORT}`);
  const address = serverAddress(loadDisplays()[0]?.host);
  console.log(`   Network: ${address ? `http://${address}:${PORT}` : 'address not set (Settings in the web UI)'}\n`);
});
