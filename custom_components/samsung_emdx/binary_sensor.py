"""Binary sensors: charging and awake."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import EmdxConfigEntry, EmdxCoordinator
from .entity import EmdxEntity, async_add_display_entities

PARALLEL_UPDATES = 0


@dataclass(frozen=True, kw_only=True)
class EmdxBinarySensorDescription(BinarySensorEntityDescription):
    """A display binary sensor."""

    value_fn: Callable[[dict[str, Any]], bool | None]


BINARY_SENSORS: tuple[EmdxBinarySensorDescription, ...] = (
    EmdxBinarySensorDescription(
        key="charging",
        device_class=BinarySensorDeviceClass.BATTERY_CHARGING,
        value_fn=lambda d: (d.get("battery") or {}).get("charging"),
    ),
    EmdxBinarySensorDescription(
        # The display answered the app's last check
        key="awake",
        translation_key="awake",
        device_class=BinarySensorDeviceClass.CONNECTIVITY,
        value_fn=lambda d: d.get("awake"),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EmdxConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the binary sensors."""
    async_add_display_entities(
        entry,
        async_add_entities,
        lambda coordinator, display_id: (
            EmdxBinarySensor(coordinator, display_id, description)
            for description in BINARY_SENSORS
        ),
    )


class EmdxBinarySensor(EmdxEntity, BinarySensorEntity):
    """A display binary sensor."""

    entity_description: EmdxBinarySensorDescription

    def __init__(
        self,
        coordinator: EmdxCoordinator,
        display_id: str,
        description: EmdxBinarySensorDescription,
    ) -> None:
        """Initialize."""
        super().__init__(coordinator, display_id, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool | None:
        """The value from the latest /api/state."""
        value = self.entity_description.value_fn(self.display)
        return None if value is None else bool(value)
