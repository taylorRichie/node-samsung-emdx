import dgram from 'node:dgram';
import net from 'node:net';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const MDC_PORT = 1515;

// EMDX displays advertise as a DLNA MediaRenderer via Samsung's UPnP SDK
const M_SEARCH = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  'MX: 2',
  'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
  '', '',
].join('\r\n');

function parseSsdpHeaders(message) {
  const headers = {};
  for (const line of message.toString().split('\r\n').slice(1)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function xmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

async function isPortOpen(host, port, timeout = 2_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function normalizeMac(mac) {
  return mac
    .split(/[:-]/)
    .map(part => part.padStart(2, '0'))
    .join(':')
    .toUpperCase();
}

// Look up a MAC in the OS ARP cache. The SSDP exchange has just populated it.
async function lookupMac(host) {
  const macRegex = /(?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i;

  // Linux: /proc/net/arp needs no external binaries
  try {
    const arpTable = fs.readFileSync('/proc/net/arp', 'utf-8');
    for (const line of arpTable.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === host && macRegex.test(cols[3])) return normalizeMac(cols[3]);
    }
  } catch { /* not Linux — fall through to arp(8) */ }

  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('arp', ['-n', host], { timeout: 5_000 }, (err, out) => {
        if (err) return reject(err);
        resolve(out);
      });
    });
    const match = stdout.match(macRegex);
    if (match) return normalizeMac(match[0]);
  } catch { /* no arp binary or no entry */ }

  return null;
}

async function fetchDeviceDescription(location) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(location, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Broadcast an SSDP M-SEARCH and collect unique response locations per host
async function ssdpSearch({ timeout = 4_000 } = {}) {
  const responses = new Map(); // host -> { location, server }

  const socket = dgram.createSocket('udp4');
  socket.on('message', (message, rinfo) => {
    const headers = parseSsdpHeaders(message);
    if (!headers.location) return;
    if (!responses.has(rinfo.address)) {
      responses.set(rinfo.address, { location: headers.location, server: headers.server || '' });
    }
  });

  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(() => resolve());
  });

  const packet = Buffer.from(M_SEARCH);
  const sendSearch = () => socket.send(packet, 0, packet.length, SSDP_PORT, SSDP_ADDRESS);
  sendSearch();
  // Repeat: SSDP is UDP, a single datagram can get lost
  const repeater = setInterval(sendSearch, 1_000);

  await new Promise(resolve => setTimeout(resolve, timeout));
  clearInterval(repeater);
  socket.close();

  return responses;
}

// Discover Samsung EMDX (e-paper LFD) displays on the local network.
// Returns [{ host, name, model, serial, mac, location }]
export async function discover({ timeout = 4_000, onProgress = () => {} } = {}) {
  onProgress('Searching for UPnP devices...');
  const responses = await ssdpSearch({ timeout });

  const displays = [];
  await Promise.all([...responses.entries()].map(async ([host, { location }]) => {
    const xml = await fetchDeviceDescription(location);
    if (!xml) return;

    const manufacturer = xmlTag(xml, 'manufacturer') || '';
    const modelName = xmlTag(xml, 'modelName') || '';
    const modelDescription = xmlTag(xml, 'modelDescription') || '';
    if (!manufacturer.toLowerCase().includes('samsung')) return;

    // EMDX e-paper displays report e.g. modelName "EM32DX", modelDescription "Samsung LFD DMR".
    // Samsung TVs share the same DMR endpoint, so require the LFD/EM signature...
    if (!modelDescription.includes('LFD') && !/^EM\d/i.test(modelName)) return;

    // ...and confirm the MDC control port is actually there
    onProgress(`Checking ${host} (${modelName})...`);
    if (!await isPortOpen(host, MDC_PORT)) return;

    displays.push({
      host,
      name: xmlTag(xml, 'friendlyName') || modelName || host,
      model: modelName,
      serial: xmlTag(xml, 'serialNumber'),
      mac: await lookupMac(host),
      location,
    });
  }));

  return displays.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}

export default { discover };
