"""Polls the app's /api/state, and refreshes early on its live events."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import timedelta
import json
from typing import Any

import aiohttp

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import EVENTS_TIMEOUT, EmdxClient, EmdxError
from .const import (
    CONF_SCAN_INTERVAL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    LOGGER,
    REFRESH_EVENTS,
)

type EmdxConfigEntry = ConfigEntry[EmdxCoordinator]


@dataclass(slots=True)
class EmdxData:
    """What /api/state says, with displays by id."""

    server: dict[str, Any] = field(default_factory=dict)
    displays: dict[str, dict[str, Any]] = field(default_factory=dict)
    groups: list[dict[str, Any]] = field(default_factory=list)


class EmdxCoordinator(DataUpdateCoordinator[EmdxData]):
    """One app instance: its displays and groups."""

    config_entry: EmdxConfigEntry

    def __init__(
        self, hass: HomeAssistant, entry: EmdxConfigEntry, client: EmdxClient
    ) -> None:
        """Initialize."""
        super().__init__(
            hass,
            LOGGER,
            config_entry=entry,
            name=f"{DOMAIN} {client.base_url}",
            update_interval=timedelta(
                seconds=entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL)
            ),
            # A send fires several events in a row; one refresh covers them
            request_refresh_debouncer=Debouncer(
                hass, LOGGER, cooldown=1.0, immediate=False
            ),
        )
        self.client = client

    async def _async_update_data(self) -> EmdxData:
        try:
            state = await self.client.get_state()
        except EmdxError as err:
            raise UpdateFailed(
                translation_domain=DOMAIN,
                translation_key="update_failed",
                translation_placeholders={"error": str(err)},
            ) from err
        return EmdxData(
            server=state.get("server") or {},
            displays={
                d["id"]: d
                for d in state["displays"]
                if isinstance(d, dict) and d.get("id")
            },
            groups=[g for g in state.get("groups") or [] if isinstance(g, dict)],
        )

    async def async_listen_events(self) -> None:
        """Follow GET /api/events and refresh when something changes.

        Optional: polling keeps working when the stream can't be reached.
        """
        delay = 5
        while True:
            try:
                async with self.client.session.get(
                    self.client.url("/api/events"),
                    timeout=EVENTS_TIMEOUT,
                    headers={"Accept": "text/event-stream"},
                ) as resp:
                    resp.raise_for_status()
                    LOGGER.debug("Following events from %s", self.client.base_url)
                    delay = 5
                    async for raw in resp.content:
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            event = json.loads(line[5:])
                        except ValueError:
                            continue
                        if (
                            isinstance(event, dict)
                            and event.get("type") in REFRESH_EVENTS
                        ):
                            await self.async_request_refresh()
                LOGGER.debug("Event stream from %s ended", self.client.base_url)
            except (aiohttp.ClientError, TimeoutError, ValueError) as err:
                LOGGER.debug(
                    "Event stream from %s unavailable (%s), retrying in %s s",
                    self.client.base_url,
                    err,
                    delay,
                )
            await asyncio.sleep(delay)
            delay = min(delay * 2, 300)
