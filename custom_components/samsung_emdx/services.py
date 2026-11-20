"""Services: send_image (to displays) and span_image (across a group)."""

from __future__ import annotations

import asyncio
import mimetypes
import os
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import (
    ATTR_AREA_ID,
    ATTR_DEVICE_ID,
    ATTR_ENTITY_ID,
    ATTR_FLOOR_ID,
    ATTR_LABEL_ID,
    ENTITY_MATCH_ALL,
)
from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
    callback,
)
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import (
    area_registry as ar,
    config_validation as cv,
    device_registry as dr,
    entity_registry as er,
)

from .api import EmdxError, EmdxResponse, ImageFile
from .const import (
    ATTR_BACKGROUND,
    ATTR_FIT,
    ATTR_GALLERY,
    ATTR_GROUP,
    ATTR_PATH,
    ATTR_PROFILE,
    ATTR_URL,
    ATTR_WAIT,
    DOMAIN,
    FITS,
    PROFILES,
    SERVICE_SEND_IMAGE,
    SERVICE_SPAN_IMAGE,
)
from .coordinator import EmdxCoordinator
from .entity import raise_for_api_error

ONE_IMAGE = "Give only one of url, path or gallery"

IMAGE_FIELDS: dict[Any, Any] = {
    vol.Exclusive(ATTR_URL, "image", msg=ONE_IMAGE): cv.url,
    vol.Exclusive(ATTR_PATH, "image", msg=ONE_IMAGE): cv.string,
    vol.Exclusive(ATTR_GALLERY, "image", msg=ONE_IMAGE): cv.string,
    vol.Optional(ATTR_FIT): vol.In(FITS),
    vol.Optional(ATTR_BACKGROUND): vol.Match(
        r"^#[0-9a-fA-F]{6}$", msg="background must be a color like #ffffff"
    ),
    vol.Optional(ATTR_PROFILE): vol.In(PROFILES),
    vol.Optional(ATTR_WAIT): cv.boolean,
}

SEND_IMAGE_SCHEMA = cv.make_entity_service_schema(IMAGE_FIELDS)
SPAN_IMAGE_SCHEMA = vol.Schema({vol.Required(ATTR_GROUP): cv.string, **IMAGE_FIELDS})

# Send options passed through to the app as they are
OPTION_FIELDS = (ATTR_FIT, ATTR_BACKGROUND, ATTR_PROFILE, ATTR_WAIT)


@callback
def async_setup_services(hass: HomeAssistant) -> None:
    """Register the services."""
    hass.services.async_register(
        DOMAIN,
        SERVICE_SEND_IMAGE,
        _async_send_image,
        schema=SEND_IMAGE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SPAN_IMAGE,
        _async_span_image,
        schema=SPAN_IMAGE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )


def _loaded_coordinators(hass: HomeAssistant) -> list[EmdxCoordinator]:
    coordinators = [
        entry.runtime_data
        for entry in hass.config_entries.async_entries(DOMAIN)
        if entry.state is ConfigEntryState.LOADED
    ]
    if not coordinators:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="not_loaded"
        )
    return coordinators


def _ids(value: Any) -> list[str]:
    if value is None or value == "none":
        return []
    return [value] if isinstance(value, str) else list(value)


@callback
def _async_target_displays(call: ServiceCall) -> list[tuple[EmdxCoordinator, str]]:
    """The displays a call targets, from its devices, entities, areas, floors, labels."""
    hass = call.hass
    coordinators = _loaded_coordinators(hass)
    if call.data.get(ATTR_ENTITY_ID) == ENTITY_MATCH_ALL:
        return [(c, display_id) for c in coordinators for display_id in c.data.displays]

    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    area_reg = ar.async_get(hass)

    # Named outright: each must be a display. Found through an area, floor or
    # label: only the displays among them count.
    explicit: set[str] = set(_ids(call.data.get(ATTR_DEVICE_ID)))
    found: set[str] = set()

    def ours(entry: er.RegistryEntry) -> bool:
        return entry.platform == DOMAIN and entry.device_id is not None

    for entity_id in _ids(call.data.get(ATTR_ENTITY_ID)):
        entry = ent_reg.async_get(entity_id)
        if entry is None or not ours(entry):
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="not_a_display",
                translation_placeholders={"target": entity_id},
            )
        explicit.add(entry.device_id)

    area_ids = set(_ids(call.data.get(ATTR_AREA_ID)))
    for floor_id in _ids(call.data.get(ATTR_FLOOR_ID)):
        area_ids.update(a.id for a in ar.async_entries_for_floor(area_reg, floor_id))
    for label_id in _ids(call.data.get(ATTR_LABEL_ID)):
        area_ids.update(a.id for a in ar.async_entries_for_label(area_reg, label_id))
        found.update(d.id for d in dr.async_entries_for_label(dev_reg, label_id))
        found.update(
            e.device_id for e in er.async_entries_for_label(ent_reg, label_id) if ours(e)
        )
    for area_id in area_ids:
        found.update(d.id for d in dr.async_entries_for_area(dev_reg, area_id))
        found.update(
            e.device_id for e in er.async_entries_for_area(ent_reg, area_id) if ours(e)
        )

    targets: dict[str, EmdxCoordinator] = {}
    for device_id in explicit | found:
        device = dev_reg.async_get(device_id)
        display_id = next(
            (i for d, i in device.identifiers if d == DOMAIN), None
        ) if device else None
        if display_id is None:
            if device_id in explicit:
                raise ServiceValidationError(
                    translation_domain=DOMAIN,
                    translation_key="not_a_display",
                    translation_placeholders={
                        "target": device.name if device else device_id
                    },
                )
            continue
        coordinator = next(
            (c for c in coordinators if display_id in c.data.displays), None
        )
        if coordinator is None:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="display_unavailable",
                translation_placeholders={"target": device.name or display_id},
            )
        targets[display_id] = coordinator

    if not targets:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="no_displays"
        )
    return [(coordinator, display_id) for display_id, coordinator in targets.items()]


def _read_image_file(path: str) -> ImageFile:
    """Read a file to upload (in the executor: file I/O and mimetypes)."""
    content = Path(path).read_bytes()
    name = os.path.basename(path)
    content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return ImageFile(name, content, content_type)


async def _async_image(
    hass: HomeAssistant, data: dict[str, Any]
) -> ImageFile | dict[str, str] | None:
    """The image a call gives: a link, a library item or a file to upload."""
    if url := data.get(ATTR_URL):
        return {"url": url}
    if gallery := data.get(ATTR_GALLERY):
        return {"gallery": gallery}
    if not (path := data.get(ATTR_PATH)):
        return None
    full = path if os.path.isabs(path) else hass.config.path(path)
    if not await hass.async_add_executor_job(hass.config.is_allowed_path, full):
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="path_not_allowed",
            translation_placeholders={"path": full},
        )
    try:
        return await hass.async_add_executor_job(_read_image_file, full)
    except OSError as err:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="file_unreadable",
            translation_placeholders={"path": full, "error": err.strerror or str(err)},
        ) from err


def _options(data: dict[str, Any]) -> dict[str, Any]:
    return {key: data[key] for key in OPTION_FIELDS if key in data}


def _send_state(resp: EmdxResponse) -> str:
    """200: delivered. 202: queued (or replaced by a newer image before it went)."""
    if resp.status == 200:
        return "delivered"
    data = resp.data if isinstance(resp.data, dict) else {}
    return "queued" if data.get("queued", True) else "replaced"


async def _async_send_image(call: ServiceCall) -> ServiceResponse:
    """Send one image to each targeted display."""
    targets = _async_target_displays(call)
    image = await _async_image(call.hass, call.data)
    if image is None:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="no_image"
        )
    options = _options(call.data)

    async def send(coordinator: EmdxCoordinator, display_id: str) -> dict[str, Any]:
        name = coordinator.data.displays.get(display_id, {}).get("name", display_id)
        result: dict[str, Any] = {"display_id": display_id, "name": name}
        try:
            resp = await coordinator.client.push(display_id, image, options)
        except EmdxError as err:
            return {**result, "state": "failed", "error": str(err)}
        result["state"] = _send_state(resp)
        if result["state"] != "delivered" and isinstance(resp.data, dict):
            result["message"] = resp.data.get("message")
        return result

    results = await asyncio.gather(*(send(c, i) for c, i in targets))
    await asyncio.gather(*(c.async_refresh() for c in {c for c, _ in targets}))

    if failed := [r for r in results if r["state"] == "failed"]:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="send_failed",
            translation_placeholders={
                "errors": "; ".join(f"{r['name']}: {r['error']}" for r in failed)
            },
        )
    return {"results": list(results)} if call.return_response else None


def _find_group(
    coordinators: list[EmdxCoordinator], ref: str
) -> tuple[EmdxCoordinator, dict[str, Any]] | None:
    """A group by id, or by name in any case or as a slug, as the app matches it."""
    key = ref.strip().lower()
    for coordinator in coordinators:
        for group in coordinator.data.groups:
            if group.get("id") == ref or key in (
                str(group.get("name", "")).lower(),
                group.get("slug"),
            ):
                return coordinator, group
    return None


async def _async_span_image(call: ServiceCall) -> ServiceResponse:
    """Span one image across a group's displays."""
    coordinators = _loaded_coordinators(call.hass)
    ref = call.data[ATTR_GROUP]
    found = _find_group(coordinators, ref)
    if found is None:
        # Perhaps made in the app since the last poll
        await asyncio.gather(*(c.async_refresh() for c in coordinators))
        found = _find_group(coordinators, ref)
    if found is None:
        names = [g.get("name") for c in coordinators for g in c.data.groups]
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="unknown_group",
            translation_placeholders={
                "group": ref,
                "groups": ", ".join(str(n) for n in names) or "none",
            },
        )
    coordinator, group = found

    image = await _async_image(call.hass, call.data)
    try:
        resp = await coordinator.client.span(group["id"], image, _options(call.data))
    except EmdxError as err:
        raise_for_api_error(err)
    finally:
        await coordinator.async_refresh()

    data = resp.data if isinstance(resp.data, dict) else {}
    # A stopped slice says why in `error`, a queued one in `message` (older
    # versions of the app used `error` for both)
    results = []
    for r in data.get("results") or []:
        result = {"display_id": r.get("displayId"), "name": r.get("name"), "state": r.get("state")}
        reason = r.get("error") or r.get("message")
        if reason:
            result["error" if r.get("state") == "failed" else "message"] = reason
        results.append(result)
    if failed := [r for r in results if r["state"] == "failed"]:
        raise HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="span_failed",
            translation_placeholders={
                "group": str(group.get("name")),
                "errors": "; ".join(f"{r['name']}: {r.get('error')}" for r in failed),
            },
        )
    if not call.return_response:
        return None
    return {
        "group_id": data.get("groupId"),
        "group": group.get("name"),
        "sent": data.get("sent"),
        "queued": data.get("queued"),
        "results": results,
    }
