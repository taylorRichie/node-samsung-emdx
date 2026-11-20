"""Sensors: battery, delivery, last image, next wake, queue, clock drift."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import PERCENTAGE, EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.typing import StateType

from .const import DELIVERY_IDLE, DELIVERY_OPTIONS, DELIVERY_STATES
from .coordinator import EmdxConfigEntry, EmdxCoordinator
from .entity import EmdxEntity, async_add_display_entities, ms_to_datetime, ms_to_iso

PARALLEL_UPDATES = 0


def _battery(display: dict[str, Any]) -> dict[str, Any]:
    return display.get("battery") or {}


def _delivery_state(display: dict[str, Any]) -> str:
    delivery = display.get("delivery")
    if not delivery:
        return DELIVERY_IDLE
    return DELIVERY_STATES.get(delivery.get("state"), "waiting")


def _delivery_attrs(display: dict[str, Any]) -> dict[str, Any]:
    delivery = display.get("delivery") or {}
    return {
        "label": delivery.get("label"),
        "source": delivery.get("source"),
        "error": delivery.get("error"),
        "attempts": delivery.get("attempts"),
        "next_attempt": ms_to_iso(delivery.get("nextAttemptAt")),
    }


def _next_wake(display: dict[str, Any]) -> datetime | None:
    schedule = display.get("schedule") or {}
    if not schedule.get("enabled"):
        return None
    return ms_to_datetime(schedule.get("nextWakeAt"))


@dataclass(frozen=True, kw_only=True)
class EmdxSensorDescription(SensorEntityDescription):
    """A display sensor, read from the display's part of /api/state."""

    value_fn: Callable[[dict[str, Any]], StateType | datetime]
    attrs_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None


SENSORS: tuple[EmdxSensorDescription, ...] = (
    EmdxSensorDescription(
        # The last reading, which the app keeps while the display sleeps
        key="battery",
        device_class=SensorDeviceClass.BATTERY,
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=PERCENTAGE,
        value_fn=lambda d: _battery(d).get("level"),
        attrs_fn=lambda d: {
            "charging": _battery(d).get("charging"),
            "read_at": ms_to_iso(_battery(d).get("at")),
        },
    ),
    EmdxSensorDescription(
        key="delivery",
        translation_key="delivery",
        device_class=SensorDeviceClass.ENUM,
        options=DELIVERY_OPTIONS,
        value_fn=_delivery_state,
        attrs_fn=_delivery_attrs,
    ),
    EmdxSensorDescription(
        key="last_image",
        translation_key="last_image",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=lambda d: ms_to_datetime(d.get("lastImageAt")),
    ),
    EmdxSensorDescription(
        key="next_wake",
        translation_key="next_wake",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=_next_wake,
        attrs_fn=lambda d: {"wake_timer": (d.get("schedule") or {}).get("wakeTimer")},
    ),
    EmdxSensorDescription(
        key="queue",
        translation_key="queue",
        native_unit_of_measurement="images",
        value_fn=lambda d: (d.get("queue") or {}).get("count"),
        attrs_fn=lambda d: {"next": (d.get("queue") or {}).get("next")},
    ),
    EmdxSensorDescription(
        key="clock_drift",
        translation_key="clock_drift",
        device_class=SensorDeviceClass.DURATION,
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfTime.SECONDS,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda d: (d.get("clock") or {}).get("drift"),
        attrs_fn=lambda d: {
            "display_time": (d.get("clock") or {}).get("time"),
            "checked_at": ms_to_iso((d.get("clock") or {}).get("checkedAt")),
        },
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EmdxConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the sensors."""
    async_add_display_entities(
        entry,
        async_add_entities,
        lambda coordinator, display_id: (
            EmdxSensor(coordinator, display_id, description) for description in SENSORS
        ),
    )


class EmdxSensor(EmdxEntity, SensorEntity):
    """A display sensor."""

    entity_description: EmdxSensorDescription

    def __init__(
        self,
        coordinator: EmdxCoordinator,
        display_id: str,
        description: EmdxSensorDescription,
    ) -> None:
        """Initialize."""
        super().__init__(coordinator, display_id, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> StateType | datetime:
        """The value from the latest /api/state."""
        return self.entity_description.value_fn(self.display)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Details that go with the value."""
        if self.entity_description.attrs_fn is None:
            return None
        return self.entity_description.attrs_fn(self.display)
