#!/usr/bin/env node
// MDC logging proxy, for working out which commands Samsung's app sends.
//
// Sits between the app and an EMDX display: answers the app the way the
// display does (plaintext MDCSTART<<TLS>>, then TLS with a local self-signed
// certificate), opens its own session to the real display, relays both
// directions and logs every MDC frame decoded. Samsung's app can't add a
// display by IP, so give this machine the display's usual address and move the
// display to a spare one. Then change one setting at a time: type a note and
// press Enter to label the change you're about to make. Ctrl+C prints a
// summary of every command the app wrote.
//
//   node tools/mdc-proxy.mjs --host <display's temporary IP>
//
// Options: --port <listen, 1515>  --display-port <1515>  --log <file.jsonl>
//          --show-pin (log the app's PIN instead of masking it)

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    host: { type: 'string' },
    port: { type: 'string', default: '1515' },
    'display-port': { type: 'string', default: '1515' },
    log: { type: 'string' },
    'show-pin': { type: 'boolean', default: false },
  },
});
if (!args.host) {
  console.error('Usage: node tools/mdc-proxy.mjs --host <display-ip> [--port 1515] [--display-port 1515] [--log file.jsonl] [--show-pin]');
  process.exit(1);
}
const listenPort = parseInt(args.port, 10);
const displayPort = parseInt(args['display-port'], 10);

// From docs/MDC-COMMANDS.md — anything else is flagged NEW, which is what
// we're hunting for
const COMMANDS = {
  0x0B: 'serial number',
  0x0E: 'software version',
  0x10: 'model info',
  0x11: 'power',
  0x1B: 'status',
  0x24: 'unidentified 0x24',
  0x25: 'on-timer',
  0x27: 'color',
  0x67: 'device name',
  0x71: 'picture mode',
  0x96: 'unidentified 0x96',
  0xA7: 'clock',
  0xB5: 'network standby',
  0xB6: 'software update status',
  0xC7: 'content download',
  0x22: 'PoE charging + data',
  0x5F: 'button lock',
};

// Commands whose first data byte selects a setting. A name ending in ? is a
// best guess from a capture; see docs/MDC-COMMANDS.md.
const SUBCOMMANDS = {
  0x1B: { 0x73: 'battery / warning', 0x75: 'USB lock', 0x87: 'PIN', 0xB0: 'screen protector time' },
  0x21: { 0x90: 'wallpaper color' },
  0xC6: { 0x81: 'sleep after' },
  0xC7: { 0x53: 'content / sleep when done', 0x54: 'thumbnail upload', 0x81: 'source' },
  0xC8: { 0x81: 'orientation' },
  0xCA: { 0x40: 'time zone + NTP' },
  0xD2: { 0x10: 'region', 0x20: 'file upload', 0x23: 'restart?', 0x70: 'terms config', 0x71: 'time zone list' },
};

// Sub-command alone is a read for these. Not for 0xD2 in general: 0x23 is an action.
const READ_BY_SUBCOMMAND = new Set([0x1B, 0x21, 0xC6, 0xC7, 0xC8, 0xCA]);
const isRead = (cmd, data) => data.length === 0 || (data.length === 1
  && (READ_BY_SUBCOMMAND.has(cmd) || (cmd === 0xD2 && (data[0] === 0x70 || data[0] === 0x71))));

// Commands known to use a 2-byte length (see nextFrame)
const LONG_FORM = new Set([0xD2]);

// Old-protocol tolerance in case the app's TLS stack is dated
const TLS_COMPAT = { minVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' };

// ─── Output ──────────────────────────────────────────────────────────────────

const tty = process.stdout.isTTY;
const paint = (code) => (s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = paint('2'), yellow = paint('33'), red = paint('31'), magenta = paint('1;35'), cyan = paint('36');

const h2 = (b) => b === undefined ? '0x??' : '0x' + b.toString(16).toUpperCase().padStart(2, '0');
const hex = (buf) => Array.from(buf, b => b.toString(16).padStart(2, '0')).join(' ');
const ascii = (buf) => Array.from(buf, b => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.').join('');
// The terminal gets a preview of large payloads; the log keeps all of it
const PREVIEW_BYTES = 32;
const preview = (buf) => buf.length > PREVIEW_BYTES ? `${hex(buf.subarray(0, PREVIEW_BYTES))} … (${buf.length} bytes)` : hex(buf);
const clock = () => new Date().toTimeString().slice(0, 8) + '.' + String(Date.now() % 1000).padStart(3, '0');
const arrow = (from) => from === 'app' ? cyan('app → display') : 'display → app';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logPath = path.resolve(args.log ?? `mdc-capture-${stamp}.jsonl`);
const logFile = fs.createWriteStream(logPath, { flags: 'a' });

function record(entry, line) {
  logFile.write(JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  console.log(`${dim(clock())}  ${line}`);
}

// ─── MDC framing ─────────────────────────────────────────────────────────────

const checksumOk = (frame) => frame.subarray(1, -1).reduce((s, b) => s + b, 0) % 256 === frame.at(-1);

// Finds the frame at the start of buf, or null if it isn't all here yet. Most
// frames have a 1-byte length, but file uploads use 2 bytes (big-endian) and a
// reply doesn't reveal its command until after the length, so try both forms
// and let the checksum decide.
function nextFrame(buf) {
  if (buf.length < 5) return null;
  const short = { total: 5 + buf[3], isLong: false };
  const long = { total: 6 + ((buf[3] << 8) | buf[4]), isLong: true };
  const forms = LONG_FORM.has(buf[1]) ? [long, short] : [short, long];
  const match = forms.find(f => buf.length >= f.total && checksumOk(buf.subarray(0, f.total)));
  if (match) return match;
  // Neither form fits: show it as a short frame with a bad checksum and move on
  return buf.length >= Math.max(short.total, long.total) ? short : null;
}

// Splits one direction's decrypted stream into MDC frames
// (AA <cmd|FF> <id> <length> <bytes> <checksum>) and text (the PIN, MDCAUTH<<…>>)
function streamParser(onFrame, onText) {
  let buf = Buffer.alloc(0);
  const parse = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length) {
      if (buf[0] === 0xAA) {
        const frame = nextFrame(buf);
        if (!frame) return;
        // Consume before the callback, so one undecodable frame can't jam the
        // stream and take every frame after it with it
        const bytes = buf.subarray(0, frame.total);
        buf = buf.subarray(frame.total);
        onFrame(bytes, frame.isLong);
      } else {
        const next = buf.indexOf(0xAA);
        const text = buf.subarray(0, next === -1 ? buf.length : next);
        // MDCAUTH<<…>> can arrive split across reads
        if (next === -1 && text.toString().startsWith('MDC') && !text.includes('>>')) return;
        buf = buf.subarray(text.length);
        onText(text);
      }
    }
  };
  // Whatever never formed a complete frame is still worth seeing
  parse.flush = () => {
    if (buf.length) onText(buf);
    buf = Buffer.alloc(0);
  };
  return parse;
}

function describeFrame(frame, isLong) {
  const ok = checksumOk(frame);
  const start = isLong ? 5 : 4; // first byte after the length
  if (frame[1] === 0xFF) {
    // AA FF <id> <length> <A|N> <cmd> <data…> <checksum>
    const ack = frame[start];
    const op = ack === 0x41 ? 'ACK' : ack === 0x4E ? 'NAK' : h2(ack);
    return { id: frame[2], cmd: frame[start + 1], op, data: frame.subarray(start + 2, -1), checksumOk: ok };
  }
  // AA <cmd> <id> <length> <data…> <checksum>
  const [, cmd, id] = frame;
  const data = frame.subarray(start, -1);
  return { id, cmd, op: isRead(cmd, data) ? 'GET' : 'SET', data, checksumOk: ok };
}

// 0xD2/0x20 upload: 20 <3 bytes, meaning unknown> <name length> <name> <size, 2 bytes> <file>
function uploadedFile(data) {
  if (data[0] !== 0x20 || data.length < 5) return '';
  const nameEnd = 5 + data[4];
  if (data.length < nameEnd + 2) return '';
  return `  file "${data.subarray(5, nameEnd)}" (${data.readUInt16BE(nameEnd)} bytes)`;
}

function commandName(cmd, data) {
  const subs = SUBCOMMANDS[cmd];
  if (subs && data.length) return subs[data[0]] ?? `${h2(cmd)}/${h2(data[0])} NEW`;
  return COMMANDS[cmd] ?? 'NEW';
}

const writes = new Map(); // "0x5D NEW" → Set of data hex values seen

function logPin(conn, from, pin) {
  const show = args['show-pin'];
  record({ conn, from, type: 'pin', pin: show ? pin : null, length: pin.length },
    `[${conn}] ${arrow(from)}  PIN ${show ? pin : '*'.repeat(pin.length)}`);
}

function logFrame(conn, from, frame, isLong) {
  const f = describeFrame(frame, isLong);
  // The display can be asked to read its own PIN back
  if (f.cmd === 0x1B && f.data[0] === 0x87 && f.data.length > 1) {
    logPin(conn, from, f.data.subarray(1).toString());
    return;
  }
  const name = commandName(f.cmd, f.data);
  if (from === 'app' && f.op === 'SET') {
    const key = `${h2(f.cmd)} ${name}`;
    if (!writes.has(key)) writes.set(key, new Set());
    writes.get(key).add(preview(f.data));
  }
  const op = f.op === 'SET' ? yellow('SET') : f.op === 'NAK' ? red('NAK') : f.op === 'GET' ? dim('GET') : f.op;
  const label = name.includes('NEW') ? magenta(name.padEnd(24)) : name.padEnd(24);
  const upload = f.cmd === 0xD2 && f.op === 'SET' && from === 'app' ? uploadedFile(f.data) : '';
  const text = f.data.length ? dim(`  "${ascii(f.data.subarray(0, PREVIEW_BYTES))}"`) : '';
  record(
    { conn, from, type: 'frame', op: f.op, cmd: h2(f.cmd), name, id: f.id, data: hex(f.data), ascii: ascii(f.data), raw: hex(frame), long: isLong, checksumOk: f.checksumOk },
    `[${conn}] ${arrow(from)}  ${op} ${h2(f.cmd)} ${label} ${preview(f.data)}${upload || text}${f.checksumOk ? '' : red('  bad checksum')}`,
  );
}

function logText(conn, from, buf) {
  const s = buf.toString();
  // The app authenticates with MDCAUTH<<pin>>; lib/Device.mjs sends the bare PIN
  const pin = from === 'app' ? s.match(/^MDCAUTH<<(.+)>>$/)?.[1] ?? s.match(/^\d{4,8}$/)?.[0] : null;
  if (pin) {
    logPin(conn, from, pin);
    return;
  }
  const shown = s.length > 200 ? `${s.slice(0, 200)}… (${buf.length} bytes)` : s;
  record({ conn, from, type: 'text', text: s, raw: hex(buf) }, `[${conn}] ${arrow(from)}  ${JSON.stringify(shown)}`);
}

// ─── TLS identity presented to the app ───────────────────────────────────────

// The app sees this self-signed cert instead of the display's own. If it
// refuses to connect, it's validating or pinning the display's certificate.
function loadCert() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.mdc-proxy');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
        '-out', certPath, '-days', '3650', '-subj', '/CN=Samsung EMDX'], { stdio: 'ignore' });
    } catch {
      console.error(`Couldn't run openssl to create the proxy's certificate in ${dir}.\n`
        + 'Install openssl, or run this once on a machine that has it (the cert is reused afterwards).');
      process.exit(1);
    }
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}
const secureContext = tls.createSecureContext({ ...loadCert(), ...TLS_COMPAT });

// ─── Proxy ───────────────────────────────────────────────────────────────────

let connCount = 0;

const server = net.createServer(app => {
  const conn = ++connCount;
  const event = (msg) => record({ conn, type: 'event', msg }, `[${conn}] ${dim(msg)}`);
  event(`app ${app.remoteAddress?.replace('::ffff:', '')}:${app.remotePort} connected — opening ${args.host}:${displayPort}`);

  let appTls = null;
  let displayTls = null;
  let parsers = [];
  let closed = false;
  const close = (why) => {
    if (closed) return;
    closed = true;
    parsers.forEach(parse => parse.flush());
    event(why);
    appTls?.destroy();
    displayTls?.destroy();
    app.destroy();
    display.destroy();
  };

  const display = net.connect({ host: args.host, port: displayPort });
  display.setTimeout(10_000, () => close('display did not answer within 10s (asleep?) — dropping the app connection'));
  display.on('error', err => close(`display connection error: ${err.message}`));
  display.on('close', () => close('display closed the connection'));
  app.on('error', err => close(`app connection error: ${err.message}`));
  app.on('close', () => close('app closed the connection'));

  // The display opens with a plaintext MDCSTART<<TLS>>, then expects a TLS
  // ClientHello on the same socket. Finish our TLS session with the display
  // first, so a display that refuses us looks like a refusal to the app too.
  display.once('data', preamble => {
    display.setTimeout(0);
    logText(conn, 'display', preamble);
    displayTls = tls.connect({ socket: display, rejectUnauthorized: false, ...TLS_COMPAT }, () => {
      const cert = displayTls.getPeerCertificate();
      event(`display TLS ${displayTls.getProtocol()} ${displayTls.getCipher()?.name}; cert CN=${cert?.subject?.CN ?? '?'} sha256 ${cert?.fingerprint256 ?? '?'}`);

      app.write(preamble);
      appTls = new tls.TLSSocket(app, { isServer: true, secureContext });
      let appSecure = false;
      appTls.on('secure', () => {
        appSecure = true;
        event(`app TLS ${appTls.getProtocol()} ${appTls.getCipher()?.name}`);
      });
      appTls.on('error', err => close(appSecure
        ? `app connection lost: ${err.message}`
        : `app TLS error: ${err.message} — the app may be rejecting the proxy's certificate`));

      const fromApp = streamParser((f, isLong) => logFrame(conn, 'app', f, isLong), t => logText(conn, 'app', t));
      const fromDisplay = streamParser((f, isLong) => logFrame(conn, 'display', f, isLong), t => logText(conn, 'display', t));
      parsers = [fromApp, fromDisplay];

      // Relay first: a decoding failure must never cost the app its session
      const decode = (parse, chunk) => {
        try { parse(chunk); } catch (err) { event(`couldn't decode ${chunk.length} bytes: ${err.message}`); }
      };
      appTls.on('data', d => { displayTls.write(d); decode(fromApp, d); });
      displayTls.on('data', d => { appTls.write(d); decode(fromDisplay, d); });
    });
    displayTls.on('error', err => close(`display TLS error: ${err.message}`));
  });
});

server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${listenPort} is already in use.` : err.message);
  process.exit(1);
});

server.listen(listenPort, () => {
  const ips = Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) => addrs.filter(a => a.family === 'IPv4' && !a.internal).map(a => `${a.address} (${name})`));
  console.log(`MDC proxy listening on port ${listenPort} → display ${args.host}:${displayPort}`);
  console.log(`This machine needs the display's usual IP so the app finds the proxy. It has: ${ips.join(', ') || 'no LAN address found'}`);
  console.log(`Logging to ${logPath}`);
  console.log(dim('Type a note + Enter to label the next change (empty line = numbered mark). Ctrl+C for a summary.\n'));
});

// ─── Notes and summary ───────────────────────────────────────────────────────

if (process.stdin.isTTY) {
  let mark = 0;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const note = line.trim() || `mark ${++mark}`;
    record({ type: 'note', note }, magenta(`──── ${note} ────`));
  });
}

// SIGTERM too, so `docker stop` also prints the summary
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nCommands the app wrote this session:`);
    if (!writes.size) console.log('  (none)');
    for (const [cmd, values] of writes) console.log(`  ${cmd.padEnd(30)} ${[...values].join('  |  ')}`);
    console.log(`\nFull log: ${logPath}`);
    logFile.end(() => process.exit(0));
  });
}
