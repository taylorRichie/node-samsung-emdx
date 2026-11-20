# HTTP API

Everything the web app does goes through this API, so scripts, Home Assistant and other tools can do the same. It's served by the app on port 3001: `http://<this computer>:3001/api/...`. There's no login; keep the port on your own network.

Wherever a path has `:display`, use the display's id or its name. Names match in any case, or written as a slug: a display named "Living Room" answers to `living room`, `Living Room` and `living-room`. Groups (`:group`) work the same way. `GET /api/state` lists both, with their slugs.

Errors come back as `{ "error": "…" }` with a 4xx or 5xx status.

## Sending images

A display that's asleep can't take an image straight away. Every send is kept until the display has it:

1. The first try wakes the display if it can. Wake-on-LAN works for a display in **Network standby** that has a MAC address. A display in deep sleep can only be woken by its power button or its own wake timer.
2. If the display can't be reached, the image waits. It goes out as soon as the display is seen awake. The app checks every minute, and also retries with Wake-on-LAN after 30 s, 1, 2, 5, 10 and then every 15 minutes. Waiting images survive a restart of the app.
3. A newer image for the same display replaces one that's still waiting.
4. Problems that retrying can't fix, like a wrong PIN or the app's own address not being set, stop the retries. The image waits as `failed` until the setting is fixed, which retries it automatically, or until you retry or cancel it.

So a send answers with one of:

| Status | Meaning | Body |
| --- | --- | --- |
| `200` | The display has the image | `{ "success": true, "delivered": true }` |
| `202` | Queued: it goes out when the display can be reached | `{ "success": true, "delivered": false, "queued": true, "message": "…", "delivery": {…} }` |
| `502` | Stopped: needs a setting fixed (see `error`) | `{ "error": "…", "delivered": false, "delivery": {…} }` |

### `POST /api/displays/:display/push`

Sends one image to a display. The image is one of:

- `image`: a file, in a multipart form
- `url`: a link the app downloads (JSON or form field)
- `gallery`: a library item, as `"category/file.jpg"` (see `GET /api/gallery`)
- `base64`: the image itself, plain base64 or a `data:` URL (JSON)

Options, all optional, for this and every other send:

| Option | | Default |
| --- | --- | --- |
| `fit` | How the image is sized to the panel: `fit` (all of it, with bars), `fill` (cover, cropping) or `stretch` | Settings → Image fit |
| `background` | Bar color for `fit`, like `#ffffff` | Settings |
| `profile` | Tone: `eink`, `vivid`, `bw` or `none` | Settings → Default profile |
| `sleepAfter` | Minutes the display stays awake afterwards (0 keeps it awake) | The display's own setting |
| `sleepMode` | Then sleep as `manual`, `scheduled` (arms its wake timer) or `deep` | Follows its mode |
| `wait` | `false` answers `202` at once instead of waiting for the first try | `true` |
| `edit` | A layout from the web app's designer (JSON) | |

Every image leaves at the panel's exact size, 2560 × 1440 or 1440 × 2560, whatever size it arrived at.

```bash
curl -X POST http://localhost:3001/api/displays/living-room/push \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/art.jpg", "fit": "fill"}'

curl -X POST http://localhost:3001/api/displays/living-room/push -F image=@art.png -F fit=fit -F background=#ffffff
```

### `POST /api/displays/:display/queue/push-next`

Sends the next image in the display's queue. The queue moves on straight away, even if the display can't be reached yet. Takes the send options above.

`POST /api/displays/:display/queue/:imageId/push` sends a particular queued image, and the queue carries on from it.

### `POST /api/displays/:display/providers/apply`

Sends the latest image from the display's chosen feed (NASA, Wikimedia and so on). Feed images fill the panel unless you pass `fit`.

### `POST /api/groups/:group/span`

Spans one image across a group's displays, each getting its slice at the same time. The picture carries on behind the frames and gaps between displays (set per group in the app), so lines stay straight across them.

The image is `image`, `url`, `gallery` or `base64`, as for a push. With none, the group's last image is sent again. The wall is laid out from how the displays are arranged on the app's canvas, and the image placed by `fit`: `fill` (the default), `fit` or `stretch`. `only` (an array of display ids) resends just those slices, to retry displays that missed it.

```json
{
  "groupId": "…", "sent": 2, "queued": 1,
  "results": [
    { "displayId": "…", "name": "Left", "state": "delivered", "ok": true },
    { "displayId": "…", "name": "Right", "state": "queued", "ok": false, "message": "Asleep in deep sleep…" }
  ]
}
```

`state` is `delivered`, `queued` or `failed` for each display. A queued one says why in `message`, a failed one in `error`.

### The waiting image

| | |
| --- | --- |
| `GET /api/displays/:display/delivery` | `{ "delivery": {…} }`, or `null` when nothing is waiting |
| `GET /api/deliveries` | Every display's, by id |
| `POST /api/displays/:display/delivery/retry` | Tries again now, waking the display like a fresh send. Answers like a send. |
| `DELETE /api/displays/:display/delivery` | Drops it. The display keeps what it shows. |

A delivery is `{ id, label, source, state, attempts, createdAt, lastAttemptAt, nextAttemptAt, error }`. `state` is `pending` (waiting for its next try), `sending` or `failed` (stopped, see `error`). `source` says where it came from: `push`, `edit`, `queue`, `schedule`, `span` or `feed`. Times are epoch milliseconds.

## Status

### `GET /api/state`

Everything at once, from what the app already knows, so it never wakes a display. This is what Home Assistant polls.

```json
{
  "server": { "address": "192.168.1.20", "port": 3001, "time": 1795034000000 },
  "displays": [{
    "id": "…", "name": "Living Room", "slug": "living-room", "host": "192.168.1.37", "connected": true,
    "serialNumber": "0WPS…", "softwareVersion": "S-RSEDWWC-1130.7",
    "orientation": "portrait", "awake": false, "sleepMode": "standby", "sleepAt": null,
    "battery": { "level": 73, "charging": false, "at": 1795033000000 },
    "clock": { "time": "2026-11-19T08:01", "drift": -42, "checkedAt": 1795033000000 },
    "lastImageAt": 1795033000000,
    "delivery": null,
    "queue": { "count": 12, "next": 4 },
    "schedule": { "enabled": true, "nextWakeAt": 1795060800000, "wakeTimer": null }
  }],
  "groups": [{ "id": "…", "name": "Hallway", "slug": "hallway", "displayIds": ["…", "…"], "lastSpanAt": 1795033000000 }]
}
```

- `battery` is the last reading, which stays known while the display sleeps. `at` says when it was read.
- `awake` means the display answered the last check.
- `serialNumber` and `softwareVersion` are `null` until the app has read them from the display (its status, or Settings).
- `clock.drift` is how many seconds the display's clock is ahead of the app's (negative when behind), to the minute.
- `schedule.wakeTimer` is `refused` when the display wouldn't take its wake timer (firmware 1130.7), so it won't wake by itself.

Other status endpoints:

| | |
| --- | --- |
| `GET /api/displays/:display/status` | Asks the display now (it must be awake): power, battery, standby, serial, version |
| `GET /api/statuses` | Last known status of every display (`null` when asleep) |
| `GET /api/displays/:display/battery-log` | Battery readings and use per day |
| `GET /api/displays/:display/last-image` | The image on the display now (JPEG) |
| `GET /api/events` | Live updates as server-sent events (see below) |

`/api/events` sends `{ "type": … }` messages:

- `snapshot`: on connect, with every status
- `status`: a display's status changed
- `push`: a display has a new image
- `display`: a display's settings changed
- `delivery`: its waiting image changed, `null` once gone
- `delivered`: a waiting image arrived
- `changed`: displays, groups, a schedule or the settings changed (`what`: `displays`, `groups`, `schedule` or `settings`, and `displayId` when it's about one display)

## Control

| | |
| --- | --- |
| `POST /api/displays/:display/wake` | Wakes it (network standby with a MAC address), and answers once it's awake |
| `POST /api/displays/:display/sleep` | Puts it to sleep. `{ "sleepMode": "manual" }` or `"scheduled"` |
| `POST /api/displays/:display/sleep/force` | Deep sleep: only its button or wake timer brings it back |
| `GET /api/displays/:display/settings` | Settings stored on the display (orientation, sleep, clock, time zone…) |
| `PUT /api/displays/:display/settings` | Changes them, for example `{ "orientation": "landscape" }` |

## Clock

The display keeps its own time, and that time decides when a sent image starts showing. The app checks it every time it sends an image, and sets it to the app's time when it's more than about a minute out (Settings → Keep display clocks in sync).

| | |
| --- | --- |
| `GET /api/displays/:display/clock` | `{ time, drift, serverTime, timeZone, checkedAt, cached }`. Read now if the display is awake; otherwise the last reading, with `cached: true`. Add `?wake=1` to wake it and read it fresh. |
| `POST /api/displays/:display/clock/sync` | Sets its clock to the app's time, waking it first if it can |

`time` is the display's local time, to the minute. The app's time zone is in Settings → General.

## Schedule

A display on a schedule gets the next image from its queue (or its feed) at each wake time. The app keeps the time and wakes the display with Wake-on-LAN, which needs **Network standby** and a MAC address. A display in deep sleep instead has its own wake timer set as it goes to sleep, which firmware 1130.7 refuses (`wakeTimer: "refused"`). Such a display gets its image whenever it next wakes for another reason.

| | |
| --- | --- |
| `GET /api/displays/:display/schedule` | The schedule, plus `mode` and `wakeMethod` (`network` or `timer`) |
| `POST /api/displays/:display/schedule` | Changes it (body below) |
| `GET /api/displays/:display/schedule/upcoming?count=10` | The next wake times |
| `POST /api/displays/:display/mode` | `{ "mode": "scheduled" }` runs the schedule, `"manual"` stops it |

```json
{
  "enabled": true,
  "by": "times",
  "times": ["07:30", "12:00", "18:00"],
  "days": [1, 2, 3, 4, 5]
}
```

```json
{ "enabled": true, "by": "interval", "intervalValue": 2, "intervalUnit": "hours", "between": { "from": "08:00", "to": "22:00" } }
```

- `days`: 0 is Sunday.
- `intervalUnit`: `minutes`, `hours`, `days` or `weeks`.
- `between` keeps an interval to a window each day. Leave it out (or `null`) to count from the last wake.

## Library

| | |
| --- | --- |
| `GET /api/gallery` | `{ items: [{ id, category, file, title, uploaded }] }` |
| `GET /api/gallery/image/:category/:file?w=300` | The image, or a thumbnail `w` pixels wide |
| `POST /api/gallery` | Adds artwork: multipart `images` (up to 20 files) and an optional `category` |
| `DELETE /api/gallery/:category/:file` | Removes uploaded artwork. Pieces from the library folder can't be removed here. |
| `POST /api/displays/:display/queue/from-gallery` | `{ "ids": ["category/file.jpg"] }` adds them to a display's queue |

```bash
curl -X POST http://localhost:3001/api/gallery -F category=Botanical -F images=@fern.jpg -F images=@moss.png
```

## Settings

`GET /api/app-settings` and `PUT /api/app-settings` cover:

- `serverAddress`: the address displays download from
- `timeZone`
- `defaultProfile`
- `imageFit` (`fit`, `fill` or `stretch`) and `imageBackground` (`#rrggbb`)
- `syncClocks` (`true` or `false`)
