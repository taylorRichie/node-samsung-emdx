import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';

import Util from './Util.mjs';

export default class Device {

  _isConnected = false;
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

  async wakeup({
    mac = this.mac,
    port = 9,
    host = '255.255.255.255',
    bytes,
    repetitions,
  } = {}) {
    // Create the magic packet
    const packet = Util.createMagicPacket(mac, {
      bytes,
      repetitions,
    });

    // Create a UDP socket
    const socket = dgram.createSocket('udp4');
    socket.once('listening', () => {
      socket.setBroadcast(host === '255.255.255.255');
    });

    // Send the magic packet
    await new Promise((resolve, reject) => {
      socket.send(packet, 0, packet.length, port, host, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    });

    // Close the socket
    socket.close();
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
      const rejectAndClear = (err) => { clearTimeout(timer); reject(err); };
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

          this._connectionTLS.on('data', (data) => {

            if (data[0] === Util.HEADER_CODE && data[1] === Util.RESPONSE_CODE) {
              const displayId = data[2];
              const length = data[3];
              const ackOrNak = data[4];
              const commandId = data[5];
              const payload = data.slice(6, 6 + length - 1 - 1);
              const checksum = data[data.length - 1];

              const { resolve, reject } = this._commands[displayId]?.[commandId] || {};
              if (!resolve) return;
              if (!reject) return;

              // Validate Checksum
              const checksumCalc = data.slice(1, data.length - 1).reduce((sum, byte) => sum + byte, 0) % 256;
              if (checksum !== checksumCalc) {
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
  }) {
    const payload = [
      commandId,
      displayId,
      data.length,
      ...data,
    ];

    const checksum = payload.reduce((sum, byte) => sum + byte, 0) % 256;

    if (this._commands?.[displayId]?.[commandId]) {
      throw new Error(`Command ${commandId} already in progress for display ${displayId}`);
    }

    const result = new Promise((resolve, reject) => {
      this._commands[displayId] = this._commands[displayId] || {};
      this._commands[displayId][commandId] = this._commands[displayId][commandId] || {};
      this._commands[displayId][commandId].resolve = resolve;
      this._commands[displayId][commandId].reject = reject;
    }).finally(() => {
      delete this._commands[displayId][commandId];
    });

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

}