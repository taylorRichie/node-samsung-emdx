# Fake display

Fake EMDX displays for testing the web app without hardware. Each one answers MDC over TLS on port 1515 like the real display does, then downloads what it's sent and saves it, so you can check exactly what a display would have received.

It needs Docker. The app always connects to port 1515, so each fake runs in its own container with its own address.

## Start

Build the app image first if you've changed the code (`docker compose build`, from the project root), then:

```bash
tools/fake-display/run.sh
```

This starts, on a Docker network of their own:

- `emdx-test-app`: a throwaway copy of the app at http://localhost:3011, with no saved state
- `fake-display-1` to `fake-display-3`, each added to the app as a display (PIN `123456`)

It doesn't touch the `samsung-emdx` container or its data.

Options: `run.sh [image] [count]`, for example `run.sh samsung-emdx:latest 4`. Defaults are `samsung-emdx:latest` and 3.

| Variable | Default | |
| --- | --- | --- |
| `PIN` | `123456` | PIN the fakes expect |
| `APP_PORT` | `3011` | Port for the test app on this computer |
| `FAKE_ORIENTATION` | `portrait` | `portrait` or `landscape` |
| `TZ` | | Time zone for the app and the fakes |

## What they received

Each fake saves what it downloads to `out/fake-display-N/` in this folder, as `<time>.jpg`, and adds a line to `index.jsonl` there with the file name, size and pixel dimensions. `display-ids.txt` maps each fake to its display id in the app.

```bash
docker logs -f fake-display-1
```

The log shows every command the app sent and the reply, and marks any the fake doesn't recognise.

## Stop

```bash
tools/fake-display/teardown.sh
```

This removes the test app, the fakes and their network. Saved images in `out/` are kept.

## How it differs from a real display

- It never sleeps. A power-off is logged, but it keeps answering.
- It reports orientation like the real display, and the app keeps each display's portrait or landscape in step with that. Change orientation from the app (the display's orientation setting), not by editing the display's rotation directly, or the app switches it back.
- Real displays refuse a power-state read and, on firmware 1130.7, an on-timer write. The fake accepts both. Run a fake with `POWER_GET_NAK=1` to refuse the power read as hardware does.
- It allows several connections at once, where a real display takes one.

Replies are modelled on captured traffic from a real display (firmware S-RSEDWWC-1130.7). See [docs/MDC-COMMANDS.md](../../docs/MDC-COMMANDS.md).
