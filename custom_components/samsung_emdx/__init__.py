"""The Samsung EMDX integration: e-paper displays run by the Samsung EMDX web app."""

from __future__ import annotations

from homeassistant.const import CONF_URL, Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv, device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .api import EmdxClient
from .const import DOMAIN
from .coordinator import EmdxConfigEntry, EmdxCoordinator
from .services import async_setup_services

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.IMAGE,
    Platform.SENSOR,
    Platform.SWITCH,
]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the services (send_image, span_image)."""
    async_setup_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: EmdxConfigEntry) -> bool:
    """Connect to one instance of the app."""
    client = EmdxClient(async_get_clientsession(hass), entry.data[CONF_URL])
    coordinator = EmdxCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Serial and firmware are only known once the app has read them from a
    # display, so devices pick them up as they appear
    device_registry = dr.async_get(hass)

    @callback
    def _sync_device_info() -> None:
        # By config entry, not async_get_device: identifiers are only unique
        # within an entry, and HA 2026.11 deprecates async_get_device for that
        for device in dr.async_entries_for_config_entry(device_registry, entry.entry_id):
            display_id = next((i for d, i in device.identifiers if d == DOMAIN), None)
            if (display := coordinator.data.displays.get(display_id)) is None:
                continue
            changes = {
                key: value
                for key, value in (
                    ("sw_version", display.get("softwareVersion")),
                    ("serial_number", display.get("serialNumber")),
                )
                if value and getattr(device, key) != value
            }
            if changes:
                device_registry.async_update_device(device.id, **changes)

    _sync_device_info()
    entry.async_on_unload(coordinator.async_add_listener(_sync_device_info))

    # Live events make changes show up sooner; polling covers everything without them
    entry.async_create_background_task(
        hass, coordinator.async_listen_events(), f"{DOMAIN} events {client.base_url}"
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EmdxConfigEntry) -> bool:
    """Disconnect."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_config_entry_device(
    hass: HomeAssistant, entry: EmdxConfigEntry, device_entry: dr.DeviceEntry
) -> bool:
    """Allow removing a display's device once the app no longer has the display."""
    displays = entry.runtime_data.data.displays
    return not any(
        domain == DOMAIN and display_id in displays
        for domain, display_id in device_entry.identifiers
    )
