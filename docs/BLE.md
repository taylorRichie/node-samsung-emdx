# EM32DX Bluetooth (BLE) protocol

> **Set up Wi-Fi without Samsung's app: [`tools/ble-setup.py`](../tools/ble-setup.py).**
> Standalone Python (needs only `pip install bleak bcrypt`), on **Linux with
> BlueZ**, for example a Raspberry Pi:
>
> ```bash
> # New display (offers Bluetooth setup until it's on a network)
> python3 tools/ble-setup.py --pin 123456 --ssid "My WiFi" --ask-password
> # Display already on a network: turn on its Bluetooth setup over MDC first
> python3 tools/ble-setup.py --turn-on 192.168.1.37 --mac 00:11:22:33:44:55 \
>     --pin 123456 --ssid "My WiFi" --ask-password
> python3 tools/ble-setup.py --pin 123456 --status   # where is it connected?
> python3 tools/ble-setup.py --selftest              # check against captured bytes
> ```
>
> `--static 192.168.1.50/24 --gateway … --dns …` sets a fixed address instead
> of DHCP. The self-test passes on macOS, and `--turn-on` was tested against a
> real display; the Bluetooth half needs a Linux run to confirm. If BlueZ also
> refuses to listen (`start_notify` fails), the fallback is `bluepy`, which
> reads raw ATT and sees indications from any handle.
>
> **Browsers can't do this (tested in Chrome on macOS).** The setup
> characteristic declares *write* and *indicate* but has **no descriptors**, so
> no Client Characteristic Configuration descriptor. Web Bluetooth's
> `startNotifications()` fails with `GATT Error: Not supported`, and Chrome only
> delivers indications to a page that subscribed, so the login challenge never
> arrives. Samsung's Android app gets them because it only calls
> `setCharacteristicNotification()` (local routing) and never writes a CCCD.
> A working host has to accept indications without subscribing: an ESP32
> (ESP-IDF/NimBLE register the handle locally) or Linux with a raw-HCI stack
> (`noble`, `bluepy`), which is why the script targets Linux.
>
> **A display that's already on a network doesn't offer the setup service**
> (only `ade3d529-c784-4f63-a987-eb69f70ee816`). Samsung's app first sends MDC
> `0x22`/`0x10` `10 00 03 07 d0 d2` ("turn on BLE", 2000 ms; see
> MDC-COMMANDS.md) over the network, then connects over Bluetooth. The web app
> sends the same from `POST /api/displays/:id/bluetooth`, and the script from
> `--turn-on`.

What Samsung's E-Paper app (Android) sends over Bluetooth, decoded from an HCI
snoop log taken while it moved a display to a new Wi-Fi network (firmware
`S-RSEDWWC-1130.7`, 2026-11-10). Work in progress: the login isn't cracked yet,
so nothing here can be replayed.

## Capturing it

1. On the phone: Developer options → **Enable Bluetooth HCI snoop log** →
   Enabled (not Filtered), and turn on USB debugging. Toggle Bluetooth off and
   on so the log starts fresh.
2. Do the thing in Samsung's app and note the time.
3. `adb bugreport` (or take one from Developer options and pull it from
   `/bugreports/`). The log is `FS/data/misc/bluetooth/logs/btsnoop_hci.log`
   in the zip.
4. Decode with Wireshark or
   `/Applications/Wireshark.app/Contents/MacOS/tshark -r btsnoop_hci.log -Y btatt`.

**The log contains your Wi-Fi password in plain text** (see Wi-Fi setup
below). Don't commit it, and delete it when you're done. Turn the snoop log off
afterwards.

## Discovery and pairing

- Advertises as **`EM32DX <last 4 of serial>`**, e.g. `EM32DX 097N`.
- Custom Samsung services, including 128-bit UUIDs
  `b5f364314f2e9182744e1bef01003ee7`, `16e80ef769eb87a9634f84c729d5e3ad` and
  `676e6974746553656369766544435653`, which is ASCII `VSCDeviceSetting`
  backwards.
- The phone pairs with **LE Secure Connections**, so the radio link is
  encrypted; the snoop log sees it decrypted.
- **Everything goes through one characteristic, ATT handle `0x002a`**: the
  phone writes (Write Request) and the display answers with indications.

## Framing

Every message starts with a header byte and a length byte:

```
[header] [length] [body…]
header = seq (2 bits) | fragment (2 bits) | channel (4 bits)
```

| Channel | Direction |
| ------- | --------- |
| `0x0` | phone → display commands |
| `0x2` | display → phone replies (seq counts 0–3 and wraps: `02`, `42`, `82`, `c2`) |
| `0xe` | login, both ways |

Messages longer than one write are split. Fragment 1's body starts with the
**total length** (4 bytes, big-endian), later fragments start with their
**offset**:

```
1e 12 | 00 00 00 18 | 14 bytes        fragment 1 of 24 bytes, channel e
2e 0e | 00 00 00 0e | 10 bytes        fragment 2, offset 14
```

## Login (channel `0xe`) — bcrypt of the PIN — SOLVED

Recovered from the decompiled app (`com.samsung.android.ePaperApp` 1.3.3,
`com.samsung.android.ePaper.data.ble.BleDataSourceImpl`) and confirmed against
live captures. **The secret is the display's 6-digit PIN.**

| Step | Direction | Message (example) |
| ---- | --------- | ----------------- |
| 1 | phone | `0e 01 01` — request a challenge |
| 2 | display | `0e 12 <b> <16-byte salt>` |
| 3 | phone | `04 <23-byte bcrypt hash>`, split into two `0xe` fragments |
| 4 | display | `0e 02 02 00` — accepted |

**Parse the challenge** (`StartAuthorizationCommand`): take the frame's data
bytes; the first data byte `b` packs `version = (b >> 5) & 7` and
`cost = b & 31`; the next **16 bytes are the bcrypt salt**. `cost` is the
bcrypt work factor (observed `6`), and `T(cost)` picks the version string
(0→`2a`, 1→`2x`, 2→`2y`, 3→`2b`, else→`2a`) — but 2a/2b/2x/2y all produce the
same raw hash, so the version doesn't matter.

**Build the answer**: `rawhash = bcrypt(pin_ascii, salt, cost)` — the 23-byte
raw hash from `at.favre.lib:bcrypt` (`O1` package). Send command `04`
(ANSWER_AUTHORIZE) with those 23 bytes,
fragmented over two `0xe` writes (fragment 1: `1e 12 00 00 00 18` + 14 bytes;
fragment 2: `2e 0e 00 00 00 0e` + 10 bytes). The app's `J()` is just a
bcrypt-base64 decoder (alphabet `./A-Za-z0-9`) turning the library's ASCII hash
into raw bytes; replicate with any bcrypt that exposes the raw hash.

**Verified.** Two live logins, PIN `123456`, cost 6:

| salt (16 B) | bcrypt(123456, salt) raw hash (23 B) |
| ----------- | ------------------------------------ |
| `d9c54838ee4c751e54e973f5b9707883` | `153befc192a5d67ec08a30d44ac853716bce237fbb104c` |
| `4c30fa229415c474b7d5fcd5f165c6cf` | `afb86b69be9f1404d72a696d572a419f2a3e2468eecad8` |

(`$2a$06$…` full strings `0aTGMM3KbP3S4VNzsV/2eu…` and `RBB4GnOTvFQ1zdxT6UVExu…`.)
An earlier capture failed to match only because the display still had its
original random PIN then, not `123456`.

**Why this matters:** with the PIN, anything paired to the display can log in
over BLE and run the provisioning commands below — chiefly Wi-Fi onboarding of
a factory-fresh unit, which MDC can't do. This can run from the web app via
**Web Bluetooth** in Chrome/Edge (the browser does the BLE; the page must be on
`localhost` or HTTPS and the machine must have Bluetooth — Docker is not
involved). It is not a way to wake a sleeping display (see below).

## GATT service and characteristic (for Web Bluetooth)

- Setup service: **`53564344-6576-6963-6553-657474696e67`** (`BleDataSourceImplKt.b()`; the UUID spells `SVCDeviceSetting`).
- One characteristic for everything, write + notify/indicate: **`434d4444-6576-6963-6553-657474696e67`** (spells `CMDDeviceSetting`).
- Pairing-service UUID also seen: `434d4444-6576-6963-6550-616972696e67` (`CMDDevicePairing`).

## Commands (channel `0x0`)

Unfragmented: `00 <length> <command> [value…]`. Reply:
`<header> <length> 00 <command> [value…]`. IDs are from `BLECommandConstant`:

| ID | Name | Use |
| --- | ---- | --- |
| `0x10` | DEVICE_STATUS | read device/OOBE status |
| `0x11` | NETWORK_TYPE | set the active interface (`01` = Wi-Fi, seen) |
| `0x12` | NETWORK_ACCESS | IPv4 config: set `c0`+12 zeros = DHCP; read returns `d8` + IP, gateway, DNS (4 bytes each), e.g. `c0a80125` = 192.168.1.37 |
| `0x13` | NETWORK_ACCESS_V6 | IPv6 config |
| `0x14` | WIFI | **set Wi-Fi AP**: `14`, `0x40\|ssidLen`, ssid, pwLen, password — plain text, display echoes it |
| `0x15` | SCAN_ACCESS_POINT | scan for Wi-Fi networks |
| `0x16` | CLEAR_SAVED_ACCESS_POINT | forget saved Wi-Fi |
| `0x18` | POE_ACTIVATION | PoE+ enable/data (`00` = off, seen) |
| `0x19` | WIRED_AVAILABLE | query/enable wired Ethernet |
| `0x20` | WRITE_CA_CERTIFICATE | enterprise Wi-Fi CA cert |
| `0x21` | WRITE_CLIENT_CERTIFICATE | enterprise client cert |
| `0x22` | WRITE_EAP_CONFIGURATION | EAP (802.1X) settings |
| `0x23` | GET_CA_CERT_LIST | list installed CA certs |
| `0x01`–`0x04` | authorize | login (see above) |

The Wi-Fi session order was: login, read status/certs, PoE off (`0x18`=`00`),
network type Wi-Fi (`0x11`=`01`), send the Wi-Fi AP (`0x14`), set DHCP
(`0x12`), read `0x12` for the new address.

**There is no power/wake command here** — BLE is for network provisioning, and
the display is already awake during it. Waking from deep sleep over BLE is not
part of this protocol (the earlier guess that `0x11`=`01` was a wake was wrong;
it sets the network type). Whether the display even advertises BLE while in
deep sleep is untested.

**PIN is not set over BLE.** The app enters the PIN only to log in (bcrypt
above). The PIN value itself is managed over MDC (`0x1B`/`0x87`, already in
`lib/Settings.mjs`), so a from-scratch onboarding would: provision Wi-Fi over
BLE, then set the PIN over MDC once the display is on the network.
