# Home Assistant

The **Samsung EMDX** integration brings the app's displays into Home Assistant: battery, whether each display is awake, what it shows and what's waiting to go to it, with buttons, a schedule switch and actions to send images. It talks to the app's [HTTP API](API.md), so the app does the work of reaching the displays and Home Assistant never needs their PINs.

It needs the app running somewhere Home Assistant can reach, and Home Assistant 2025.8 or newer. The simplest is the **Samsung EMDX add-on**, which runs the app inside Home Assistant (see the README). Then the app's address is `http://127.0.0.1:3001`. The app can just as well run on another computer, in Docker or on its own.

## Install

### With HACS

1. In HACS, open the menu (⋮) and choose **Custom repositories**.
2. Add `https://github.com/PeitzGreene/node-samsung-emdx` with the type **Integration**.
3. Find **Samsung EMDX** in HACS and download it.
4. Restart Home Assistant.

### By hand

Copy the `custom_components/samsung_emdx` folder from this repository into the `custom_components` folder of your Home Assistant configuration (so you have `/config/custom_components/samsung_emdx/manifest.json`), then restart Home Assistant.

## Set up

1. Go to **Settings → Devices & services → Add integration** and pick **Samsung EMDX**.
2. Enter the app's address as you'd open it in a browser, for example `http://192.168.1.20:3001`. With the add-on, use `http://127.0.0.1:3001`.

Home Assistant checks the address by reading the app's state. Use an address Home Assistant can reach: if Home Assistant runs in Docker, `localhost` is the container itself, so give the computer's network address instead. Each app can be added once. To change the address later, choose **Reconfigure** on the integration.

Every display in the app becomes a device (Samsung EM32DX). Displays you add to the app later show up on their own; one you remove from the app becomes unavailable, and you can then delete its device in Home Assistant.

**Options:** the polling interval, 30 seconds unless you change it. The integration reads `GET /api/state`, which never wakes a display. It also follows the app's live events, so a push, a delivery or a display waking or sleeping usually shows up within a second or two. Polling covers everything on its own if the events can't be reached.

## Entities

Each display has these, named after the display (a display called "Living Room" gets `sensor.living_room_battery` and so on):

| Entity | | |
| --- | --- | --- |
| Battery | sensor, % | The last reading. It stays known while the display sleeps. Attributes `charging`, `read_at`. |
| Charging | binary sensor | On while charging. |
| Awake | binary sensor (connectivity) | On when the display answered the app's last check. |
| Delivery | sensor | The image waiting to go to it: `idle` (nothing waiting), `waiting`, `sending` or `failed` (stopped, needs a setting fixed). Attributes `label`, `source`, `error`, `attempts`, `next_attempt`. |
| Last image | sensor, timestamp | When the display last got an image. |
| Next wake | sensor, timestamp | When its schedule next wakes it; unknown with no schedule. Attribute `wake_timer` (`refused` when the display won't take its wake timer). |
| Queue | sensor | Images in its queue. Attribute `next`: the position that goes next. |
| Clock drift | sensor, seconds (diagnostic) | How far the display's clock is ahead of the app's (negative when behind), to the minute. Attributes `display_time`, `checked_at`. |
| Current image | image | What the display shows now. |
| Wake | button | Wakes it (network standby with a MAC address), and answers once it's awake. |
| Sleep | button | Puts it to sleep, arming its wake timer when it's on a schedule. |
| Next image | button | Sends the next image in its queue. Answers at once; **Delivery** follows the send. |
| Retry delivery | button | Tries the waiting image again now. |
| Sync clock | button (configuration) | Sets its clock to the app's time, waking it first if it can. |
| Schedule | switch | On runs the display's schedule (the times and days are set in the app). Off puts it back in manual mode and keeps the schedule for next time. |

A button or switch that fails shows the app's own error, for example "The queue is empty".

## Actions

### `samsung_emdx.send_image`

Sends an image to one or more displays. Target the display devices, or any entity of a display (such as `image.living_room_current_image`), or an area, floor or label that has displays.

| Field | | |
| --- | --- | --- |
| `url` | one of these three | A link to the image. The app downloads it, so it must reach that address. |
| `path` | | A file Home Assistant can read, such as `/config/www/art.jpg`, uploaded to the app. It must be in `/config/www`, the media folder, or a folder in [`allowlist_external_dirs`](https://www.home-assistant.io/integrations/homeassistant/#allowlist_external_dirs). A relative path is taken from the config folder. |
| `gallery` | | An item from the app's library, as `category/file.jpg`. |
| `fit` | optional | `fit` (all of it, with bars), `fill` (cover, cropping) or `stretch`. Default: the app's setting. |
| `background` | optional | Bar color for `fit`, like `#ffffff`. |
| `profile` | optional | `eink`, `vivid`, `bw` or `none`. |
| `wait` | optional | `true` (default) waits for the first attempt to send it. `false` answers at once. |

A display that's asleep can't take an image straight away. The app keeps the image and sends it as soon as the display can be reached, so the action succeeds with the image **queued**; the Delivery sensor shows it waiting. A newer image for the same display replaces one that's still waiting. The action fails, with the app's error, when the image can't be had (a link that doesn't download, a library item that doesn't exist) or the send has stopped on something retrying can't fix, such as a wrong PIN.

With `response_variable` it tells you what happened to each display:

```yaml
results:
  - display_id: 8e0a49ed-8177-447b-a2c6-7e03dc570370
    name: Living Room
    state: delivered          # or queued
  - display_id: 00c1acd1-7585-425c-8c9e-c26927744368
    name: Bedroom
    state: queued
    message: "Asleep in deep sleep, which can't be woken over the network. It gets the image when it next wakes: …"
```

### `samsung_emdx.span_image`

Spans one image across a group's displays, each getting its slice, laid out as the displays are arranged in the app. Groups are made in the app.

| Field | | |
| --- | --- | --- |
| `group` | required | The group's name (any case, or as a slug like `hallway`) or id. |
| `url`, `path`, `gallery` | optional | The image, as for `send_image`. With none, the group's last image is sent again. |
| `fit`, `background`, `profile`, `wait` | optional | As for `send_image`. `fit` defaults to `fill`. |

It succeeds when every slice was delivered or queued, and fails, naming the displays, when any of them stopped. The response gives `group_id`, `group`, `sent`, `queued` and `results` per display.

## Examples

These use Home Assistant's current automation syntax. Find a display's entity ids under **Settings → Devices & services → Samsung EMDX**.

### A camera snapshot

```yaml
automation:
  - alias: "Doorbell snapshot on the hallway display"
    triggers:
      - trigger: state
        entity_id: binary_sensor.doorbell
        to: "on"
    actions:
      - action: camera.snapshot
        target:
          entity_id: camera.front_door
        data:
          filename: /media/emdx/doorbell.jpg
      - action: samsung_emdx.send_image
        target:
          entity_id: image.hallway_current_image
        data:
          path: /media/emdx/doorbell.jpg
          fit: fill
          profile: vivid
```

`/media` keeps the snapshot private. Anything in `/config/www` is served by Home Assistant to anyone at `/local/…`.

### A file from /config/www

Upload it from Home Assistant:

```yaml
action: samsung_emdx.send_image
target:
  device_id: 5b3e0c7a9d2f4e1b8c6a0f9e7d5c3b1a
data:
  path: /config/www/art/monday.jpg
  fit: fit
  background: "#ffffff"
```

Or let the app download it. Use Home Assistant's network address: the app does the download, so `localhost` would be the app's own computer.

```yaml
action: samsung_emdx.send_image
target:
  entity_id:
    - image.living_room_current_image
    - image.bedroom_current_image
data:
  url: http://192.168.1.10:8123/local/art/monday.jpg
```

### Across a group

```yaml
automation:
  - alias: "Panorama across the hallway every morning"
    triggers:
      - trigger: time
        at: "07:00:00"
    actions:
      - action: samsung_emdx.span_image
        data:
          group: Hallway
          gallery: Landscapes/alps.jpg
          fit: fill
```

### Low battery

```yaml
automation:
  - alias: "E-paper battery low"
    triggers:
      - trigger: numeric_state
        entity_id:
          - sensor.living_room_battery
          - sensor.hallway_battery
        below: 20
    conditions:
      - condition: template
        value_template: "{{ not state_attr(trigger.entity_id, 'charging') }}"
    actions:
      - action: notify.notify
        data:
          title: "E-paper battery low"
          message: >-
            {{ state_attr(trigger.entity_id, 'friendly_name') }} is at
            {{ trigger.to_state.state }}%.
```

### The next image from the queue

```yaml
automation:
  - alias: "Next picture at 08:00 on weekdays"
    triggers:
      - trigger: time
        at: "08:00:00"
    conditions:
      - condition: time
        weekday: [mon, tue, wed, thu, fri]
    actions:
      - action: button.press
        target:
          entity_id: button.living_room_next_image
```

### Tell me when an image couldn't be sent

```yaml
automation:
  - alias: "E-paper delivery stopped"
    triggers:
      - trigger: state
        entity_id: sensor.living_room_delivery
        to: failed
    actions:
      - action: notify.notify
        data:
          message: >-
            The living room display stopped trying:
            {{ state_attr('sensor.living_room_delivery', 'error') }}
```

## Troubleshooting

- **Can't connect when adding it**: open the address from the Home Assistant machine (for example `curl http://192.168.1.20:3001/api/state`). From Docker, use the host's network address.
- **"Couldn't download the image"**: the app couldn't fetch the `url`. Make sure it's reachable from the computer running the app, or send the file with `path` instead.
- **"Home Assistant isn't allowed to read …"**: put the file in `/config/www` or the media folder, or add its folder to `allowlist_external_dirs`.
- **An image stays waiting**: a display in deep sleep can't be woken over the network. It gets the image when it next wakes (its power button or its own wake timer). Network standby with a MAC address lets the app wake it.
- To see what the integration does, add this to `configuration.yaml`:

  ```yaml
  logger:
    logs:
      custom_components.samsung_emdx: debug
  ```
