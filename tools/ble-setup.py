#!/usr/bin/env python3
"""
Put a Samsung EMDX e-paper display (EM32DX, EM13DX, EM75DX) on a Wi-Fi network
over Bluetooth, without Samsung's E-Paper app. Protocol: docs/BLE.md.

Runs on Linux (for example a Raspberry Pi) with BlueZ. The display sends its
replies as indications on a characteristic with no subscribe descriptor;
BlueZ delivers those, but browsers and macOS refuse to subscribe.

    pip install bleak bcrypt

    # A brand-new display (it offers Bluetooth setup until it's on a network)
    python3 ble-setup.py --pin 123456 --ssid "My WiFi" --ask-password

    # A display already on a network: first ask it, over the network, to turn
    # on Bluetooth setup (MDC 0x22/0x10), as Samsung's app does
    python3 ble-setup.py --turn-on 192.168.1.37 --mac 00:11:22:33:44:55 \\
        --pin 123456 --ssid "My WiFi" --ask-password

    # Just show where it's connected now
    python3 ble-setup.py --pin 123456 --status

    # Check the protocol code against captured bytes (no display needed)
    python3 ble-setup.py --selftest

The Wi-Fi password only goes to the display, over Bluetooth.
"""

import argparse
import asyncio
import getpass
import socket
import ssl
import sys
import time

SERVICE_UUID = "53564344-6576-6963-6553-657474696e67"
CHARACTERISTIC_UUID = "434d4444-6576-6963-6553-657474696e67"
NAME_PREFIXES = ("EM32DX", "EM13DX", "EM75DX")

OP_REQUEST, OP_RESPONSE, OP_AUTH = 0, 1, 7
START_AUTH, CONFIRM_AUTH, QUERY_AUTH, ANSWER_AUTH = 0x01, 0x02, 0x03, 0x04
DEVICE_STATUS, NETWORK_TYPE, NETWORK_ACCESS, WIFI = 0x10, 0x11, 0x12, 0x14
LOGIN_RESULTS = {128: "the display refused the login", 129: "the login got out of step; try again", 130: "wrong PIN"}

# Writes sized for the smallest BLE packet (23-byte MTU), as the app does
MTU = 23


# ─── Framing ────────────────────────────────────────────────────────────────

def header(id_, fragment, more, op, length):
    """id(2) | fragment(1) | more(1) | op(3) | length(9)"""
    return bytes([((id_ & 3) << 6) | ((fragment & 1) << 5) | ((more & 1) << 4) | ((op & 7) << 1) | ((length >> 8) & 1), length & 0xFF])


def encode_message(op, command, data=b"", id_=0):
    """The writes that carry one message; long ones split with length/offset prefixes"""
    data = bytes(data)
    body = bytes([command]) + data
    if len(data) + 5 <= MTU - 5:
        return [header(id_, 0, 0, op, len(body)) + body]
    size = MTU - 3 - 2 - 4
    count = -(-len(body) // size)
    frames = []
    for i in range(count):
        start = i * size
        end = len(body) if i == count - 1 else start + size
        piece = (len(body) if i == 0 else start).to_bytes(4, "big") + body[start:end]
        frames.append(header(id_, 0 if i == 0 else 1, 0 if i == count - 1 else 1, op, len(piece)) + piece)
    return frames


class Reassembler:
    """Turns the display's indications into whole replies: (op, command, status, data)"""

    def __init__(self):
        self.parts = None

    def push(self, frame):
        frame = bytes(frame)
        b0 = frame[0]
        fragment, more, op = (b0 >> 5) & 1, (b0 >> 4) & 1, (b0 >> 1) & 7
        length = ((b0 & 1) << 8) | frame[1]
        body = frame[2:2 + length]
        if fragment or more:
            if not fragment:
                self.parts = b""
            self.parts = (self.parts or b"") + body[4:]
            if more:
                return None
            payload, self.parts = self.parts, None
        else:
            payload = body
        if op == OP_AUTH:
            return op, payload[0], 0, payload[1:]
        return op, payload[1], payload[0] & 63, payload[2:]


# ─── Login ──────────────────────────────────────────────────────────────────

B64 = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


def bcrypt_b64(data):
    out, i = [], 0
    while i < len(data):
        c1 = data[i]; i += 1
        out.append(B64[(c1 >> 2) & 63]); c1 = (c1 & 3) << 4
        if i >= len(data):
            out.append(B64[c1 & 63]); break
        c2 = data[i]; i += 1
        out.append(B64[(c1 | (c2 >> 4)) & 63]); c2 = (c2 & 15) << 2
        if i >= len(data):
            out.append(B64[c2 & 63]); break
        c3 = data[i]; i += 1
        out.append(B64[(c2 | (c3 >> 6)) & 63]); out.append(B64[c3 & 63])
    return "".join(out)


def bcrypt_b64_decode(text, length):
    out, bits, value = bytearray(), 0, 0
    for ch in text:
        value = ((value << 6) | B64.index(ch)) & 0xFFFF
        bits += 6
        if bits >= 8:
            bits -= 8
            out.append((value >> bits) & 0xFF)
            if len(out) == length:
                break
    return bytes(out)


def login_answer(pin, challenge):
    """Challenge: cost in the low 5 bits of byte 0, then a 16-byte salt. Answer: the raw 23-byte bcrypt hash of the PIN."""
    import bcrypt
    cost, salt = challenge[0] & 31, bytes(challenge[1:17])
    if len(salt) != 16:
        raise RuntimeError("the display's login challenge was too short")
    full = bcrypt.hashpw(pin.encode(), f"$2a${cost:02d}${bcrypt_b64(salt)}".encode()).decode()
    return bcrypt_b64_decode(full[-31:], 23)


# ─── Settings ───────────────────────────────────────────────────────────────

def encode_wifi(ssid, password):
    name, pw = ssid.encode(), password.encode()
    if not 1 <= len(name) <= 32:
        raise ValueError("the network name must be 1 to 32 bytes")
    if len(pw) > 64:
        raise ValueError("the password can be at most 64 bytes")
    first = (0x40 if pw else 0) | (len(name) & 63)
    return bytes([first]) + name + (bytes([len(pw)]) + pw if pw else b"")


def ip_bytes(ip):
    parts = [int(p) for p in ip.split(".")]
    if len(parts) != 4 or any(not 0 <= p <= 255 for p in parts):
        raise ValueError(f"not an IPv4 address: {ip}")
    return bytes(parts)


def encode_ipv4(static=None):
    """None for DHCP, else (ip, prefix, gateway, dns)"""
    if static is None:
        return bytes([0xC0]) + bytes(12)
    ip, prefix, gateway, dns = static
    if not 1 <= prefix <= 32:
        raise ValueError("the prefix length must be 1 to 32")
    return bytes([prefix & 63]) + ip_bytes(ip) + ip_bytes(gateway) + ip_bytes(dns)


def parse_address(data):
    ip = lambda i: ".".join(str(b) for b in data[i:i + 4])
    return {"dhcp": bool(data[0] & 0x80), "prefix": data[0] & 63, "ip": ip(1), "gateway": ip(5), "dns": ip(9)}


def parse_status(data):
    b = data[0] if data else 0
    return {"connected": bool(b >> 6 & 1), "gateway": bool(b >> 5 & 1), "internet": bool(b >> 4 & 1)}


# ─── MDC over the network: turn on Bluetooth setup ──────────────────────────

def wake_on_lan(mac, host):
    packet = b"\xff" * 6 + bytes.fromhex(mac.replace(":", "").replace("-", "")) * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        targets = ["255.255.255.255", host]
        if host.count(".") == 3:
            targets.append(host.rsplit(".", 1)[0] + ".255")
        for target in targets:
            try:
                s.sendto(packet, (target, 9))
            except OSError:
                pass


def mdc_turn_on_bluetooth(host, pin, mac=None, wait=90):
    """MDC 0x22/0x10 `10 00 03 07 d0 d2` over TLS on port 1515, like Samsung's app"""
    deadline = time.time() + wait
    while True:
        try:
            raw = socket.create_connection((host, 1515), timeout=5)
            break
        except OSError:
            if time.time() > deadline:
                raise RuntimeError(f"{host} didn't answer. If it's in deep sleep, press its button; in network standby, pass --mac")
            if mac:
                wake_on_lan(mac, host)
            time.sleep(3)
    with raw:
        raw.settimeout(15)
        if b"MDCSTART<<TLS>>" not in raw.recv(64):
            raise RuntimeError("the display didn't start an MDC session")
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with ctx.wrap_socket(raw) as tls:
            tls.sendall(pin.encode())
            reply = tls.recv(64)
            if b"PASS" not in reply:
                raise RuntimeError(f"MDC login failed: {reply.decode(errors='replace')}")
            data = bytes([0x10, 0x00, 0x03, 0x07, 0xD0, 0xD2])
            body = bytes([0x22, 0x00, len(data)]) + data
            tls.sendall(b"\xaa" + body + bytes([sum(body) & 0xFF]))
            reply = tls.recv(64)  # the display takes ~3 s
            if len(reply) < 6 or reply[4] != 0x41:
                raise RuntimeError(f"the display refused 'turn on Bluetooth': {reply.hex()}")


# ─── Bluetooth session ──────────────────────────────────────────────────────

class Session:
    def __init__(self, client):
        self.client = client
        self.reassembler = Reassembler()
        self.waiting = None  # (op, command, future)

    def on_indication(self, _sender, data):
        reply = self.reassembler.push(data)
        if not reply or not self.waiting:
            return
        op, command, future = self.waiting
        if reply[0] == op and (command is None or reply[1] == command) and not future.done():
            future.set_result(reply)

    async def start(self):
        try:
            await self.client.start_notify(CHARACTERISTIC_UUID, self.on_indication)
        except Exception as err:
            raise RuntimeError(
                f"this computer's Bluetooth stack won't deliver the display's replies ({err}). "
                "The setup characteristic has no subscribe descriptor; run this on Linux with BlueZ (e.g. a Raspberry Pi)."
            )

    async def exchange(self, op, command, data, reply_op, reply_command, timeout=15):
        future = asyncio.get_running_loop().create_future()
        self.waiting = (reply_op, reply_command, future)
        try:
            for i, frame in enumerate(encode_message(op, command, data)):
                if i:
                    await asyncio.sleep(0.2)  # the app paces chunks the same way
                await self.client.write_gatt_char(CHARACTERISTIC_UUID, frame, response=True)
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError("the display didn't answer")
        finally:
            self.waiting = None

    async def login(self, pin):
        if not (len(pin) == 6 and pin.isdigit()):
            raise ValueError("the PIN is 6 digits")
        first, last_error = None, None
        for attempt in range(4):  # the first write can fail while the computer pairs
            try:
                first = await self.exchange(OP_AUTH, START_AUTH, b"", OP_AUTH, None, timeout=8)
                break
            except Exception as err:
                last_error = err
                if attempt == 0:
                    try:
                        await self.client.pair()
                    except Exception:
                        pass
                await asyncio.sleep(1.5)
        if not first:
            raise RuntimeError(f"couldn't start the login: {last_error}")
        confirm = first
        if first[1] == QUERY_AUTH:
            confirm = await self.exchange(OP_AUTH, ANSWER_AUTH, login_answer(pin, first[3]), OP_AUTH, CONFIRM_AUTH)
        if confirm[1] != CONFIRM_AUTH:
            raise RuntimeError("unexpected reply to the login")
        result = confirm[3][0] if confirm[3] else 255
        if result not in (0, 1):  # 1 = already logged in
            raise RuntimeError(f"login failed: {LOGIN_RESULTS.get(result, f'code {result}')}")

    async def request(self, command, data=b"", timeout=15):
        op, cmd, status, payload = await self.exchange(OP_REQUEST, command, data, OP_RESPONSE, command, timeout)
        if status:
            raise RuntimeError(f"the display rejected command 0x{command:02x} (status {status})")
        return payload

    async def address(self):
        return parse_address(await self.request(NETWORK_ACCESS))

    async def status(self):
        return parse_status(await self.request(DEVICE_STATUS))

    async def join_wifi(self, ssid, password, static=None):
        wifi, ip = encode_wifi(ssid, password), encode_ipv4(static)
        before = await self.address()
        started = time.time()
        print("Switching the display to Wi-Fi")
        await self.request(NETWORK_TYPE, b"\x01")
        print(f"Sending the settings for {ssid}")
        await self.request(WIFI, wifi, timeout=30)
        await self.request(NETWORK_ACCESS, ip)
        print(f"Waiting for it to join {ssid}")
        while time.time() - started < 75:
            address = await self.address()
            status = await self.status()
            if address["ip"] != "0.0.0.0" and status["connected"] and (address["ip"] != before["ip"] or time.time() - started > 15):
                return address
            await asyncio.sleep(3)
        raise RuntimeError(f"no address on {ssid} after a minute; check the password and that the display can reach it")


async def find_display(args):
    from bleak import BleakScanner
    if args.address:
        device = await BleakScanner.find_device_by_address(args.address, timeout=20)
    else:
        prefixes = (args.name,) if args.name else NAME_PREFIXES
        device = await BleakScanner.find_device_by_filter(
            lambda d, adv: (adv.local_name or d.name or "").startswith(prefixes), timeout=20)
    if not device:
        raise RuntimeError("no display found over Bluetooth. Is it awake, and in Bluetooth setup (new, or --turn-on)?")
    return device


async def run(args):
    from bleak import BleakClient
    if args.turn_on:
        print(f"Asking {args.turn_on} to turn on Bluetooth setup")
        mdc_turn_on_bluetooth(args.turn_on, args.mdc_pin or args.pin, args.mac)
        await asyncio.sleep(1)
    device = await find_display(args)
    print(f"Connecting to {device.name or device.address}")
    async with BleakClient(device, timeout=30) as client:
        session = Session(client)
        await session.start()
        print("Logging in")
        await session.login(args.pin)
        address, status = await session.address(), await session.status()
        on = f"at {address['ip']}" + ("" if status["internet"] else " (no internet)") if address["ip"] != "0.0.0.0" else "not on a network"
        print(f"Logged in. The display is {on}.")
        if args.status or not args.ssid:
            return
        password = getpass.getpass(f"Password for {args.ssid} (empty for an open network): ") if args.ask_password else (args.password or "")
        static = None
        if args.static:
            ip, _, prefix = args.static.partition("/")
            if not (prefix and args.gateway and args.dns):
                raise ValueError("--static needs IP/prefix, plus --gateway and --dns")
            static = (ip, int(prefix), args.gateway, args.dns)
        joined = await session.join_wifi(args.ssid, password, static)
        print(f"Done: on {args.ssid} at {joined['ip']} (gateway {joined['gateway']}, DNS {joined['dns']}).")


# ─── Self-test against captured bytes ───────────────────────────────────────

def selftest():
    failures = 0

    def check(name, got, want):
        nonlocal failures
        ok = got == want
        failures += not ok
        print(f"{'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f"\n   got  {got}\n   want {want}"))

    a = bytes.fromhex("66d9c54838ee4c751e54e973f5b9707883")
    check("login answer, capture A", login_answer("123456", a).hex(), "153befc192a5d67ec08a30d44ac853716bce237fbb104c")
    check("login answer, capture B", login_answer("123456", bytes.fromhex("664c30fa229415c474b7d5fcd5f165c6cf")).hex(), "afb86b69be9f1404d72a696d572a419f2a3e2468eecad8")
    frames = encode_message(OP_AUTH, ANSWER_AUTH, login_answer("123456", a))
    check("answer frames", [f.hex() for f in frames], ["1e120000001804153befc192a5d67ec08a30d44a", "2e0e0000000ec853716bce237fbb104c"])
    check("start login", encode_message(OP_AUTH, START_AUTH)[0].hex(), "0e0101")
    check("DHCP", encode_message(OP_REQUEST, NETWORK_ACCESS, encode_ipv4())[0].hex(), "000e12c0000000000000000000000000")
    check("network type", encode_message(OP_REQUEST, NETWORK_TYPE, b"\x01")[0].hex(), "00021101")
    check("wifi payload", encode_wifi("TestNet", "secret123").hex(), "47" + b"TestNet".hex() + "09" + b"secret123".hex())
    check("open network", encode_wifi("Cafe", "").hex(), "04" + b"Cafe".hex())
    r = Reassembler()
    check("challenge reply", r.push(bytes.fromhex("0e120366d9c54838ee4c751e54e973f5b9707883")), (7, 3, 0, a))
    check("login accepted", r.push(bytes.fromhex("0e020200")), (7, 2, 0, b"\x00"))
    check("status", parse_status(r.push(bytes.fromhex("c2030010f8"))[3]), {"connected": True, "gateway": True, "internet": True})
    check("address", parse_address(r.push(bytes.fromhex("020f0012d8c0a80125c0a80101c0a80101"))[3]),
          {"dhcp": True, "prefix": 24, "ip": "192.168.1.37", "gateway": "192.168.1.1", "dns": "192.168.1.1"})
    r2 = Reassembler()
    first = r2.push(bytes([0x92, 0x0A, 0, 0, 0, 9, 0x00, 0x14, 1, 2, 3, 4]))
    check("split reply", (first, r2.push(bytes([0xA2, 0x09, 0, 0, 0, 6, 5, 6, 7, 8, 9]))), (None, (1, 0x14, 0, bytes(range(1, 10)))))
    print("all passed" if not failures else f"{failures} FAILED")
    return failures == 0


def main():
    p = argparse.ArgumentParser(description="Set up an EMDX e-paper display's Wi-Fi over Bluetooth (Linux/BlueZ).")
    p.add_argument("--pin", help="the display's 6-digit PIN")
    p.add_argument("--ssid", help="Wi-Fi network name to join")
    p.add_argument("--password", help="Wi-Fi password (or use --ask-password)")
    p.add_argument("--ask-password", action="store_true", help="prompt for the Wi-Fi password")
    p.add_argument("--static", metavar="IP/PREFIX", help="static address, e.g. 192.168.1.50/24 (default DHCP)")
    p.add_argument("--gateway", help="gateway for --static")
    p.add_argument("--dns", help="DNS server for --static")
    p.add_argument("--status", action="store_true", help="only log in and show where it's connected")
    p.add_argument("--turn-on", metavar="HOST", help="first ask the display at HOST, over the network, to turn on Bluetooth setup")
    p.add_argument("--mdc-pin", help="PIN for --turn-on, if different from --pin")
    p.add_argument("--mac", help="the display's MAC, to wake it with Wake-on-LAN for --turn-on")
    p.add_argument("--name", help="Bluetooth name prefix to look for (default EM32DX/EM13DX/EM75DX)")
    p.add_argument("--address", help="the display's Bluetooth address, instead of searching by name")
    p.add_argument("--selftest", action="store_true", help="check the protocol code against captured bytes and exit")
    args = p.parse_args()

    if args.selftest:
        sys.exit(0 if selftest() else 1)
    if not args.pin:
        p.error("--pin is required")
    if not (args.ssid or args.status):
        p.error("give --ssid to join a network, or --status")
    try:
        asyncio.run(run(args))
    except Exception as err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
