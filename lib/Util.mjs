export default class Util {

  static HEADER_CODE = 0xAA;
  static RESPONSE_CODE = 0xFF;

  static createMagicPacket(mac, {
    bytes = 6,
    repetitions = 16,
  } = {}) {
    const macBuffer = Buffer.alloc(bytes);

    mac.split(':').forEach((value, i) => {
      macBuffer[i] = parseInt(value, 16);
    });

    const buffer = Buffer.alloc(bytes + repetitions * bytes);

    // start the magic packet from 6 bytes of FF
    for (let i = 0; i < bytes; i++) {
      buffer[i] = 0xFF;
    }

    // copy mac address 16 times
    for (let i = 0; i < repetitions; i++) {
      macBuffer.copy(buffer, (i + 1) * bytes, 0, macBuffer.length);
    }

    return buffer;
  }

}