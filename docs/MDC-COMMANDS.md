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
| `0x27` | Unknown                       | `0x19` (25)                | Constant; likely a timer/index field. |
| `0x67` | Device name                   | `"Display 4"` (ASCII)      | The name set during onboarding. |
| `0x71` | Unknown                       | `0x24` (36)                | |
| `0x96` | Unknown                       | `0x00`                     | |
| `0xA7` | **Real-time clock / date**    | `0d 05 08 08 07 EA 00`     | `[day, dayOfWeek(Sun=1), minute, month, yearHi, yearLo, 00]`. day/month/year verified against wall clock; dow/minute inferred. |
| `0xB5` | Network standby (WoL listener)| `0x01` (on)                | Get + set both work. |
| `0xB6` | Software-update status (likely)| `00 0B 00 00 00 00 0B ...`| 13-byte struct; interpretation tentative. |

### `0x1B` status container sub-commands

`0x1B` takes a one-byte sub-command. Confirmed responders on EM32DX:

| Sub    | Meaning                        | Sample |
| ------ | ------------------------------ | ------ |
| `0x73` | **Battery state**              | `73 CC PP HH LL ..` → charging / present / healthy / level% |
| `0x61` | Unknown                        | `61 00` |
| `0x62` | Unknown (text)                 | `62 "Unknown"` |
| `0x75` | Unknown                        | `75 00 00` |
| `0x87` | Returns the display **PIN**    | `87 "014381"` (only after auth) |
| `0x8D` | Unknown                        | `8D 01` |

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
