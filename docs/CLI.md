# Samsung EMDX CLI — Complete Reference

A detailed guide to controlling the Samsung EMDX E-Paper Display from the command line using the Samsung MDC (Multiple Display Control) protocol.

---

## Table of Contents

1. [Overview](#overview)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Commands](#commands)
5. [How It Works](#how-it-works)
6. [MDC Protocol Reference](#mdc-protocol-reference)
7. [Content Format](#content-format)
8. [Image Specifications](#image-specifications)
9. [Network & Firewall](#network--firewall)
10. [Power Management](#power-management)
11. [Troubleshooting](#troubleshooting)

---

## Overview

The CLI communicates with the Samsung EMDX over your local network. The display uses:

- **TCP port 1515** — MDC protocol (unencrypted handshake, then TLS)
- **HTTP** — The display fetches images from a local server on your machine
- **UDP port 9** — Wake-on-LAN (optional)

Your computer must be reachable by the display on the same subnet. The display initiates the HTTP download, so your machine must accept inbound connections on the ephemeral port used by the local server.

---

## Requirements

- **Node.js** ≥ 20
- **Samsung EMDX** E-Paper Display on the same network
- **Display PIN** — Set in the display’s settings (default is often `000000`)
- **Display IP** — Assigned via DHCP or static; find it in your router or the display’s network settings

---

## Installation

```bash
git clone https://github.com/taylorRichie/node-samsung-emdx.git
cd node-samsung-emdx
npm install
```

Run commands via:

```bash
node bin/index.mjs <command> [options]
```

Or add a script to `package.json` and use `npm run` if you prefer.

---

## Commands

### `show-image` — Push an image to the display

Shows an image on the EMDX. Starts a local HTTP server, connects to the display via MDC, sends a content URL, and waits for the display to download the image.

```bash
node bin/index.mjs show-image \
  --host 192.168.1.37 \
  --pin 014381 \
  --image /path/to/image.jpg
```

**Options:**

| Option          | Required | Default        | Description                                      |
| --------------- | -------- | -------------- | ------------------------------------------------ |
| `--host`        | Yes      | —              | Display IP address                               |
| `--pin`         | Yes      | —              | Display PIN (e.g. `000000` or `014381`)          |
| `--image`       | Yes      | —              | Path to image file (JPG, PNG, etc.)              |
| `--mac`         | No       | —              | MAC address for Wake-on-LAN before pushing       |
| `--local-ip`    | No       | Auto-detected   | Your machine’s IP (display fetches from this)   |
| `--sleep-after` | No       | `0`            | Minutes before deep sleep after push (`0` = never)|

**Examples:**

```bash
# Basic push
node bin/index.mjs show-image --host 192.168.1.37 --pin 014381 --image photo.jpg

# Wake display first, then push, then sleep after 20 minutes
node bin/index.mjs show-image \
  --host 192.168.1.37 \
  --pin 014381 \
  --image photo.jpg \
  --mac 28:07:08:28:F2:F8 \
  --sleep-after 20

# Use a specific local IP (e.g. when multiple interfaces)
node bin/index.mjs show-image \
  --host 192.168.1.37 \
  --pin 014381 \
  --image photo.jpg \
  --local-ip 192.168.1.100
```

---

### `wake` — Wake the display via Wake-on-LAN

Sends a Wake-on-LAN magic packet to the display’s MAC address. Use when the display is in deep sleep and not responding to TCP.

```bash
node bin/index.mjs wake --mac 28:07:08:28:F2:F8
```

**Options:**

| Option   | Required | Description        |
| -------- | -------- | ------------------ |
| `--mac`  | Yes      | Display MAC address |

**Notes:**

- Display must support Wake-on-LAN and have it enabled
- Magic packet is sent to `255.255.255.255:9` (UDP broadcast)
- Wait a few seconds after waking before running `show-image` or `status`
- WoL only works when the display was put to sleep with network standby disabled; otherwise it may already be reachable

---

### `sleep` — Power off the display (deep sleep)

Powers off the display and disables network standby for minimal battery use. Use Wake-on-LAN to wake it again.

```bash
node bin/index.mjs sleep --host 192.168.1.37 --pin 014381
```

**Options:**

| Option   | Required | Description        |
| -------- | -------- | ------------------ |
| `--host` | Yes      | Display IP address |
| `--pin`  | Yes      | Display PIN        |
| `--mac`  | No       | Not used for sleep |

**What it does:**

1. Connects to the display
2. Disables network standby (MDC `0xB5` → `0x00`) — turns off WiFi listener
3. Powers off (MDC `0x11` → `0x00`)
4. Disconnects

After this, the display is in deep sleep. Use `wake --mac` to bring it back.

---

### `status` — Display status and info

Connects to the display and reports power, battery, and device info.

```bash
node bin/index.mjs status --host 192.168.1.37 --pin 014381
```

**Options:**

| Option   | Required | Description        |
| -------- | -------- | ------------------ |
| `--host` | Yes      | Display IP address |
| `--pin`  | Yes      | Display PIN        |
| `--mac`  | No       | Optional, unused   |

**Example output:**

```
🔄 Connecting to 192.168.1.37...
Power:    On
Battery:  85% (charging)
Name:     Samsung EMDX
Serial:   XXXXX
Software: X.X.X
```

**Notes:**

- Power state query (`0x11` get) is NAK’d by EMDX — shows `Unknown` or `null`
- Battery uses MDC command `0x1B` (Battery State)
- If the display is asleep, the connection will time out (~10 seconds)

---

## How It Works

### `show-image` flow

1. **Start HTTP server** — Binds to an available port (default 3000) on your machine.
2. **Wake (optional)** — If `--mac` is set, sends WoL magic packet and waits 1 second.
3. **Connect** — TCP to display `host:1515`, receives `MDCSTART<<TLS>>`, upgrades to TLS.
4. **Authenticate** — Sends PIN; expects `MDCAUTH<<PASS>>` or `MDCAUTH<<FAIL:...>>`.
5. **Enable network standby** — Sends `0xB5` with `0x01` so the display stays reachable.
6. **Set content URL** — Sends `0xC7` with a URL to `http://<local-ip>:<port>/content.json`.
7. **Disconnect** — Closes the MDC connection.
8. **Display fetches** — Display requests `/content.json`, then the image URL from the manifest.
9. **Server serves** — Your machine serves the JSON and image over HTTP.
10. **Sleep timer (optional)** — If `--sleep-after` > 0, after the image is downloaded a timer runs; when it fires, the CLI reconnects, disables network standby, powers off, and exits.

### Connection timeout

`connect()` uses a 10-second timeout. If the display is off or unreachable, it fails with:

```
Connection timed out after 10s — display may be asleep
```

---

## MDC Protocol Reference

The Samsung MDC protocol uses:

- **Transport:** TCP port 1515, then TLS
- **Header:** `0xAA` for commands
- **Response header:** `0xFF`
- **ACK:** `0x41` ('A')
- **NAK:** `0x4E` ('N')

### Commands used by this CLI

| Command ID | Name                 | Direction | Data        | Description                          |
| ---------- | -------------------- | --------- | ----------- | ------------------------------------ |
| `0x0B`     | Serial Number        | Get       | —           | Device serial number                  |
| `0x0E`     | Software Version     | Get       | —           | Firmware version                      |
| `0x11`     | Power Control        | Get/Set   | `0x00` off, `0x01` on | Power state                    |
| `0x1B`     | Battery State        | Get       | `0x73`      | Battery level, charging, health       |
| `0x67`     | Device Name          | Get       | —           | Display name                          |
| `0xB5`     | Network Standby      | Get/Set   | `0x00` off, `0x01` on | WiFi listener on/off      |
| `0xC7`     | Content Download     | Set       | `0x53 0x80 <len> <url>` | Set content manifest URL   |

### Power control (`0x11`)

- **Get:** No data; response byte: `0x00` Off, `0x01` On, `0x02` Reboot
- **Set:** Data `[0x00]` = off, `[0x01]` = on  
- **EMDX:** Often NAKs the get command; set (power off) is supported.

### Network standby (`0xB5`)

- **Off (`0x00`):** Network interface off → deep sleep, low battery drain
- **On (`0x01`):** Network stays on → can receive MDC, higher drain

For long idle periods, disable network standby before powering off.

### Battery state (`0x1B`)

Request data: `[0x73]`. Response format:

| Byte | Meaning              | Values                          |
| ---- | -------------------- | ------------------------------- |
| 0    | Sub-command echo     | `0x73`                          |
| 1    | Charging             | `0x00` not charging, `0x01` charging |
| 2    | Battery present      | `0x01` present                  |
| 3    | Battery health       | `0x01` good                     |
| 4    | Level                | `0x00`–`0x64` (0–100%)          |
| 5+   | Extra                | Voltage/temperature, etc.       |

---

## Content Format

The display expects a JSON manifest at the URL you send via `0xC7`. This project uses a structure compatible with the Samsung E-Paper app:

```json
{
  "schedule": [{
    "start_date": "1970-01-01",
    "stop_date": "2999-12-31",
    "start_time": "00:00:00",
    "contents": [{
      "image_url": "http://192.168.1.100:3000/image",
      "file_id": "UUID",
      "file_path": "/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents/UUID/filename.jpg",
      "duration": 91326,
      "file_size": "1234567",
      "file_name": "UUID.jpg"
    }]
  }],
  "name": "node-samsung-emdx",
  "version": 1,
  "create_time": "2025-01-01 00:00:00",
  "id": "FILE_ID",
  "program_id": "com.samsung.ios.ePaper",
  "content_type": "ImageContent",
  "deploy_type": "MOBILE"
}
```

The display fetches `image_url` and uses it as the image to show. The CLI serves the image file directly at that URL.

---

## Image Specifications

- **Resolution:** EMDX is 2560×1440 (WQHD). Larger images are scaled; very large files can cause timeouts or failures.
- **Formats:** JPEG is most reliable. PNG and other formats may work but are less tested.
- **Size:** Keep under ~5 MB for reliable transfer. The web UI caps output at 3840×2160 and uses JPEG quality 0.85.
- **Orientation:** For portrait mounting, you may need to rotate the image 90° or 270° before sending (the web UI has an output rotation control).

---

## Network & Firewall

- **Display → your machine:** The display must be able to open HTTP connections to your machine’s IP and the port used by the local server.
- **Your machine → display:** You need TCP access to the display on port 1515.
- **Same subnet:** Typically required for both MDC and WoL.
- **Firewall:** Allow inbound TCP on the ephemeral port (e.g. 3000) and outbound TCP to `host:1515`. WoL uses outbound UDP to `255.255.255.255:9`.

---

## Power Management

### Wake-on-LAN

- Uses standard WoL magic packet (6× `0xFF` + 16× MAC).
- Sent to `255.255.255.255:9` (UDP).
- Display must support WoL and have it enabled.
- After wake, wait a few seconds before sending MDC commands.

### Deep sleep

1. Disable network standby (`0xB5` → `0x00`)
2. Power off (`0x11` → `0x00`)

This minimizes battery use. WoL is required to wake again.

### Light sleep (not used by default)

- Leave network standby on (`0xB5` → `0x01`) and only power off.
- Display stays reachable over the network but uses more power.

---

## Troubleshooting

### "Connection timed out — display may be asleep"

- Display is off or unreachable.
- Try `wake --mac` first, then wait 5–10 seconds.
- Confirm display IP and that it’s on the same network.

### "Authentication Failed: Incorrect PIN"

- Wrong PIN. Check display settings.
- Default is often `000000`.

### "Authentication Failed: Blocked"

- Too many failed attempts. Wait before retrying.

### "Display did not download the image within 30 seconds"

- Display could not reach your machine (firewall, wrong IP, etc.).
- Check `--local-ip` matches the IP the display can reach.
- Ensure the HTTP server port is open in your firewall.

### Image appears blank or wrong

- Image may be too large; try a smaller JPEG.
- For portrait mounting, try rotating the image 90° or 270° before sending.

### WoL not working

- Confirm MAC address and that WoL is enabled on the display.
- Display must have been put to sleep with network standby disabled.
- Some networks block broadcast; try sending to the display’s IP instead of `255.255.255.255` (WoL support may vary).

### Battery drains overnight

- Ensure sleep disables network standby before power off.
- The `sleep` command and `--sleep-after` in `show-image` both do this.

---

## References

- [node-samsung-mdc](https://github.com/WeeJeWel/node-samsung-mdc) — Original MDC protocol implementation
- [Samsung MDC Protocol v13.7c](https://aca.im/driver_docs/Samsung/MDC%20Protocol%202015%20v13.7c.pdf) — Protocol specification
- [Samsung EMDX](https://github.com/taylorRichie/node-samsung-emdx) — This project
