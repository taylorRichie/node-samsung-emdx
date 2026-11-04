export default class Util {

  static HEADER_CODE = 0xAA;
  static RESPONSE_CODE = 0xFF;

  static checksum(bytes) {
    return bytes.reduce((sum, byte) => sum + byte, 0) % 256;
  }

  // Finds the frame at the start of buf, or null if it isn't all here yet.
  // Most frames have a 1-byte length, but 0xD2 uses 2 bytes (big-endian), and a
  // reply doesn't reveal its command until after the length. So try both forms
  // and let the checksum decide, starting with the one the caller expects.
  static nextFrame(buf, expectLong = false) {
    if (buf.length < 5) return null;

    const short = { total: 5 + buf[3], isLong: false };
    const long = { total: 6 + ((buf[3] << 8) | buf[4]), isLong: true };
    const isComplete = ({ total }) => buf.length >= total
      && Util.checksum(buf.subarray(1, total - 1)) === buf[total - 1];

    const match = (expectLong ? [long, short] : [short, long]).find(isComplete);
    if (match) return match;

    // Neither form fits: hand it over as a short frame so the checksum check rejects it
    return buf.length >= Math.max(short.total, long.total) ? short : null;
  }

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