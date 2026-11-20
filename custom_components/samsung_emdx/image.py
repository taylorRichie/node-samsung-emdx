"""Image: what the display shows now."""

from __future__ import annotations

from homeassistant.components.image import ImageEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import EmdxError
from .const import LOGGER
from .coordinator import EmdxConfigEntry, EmdxCoordinator
from .entity import EmdxEntity, async_add_display_entities, ms_to_datetime

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: EmdxConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the current image."""
    async_add_display_entities(
        entry,
        async_add_entities,
        lambda coordinator, display_id: [EmdxCurrentImage(coordinator, display_id)],
    )


class EmdxCurrentImage(EmdxEntity, ImageEntity):
    """GET /api/displays/:id/last-image, updated when lastImageAt changes."""

    _attr_translation_key = "current_image"
    _attr_content_type = "image/jpeg"

    def __init__(self, coordinator: EmdxCoordinator, display_id: str) -> None:
        """Initialize."""
        EmdxEntity.__init__(self, coordinator, display_id, "current_image")
        ImageEntity.__init__(self, coordinator.hass)
        self._attr_image_last_updated = ms_to_datetime(self.display.get("lastImageAt"))

    @callback
    def _handle_coordinator_update(self) -> None:
        self._attr_image_last_updated = ms_to_datetime(self.display.get("lastImageAt"))
        super()._handle_coordinator_update()

    async def async_image(self) -> bytes | None:
        """The JPEG, fetched from the app."""
        try:
            return await self.coordinator.client.get_last_image(self.display_id)
        except EmdxError as err:
            LOGGER.debug("Couldn't fetch the image of %s: %s", self.entity_id, err)
            return None
