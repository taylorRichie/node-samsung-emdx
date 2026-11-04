# Samsung EMDX

Control a Samsung EMDX E-Paper Display from the command line or a web interface. Push images to the display over your local network using the Samsung MDC protocol.

## Web Interface

A browser-based UI for cropping and pushing images to the display.

**Features:**
- Drag & drop, click-to-browse, or paste images from clipboard
- Portrait (9:16) and landscape (16:9) orientation toggle
- Interactive crop with zoom and rotation
- Brightness and contrast adjustments
- Live preview of all edits
- One-click push to display
- Wake-on-LAN and deep sleep power management
- Battery status monitoring
- Last pushed image preview (persisted across sessions)
- Connection settings saved in browser
- Device settings stored on the display: orientation, source, wallpaper color, picture mode, sleep, battery warning, screen protection time, time zone, PIN, and button and USB locks

### Quick Start

```bash
cp .env.example .env   # Edit with your display's IP, PIN, and MAC
cd web
npm install
npm run start
```

This builds the frontend and starts the server at **http://localhost:3001**.

### Environment Variables

Copy `.env.example` to `.env` in the project root and fill in your display settings:

```
DISPLAY_HOST=192.168.1.37
DISPLAY_PIN=000000
DISPLAY_MAC=00:00:00:00:00:00
DISPLAY_SLEEP_AFTER=20
```

| Variable              | Description                                  | Required |
| --------------------- | -------------------------------------------- | -------- |
| `DISPLAY_HOST`        | IP address of the display                    | Yes      |
| `DISPLAY_PIN`         | Display PIN                                  | Yes      |
| `DISPLAY_MAC`         | MAC address (for Wake-on-LAN)                | No       |
| `DISPLAY_SLEEP_AFTER` | Minutes of inactivity before deep sleep (0 = never) | No |

These values are used as defaults in the web UI. You can also override them from the settings panel in the browser.

### Development

```bash
cd web
npm install
npm run dev
```

Runs Vite dev server (with hot reload) and the backend API server concurrently. The frontend proxies API requests to the backend on port 3001.

> **Note:** Your computer and the display must be on the same network. The display downloads the image from a local HTTP server on your machine, so firewalls must allow inbound connections on the server port (default 3001).

## Docker

```bash
cp .env.example .env   # set TZ (and LOCAL_IP if needed)
mkdir -p gallery       # optional artwork library: gallery/<category>/<name>.jpg
docker compose up -d --build
```

The web UI is then at **http://&lt;host&gt;:3001**.

The compose file uses **host networking**, which a Linux host needs for all features to work:

- the display downloads pushed images from this server, so it must be reachable at the host's LAN IP
- display discovery (SSDP multicast) and Wake-on-LAN (UDP broadcast) must reach the LAN

If the server logs a `Network:` address that isn't the host's LAN IP (auto-detection only checks `eth0`/`en0`), set `LOCAL_IP` in `.env`.

Set `TZ` (for example `America/Chicago`). Scheduled wake timers are sent to the display in server-local time, and the container otherwise runs in UTC.

| Volume                 | Container path                                           | Contents                                 |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `displays`             | `/app/web/.displays`                                     | Displays, queues, history, scenes        |
| `./gallery` (bind, ro) | `/app/web/.gallery`                                      | Artwork library                          |
| `models`               | `/app/web/node_modules/@huggingface/transformers/.cache` | Depth model (~95 MB, fetched on first use) |

**Docker Desktop (macOS/Windows):** host networking doesn't reach your LAN. Publish the port and pass your machine's LAN IP instead. Pushing works this way, but discovery and Wake-on-LAN don't, so add displays by IP and wake them some other way.

```bash
docker run -d --name samsung-emdx -p 3001:3001 \
  -e LOCAL_IP=192.168.1.20 -e TZ=America/Chicago --env-file .env \
  -v emdx-displays:/app/web/.displays -v emdx-models:/app/web/node_modules/@huggingface/transformers/.cache \
  samsung-emdx:latest
```

**CLI in the container:**

```bash
docker run --rm --network host samsung-emdx node /app/bin/index.mjs discover
```

**Building for another architecture** (for example on an Apple Silicon Mac, for an x86 server):

```bash
docker buildx build --platform linux/amd64 -t samsung-emdx:latest --load .
```

## CLI

You can also push images directly from the command line without the web UI.

### Usage

```bash
# Find displays on your network (IP, MAC, model, serial)
node bin/index.mjs discover

# Push an image
node bin/index.mjs show-image \
  --host 192.168.0.123 \
  --pin 123456 \
  --image ~/Photos/Doggy.jpg \
  --mac 00:11:22:33:44:55 \
  --sleep-after 20

# Wake the display
node bin/index.mjs wake --mac 00:11:22:33:44:55

# Sleep the display (deep sleep with network standby disabled)
node bin/index.mjs sleep --host 192.168.0.123 --pin 123456

# Check display status
node bin/index.mjs status --host 192.168.0.123 --pin 123456
```

### CLI Options (show-image)

| Option          | Description                                  | Required |
| --------------- | -------------------------------------------- | -------- |
| `--image`       | Path to the image file                       | Yes      |
| `--host`        | Display IP address                           | Yes      |
| `--pin`         | Display PIN                                  | Yes      |
| `--mac`         | MAC address (Wake-on-LAN)                    | No       |
| `--local-ip`    | Override auto-detected local IP              | No       |
| `--sleep-after` | Minutes before deep sleep (0 = never)        | No       |

## Requirements

- **Node.js** >= 20
- Samsung EMDX E-Paper Display on the same network

## How It Works

1. A local HTTP server starts on your machine
2. Connects to the display over TCP using the Samsung MDC protocol (port 1515)
3. Authenticates with the PIN over TLS
4. Sends a content download URL pointing back to the local server
5. The display fetches the content manifest and image over HTTP
6. The display refreshes with the new image

## Documentation

- **[CLI Reference](docs/CLI.md)** — Detailed guide to all CLI commands, MDC protocol, content format, and troubleshooting

## References

- [node-samsung-mdc](https://github.com/WeeJeWel/node-samsung-mdc) — Samsung MDC protocol implementation
