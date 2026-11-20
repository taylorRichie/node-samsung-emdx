"""Base entity: one device per display."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from datetime import datetime
from typing import Any

from homeassistant.core import callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .api import EmdxApiError, EmdxConnectionError
from .const import DOMAIN, MANUFACTURER, MODEL
from .coordinator import EmdxConfigEntry, EmdxCoordinator


def ms_to_datetime(value: Any) -> datetime | None:
    """An epoch-milliseconds time from the API as a UTC datetime."""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return dt_util.utc_from_timestamp(value / 1000)
    return None


def ms_to_iso(value: Any) -> str | None:
    """An epoch-milliseconds time as ISO 8601, for state attributes."""
    when = ms_to_datetime(value)
    return when.isoformat() if when else None


def raise_for_api_error(err: Exception) -> None:
    """Turn a client error into a HomeAssistantError with the app's own text."""
    if isinstance(err, EmdxApiError):
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="api_error",
            translation_placeholders={"error": err.message},
        ) from err
    if isinstance(err, EmdxConnectionError):
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="cannot_connect",
            translation_placeholders={"error": str(err)},
        ) from err
    raise err


@callback
def async_add_display_entities(
    entry: EmdxConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
    factory: Callable[[EmdxCoordinator, str], Iterable[Entity]],
) -> None:
    """Add entities for every display, and for displays added to the app later."""
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def _add_new() -> None:
        new = [i for i in coordinator.data.displays if i not in known]
        if not new:
            return
        known.update(new)
        async_add_entities(
            [entity for i in new for entity in factory(coordinator, i)]
        )

    _add_new()
    entry.async_on_unload(coordinator.async_add_listener(_add_new))


class EmdxEntity(CoordinatorEntity[EmdxCoordinator]):
    """An entity of one display."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: EmdxCoordinator, display_id: str, key: str) -> None:
        """Initialize."""
        super().__init__(coordinator)
        self.display_id = display_id
        self._attr_unique_id = f"{display_id}_{key}"
        display = coordinator.data.displays[display_id]
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, display_id)},
            name=display.get("name") or "EMDX display",
            manufacturer=MANUFACTURER,
            model=MODEL,
            configuration_url=coordinator.client.base_url,
        )

    @property
    def display(self) -> dict[str, Any]:
        """This display in the latest /api/state (empty once it's gone)."""
        return self.coordinator.data.displays.get(self.display_id) or {}

    @property
    def available(self) -> bool:
        """Available while the app answers and still has this display."""
        return super().available and self.display_id in self.coordinator.data.displays

    async def _async_action(self, action: Callable[[], Awaitable[Any]]) -> Any:
        """Run an API call, raise its error sensibly, then refresh the state."""
        try:
            return await action()
        except (EmdxApiError, EmdxConnectionError) as err:
            raise_for_api_error(err)
        finally:
            await self.coordinator.async_refresh()
