// Display settings, mapped from Samsung's app (see docs/MDC-COMMANDS.md).
//
// Each entry names its MDC command. `query` is the data that reads the setting,
// `parse` decodes the reply, and `encode` builds the data that writes it,
// throwing on an invalid value. Entries without `parse` are write-only.
// `refresh` marks picture settings, which the app follows with a refresh.

const ORIENTATIONS = { 0x00: 'landscape', 0x01: 'portrait' };
const SOURCES = { 0x03: 'usb', 0x04: 'default' };
const WALLPAPER_COLORS = { 0: 'white', 1: 'black', 2: 'red', 3: 'green', 4: 'blue', 5: 'yellow' };
const PICTURE_MODES = { 0x22: 'custom', 0x24: 'vivid' };
const SLEEP_MODES = { 0x00: 'deep', 0x01: 'standby' };
// Sleep after presets, in minutes
const SLEEP_AFTER_PRESETS = { 0x06: 5 };

function option(names, value) {
  const byte = Object.keys(names).find(key => names[key] === value);
  if (byte === undefined) throw new Error(`Invalid value: ${value}`);
  return Number(byte);
}

function flag(value) {
  if (typeof value !== 'boolean') throw new Error(`Invalid value: ${value}`);
  return value ? 0x01 : 0x00;
}

function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function ascii(value, { max }) {
  if (typeof value !== 'string' || !value || value.length > max || !/^[\x20-\x7E]+$/.test(value)) {
    throw new Error(`Must be 1 to ${max} plain characters`);
  }
  return [...Buffer.from(value, 'ascii')];
}

// 40 00 <ntp> 80 <length> <server> 81 <length> <zone>
function parseTime(r) {
  const time = { ntp: r[2] === 0x01, server: '', zone: '' };
  for (let i = 3; i + 2 <= r.length; i += 2 + r[i + 1]) {
    const value = r.subarray(i + 2, i + 2 + r[i + 1]).toString();
    if (r[i] === 0x80) time.server = value;
    if (r[i] === 0x81) time.zone = value;
  }
  return time;
}

function encodeTime({ server, zone } = {}) {
  const serverBytes = ascii(server, { max: 64 });
  const zoneBytes = ascii(zone, { max: 64 });
  return [0x40, 0x00, 0x01, 0x80, serverBytes.length, ...serverBytes, 0x81, zoneBytes.length, ...zoneBytes];
}

// [day, hour (12h), minute, month, yearHi, yearLo, am/pm]. Every capture so far
// was in the afternoon with 0x00 here, so 0x01 for AM follows the public MDC
// protocol and is unconfirmed on this display.
function parseClock(r) {
  if (r.length < 7) return null;
  return { day: r[0], hour: r[1], minute: r[2], month: r[3], year: (r[4] << 8) | r[5], pm: r[6] === 0x00 };
}

function encodeClock(value) {
  const date = value === 'now' ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid value: ${value}`);
  const hours = date.getHours();
  const year = date.getFullYear();
  return [date.getDate(), hours % 12 || 12, date.getMinutes(), date.getMonth() + 1, year >> 8, year & 0xFF, hours < 12 ? 0x01 : 0x00];
}

// Read: b0 80 02 <HH> <MM> 81 04 <HH> <MM> 04 0b
function parseProtectorTime(r) {
  if (r[1] !== 0x80) return null;
  return `${String(r[3]).padStart(2, '0')}:${String(r[4]).padStart(2, '0')}`;
}

function encodeProtectorTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) throw new Error(`Invalid value: ${value}`);
  return [0xB0, 0x80, 0x02, integer(Number(match[1]), 0, 23), integer(Number(match[2]), 0, 59)];
}

function encodePin(value) {
  if (!/^\d{6}$/.test(value ?? '')) throw new Error('PIN must be 6 digits');
  return [0x87, ...Buffer.from(value, 'ascii')];
}

export const SETTINGS = {
  orientation: {
    commandId: 0xC8,
    query: [0x81],
    parse: r => ORIENTATIONS[r[1]] ?? null,
    encode: value => [0x81, option(ORIENTATIONS, value)],
  },
  source: {
    commandId: 0xC7,
    query: [0x81],
    parse: r => SOURCES[r[1]] ?? null,
    encode: value => [0x81, option(SOURCES, value)],
  },
  wallpaperColor: {
    commandId: 0x21,
    query: [0x90],
    parse: r => WALLPAPER_COLORS[r[2]] ?? null,
    encode: value => [0x90, 0x00, option(WALLPAPER_COLORS, value)],
  },
  pictureMode: {
    commandId: 0x71,
    query: [],
    parse: r => PICTURE_MODES[r[0]] ?? null,
    encode: value => [option(PICTURE_MODES, value)],
    refresh: true,
  },
  color: {
    commandId: 0x27,
    query: [],
    parse: r => r[0],
    encode: value => [integer(value, 0, 100)],
    refresh: true,
  },
  sleepMode: {
    commandId: 0xB5,
    query: [],
    parse: r => SLEEP_MODES[r[0]] ?? null,
    encode: value => [option(SLEEP_MODES, value)],
  },
  // Minutes, or null on a preset whose length isn't known yet (0x08). Some
  // values are stored as presets: writing 5 minutes reads back as 0x06.
  // Longer than 255 minutes is unconfirmed, so it isn't offered.
  sleepAfter: {
    commandId: 0xC6,
    query: [0x81],
    parse: r => (r[1] === 0xF0 ? (r[2] << 8) | r[3] : SLEEP_AFTER_PRESETS[r[1]] ?? null),
    encode: value => [0x81, 0xF0, 0x00, integer(value, 1, 255)],
  },
  sleepWhenContentDone: {
    commandId: 0xC7,
    query: [0x53],
    parse: r => r[2] === 0x01,
    encode: value => [0x53, 0x01, flag(value)],
  },
  // Byte 2 of the battery reply is assumed to be this flag; Device.getBatteryState
  // labels it "present". No read has been captured with the warning off.
  batteryWarning: {
    commandId: 0x1B,
    query: [0x73],
    parse: r => r[2] === 0x01,
    encode: value => [0x73, 0x00, flag(value)],
  },
  screenProtectorTime: {
    commandId: 0x1B,
    query: [0xB0],
    parse: parseProtectorTime,
    encode: encodeProtectorTime,
  },
  buttonLock: {
    commandId: 0x5F,
    query: [],
    parse: r => r[0] === 0x01,
    encode: value => [flag(value)],
  },
  usbLock: {
    commandId: 0x1B,
    query: [0x75],
    parse: r => r[2] === 0x01,
    encode: value => [0x75, 0x00, flag(value)],
  },
  deviceName: {
    commandId: 0x67,
    query: [],
    parse: r => r.toString(),
    encode: value => ascii(value, { max: 32 }),
  },
  time: {
    commandId: 0xCA,
    query: [0x40],
    parse: parseTime,
    encode: encodeTime,
  },
  clock: {
    commandId: 0xA7,
    query: [],
    parse: parseClock,
    encode: encodeClock,
  },
  pin: {
    commandId: 0x1B,
    encode: encodePin,
  },
};
