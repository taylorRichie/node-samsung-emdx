# Samsung EMDX

Control a Samsung EMDX E-Paper Display from the command line or a web interface. Push images to the display over your local network using the Samsung MDC protocol.

## Web Interface

A browser-based UI for designing images and sending them to the display.

**Features:**
- Image designer with an e-paper preview: see how the 6-color panel will render an image, or compare it side by side with the original
- Every image gets the E-ink profile unless you choose otherwise, including queued images and image feeds. Change the default under Settings → Images
- Vivid, B&W and Original profiles, plus brightness, contrast, saturation, midtones and sharpening controls
- Fit, fill or stretch, resize from the corners (⇧ to stretch freely) or stretch one way from the sides, snap to center and edges, rotate, corner radius, borders, and backgrounds in the panel's own solid colors
- Send from anywhere through the designer: a new image, a queued image, or artwork from the library (**Send…**), so it can be adjusted before it goes
- Undo and redo. Designs are saved separately, so the original image is never changed
- Queue with schedules: several wake times a day on chosen days, or every few minutes or hours (optionally only between two times of day), from the queue or an image feed
- Artwork library: browse it, upload your own artwork into categories, and queue it on any display
- One image spanned across a group of displays, with their frames and gaps taken out so lines stay straight across them
- Every image is resized to the panel's exact resolution: fit (with bars), fill (cropped) or stretch, chosen under Settings → Images or per send
- Portrait and landscape linked between the viewer and the display
- Wi-Fi setup over Bluetooth without Samsung's app, with [`tools/ble-setup.py`](tools/ble-setup.py) on Linux (e.g. a Raspberry Pi). See [docs/BLE.md](docs/BLE.md)
- Sends don't give up. The app wakes a display with Wake-on-LAN in network standby. One it can't reach keeps its image waiting, which goes out as soon as the display is seen awake: its button, its own wake, or the next retry. Waiting images show on the canvas and survive a restart
- The display's clock is checked whenever an image is sent, and put right when it's out. Each display shows its time and how far off it is
- Keeps displays asleep: the app checks each one every minute, and puts back to sleep a display that woke by itself (its daily panel care at the screen protection time, its button, or a sleep that didn't take)
- Battery status monitoring
- Settings stored on the display: source, wallpaper color, picture mode, sleep, battery warning, screen protection time, time zone, button and USB lock, and PIN

### Quick Start

```bash
cd web
npm install
npm run start
```

This builds the frontend and starts the server at **http://localhost:3001**. Choose **Add display** and enter the screen's name, IP address and PIN. There's no config file: everything is set in the web UI and stored by the app.

### Settings

Open these with the gear icon at the top right. Each display also has its own page there, for its connection, screen, power, time and security settings.

| Setting                    | What it's for                                                                 |
| -------------------------- | ----------------------------------------------------------------------------- |
| This computer's IP address | Displays download images from it. Detected automatically, except in Docker Desktop, where **Add display** asks for it. |
| Time zone                  | Used for scheduled wake times and setting display clocks. Taken from your browser the first time you open the app. |
| Keep display clocks in sync | Sets a display's clock to this app's time when it's more than a minute out. On by default. |
| Image fit                  | How images without a layout of their own are sized to the panel: fit, fill or stretch, and the bar color for fit. |
| Default profile            | The look given to images that don't have their own. E-ink unless you change it. |

### Spanning one image across displays

1. Arrange the displays on the canvas the way they hang: side by side, stacked, or a grid. Mixed portrait and landscape works too.
2. Select them: drag a box around them, or click one and shift-click the rest.
3. Choose **Span image** in the bar above them, and pick an image.
4. Under **Wall**, set **Frame** (the frame width per display; about 14 mm on the EMDX) and **Gap** (the space between displays). Add **Row gap** when there are several rows.
5. Choose **Send**. Every display gets its slice at the same time.

The picture carries on behind the frames and gaps, so straight lines stay straight from one screen to the next. The selection is saved as a group under **Groups** in the display list, with its gap settings and image. Click a group to select its displays again, and use the pencil button to edit and resend its image. If a display misses the send, **Retry** in the message resends just that display's slice.

### Development

```bash
cd web
npm install
npm run dev
```

Runs Vite dev server (with hot reload) and the backend API server concurrently. The frontend proxies API requests to the backend on port 3001.

No display to test with? [`tools/fake-display`](tools/fake-display/README.md) runs fake ones in Docker that save what they're sent.

> **Note:** Your computer and the display must be on the same network. The display downloads the image from a local HTTP server on your machine, so firewalls must allow inbound connections on the server port (default 3001).

### Home Assistant

There's a Home Assistant integration in [`custom_components/samsung_emdx`](custom_components/samsung_emdx). It gives each display battery, charging, awake and delivery sensors, its current image, and wake, sleep and next-image buttons. Its services send an image (a link, a file Home Assistant can read, or library artwork) to a display or span it across a group. See [docs/HOME-ASSISTANT.md](docs/HOME-ASSISTANT.md).

Without the integration, a `rest_command` can send an image:

```yaml
rest_command:
  epaper_show:
    url: "http://<this computer>:3001/api/displays/living-room/push"
    method: POST
    content_type: "application/json"
    payload: '{"url": "{{ url }}", "fit": "fill"}'
    timeout: 200
```

Displays can be named in the address, like `living-room` here. The request answers once the display has the image, or with `202` when the display couldn't be reached yet: the image then waits and goes out as soon as it can. Waking a display over the network needs **Network standby** (the display's settings → Power → Sleep mode) and its MAC address.

### HTTP API

Everything the web app does is in the API: sending images (file, link, library or base64), spanning across groups, the waiting images, schedules, the library, clocks and status. `GET /api/state` returns everything at once. See [docs/API.md](docs/API.md).

## Home Assistant add-on

The app also runs as a Home Assistant add-on, with its web app in the sidebar (**E-Paper**). It's the same app as below, with its data kept in Home Assistant and included in its backups.

1. **Settings → Add-ons → Add-on store**, then the menu (⋮) → **Repositories**, and add `https://github.com/PeitzGreene/node-samsung-emdx`.
2. Install **Samsung EMDX**, start it, and open **E-Paper** in the sidebar.
3. For displays as entities and actions in automations, add the [integration](docs/HOME-ASSISTANT.md) with the address `http://127.0.0.1:3001`.

The add-on uses the host's network (port 3001), so scanning, Wake-on-LAN and the address displays download from all work without setup. Artwork in `/media/samsung-emdx/<category>/` shows in the library alongside uploads. More in [homeassistant-addon/DOCS.md](homeassistant-addon/DOCS.md). It runs on 64-bit Home Assistant (aarch64 or amd64).

## Docker

```bash
mkdir -p gallery       # optional artwork library: gallery/<category>/<name>.jpg
docker compose up -d --build
```

Or run the published image, built for amd64 and arm64 by [.github/workflows/image.yml](.github/workflows/image.yml):

```bash
docker run -d --name samsung-emdx --init --restart unless-stopped -p 3001:3001 \
  -v emdx-data:/app/web/.displays ghcr.io/peitzgreene/node-samsung-emdx:latest
```

Open **http://localhost:3001** and choose **Add display**. Docker Desktop keeps the app from detecting your computer's IP address, so the dialog asks for it (on a Mac, `ipconfig getifaddr en0` shows it). If that address changes later, update it under Settings → General.

**Docker Desktop (macOS/Windows):** scanning for displays and Wake-on-LAN can't reach your network from Docker's VM. Add displays by IP, and wake them some other way. Everything else works.

**Linux:** add the host networking override, so scanning and Wake-on-LAN work and your IP address is detected:

```bash
docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build
```

| Volume                 | Container path                                           | Contents                                 |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `displays`             | `/app/web/.displays`                                     | Displays, settings, queues, groups, scenes, images waiting to be sent, and artwork uploaded in the app |
| `./gallery` (bind, ro) | `/app/web/.gallery`                                      | Artwork library folder (read-only; uploads go in `displays`) |
| `models`               | `/app/web/node_modules/@huggingface/transformers/.cache` | Depth model (~95 MB, fetched on first use) |

The app finds these through environment variables, which the add-on uses to keep everything in `/data`. Set them to put the data anywhere else:

| Variable | Default | |
| --- | --- | --- |
| `EMDX_DATA_DIR` | `web/.displays` | Displays, settings, queues, groups, uploads |
| `EMDX_GALLERY_DIR` | `web/.gallery` | The read-only artwork folder |
| `EMDX_CACHE_DIR` | thumbnails in `web/.gallery-thumbs`, the model in `node_modules` | Thumbnails (`thumbs/`) and the depth model (`models/`) |
| `PORT` | `3001` | |

**Releasing:** set the version in `homeassistant-addon/config.yaml` and `build.yaml`, then push a tag such as `v1.1.0`. The workflow publishes the image for that version, which the add-on builds on. Make the package public on GitHub once, so Home Assistant can pull it.

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
- **[HTTP API](docs/API.md)** — Sending images, groups, schedules, the library, clocks and status
- **[Home Assistant](docs/HOME-ASSISTANT.md)** — The integration's setup, entities and services
- **[MDC Commands](docs/MDC-COMMANDS.md)** — Known command surface, and how to capture new commands from Samsung's app with `tools/mdc-proxy.mjs`

## References

- [node-samsung-mdc](https://github.com/WeeJeWel/node-samsung-mdc) — Samsung MDC protocol implementation
