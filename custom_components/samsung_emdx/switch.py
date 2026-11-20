"""Switch: the display's schedule."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import EmdxConfigEntry, EmdxCoordinator
from .entity import EmdxEntity, async_add_display_entities

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EmdxConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the schedule switch."""
    async_add_display_entities(
        entry,
        async_add_entities,
        lambda coordinator, display_id: [EmdxScheduleSwitch(coordinator, display_id)],
    )


class EmdxScheduleSwitch(EmdxEntity, SwitchEntity):
    """On: the display runs its schedule (mode scheduled, schedule enabled)."""

    _attr_translation_key = "schedule"

    def __init__(self, coordinator: EmdxCoordinator, display_id: str) -> None:
        """Initialize."""
        super().__init__(coordinator, display_id, "schedule")

    @property
    def is_on(self) -> bool:
        """/api/state's schedule.enabled is on only in scheduled mode."""
        return bool((self.display.get("schedule") or {}).get("enabled"))

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Scheduled mode, with the schedule enabled."""
        client = self.coordinator.client

        async def _turn_on() -> None:
            await client.set_mode(self.display_id, "scheduled")
            await client.set_schedule(self.display_id, {"enabled": True})

        await self._async_action(_turn_on)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Manual mode. The schedule's times are kept for next time."""
        await self._async_action(
            lambda: self.coordinator.client.set_mode(self.display_id, "manual")
        )
