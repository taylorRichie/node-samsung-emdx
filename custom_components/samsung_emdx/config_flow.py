"""Config flow: the app's URL. Options: how often to poll."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
    OptionsFlowWithReload,
)
from homeassistant.const import CONF_URL
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .api import EmdxClient, EmdxConnectionError, EmdxError, normalize_url
from .const import (
    CONF_SCAN_INTERVAL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    LOGGER,
    MAX_SCAN_INTERVAL,
    MIN_SCAN_INTERVAL,
)
from .coordinator import EmdxConfigEntry

URL_SCHEMA = vol.Schema(
    {vol.Required(CONF_URL): TextSelector(TextSelectorConfig(type=TextSelectorType.URL))}
)


async def _validate(hass: HomeAssistant, raw_url: str) -> tuple[str, dict[str, str]]:
    """Normalize the URL and check that /api/state answers like the app."""
    try:
        url = normalize_url(raw_url)
    except ValueError:
        return raw_url, {CONF_URL: "invalid_url"}
    client = EmdxClient(async_get_clientsession(hass), url)
    try:
        await client.get_state()
    except EmdxConnectionError:
        return url, {"base": "cannot_connect"}
    except EmdxError as err:
        LOGGER.debug("%s isn't the Samsung EMDX app: %s", url, err)
        return url, {"base": "not_emdx"}
    return url, {}


class SamsungEmdxConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add an instance of the Samsung EMDX app."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for the app's URL."""
        errors: dict[str, str] = {}
        if user_input is not None:
            url, errors = await _validate(self.hass, user_input[CONF_URL])
            if not errors:
                await self.async_set_unique_id(url)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=f"Samsung EMDX ({url.split('://', 1)[1]})",
                    data={CONF_URL: url},
                )
        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(URL_SCHEMA, user_input),
            errors=errors,
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Change the app's URL, for example after its address changed."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            url, errors = await _validate(self.hass, user_input[CONF_URL])
            if not errors:
                if url != entry.unique_id:
                    await self.async_set_unique_id(url)
                    self._abort_if_unique_id_configured()
                return self.async_update_reload_and_abort(
                    entry,
                    unique_id=url,
                    title=f"Samsung EMDX ({url.split('://', 1)[1]})",
                    data_updates={CONF_URL: url},
                )
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=self.add_suggested_values_to_schema(
                URL_SCHEMA, user_input or {CONF_URL: entry.data[CONF_URL]}
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: EmdxConfigEntry) -> OptionsFlow:
        """Options: the polling interval."""
        return SamsungEmdxOptionsFlow()


class SamsungEmdxOptionsFlow(OptionsFlowWithReload):
    """How often to poll /api/state. Saving reloads the entry with the new interval."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for the polling interval."""
        if user_input is not None:
            return self.async_create_entry(
                data={CONF_SCAN_INTERVAL: int(user_input[CONF_SCAN_INTERVAL])}
            )
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_SCAN_INTERVAL,
                    default=self.config_entry.options.get(
                        CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL
                    ),
                ): NumberSelector(
                    NumberSelectorConfig(
                        min=MIN_SCAN_INTERVAL,
                        max=MAX_SCAN_INTERVAL,
                        step=1,
                        mode=NumberSelectorMode.BOX,
                        unit_of_measurement="s",
                    )
                )
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
