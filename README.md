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

## CLI

You can also push images directly from the command line without the web UI.

### Usage

```bash
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

## References

- [node-samsung-mdc](https://github.com/WeeJeWel/node-samsung-mdc) — Samsung MDC protocol implementation
