"""Constants for the Samsung EMDX integration."""

from __future__ import annotations

import logging
from typing import Final

DOMAIN: Final = "samsung_emdx"
LOGGER = logging.getLogger(__package__)

MANUFACTURER: Final = "Samsung"
MODEL: Final = "EM32DX"

CONF_SCAN_INTERVAL: Final = "scan_interval"
DEFAULT_SCAN_INTERVAL: Final = 30  # seconds
MIN_SCAN_INTERVAL: Final = 5
MAX_SCAN_INTERVAL: Final = 3600

# Event types from GET /api/events that mean /api/state has changed
REFRESH_EVENTS: Final = frozenset(
    {"snapshot", "status", "push", "delivery", "delivered", "display", "changed"}
)

# Send options (docs/API.md, "Sending images")
FITS: Final = ["fit", "fill", "stretch"]
PROFILES: Final = ["eink", "vivid", "bw", "none"]

# The Delivery sensor's states. The API's delivery.state is pending, sending or
# failed; no delivery at all is idle.
DELIVERY_IDLE: Final = "idle"
DELIVERY_STATES: Final = {"pending": "waiting", "sending": "sending", "failed": "failed"}
DELIVERY_OPTIONS: Final = ["idle", "waiting", "sending", "failed"]

# Service fields
ATTR_URL: Final = "url"
ATTR_PATH: Final = "path"
ATTR_GALLERY: Final = "gallery"
ATTR_FIT: Final = "fit"
ATTR_BACKGROUND: Final = "background"
ATTR_PROFILE: Final = "profile"
ATTR_WAIT: Final = "wait"
ATTR_GROUP: Final = "group"

SERVICE_SEND_IMAGE: Final = "send_image"
SERVICE_SPAN_IMAGE: Final = "span_image"
