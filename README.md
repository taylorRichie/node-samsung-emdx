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
cd web
npm install
npm run start
```

This builds the frontend and starts the server at **http://localhost:3001**. Choose **Add display** and enter the screen's name, IP address and PIN. There's no config file: everything is set in the web UI and stored by the app.

### Server Settings

Open these with the gear icon at the top right.

| Setting                    | What it's for                                                                 |
| -------------------------- | ----------------------------------------------------------------------------- |
| This computer's IP address | Displays download images from it. Detected automatically, except in Docker Desktop, where **Add display** asks for it. |
| Time zone                  | Used for scheduled wake times. Taken from your browser the first time you open the app. |

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
mkdir -p gallery       # optional artwork library: gallery/<category>/<name>.jpg
docker compose up -d --build
```

Open **http://localhost:3001** and choose **Add display**. Docker Desktop keeps the app from detecting your computer's IP address, so the dialog asks for it (on a Mac, `ipconfig getifaddr en0` shows it). If that address changes later, update it in Server settings.

**Docker Desktop (macOS/Windows):** scanning for displays and Wake-on-LAN can't reach your network from Docker's VM. Add displays by IP, and wake them some other way. Everything else works.

**Linux:** add the host networking override, so scanning and Wake-on-LAN work and your IP address is detected:

```bash
docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build
```

| Volume                 | Container path                                           | Contents                                 |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `displays`             | `/app/web/.displays`                                     | Displays, settings, queues, history, scenes |
| `./gallery` (bind, ro) | `/app/web/.gallery`                                      | Artwork library                          |
| `models`               | `/app/web/node_modules/@huggingface/transformers/.cache` | Depth model (~95 MB, fetched on first use) |

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
- **[MDC Commands](docs/MDC-COMMANDS.md)** — Known command surface, and how to capture new commands from Samsung's app with `tools/mdc-proxy.mjs`

## References

- [node-samsung-mdc](https://github.com/WeeJeWel/node-samsung-mdc) — Samsung MDC protocol implementation
