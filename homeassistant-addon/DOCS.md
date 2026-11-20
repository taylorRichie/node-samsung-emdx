# Samsung EMDX

The Samsung EMDX web app, run by Home Assistant. Open it from **E-Paper** in the sidebar. Everything is set up in the app itself: there are no add-on options.

## First steps

1. Open **E-Paper** in the sidebar.
2. Choose **Add display** and enter its name, IP address and PIN (from the display's network screen). **Scan network** finds displays that are awake.
3. Open the display's settings (the gear) and set **Sleep mode** to **Network standby** and its **MAC address**. Then the app can wake it to send images and run its schedule. In deep sleep, a display only wakes for its power button, so images wait until then.

## The app's address

Displays download images straight from this add-on, on port **3001** of the Home Assistant machine. The add-on uses the host's network, so the app finds the machine's address by itself. If it can't, set it under the app's Settings → General.

The app is also at `http://<home assistant>:3001` outside the sidebar, for a phone on the same network or for scripts. Port 3001 must be free on the Home Assistant machine.

## Artwork

- **Upload** in the app's library keeps artwork with the add-on's data.
- Files you put in `/media/samsung-emdx/<category>/` show in the library too, under their folder's name. Add them with the Samba share, the File editor, or Media → Local media. JPEG, PNG and WebP work.

## The integration

The add-on runs the app. The **Samsung EMDX** integration brings its displays into Home Assistant: battery, awake and delivery sensors, the current image, wake, sleep and next-image buttons, and actions to send an image or span one across a group. Install it as described in the repository's `docs/HOME-ASSISTANT.md`. When it asks for the app's URL, enter:

```
http://127.0.0.1:3001
```

## Data and backups

Displays, queues, groups, schedules and uploaded artwork live in the add-on's data and are included in Home Assistant backups. Thumbnails and the depth model used for room photos are a cache that's left out of backups and made again when needed.

## Running it without Home Assistant

It's the same app: `docker compose up -d` in the repository, or `npm run start` in `web/`. A copy running on its own and this add-on keep separate data.
