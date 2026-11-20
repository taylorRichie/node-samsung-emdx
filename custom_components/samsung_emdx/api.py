"""Client for the Samsung EMDX web app's HTTP API (docs/API.md in the app)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import aiohttp
from yarl import URL

# /api/state only reads what the app already knows, so it answers quickly
STATE_TIMEOUT = aiohttp.ClientTimeout(total=15)
# Sends wait for the first attempt, and wake/clock sync wait for the display:
# up to 90 s in network standby and 3 minutes in deep sleep (docs/API.md)
ACTION_TIMEOUT = aiohttp.ClientTimeout(total=330)
# The event stream stays open; the app sends a keepalive every 25 s
EVENTS_TIMEOUT = aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=90)


class EmdxError(Exception):
    """Base error talking to the app."""


class EmdxConnectionError(EmdxError):
    """The app couldn't be reached, or didn't answer in time."""


class EmdxApiError(EmdxError):
    """The app answered with an error (4xx/5xx and `{ "error": … }`)."""

    def __init__(self, status: int, message: str, data: Any = None) -> None:
        """Initialize."""
        super().__init__(message)
        self.status = status
        self.message = message
        self.data = data


@dataclass(slots=True)
class EmdxResponse:
    """A successful answer: 200, or 202 for a send that's queued."""

    status: int
    data: Any


@dataclass(slots=True)
class ImageFile:
    """An image to upload as the multipart `image` field."""

    filename: str
    content: bytes
    content_type: str


def normalize_url(value: str) -> str:
    """The app's base URL, like http://192.168.1.20:3001 (no trailing slash or /api)."""
    value = value.strip()
    if "://" not in value:
        value = f"http://{value}"
    url = URL(value)
    if url.scheme not in ("http", "https") or not url.host:
        raise ValueError("not an http(s) URL")
    path = url.path.rstrip("/")
    if path.endswith("/api"):
        path = path[: -len("/api")]
    return str(url.with_path(path or "/").with_query(None).with_fragment(None)).rstrip(
        "/"
    )


def _ref(value: str) -> str:
    """A display or group id or name, as one path segment."""
    return quote(str(value), safe="")


def _form_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class EmdxClient:
    """Talks to one instance of the app."""

    def __init__(self, session: aiohttp.ClientSession, base_url: str) -> None:
        """Initialize."""
        self.session = session
        self.base_url = base_url.rstrip("/")

    def url(self, path: str) -> str:
        """Absolute URL for an API path."""
        return f"{self.base_url}{path}"

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        data: Any = None,
        timeout: aiohttp.ClientTimeout = ACTION_TIMEOUT,
    ) -> EmdxResponse:
        """Make a request; raise EmdxApiError for 4xx/5xx with the app's error text."""
        try:
            async with self.session.request(
                method, self.url(path), json=json, data=data, timeout=timeout
            ) as resp:
                if resp.content_type == "application/json":
                    try:
                        body: Any = await resp.json()
                    except ValueError:
                        body = None
                else:
                    body = await resp.text()
                if resp.status >= 400:
                    message = (
                        body.get("error") if isinstance(body, dict) else None
                    ) or (body.strip() if isinstance(body, str) else "") or (
                        f"HTTP {resp.status} {resp.reason}"
                    )
                    raise EmdxApiError(resp.status, str(message), body)
                return EmdxResponse(resp.status, body)
        except TimeoutError as err:
            raise EmdxConnectionError(
                f"No answer from {self.base_url} in time"
            ) from err
        except aiohttp.ClientError as err:
            raise EmdxConnectionError(
                f"Couldn't reach {self.base_url}: {err}"
            ) from err

    # ─── Status ──────────────────────────────────────────────────────────────

    async def get_state(self) -> dict[str, Any]:
        """GET /api/state: every display and group. Never wakes a display."""
        resp = await self.request("GET", "/api/state", timeout=STATE_TIMEOUT)
        if not isinstance(resp.data, dict) or not isinstance(
            resp.data.get("displays"), list
        ):
            raise EmdxError(
                f"{self.base_url} answered /api/state, but not like the Samsung EMDX app"
            )
        return resp.data

    async def get_last_image(self, display: str) -> bytes | None:
        """The image the display shows now (JPEG), or None when it has none yet."""
        try:
            async with self.session.get(
                self.url(f"/api/displays/{_ref(display)}/last-image"),
                timeout=STATE_TIMEOUT,
            ) as resp:
                if resp.status == 404:
                    return None
                resp.raise_for_status()
                return await resp.read()
        except TimeoutError as err:
            raise EmdxConnectionError(
                f"No answer from {self.base_url} in time"
            ) from err
        except aiohttp.ClientError as err:
            raise EmdxConnectionError(
                f"Couldn't fetch the image from {self.base_url}: {err}"
            ) from err

    # ─── Sending ─────────────────────────────────────────────────────────────

    async def _send(
        self, path: str, image: ImageFile | dict[str, str] | None, options: dict
    ) -> EmdxResponse:
        if isinstance(image, ImageFile):
            form = aiohttp.FormData()
            form.add_field(
                "image",
                image.content,
                filename=image.filename,
                content_type=image.content_type,
            )
            for key, value in options.items():
                form.add_field(key, _form_value(value))
            return await self.request("POST", path, data=form)
        return await self.request("POST", path, json={**(image or {}), **options})

    async def push(
        self, display: str, image: ImageFile | dict[str, str], options: dict
    ) -> EmdxResponse:
        """POST /api/displays/:display/push. 200 delivered, 202 queued."""
        return await self._send(f"/api/displays/{_ref(display)}/push", image, options)

    async def span(
        self, group: str, image: ImageFile | dict[str, str] | None, options: dict
    ) -> EmdxResponse:
        """POST /api/groups/:group/span. No image resends the group's last one."""
        return await self._send(f"/api/groups/{_ref(group)}/span", image, options)

    async def push_next(self, display: str, *, wait: bool = True) -> EmdxResponse:
        """POST /api/displays/:display/queue/push-next."""
        return await self.request(
            "POST",
            f"/api/displays/{_ref(display)}/queue/push-next",
            json={"wait": wait},
        )

    async def retry_delivery(self, display: str, *, wait: bool = True) -> EmdxResponse:
        """POST /api/displays/:display/delivery/retry."""
        return await self.request(
            "POST",
            f"/api/displays/{_ref(display)}/delivery/retry",
            json={"wait": wait},
        )

    # ─── Control ─────────────────────────────────────────────────────────────

    async def wake(self, display: str) -> EmdxResponse:
        """POST /api/displays/:display/wake. Answers once it's awake."""
        return await self.request("POST", f"/api/displays/{_ref(display)}/wake")

    async def sleep(self, display: str, sleep_mode: str = "manual") -> EmdxResponse:
        """POST /api/displays/:display/sleep."""
        return await self.request(
            "POST",
            f"/api/displays/{_ref(display)}/sleep",
            json={"sleepMode": sleep_mode},
        )

    async def sync_clock(self, display: str) -> EmdxResponse:
        """POST /api/displays/:display/clock/sync."""
        return await self.request("POST", f"/api/displays/{_ref(display)}/clock/sync")

    async def set_mode(self, display: str, mode: str) -> EmdxResponse:
        """POST /api/displays/:display/mode: scheduled or manual."""
        return await self.request(
            "POST", f"/api/displays/{_ref(display)}/mode", json={"mode": mode}
        )

    async def set_schedule(self, display: str, schedule: dict) -> EmdxResponse:
        """POST /api/displays/:display/schedule."""
        return await self.request(
            "POST", f"/api/displays/{_ref(display)}/schedule", json=schedule
        )
