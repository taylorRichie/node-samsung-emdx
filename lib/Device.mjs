import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';

import { SETTINGS } from './Settings.mjs';
import Util from './Util.mjs';

// Commands that use a 2-byte length, in both directions
const LONG_FRAME_COMMANDS = new Set([0xD2]);

export default class Device {

  _isConnected = false;
  _received = Buffer.alloc(0);
  _longRepliesPending = 0;
  _commands = {
    // [displayId]: {
    //   [commandId]: {
    //     resolve: () => {},
    //     reject: () => {},
    //   }
    // }
  }

  constructor({
    mac = '00:00:00:00:00:00',
    host = '192.168.0.1',
    port = 1515,
    pin = '000000',
  }) {
    this.mac = mac;
    this.host = host;
    this.port = port;
    this.pin = pin;
  }

  // Sends the Wake-on-LAN magic packet. With no `host`, it goes to the
  // broadcast address, the display's /24 subnet broadcast and the display's
  // own address. Broadcasts don't leave Docker Desktop's VM on a Mac or
  // Windows host, but a packet to the display's address does, and the display
  // only looks for the MAC inside it. Succeeds if any copy was sent.
  async wakeup({
    mac = this.mac,
    port = 9,
    host,
    bytes,
    repetitions,
  } = {}) {
    const packet = Util.createMagicPacket(mac, {
      bytes,
      repetitions,
    });

    const targets = host ? [host] : ['255.255.255.255'];
    const ipv4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(this.host ?? '');
    if (!host && ipv4) targets.push(`${ipv4[1]}.255`, this.host);

    const socket = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(() => { socket.setBroadcast(true); resolve(); });
    });

    const results = await Promise.allSettled(targets.map(target => new Promise((resolve, reject) => {
      socket.send(packet, 0, packet.length, port, target, err => (err ? reject(err) : resolve()));
    })));
    socket.close();

    const sent = results.filter(r => r.status === 'fulfilled').length;
    if (!sent) throw results[0].reason;
  }

  async connect({ timeout = 10_000 } = {}) {
    // If already connected
    if (this._isConnected) return;

    // If already connecting
    if (this._connectPromise) {
      await this._connectPromise;
      return;
    }

    this._connectPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._connectionTCP) this._connectionTCP.destroy();
        reject(new Error(`Connection timed out after ${timeout / 1000}s — display may be asleep`));
      }, timeout);
      // Close the socket too: the display takes one session at a time, so one
      // left open by a failed login would lock out the next attempt
      const rejectAndClear = (err) => {
        clearTimeout(timer);
        this._connectionTCP?.destroy();
        reject(err);
      };
      const resolveAndClear = (val) => { clearTimeout(timer); resolve(val); };

      this._connectionTCP = net.connect({
        host: this.host,
        port: this.port,
        rejectUnauthorized: false,
      });
      // this._connectionTCP.setEncoding('utf8');
      this._connectionTCP.on('data', (data) => {
        if (`${data}` === 'MDCSTART<<TLS>>') {
          this._connectionTLS = tls.connect({
            socket: this._connectionTCP,
            rejectUnauthorized: false,
          }, err => {
            if (err) return rejectAndClear(err);
            this._connectionTLS.write(Buffer.from(this.pin), (err) => {
              if (err) return rejectAndClear(err);
            });
          });

          this._connectionTLS.on('data', (chunk) => {
            this._received = Buffer.concat([this._received, chunk]);

            // Frames can arrive split across reads, or several in one read
            while (this._received[0] === Util.HEADER_CODE) {
              const next = Util.nextFrame(this._received, this._longRepliesPending > 0);
              if (!next) return;
              const frame = this._received.subarray(0, next.total);
              this._received = this._received.subarray(next.total);
              this._handleFrame(frame, next.isLong);
            }
            if (!this._received.length) return;

            const data = this._received;
            this._received = Buffer.alloc(0);

            if (`${data}` == 'MDCAUTH<<PASS>>') {
              return resolveAndClear();
            }

            if (`${data}` === 'MDCAUTH<<FAIL:0x01>>') {
              return rejectAndClear(new Error('Authentication Failed: Incorrect PIN'));
            }

            if (`${data}` === 'MDCAUTH<<FAIL:0x02>>') {
              return rejectAndClear(new Error('Authentication Failed: Blocked'));
            }

            console.log(`Received unknown data: ${data}`, data);
          })
          this._connectionTLS.once('error', rejectAndClear);
        }
      });
      this._connectionTCP.on('error', rejectAndClear);
      this._connectionTCP.once('close', () => {
        rejectAndClear(new Error('Closed'));
      });
    });

    await this._connectPromise;

    this._connectPromise = null;
    this._isConnected = true;
  }

  _handleFrame(frame, isLong) {
    if (frame[1] !== Util.RESPONSE_CODE) return;

    const start = isLong ? 5 : 4; // first byte after the length
    const displayId = frame[2];
    const ackOrNak = frame[start];
    const commandId = frame[start + 1];
    const payload = frame.subarray(start + 2, -1);
    const checksum = frame[frame.length - 1];

    const { resolve, reject } = this._commands[displayId]?.[commandId] || {};
    if (!resolve) return;
    if (!reject) return;

    // Validate Checksum
    if (checksum !== Util.checksum(frame.subarray(1, -1))) {
      return reject(new Error('Checksum Mismatch'));
    }

    switch (ackOrNak) {
      case 0x41: { // 'A'
        return resolve(payload);
      }
      case 0x4E: { // 'N'
        const err = new Error('NAK');
        err.payload = payload;
        return reject(err);
      }
    }
  }

  async disconnect() {
    // If not connected
    if (!this._isConnected) return;

    // If connecting
    if (this._connectPromise) {
      await this._connectPromise;
      this._connectPromise = null;
    }

    // If already disconnecting
    if (this._disconnectPromise) {
      await this._disconnectPromise;
      return;
    }
    this._disconnectPromise = Promise.resolve().then(async () => {
      // Disconnect from the device
      if (this._connectionTLS) {
        this._connectionTLS.end();
        this._connectionTLS = null;
      }

      if (this._connectionTCP) {
        this._connectionTCP.end();
        this._connectionTCP = null;
      }
    });

    await this._disconnectPromise;
    this._disconnectPromise = null;
    this._isConnected = false;
  }

  async send(buf) {
    if (!this._isConnected) {
      await this.connect();
    }

    await new Promise((resolve, reject) => {
      this._connectionTLS.write(buf, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    });
  }

  async sendCommand({
    commandId = 0x00,
    displayId = 0,
    data = [],
    timeout = 10_000,
  }) {
    const isLong = LONG_FRAME_COMMANDS.has(commandId);
    const payload = [
      commandId,
      displayId,
      ...(isLong ? [data.length >> 8, data.length & 0xFF] : [data.length]),
      ...data,
    ];

    const checksum = Util.checksum(payload);

    if (this._commands?.[displayId]?.[commandId]) {
      throw new Error(`Command ${commandId} already in progress for display ${displayId}`);
    }

    let timer;
    if (isLong) this._longRepliesPending++;
    const result = new Promise((resolve, reject) => {
      this._commands[displayId] = this._commands[displayId] || {};
      this._commands[displayId][commandId] = this._commands[displayId][commandId] || {};
      this._commands[displayId][commandId].resolve = resolve;
      this._commands[displayId][commandId].reject = reject;
      timer = setTimeout(() => reject(new Error(`No reply to command 0x${commandId.toString(16)}`)), timeout);
    }).finally(() => {
      clearTimeout(timer);
      if (isLong) this._longRepliesPending--;
      delete this._commands[displayId][commandId];
    });
    result.catch(() => {}); // a failed send below rejects this with nobody listening

    await this.send(Buffer.from([
      Util.HEADER_CODE,
      ...payload,
      checksum,
    ]));

    return result;
  }

  async getSerialNumber({
    displayId,
  } = {}) {
    const result = await this.sendCommand({
      displayId,
      commandId: 0x0B,
    });

    return String(result);
  }

  async getSoftwareVersion({
    displayId,
  } = {}) {
    const result = await this.sendCommand({
      displayId,
      commandId: 0x0E,
    });

    return String(result);
  }

  async getDeviceName({
    displayId,
  } = {}) {
    const result = await this.sendCommand({
      displayId,
      commandId: 0x67,
    });

    return String(result);
  }

  async getPowerState({
    displayId,
  } = {}) {
    try {
      const result = await this.sendCommand({
        displayId,
        commandId: 0x11,
      });

      switch (result[0]) {
        case 0x00:
          return 'Off';
        case 0x01:
          return 'On';
        case 0x02:
          return 'Reboot';
        default:
          return null;
      }
    } catch {
      // EMDX e-paper displays NAK the power state query
      return null;
    }
  }

  async setContentDownload({
    displayId,
    url = null,
  } = {}) {
    if (!url) {
      throw new Error('Missing URL');
    }

    if (url.length > 255) {
      throw new Error('URL too long, there is a maximum of 255 characters');
    }

    await this.sendCommand({
      displayId,
      commandId: 0xC7,
      data: Buffer.from([
        0x53,
        0x80,
        url.length,
        ...Buffer.from(url),
      ]),
    });
  }

  async setPower({
    displayId,
    power = true,
  } = {}) {
    await this.sendCommand({
      displayId,
      commandId: 0x11,
      data: [power ? 0x01 : 0x00],
    });
  }

  async setNetworkStandby({
    displayId,
    enabled = true,
  } = {}) {
    await this.sendCommand({
      displayId,
      commandId: 0xB5,
      data: [enabled ? 0x01 : 0x00],
    });
  }

  async getNetworkStandby({
    displayId,
  } = {}) {
    try {
      const result = await this.sendCommand({
        displayId,
        commandId: 0xB5,
      });
      return result[0] === 0x01;
    } catch {
      return null;
    }
  }

  // MDC 0x25 — On Timer (Auto Power On)
  // Repeat: 0x01=Once, 0x02=Daily, 0x03=Mon-Fri, 0x04=Mon-Sat, 0x05=Sat-Sun
  async setOnTimer({
    displayId,
    enabled = true,
    repeat = 0x02,
    hour = 8,
    minute = 0,
  } = {}) {
    await this.sendCommand({
      displayId,
      commandId: 0x25,
      data: [enabled ? 0x01 : 0x00, repeat, hour, minute, 0x01],
    });
  }

  async getOnTimer({
    displayId,
  } = {}) {
    try {
      const result = await this.sendCommand({
        displayId,
        commandId: 0x25,
      });
      return {
        enabled: result[0] === 0x01,
        raw: Array.from(result),
      };
    } catch {
      return null;
    }
  }

  // MDC 0x10 — Display/model info. EM32DX returns a 3-byte code (e.g. 02 7a 01).
  async getModelInfo({
    displayId,
  } = {}) {
    try {
      const result = await this.sendCommand({
        displayId,
        commandId: 0x10,
      });
      return Array.from(result);
    } catch {
      return null;
    }
  }

  // MDC 0xA7 — Real-time clock. EM32DX returns 7 bytes:
  //   [day, hour (12h), minute, month, yearHi, yearLo, am/pm]
  async getClock({
    displayId,
  } = {}) {
    try {
      const r = await this.sendCommand({
        displayId,
        commandId: 0xA7,
      });
      if (r.length < 6) return { raw: Array.from(r) };
      return {
        day: r[0],
        hour: r[1],
        minute: r[2],
        month: r[3],
        year: (r[4] << 8) | r[5],
        raw: Array.from(r),
      };
    } catch {
      return null;
    }
  }

  // Where a pushed image's schedule entry should start: now, on the display's
  // own clock. The display shows whichever entry started most recently, even
  // one left by an earlier push, so an entry dated earlier downloads but is
  // never drawn (see docs/MDC-COMMANDS.md, Content schedules). Falls back to
  // this machine's local time if the clock can't be read.
  async getScheduleStart({
    displayId,
  } = {}) {
    const pad = n => String(n).padStart(2, '0');
    const c = await this.getSetting('clock', { displayId }).catch(() => null);
    const valid = c && c.year >= 2024 && c.month >= 1 && c.month <= 12 && c.day >= 1 && c.day <= 31
      && c.hour >= 0 && c.hour <= 12 && c.minute >= 0 && c.minute <= 59;
    if (valid) {
      const hour = (c.hour % 12) + (c.pm ? 12 : 0);
      return { start_date: `${c.year}-${pad(c.month)}-${pad(c.day)}`, start_time: `${pad(hour)}:${pad(c.minute)}:00`, source: 'display' };
    }
    const d = new Date();
    return {
      start_date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      start_time: `${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
      source: 'local',
    };
  }

  // MDC 0x22/0x10 (Samsung's MDC_COMMAND_TURN_ON_BLE): makes the display offer
  // its Bluetooth setup service, so its Wi-Fi can be changed over Bluetooth.
  // Samsung's app sends this, with 2000 ms, before every Wi-Fi change. Data is
  // 00, length 3, a 2-byte big-endian time in milliseconds, then d2. The
  // display ACKs 2000 after ~3 s and NAKs 60000 (`10 01`), so keep 2000.
  async turnOnBluetooth({
    displayId,
    ms = 2000,
  } = {}) {
    const time = Math.max(0, Math.min(0xFFFF, Math.round(ms)));
    return this.sendCommand({
      displayId,
      commandId: 0x22,
      data: [0x10, 0x00, 0x03, time >> 8, time & 0xFF, 0xD2],
      timeout: 15_000,
    });
  }

  async getBatteryState({
    displayId,
  } = {}) {
    const result = await this.sendCommand({
      displayId,
      commandId: 0x1B,
      data: Buffer.from([
        0x73,
      ]),
    });

    // Response: <Buffer 73 CC PP HH LL XX XX>
    //   [0] 0x73 = sub-command echo
    //   [1] charging status (0x00 = not charging, 0x01 = charging)
    //   [2] battery present (0x01 = present)
    //   [3] battery health  (0x01 = good)
    //   [4] battery level percentage (0x00-0x64)
    //   [5..] additional data (voltage/temp, exposed as raw)
    return {
      charging: result[1] === 0x01,
      present: result[2] === 0x01,
      healthy: result[3] === 0x01,
      level: result[4],
      raw: Array.from(result),
    };
  }

  async getSetting(name, {
    displayId,
    timeout,
  } = {}) {
    const { commandId, query, parse } = SETTINGS[name];
    return parse(await this.sendCommand({ displayId, commandId, data: query, timeout }));
  }

  async setSetting(name, value, {
    displayId,
  } = {}) {
    const { commandId, encode, refresh } = SETTINGS[name];
    await this.sendCommand({ displayId, commandId, data: encode(value) });

    // The app follows every picture change with this. The display takes ~3s
    // and usually NAKs it, so the outcome isn't meaningful.
    if (refresh) {
      await this.sendCommand({ displayId, commandId: 0x1B, data: [0xB0, 0x00, 0x00] }).catch(() => {});
    }
  }

  // Reads every readable setting; one the display rejects comes back null.
  // Stops early if it goes quiet, rather than waiting out each timeout in turn.
  async getSettings({
    displayId,
  } = {}) {
    const settings = {};
    let timeouts = 0;
    for (const [name, { parse }] of Object.entries(SETTINGS)) {
      if (!parse || timeouts >= 2) continue;
      settings[name] = await this.getSetting(name, { displayId, timeout: 4_000 }).catch(err => {
        if (err.message !== 'NAK') timeouts++;
        return null;
      });
    }
    return settings;
  }

  // 71 00 <count> followed by <length> <name> for each zone
  async getTimeZones({
    displayId,
  } = {}) {
    const r = await this.sendCommand({ displayId, commandId: 0xD2, data: [0x71] });
    const zones = [];
    for (let i = 3, n = 0; n < r[2] && i < r.length; n++, i += 1 + r[i]) {
      zones.push(r.subarray(i + 1, i + 1 + r[i]).toString());
    }
    return zones;
  }

}
