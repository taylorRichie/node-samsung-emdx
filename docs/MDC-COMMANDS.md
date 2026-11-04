# EM32DX MDC Command Surface

An empirical inventory of the Samsung MDC command set supported by the **EM32DX**
32" color e-paper display (firmware `S-RSEDWWC-1050.1`), captured by sweeping the
full `0x00`–`0xFF` command space against a live unit and cross-referencing the
public Samsung MDC protocol.

**Why this exists:** the transport here (MDC over TLS on TCP 1515) is entirely
local and does **not** depend on Samsung's phone app or any cloud service. Once a
display is on the network, everything below works forever, regardless of whether
Samsung keeps the app alive. This document is the reference for building an
app-independent controller. The only thing MDC does *not* cover is first-time
WiFi onboarding of a factory-fresh unit (that path is Bluetooth/SoftAP — see the
project notes).

## How to read this

Each command is a single byte. A **get** is the command with a zero-length
payload; the display answers `ACK` (`0x41`) with data, `NAK` (`0x4E`) for an
unsupported/invalid command, or stays silent (timeout) for command IDs it doesn't
implement at all. A **set** sends a data payload; some commands accept sets even
though they reject gets (notably power).

Results below are consolidated over multiple probe rounds. `ACK` entries are
confirmed on real hardware; the "not supported" list is commands that reliably
`NAK` or time out.

---

## Confirmed READABLE (get → ACK)

| Cmd    | Name / meaning                | Sample response            | Notes |
| ------ | ----------------------------- | -------------------------- | ----- |
| `0x0B` | Serial number                 | `"0WPSHNPY900879F"` (ASCII)| Stable per-unit ID. |
| `0x0E` | Software / firmware version   | `"S-RSEDWWC-1050.1"` (ASCII)| |
| `0x10` | Display / model info          | `02 7A 01` (3 bytes)       | Opaque model code. |
| `0x1B` | Status container (sub-command)| see below                  | Requires a sub-command byte; `0x73` = battery. |
| `0x24` | Mode/flag (unconfirmed)       | `0x32` (`'2'`)             | Constant; exact meaning unknown. |
| `0x25` | On-Timer (auto power-on)      | `0x00` (disabled)          | Get + set both work. |
| `0x27` | Color (Custom picture mode)   | `0x19` (25)                | Get + set both work. |
| `0x67` | Device name                   | `"Display 4"` (ASCII)      | The name set during onboarding. |
| `0x71` | Picture mode                  | `0x24` (Vivid)             | Get + set both work. `0x22` is Custom. |
| `0x96` | Unknown                       | `0x00`                     | |
| `0xA7` | **Real-time clock / date**    | `0d 05 08 08 07 EA 00`     | `[day, hour(12h), minute, month, yearHi, yearLo, 00]`. Get + set both work. Samsung's app set `03 05 15 0b 07 ea 00` at 5:21 PM, so byte 2 is the hour, not day of week. The last byte is `00` in every PM sample: probably an AM/PM flag, AM value unconfirmed. |
| `0xB5` | Network standby (WoL listener)| `0x01` (on)                | Get + set both work. |
| `0xB6` | Software-update status (likely)| `00 0B 00 00 00 00 0B ...`| 13-byte struct; interpretation tentative. |

### `0x1B` status container sub-commands

`0x1B` takes a one-byte sub-command. Confirmed responders on EM32DX:

| Sub    | Meaning                        | Sample |
| ------ | ------------------------------ | ------ |
| `0x73` | **Battery state**              | `73 CC PP HH LL ..` → charging / present / healthy / level% |
| `0x61` | Unknown                        | `61 00` |
| `0x62` | Unknown (text)                 | `62 "Unknown"` |
| `0x71` | Unknown                        | `71 00` |
| `0x75` | USB lock                       | `75 00 00` |
| `0x87` | Returns the display **PIN**    | `87 "014381"` (only after auth) |
| `0x8C` | Unknown                        | `8C 01` |
| `0x8D` | Unknown                        | `8D 01` |
| `0xB0` | Screen protector time          | `B0 80 02 03 00 81 04 03 00 04 0B` |

---

## Confirmed WRITABLE (set → ACK, proven in production)

These are the commands the controller actually uses; all are verified working on
the live displays.

| Cmd    | Name              | Set payload                         | Effect |
| ------ | ----------------- | ----------------------------------- | ------ |
| `0x11` | Power             | `0x01` on / `0x00` off              | Powers the panel. **Get is NAK'd** — write-observable only. |
| `0xB5` | Network standby   | `0x01` on / `0x00` off              | WiFi listener; must be on for WoL to work, off for true deep sleep. |
| `0x25` | On-Timer          | `[en, repeat, hh, mm, 0x01]`        | Schedules an automatic power-on. |
| `0xC7` | Content download  | `0x53 0x80 <len> <url>` (url ≤255)  | Points the display at a `content.json` manifest to pull a new image. |

Wake-on-LAN is separate from MDC: a UDP magic packet to port 9 (needs the MAC and
network-standby left on).

### Captured from Samsung's app

Seen with `tools/mdc-proxy.mjs`. The app opens every session the same way: set
the clock (`0xA7`), read the battery (`0x1B`/`0x73`), upload `CMSServer.crt`
(`0xD2`).

- **Auth.** The app sends `MDCAUTH<<pin>>`; `lib/Device.mjs` sends the bare PIN.
  The display accepts both.
- **Sub-commands.** Beyond `0x1B`, the first data byte of `0x21`, `0xC6`, `0xC7`,
  `0xC8`, `0xCA` and `0xD2` selects a setting. Sending that byte alone reads it;
  adding values writes it. Replies echo the sub-command.
- **`0xD2` long frames.** `0xD2` is always a **long frame** with a 2-byte
  big-endian length, in both directions:
  `AA D2 <id> <lenHi> <lenLo> <payload> <checksum>` and
  `AA FF <id> <lenHi> <lenLo> <A|N> D2 <data> <checksum>`, checksum calculated as
  for normal frames.
- **`CMSServer.crt`.** Uploaded with `0xD2`/`0x20` as
  `20 00 00 06 <nameLen> <name> <sizeHi> <sizeLo> <file>` (bytes 2–4 unexplained).
  It's a PEM certificate: self-signed, `CN=ePaper CMS Server`, new each session,
  valid for 50 years, server auth, SANs `0.0.0.0`, `localhost`, `127.0.0.1`. It's
  sent just before `0xC7`/`0x54` points the display at
  `https://<phone>:6869/device-thumbnail`, so it presumably lets the display trust
  the app's HTTPS server.

Settings mapped from two captures (firmware `S-RSEDWWC-1130.7`), the second
labelled by hand as each change was made. **Confirmed** means a person watched
the app change that setting; **likely** comes from timing and values, so test
before relying on it.

| Setting | Command | Write | Confidence |
| ------- | ------- | ----- | ---------- |
| Clock | `0xA7` | `[day, hour12, minute, month, yearHi, yearLo, 00]` | Confirmed |
| Time zone + NTP | `0xCA`/`0x40` | `40 00 01 80 <len> <server> 81 <len> <zone>`; byte 3 is `00` with server `"Null"`, so probably NTP on/off | Confirmed |
| Time zone list | `0xD2`/`0x71` | Read only: `71 00 <count>` then length-prefixed names (90 zones) | Confirmed |
| Device name | `0x67` | ASCII name | Confirmed |
| PIN | `0x1B`/`0x87` | `87 <ASCII digits>`; display echoes it | Confirmed |
| Orientation | `0xC8`/`0x81` | `81 00` landscape, `81 01` portrait | Confirmed |
| Source | `0xC7`/`0x81` | `81 03` USB, `81 04` the normal source; the app re-uploads the certificate and thumbnail request when returning to `04` | Confirmed |
| Screen protector time | `0x1B`/`0xB0` | `b0 80 02 <HH> <MM>`; 3 am is `03 00`, 24-hour format unconfirmed. Read adds `81 04 <HH> <MM> 04 0b` | Confirmed |
| Wallpaper color | `0x21`/`0x90` | `90 00 <n>`: 0 white, 1 black, 2 red, 3 green, 4 blue, 5 yellow | Confirmed |
| Sleep mode | `0xB5` | `00` deep sleep, `01` network standby on; the app follows it with `0xC6` `81 08` (see below) | Confirmed |
| Sleep after | `0xC6`/`0x81` | `81 f0 00 <minutes>`: 16 min is `f0 00 10`, 18 min is `f0 00 12`. Above 255 minutes unconfirmed | Confirmed |
| Sleep when content finishes | `0xC7`/`0x53` | `53 01 <00/01>`; read with `53` | Confirmed |
| Battery warning | `0x1B`/`0x73` | `73 00 <00/01>` | Confirmed |
| Button lock | `0x5F` | `00` off, `01` on | Confirmed |
| USB lock | `0x1B`/`0x75` | `75 00 <00/01>` | Confirmed |
| Picture mode | `0x71` | `24` Vivid, `22` Custom; other modes not captured | Confirmed |
| Color (Custom mode) | `0x27` | The value the app shows (11 is `0b`); default 25 | Confirmed |
| PoE charging and data | `0x22`/`0x10` | `10 00 03 07 d0 d2`, same bytes in both captures; other options and off not captured; ACK takes ~3 s | Likely |
| Restart | `0xD2`/`0x23` | `23`; display dropped within 0.5 s, back within 55 s | Likely |
| Thumbnail upload | `0xC7`/`0x54` | `54 <url>`; reply `54 <len> <url>` | Likely |

Still unexplained:

- **`0xC6` `81 08`.** The value before any custom sleep after was set. The app
  writes it after every sleep mode change, and a later read returns `81 08`, so
  changing sleep mode replaces a custom sleep after. Probably a preset.
- **`0x1B` `b0 00 00`.** Follows every picture change. It usually NAKs (`b0 01`)
  after ~3 s, and once ACKed immediately, after color returned to its default.
- **Custom mode sliders.** Entering Custom also writes `0x21`/`0x4F` (`00`), `0x24`
  (`50`), `0x96` (`00`) and `0x27` with their current values. Only `0x27` is
  identified; the rest are probably the other sliders.
- **Battery read.** `0x1B`/`0x73` byte 2, labelled "present" in `lib/Device.mjs`,
  may really be the battery warning flag. No read has been captured with the
  warning off.
- `0xC7`/`0x50` reads `50 00 00 80 02 04 00`, right after switching source to USB.
- `0x1B`/`0x8C` reads `8c 01` just before the PoE write; `0x1B`/`0x71` reads `71 00`.
- `0xD2`/`0x10`: `10 "4:1:1:0"` returns `10 "4:1:1:US"`, a region or country query.
- `0xD2`/`0x70`: JSON describing Samsung's terms-and-conditions endpoint.

---

## Confirmed NOT supported

These reliably `NAK` a get — the display understands MDC but this feature doesn't
exist on an e-paper panel:

`0x00` status-all · `0x08` panel-on-time · `0x0C` model-number · `0x0D`
error-status · `0x11` power **get** · `0x12` volume · `0x13` mute · `0x14`
input-source · `0x15` picture-mode · `0x19` screen-size · `0x1A` video-wall ·
`0x84` temperature — plus ~130 more across the range.

Silent (no response at all): `0xD1` and essentially the entire `0xBB`–`0xFD`
range, and most of `0x2D`–`0x60` (lamp / fan / timer / diagnostics commands that
only exist on powered signage panels).

**Takeaway:** there is no hidden feature set. Volume, input switching, brightness,
picture controls, video-wall, thermal — none of it applies to this hardware and
none of it responds. The complete useful surface is the ~13 readable + 4 writable
commands above (plus WoL). Your existing controller already implements the
important half.

**Correction:** the sweep only sent empty gets, so it can't see commands that need
a payload. `0xD2` falls in the "silent" range above, yet it's how Samsung's app
uploads files. Treat "silent" as "doesn't answer an empty get", not "doesn't
exist".

---

## Operational notes for a durable controller

- **One session at a time.** The display accepts a single MDC/TLS connection.
  A dropped connection isn't reaped instantly — expect to retry the initial
  connect for ~30–60 s (fresh `Device` per attempt) if a previous session died
  uncleanly.
- **It throttles under load.** After roughly 30–60 rapid commands on one
  connection, the display starts silently dropping responses (looks like
  timeouts). Keep cadence gentle (≥250 ms between commands) and reconnect if it
  goes quiet. This is why bulk sweeps show tail-end timeouts on commands that
  otherwise ACK.
- **Auth quirk.** A wrong PIN sometimes returns `MDCAUTH<<FAIL:0x01>>` and
  sometimes just goes silent (looks like a connect timeout). Don't assume a
  timeout means "asleep" — it can mean "wrong PIN" or "session busy."
- **Sleeping displays are invisible.** In deep sleep (network standby off) the
  unit answers nothing — not MDC, not SSDP, not ping. Wake via WoL first.

## Library coverage

`lib/Device.mjs` implements: `getSerialNumber` (0x0B), `getSoftwareVersion`
(0x0E), `getModelInfo` (0x10), `getDeviceName` (0x67), `getPowerState` (0x11,
returns null — NAK'd), `getBatteryState` (0x1B/0x73), `getNetworkStandby` /
`setNetworkStandby` (0xB5), `getOnTimer` / `setOnTimer` (0x25), `getClock`
(0xA7), `setPower` (0x11), `setContentDownload` (0xC7), and `wakeup` (WoL). The
generic `sendCommand({ commandId, data })` is the escape hatch for anything else.

`lib/Settings.mjs` describes the settings captured from Samsung's app.
`getSetting`, `setSetting` and `getSettings` read and write them by name, and
`getTimeZones` reads the zone list. The web app shows them under **Device
settings**, except PoE and restart, which aren't fully mapped. Two differences
from the app: `setSetting` doesn't send `0xC6` `81 08` after a sleep mode change,
so a custom sleep after survives it, and it doesn't rewrite the Custom picture
values when entering that mode.

## Capturing commands from Samsung's app

Settings the app exposes but this table doesn't cover (orientation, screen
saver time, clock, default background color, sleep mode/timer, battery
warning, PIN change, button lock, USB lock) can be mapped with
`tools/mdc-proxy.mjs`. It answers the app the way the display does
(`MDCSTART<<TLS>>`, then TLS with its own self-signed certificate), opens its
own session to the real display, relays both directions and logs every frame
decoded. Commands not in this document are flagged **NEW** and writes are
highlighted.

1. **Stop anything else talking to the display** (one session at a time):
   `docker compose stop`.
2. **Wake the display** so it's listening on 1515.
3. **Swap addresses.** Samsung's app can't add a display by IP, so the proxy has
   to answer at the address the app already knows. Move the display to a spare
   IP and give the proxy machine the display's usual IP. Nothing in the web app
   needs changing if you put both addresses back afterwards.
4. **Start the proxy** on that machine, pointing at the display's temporary IP:

   ```bash
   node tools/mdc-proxy.mjs --host 10.10.1.199
   ```

   On macOS 15+, Node needs Local Network permission (System Settings →
   Privacy & Security → Local Network) or connections to the display fail with
   `EHOSTUNREACH`; macOS asks the first time you run it from Terminal.
   Alternatively run it in Docker, which already has LAN access:

   ```bash
   docker run --rm -it -p 1515:1515 -e TZ=America/Chicago \
     -v "$PWD/tools:/tools" -v "$PWD:/work" -w /work \
     samsung-emdx node /tools/mdc-proxy.mjs --host 10.10.1.199
   ```

   (The image has no `openssl`, so create the proxy's certificate once by
   running the host command first, or it exits with a message saying so.)
5. **Open Samsung's app** and connect to the display as usual. The proxy logs
   `app … connected`, then `file upload` once the app has finished its session
   start.
6. **Change one setting at a time.** Before each, type a note in the proxy's
   terminal (e.g. `button lock on`) and press Enter; it's written into the log
   as a divider. Change each setting to two or three values so the encoding is
   obvious.
7. **Ctrl+C** prints every command the app wrote with the values seen. The
   full session is in `mdc-capture-<timestamp>.jsonl` (one JSON object per
   frame, note or event). `Ctrl+Z` only pauses the proxy, and the paused process
   keeps port 1515: use `fg`, then Ctrl+C.
8. **Put both addresses back**, then `docker compose up -d`.

PINs are masked in the log unless you pass `--show-pin`: logging in, the display
reading its PIN back, and setting a new one. If the app won't connect through the
proxy (the proxy logs an app TLS error), the app is validating the display's
certificate; fall back to reading the app itself.
To confirm a mapping afterwards, read the command back with
`device.sendCommand({ commandId })` and compare it with the value you set.
