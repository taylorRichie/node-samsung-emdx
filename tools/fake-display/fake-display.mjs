#!/usr/bin/env node
// Fake Samsung EMDX e-paper display: MDC over TLS on TCP 1515.
//
// Speaks the display's side of what lib/Device.mjs expects:
//   plaintext MDCSTART<<TLS>>, TLS upgrade (self-signed cert), PIN,
//   MDCAUTH<<PASS>> / MDCAUTH<<FAIL:0x01>>, then MDC frames.
// Replies are modelled on the captures in the project (firmware S-RSEDWWC-1130.7).
// On 0xC7/0x53/0x80 (content download) it fetches content.json, downloads each
// image_url and saves it to $OUT as <ISO timestamp>.jpg.
//
// Node built-ins only. Env:
//   PIN            expected PIN (default 123456)
//   PORT           listen port (default 1515)
//   OUT            where downloaded images go (default /out)
//   NAME           device name reported by 0x67 (default: hostname)
//   SERIAL         serial number reported by 0x0B (default derived from NAME)
//   CERT, KEY      PEM files (default /fake/certs/cert.pem, key.pem)
//   ORIENTATION    portrait | landscape (default portrait)
//   BATTERY        battery level percent (default 73)
//   POWER_GET_NAK  1 = NAK a power-state get like real hardware (default: ACK with the state)
//   REPLY_DELAY_MS delay before each reply (default 30)
//   PROGRESS       0 = don't POST /content-transfer-progress (default 1, as the real display does)

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const env = process.env;
const PIN = env.PIN ?? '123456';
const PORT = parseInt(env.PORT ?? '1515', 10);
const OUT = env.OUT ?? '/out';
const NAME = env.NAME ?? os.hostname();
const SERIAL = env.SERIAL ?? `0WPSFAKE${NAME.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(-7).padStart(7, '0')}`;
const CERT = env.CERT ?? '/fake/certs/cert.pem';
const KEY = env.KEY ?? '/fake/certs/key.pem';
const REPLY_DELAY_MS = parseInt(env.REPLY_DELAY_MS ?? '30', 10);
const POWER_GET_NAK = env.POWER_GET_NAK === '1';
const PROGRESS = env.PROGRESS !== '0';

// ─── Display state (in memory, lost on restart) ───────────────────────────────

const state = {
  power: true,
  networkStandby: false,
  battery: Math.max(0, Math.min(100, parseInt(env.BATTERY ?? '73', 10))),
  batteryWarning: true,
  orientation: env.ORIENTATION === 'landscape' ? 0x00 : 0x01, // 0xC8/0x81: 00 landscape, 01 portrait
  source: 0x04, // 0xC7/0x81: 03 usb, 04 default
  sleepWhenContentDone: 0x00,
  sleepAfter: [0x08], // 0xC6/0x81 reply after 81
  wallpaperColor: 0x00,
  brightness: 0x00, // 0x21/0x4F
  contrast: 0x32, // 0x24
  gamma: 0x00, // 0x96
  color: 0x19, // 0x27
  pictureMode: 0x24, // 0x71
  buttonLock: 0x00,
  usbLock: 0x00,
  deviceName: NAME,
  pin: PIN,
  onTimer: [0x00],
  clockOffsetMs: 0, // set by 0xA7 writes
  ntp: { flag: 0x00, server: 'Null', zone: env.TZ || 'Etc/UTC' },
  protector: [0x03, 0x00],
};

const SOFTWARE_VERSION = 'S-RSEDWWC-1130.7';
const MODEL_INFO = [0x02, 0x7A, 0x01];
const TIME_ZONES = ['Africa/Casablanca', 'America/Chicago', 'America/New_York', 'Europe/London', 'Etc/UTC'];

// ─── Logging ──────────────────────────────────────────────────────────────────

const clock = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`${clock()} [${NAME}]`, ...a);
const h2 = b => '0x' + b.toString(16).toUpperCase().padStart(2, '0');
const hex = buf => Array.from(buf, b => b.toString(16).padStart(2, '0')).join(' ');
const short = buf => (buf.length > 40 ? `${hex(buf.subarray(0, 40))} … (${buf.length} bytes)` : hex(buf));
const ascii = buf => Array.from(buf, b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');

// ─── MDC framing (mirrors lib/Util.mjs) ───────────────────────────────────────

const HEADER = 0xAA;
const RESPONSE = 0xFF;
const ACK = 0x41;
const NAK = 0x4E;
const LONG_FRAME_COMMANDS = new Set([0xD2]);
const checksum = bytes => bytes.reduce((s, b) => s + b, 0) % 256;

// Command frame from the app: AA <cmd> <id> <len> <data> <chk>,
// or for 0xD2: AA D2 <id> <lenHi> <lenLo> <data> <chk>. The checksum decides
// if the expected form doesn't fit.
function nextFrame(buf) {
  if (buf.length < 5) return null;
  const shortF = { total: 5 + buf[3], isLong: false };
  const longF = { total: 6 + ((buf[3] << 8) | buf[4]), isLong: true };
  const ok = ({ total }) => buf.length >= total && checksum(buf.subarray(1, total - 1)) === buf[total - 1];
  const forms = LONG_FRAME_COMMANDS.has(buf[1]) ? [longF, shortF] : [shortF, longF];
  const match = forms.find(ok);
  if (match) return match;
  // Neither form fits once both could be complete: drop it as the expected form
  return buf.length >= Math.max(shortF.total, longF.total) ? { ...forms[0], bad: true } : null;
}

// Reply: AA FF <id> <len> <A|N> <cmd> <payload> <chk>; 0xD2 uses a 2-byte length.
function buildReply(id, cmd, payload, { nak = false } = {}) {
  let data = Buffer.from(payload);
  const isLong = LONG_FRAME_COMMANDS.has(cmd);
  if (!isLong && data.length + 2 > 255) data = data.subarray(0, 1); // keep a short frame valid
  const body = [nak ? NAK : ACK, cmd, ...data];
  const head = isLong ? [RESPONSE, id, body.length >> 8, body.length & 0xFF] : [RESPONSE, id, body.length];
  const bytes = [...head, ...body];
  return Buffer.from([HEADER, ...bytes, checksum(bytes)]);
}

// ─── Command handlers ─────────────────────────────────────────────────────────

const str = s => [...Buffer.from(s, 'ascii')];
const lp = s => [Buffer.byteLength(s), ...str(s)]; // length-prefixed ASCII

function displayNow() {
  return new Date(Date.now() + state.clockOffsetMs);
}

// [day, hour (12h), minute, month, yearHi, yearLo, am/pm]: 00 = PM, 01 = AM (see lib/Settings.mjs)
function clockBytes(d = displayNow()) {
  const h = d.getHours();
  const y = d.getFullYear();
  return [d.getDate(), h % 12 || 12, d.getMinutes(), d.getMonth() + 1, y >> 8, y & 0xFF, h < 12 ? 0x01 : 0x00];
}

function setClock(r) {
  if (r.length < 7) return;
  const hour = (r[1] % 12) + (r[6] === 0x00 ? 12 : 0);
  const target = new Date((r[4] << 8) | r[5], r[3] - 1, r[0], hour, r[2], 0);
  if (!Number.isNaN(target.getTime())) state.clockOffsetMs = target.getTime() - Date.now();
}

function ntpBytes() {
  const { flag, server, zone } = state.ntp;
  return [0x40, 0x00, flag, 0x80, ...lp(server), 0x81, ...lp(zone)];
}

// Each handler gets the frame's data and returns { name, payload, nak?, after? }.
// `after` runs once the reply is sent.
const HANDLERS = {
  0x0B: () => ({ name: 'serial number', payload: str(SERIAL) }),
  0x0E: () => ({ name: 'software version', payload: str(SOFTWARE_VERSION) }),
  0x10: () => ({ name: 'model info', payload: MODEL_INFO }),

  0x11: d => {
    if (!d.length) {
      if (POWER_GET_NAK) return { name: 'power get (NAK, like hardware)', payload: [0x01], nak: true };
      return { name: 'power get', payload: [state.power ? 0x01 : 0x00] };
    }
    state.power = d[0] === 0x01;
    return { name: `power ${state.power ? 'ON' : 'OFF'}${state.power ? '' : ' (simulated; stays reachable)'}`, payload: [d[0]] };
  },

  0x1B: d => {
    const sub = d[0];
    switch (sub) {
      case 0x73:
        if (d.length > 1) { state.batteryWarning = d[2] === 0x01; return { name: 'battery warning set', payload: [...d] }; }
        return { name: 'battery', payload: [0x73, 0x00, state.batteryWarning ? 0x01 : 0x00, 0x01, state.battery, 0x02, 0x00] };
      case 0x75:
        if (d.length > 1) { state.usbLock = d[2] ?? 0; return { name: 'USB lock set', payload: [...d] }; }
        return { name: 'USB lock', payload: [0x75, 0x00, state.usbLock] };
      case 0x87:
        if (d.length > 1) { state.pin = Buffer.from(d.subarray(1)).toString(); return { name: 'PIN set (not applied to auth)', payload: [...d] }; }
        return { name: 'PIN', payload: [0x87, ...str(state.pin)] };
      case 0xB0:
        if (d.length === 3 && d[1] === 0x00) return { name: 'daily refresh / picture refresh', payload: [0xB0, 0x00, 0x00] };
        if (d.length > 1 && d[1] === 0x80) { state.protector = [d[3] ?? 0, d[4] ?? 0]; return { name: 'screen protector time set', payload: [...d] }; }
        return { name: 'screen protector time', payload: [0xB0, 0x80, 0x02, ...state.protector, 0x81, 0x04, ...state.protector, 0x04, 0x0B] };
      case 0x71: return { name: 'PoE+', payload: [0x71, 0x00] };
      case 0x8C: return { name: 'network setting', payload: [0x8C, 0x01] };
      case 0x8D: return { name: '0x1B/0x8D', payload: [0x8D, 0x01] };
      case 0x61: return { name: 'software update progress', payload: [0x61, 0x00] };
      case 0x62: return { name: 'software update result', payload: [0x62, ...str('Unknown')] };
      default: return { name: `0x1B/${sub === undefined ? '-' : h2(sub)} (generic)`, payload: d.length > 1 ? [...d] : [sub ?? 0x00, 0x00], unknown: true };
    }
  },

  0x21: d => {
    if (d[0] === 0x90) {
      if (d.length > 2) { state.wallpaperColor = d[2]; return { name: 'wallpaper color set', payload: [...d] }; }
      return { name: 'wallpaper color', payload: [0x90, 0x00, state.wallpaperColor] };
    }
    if (d[0] === 0x4F) {
      if (d.length > 1) { state.brightness = d[1]; return { name: 'brightness set', payload: [...d] }; }
      return { name: 'brightness', payload: [0x4F, state.brightness] };
    }
    return { name: '0x21 (generic)', payload: d.length ? [...d] : [0x00], unknown: true };
  },

  0x22: d => ({ name: 'turn on Bluetooth setup', payload: [...d] }),
  0x24: d => (d.length ? (state.contrast = d[0], { name: 'contrast set', payload: [d[0]] }) : { name: 'contrast', payload: [state.contrast] }),
  0x25: d => (d.length ? (state.onTimer = [...d], { name: 'on-timer set (ACKed; real 1130.7 NAKs this)', payload: [...d] }) : { name: 'on-timer', payload: [state.onTimer[0]] }),
  0x27: d => (d.length ? (state.color = d[0], { name: 'color set', payload: [d[0]] }) : { name: 'color', payload: [state.color] }),
  0x5F: d => (d.length ? (state.buttonLock = d[0], { name: 'button lock set', payload: [d[0]] }) : { name: 'button lock', payload: [state.buttonLock] }),
  0x67: d => (d.length ? (state.deviceName = Buffer.from(d).toString(), { name: 'device name set', payload: [...d] }) : { name: 'device name', payload: str(state.deviceName) }),
  0x71: d => (d.length ? (state.pictureMode = d[0], { name: 'picture mode set', payload: [d[0]] }) : { name: 'picture mode', payload: [state.pictureMode] }),
  0x96: d => (d.length ? (state.gamma = d[0], { name: 'gamma set', payload: [d[0]] }) : { name: 'gamma', payload: [state.gamma] }),
  0xA7: d => (d.length ? (setClock(d), { name: 'clock set', payload: [...d] }) : { name: 'clock', payload: clockBytes() }),

  0xB5: d => {
    if (d.length) { state.networkStandby = d[0] === 0x01; return { name: `network standby ${state.networkStandby ? 'on' : 'off'}`, payload: [d[0]] }; }
    return { name: 'network standby', payload: [state.networkStandby ? 0x01 : 0x00] };
  },
  0xB6: () => ({ name: 'DST', payload: [0x00, 0x0B, 0x00, 0x00, 0x00, 0x00, 0x0B, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] }),

  0xC6: d => {
    if (d[0] === 0x81 && d.length > 1) { state.sleepAfter = [...d.subarray(1)]; return { name: 'sleep after set', payload: [...d] }; }
    return { name: 'sleep after', payload: [0x81, ...state.sleepAfter] };
  },

  0xC7: d => {
    const sub = d[0];
    if (sub === 0x53 && d[1] === 0x80) {
      const len = d[2];
      const url = Buffer.from(d.subarray(3, 3 + len)).toString();
      return { name: `CONTENT DOWNLOAD ${url}`, payload: [...d], after: () => downloadContent(url) };
    }
    if (sub === 0x53) {
      if (d.length > 2) { state.sleepWhenContentDone = d[2]; return { name: 'sleep when content done set', payload: [...d] }; }
      return { name: 'sleep when content done', payload: [0x53, 0x01, state.sleepWhenContentDone] };
    }
    if (sub === 0x81) {
      if (d.length > 1) { state.source = d[1]; return { name: 'source set', payload: [...d] }; }
      return { name: 'source', payload: [0x81, state.source] };
    }
    if (sub === 0x54) {
      const url = Buffer.from(d.subarray(1));
      return { name: 'thumbnail upload', payload: [0x54, url.length, ...url] };
    }
    if (sub === 0x50) return { name: 'USB slideshow', payload: [0x50, 0x00, 0x00, 0x80, 0x02, 0x04, 0x00] };
    return { name: `0xC7/${sub === undefined ? '-' : h2(sub)} (generic)`, payload: d.length ? [...d] : [0x00], unknown: true };
  },

  0xC8: d => {
    if (d[0] === 0x81 && d.length > 1) { state.orientation = d[1]; return { name: `orientation set ${d[1] ? 'portrait' : 'landscape'}`, payload: [...d] }; }
    return { name: 'orientation', payload: [0x81, state.orientation] };
  },

  0xCA: d => {
    if (d[0] === 0x40 && d.length > 3) {
      const t = { flag: d[2], server: '', zone: '' };
      for (let i = 3; i + 2 <= d.length; i += 2 + d[i + 1]) {
        const v = Buffer.from(d.subarray(i + 2, i + 2 + d[i + 1])).toString();
        if (d[i] === 0x80) t.server = v;
        if (d[i] === 0x81) t.zone = v;
      }
      state.ntp = t;
      return { name: 'time zone + NTP set', payload: [...d] };
    }
    return { name: 'time zone + NTP', payload: ntpBytes() };
  },

  0xD2: d => {
    const sub = d[0];
    switch (sub) {
      case 0x71: return { name: 'time zone list', payload: [0x71, 0x00, TIME_ZONES.length, ...TIME_ZONES.flatMap(lp)] };
      case 0x70: return { name: 'terms config', payload: [0x70, 0x00, 0x00, 0x00, ...str('{"HEADER":[],"URL":""}')] };
      case 0x10: return { name: 'factory menu / region', payload: [0x10, ...str('4:1:1:US')] };
      case 0x20: {
        let file = '';
        if (d.length > 5) file = Buffer.from(d.subarray(5, 5 + d[4])).toString();
        return { name: `file upload${file ? ` "${file}"` : ''}`, payload: [0x20] };
      }
      case 0x23: return { name: 'restart (ignored)', payload: [0x23] };
      default: return { name: `0xD2/${sub === undefined ? '-' : h2(sub)} (generic)`, payload: sub === undefined ? [0x00] : [sub], unknown: true };
    }
  },
};

function handleCommand(cmd, data) {
  const handler = HANDLERS[cmd];
  if (handler) return handler(data);
  // Unknown command: ACK generically, echoing what a set sent or 00 for a get
  return { name: `UNKNOWN ${h2(cmd)}`, payload: data.length ? [...data] : [0x00], unknown: true };
}

// ─── Content download ─────────────────────────────────────────────────────────

function request(url, { method = 'GET', body = null, headers = {}, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers, timeout, rejectUnauthorized: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeout / 1000}s`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Width/height from the first SOF marker
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { i += 2; continue; }
    if (m === 0xD9 || m === 0xDA) return null;
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

let lastStamp = '';
function outputName() {
  // ISO timestamp, with ':' → '-' so the name is safe in Finder and shells
  let stamp = new Date().toISOString().replace(/:/g, '-');
  if (stamp === lastStamp || fs.existsSync(path.join(OUT, `${stamp}.jpg`))) {
    let n = 2;
    while (fs.existsSync(path.join(OUT, `${stamp}-${n}.jpg`))) n++;
    stamp = `${stamp}-${n}`;
  }
  lastStamp = stamp;
  return `${stamp}.jpg`;
}

async function postProgress(origin, body) {
  if (!PROGRESS) return;
  try {
    await request(`${origin}/content-transfer-progress`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, timeout: 3_000,
    });
  } catch { /* the real display ignores failures too */ }
}

async function downloadContent(contentUrl) {
  const started = Date.now();
  log(`⬇  fetching manifest ${contentUrl}`);
  let manifest;
  try {
    const res = await request(contentUrl);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.toString().slice(0, 200)}`);
    manifest = JSON.parse(res.body.toString());
  } catch (err) {
    log(`✗ manifest fetch failed: ${err.message}`);
    return;
  }

  const contents = (manifest.schedule ?? []).flatMap(entry => (entry.contents ?? []).map(c => ({ ...c, entry })));
  const seen = new Set();
  const items = contents.filter(c => c.image_url && !seen.has(c.image_url) && seen.add(c.image_url));
  log(`   manifest id=${manifest.id ?? '?'} entries=${manifest.schedule?.length ?? 0} images=${items.length}`
    + (manifest.schedule?.[0] ? ` start=${manifest.schedule[0].start_date} ${manifest.schedule[0].start_time}` : ''));

  const origin = new URL(contentUrl).origin;
  fs.mkdirSync(OUT, { recursive: true });
  let done = 0;
  for (const item of items) {
    try {
      const res = await request(item.image_url, { timeout: 60_000 });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const file = outputName();
      fs.writeFileSync(path.join(OUT, file), res.body);
      const size = jpegSize(res.body);
      const dims = size ? `${size.width}x${size.height}` : 'unknown dimensions (not a baseline/progressive JPEG?)';
      log(`✔  saved ${file}  ${res.body.length} bytes  ${dims}  (${res.headers['content-type'] ?? '?'}, from ${item.image_url})`);
      fs.appendFileSync(path.join(OUT, 'index.jsonl'), JSON.stringify({
        file, bytes: res.body.length, width: size?.width ?? null, height: size?.height ?? null,
        image_url: item.image_url, content_url: contentUrl, manifest_id: manifest.id ?? null,
        file_name: item.file_name ?? null, start: `${item.entry.start_date} ${item.entry.start_time}`,
        saved_at: new Date().toISOString(),
      }) + '\n');
      done++;
      await postProgress(origin, {
        content_id: manifest.id, content_name: manifest.name, device_id: SERIAL,
        current_image_status: { image_id: item.file_id, image_name: item.file_name, progress: '100', status: 'Successful', error_message: '' },
        progress: String(Math.round((done / items.length) * 100)), status: done === items.length ? 'Successful' : 'Downloading', error_message: '',
      });
    } catch (err) {
      log(`✗ image download failed (${item.image_url}): ${err.message}`);
    }
  }
  log(`   content download finished: ${done}/${items.length} saved in ${Date.now() - started} ms`);
}

// ─── Server ───────────────────────────────────────────────────────────────────

const secureContext = tls.createSecureContext({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) });
let connCount = 0;

const server = net.createServer(socket => {
  const conn = ++connCount;
  const peer = `${socket.remoteAddress?.replace('::ffff:', '')}:${socket.remotePort}`;
  const clog = (...a) => log(`#${conn}`, ...a);
  clog(`connect from ${peer}`);
  socket.on('error', err => clog(`socket error: ${err.message}`));

  // Plaintext preamble, then TLS on the same socket (as tools/mdc-proxy.mjs does)
  socket.write('MDCSTART<<TLS>>');
  const tlsSock = new tls.TLSSocket(socket, { isServer: true, secureContext });
  tlsSock.on('error', err => clog(`TLS error: ${err.message}`));
  tlsSock.on('secure', () => clog(`TLS ${tlsSock.getProtocol()} ${tlsSock.getCipher()?.name}`));
  tlsSock.on('close', () => clog('closed'));

  let authed = false;
  let buf = Buffer.alloc(0);
  let queue = Promise.resolve();

  tlsSock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);

    if (!authed) {
      // The library sends the bare PIN; Samsung's app sends MDCAUTH<<pin>>
      const text = buf.toString('latin1');
      if (text.startsWith('MDCAUTH<<') && !text.includes('>>')) return;
      const end = text.startsWith('MDCAUTH<<') ? text.indexOf('>>') + 2 : (buf.indexOf(HEADER) === -1 ? buf.length : buf.indexOf(HEADER));
      const raw = text.slice(0, end);
      buf = buf.subarray(end);
      const pin = raw.match(/^MDCAUTH<<(.*)>>$/)?.[1] ?? raw.trim();
      if (pin === PIN) {
        authed = true;
        clog('auth PASS');
        tlsSock.write('MDCAUTH<<PASS>>');
      } else {
        clog(`auth FAIL (got ${pin.length}-char PIN)`);
        tlsSock.write('MDCAUTH<<FAIL:0x01>>');
        setTimeout(() => tlsSock.destroy(), 200);
        return;
      }
    }

    while (buf.length) {
      if (buf[0] !== HEADER) {
        const next = buf.indexOf(HEADER);
        const junk = buf.subarray(0, next === -1 ? buf.length : next);
        clog(`ignoring ${junk.length} non-frame bytes: ${short(junk)} "${ascii(junk.subarray(0, 40))}"`);
        buf = buf.subarray(junk.length);
        continue;
      }
      const f = nextFrame(buf);
      if (!f) return;
      const frame = buf.subarray(0, f.total);
      buf = buf.subarray(f.total);
      if (f.bad) { clog(`bad checksum, dropping frame ${short(frame)}`); continue; }

      const cmd = frame[1];
      const id = frame[2];
      const data = Buffer.from(frame.subarray(f.isLong ? 5 : 4, -1));
      // Replies go out in order, one at a time
      queue = queue.then(async () => {
        let r;
        try {
          r = handleCommand(cmd, data);
        } catch (err) {
          r = { name: `handler error: ${err.message}`, payload: [0x00], nak: true };
        }
        if (REPLY_DELAY_MS > 0) await new Promise(res => setTimeout(res, REPLY_DELAY_MS));
        const reply = buildReply(id, cmd, r.payload, { nak: r.nak });
        clog(`${h2(cmd)}${f.isLong ? ' (long)' : ''} ${data.length ? short(data) : '(no data)'}  → ${r.nak ? 'NAK' : 'ACK'} ${short(Buffer.from(r.payload))}  [${r.name}]${r.unknown ? '  ⚠ unrecognised, generic ACK' : ''}`);
        if (!tlsSock.destroyed) tlsSock.write(reply);
        if (r.after) setImmediate(() => r.after().catch(err => log(`✗ ${err.message}`)));
      });
    }
  });
});

server.on('error', err => {
  console.error(`listen error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  log(`fake EMDX listening on :${PORT}  name="${NAME}" serial=${SERIAL} pin=${'*'.repeat(PIN.length)} out=${OUT} orientation=${state.orientation ? 'portrait' : 'landscape'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log(`${sig}, exiting`); process.exit(0); });
