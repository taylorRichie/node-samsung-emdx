"""Buttons: wake, sleep, next image, retry delivery, sync clock."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.button import ButtonEntity, ButtonEntityDescription
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import EmdxClient, EmdxResponse
from .coordinator import EmdxConfigEntry, EmdxCoordinator
from .entity import EmdxEntity, async_add_display_entities

PARALLEL_UPDATES = 0


def _sleep_mode(display: dict[str, Any]) -> str:
    # As the app does after a wake: a display on a schedule arms its wake timer
    return "scheduled" if (display.get("schedule") or {}).get("enabled") else "manual"


@dataclass(frozen=True, kw_only=True)
class EmdxButtonDescription(ButtonEntityDescription):
    """A display button: (client, display id, display) -> API call."""

    press_fn: Callable[[EmdxClient, str, dict[str, Any]], Awaitable[EmdxResponse]]


BUTTONS: tuple[EmdxButtonDescription, ...] = (
    EmdxButtonDescription(
        key="wake",
        translation_key="wake",
        press_fn=lambda client, display_id, _: client.wake(display_id),
    ),
    EmdxButtonDescription(
        key="sleep",
        translation_key="sleep",
        press_fn=lambda client, display_id, display: client.sleep(
            display_id, _sleep_mode(display)
        ),
    ),
    EmdxButtonDescription(
        # Answers at once; the Delivery sensor follows the send
        key="next_image",
        translation_key="next_image",
        press_fn=lambda client, display_id, _: client.push_next(display_id, wait=False),
    ),
    EmdxButtonDescription(
        key="retry_delivery",
        translation_key="retry_delivery",
        press_fn=lambda client, display_id, _: client.retry_delivery(
            display_id, wait=False
        ),
    ),
    EmdxButtonDescription(
        key="sync_clock",
        translation_key="sync_clock",
        entity_category=EntityCategory.CONFIG,
        press_fn=lambda client, display_id, _: client.sync_clock(display_id),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EmdxConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the buttons."""
    async_add_display_entities(
        entry,
        async_add_entities,
        lambda coordinator, display_id: (
            EmdxButton(coordinator, display_id, description) for description in BUTTONS
        ),
    )


class EmdxButton(EmdxEntity, ButtonEntity):
    """A display button."""

    entity_description: EmdxButtonDescription

    def __init__(
        self,
        coordinator: EmdxCoordinator,
        display_id: str,
        description: EmdxButtonDescription,
    ) -> None:
        """Initialize."""
        super().__init__(coordinator, display_id, description.key)
        self.entity_description = description

    async def async_press(self) -> None:
        """Make the API call, then refresh."""
        await self._async_action(
            lambda: self.entity_description.press_fn(
                self.coordinator.client, self.display_id, self.display
            )
        )
