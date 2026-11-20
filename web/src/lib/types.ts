import type { Adjust, ProfileId } from "../../eink.mjs"

export type { Adjust, ProfileId }

export interface DisplayConfig {
  id: string
  name: string
  host: string
  pin: string
  mac: string
  sleepAfter: number
  canvasX: number
  canvasY: number
  canvasWidth: number
  canvasHeight: number
  /** Canvas-view rotation in degrees: 0 | 90 | 180 | 270 */
  rotation?: number
  /** Content rotation applied when pushing — which way is "up" on the physical display */
  upRotation?: number
  /** Guard against accidental changes once calibration is set */
  upLocked?: boolean
  /** Scene this display is placed on (perspective mode), or null */
  sceneId?: string | null
  /** Perspective quad corners relative to the scene origin: [TL, TR, BR, BL] */
  quad?: Quad | null
  /** Depth-plane the display sits on (used to detect same-wall moves) */
  plane?: { p: number; r: number } | null
}

export interface Point { x: number; y: number }
/** [topLeft, topRight, bottomRight, bottomLeft] */
export type Quad = [Point, Point, Point, Point]

export interface Scene {
  id: string
  canvasX: number
  canvasY: number
  canvasWidth: number
  canvasHeight: number
  /** Locked scenes can't be dragged or resized (selection still works) */
  locked?: boolean
}

/** App-wide settings, set from the web UI and stored on the server */
export interface AppSettings {
  /** Address displays download images from; null falls back to detection */
  serverAddress: string | null
  /** null when it can't be known, such as inside Docker Desktop */
  detectedAddress: string | null
  timeZone: string | null
  /** Look given to images that don't have one of their own */
  defaultProfile: ProfileId
  /** How an image without a layout of its own is sized to the panel */
  imageFit: ImageFit
  /** Bars around a fitted image */
  imageBackground: string
  /** Set a display's clock to this app's time when it's out */
  syncClocks: boolean
  port: number
}

export type ImageFit = "fit" | "fill" | "stretch"

export const WALLPAPER_COLORS =["white", "black", "red", "green", "blue", "yellow"] as const

/** Settings stored on the display itself. null means it couldn't be read. */
export interface DeviceSettings {
  orientation: "landscape" | "portrait" | null
  source: "default" | "usb" | null
  wallpaperColor: (typeof WALLPAPER_COLORS)[number] | null
  pictureMode: "vivid" | "custom" | null
  /** Only applies in the custom picture mode */
  color: number | null
  sleepMode: "standby" | "deep" | null
  /** Minutes; null while the display is on its built-in preset */
  sleepAfter: number | null
  sleepWhenContentDone: boolean | null
  batteryWarning: boolean | null
  /** "HH:MM" */
  screenProtectorTime: string | null
  buttonLock: boolean | null
  usbLock: boolean | null
  deviceName: string | null
  time: { ntp: boolean; server: string; zone: string } | null
  clock: { day: number; hour: number; minute: number; month: number; year: number; pm: boolean } | null
}

export interface DiscoveredDisplay {
  host: string
  name: string
  model: string
  serial: string | null
  mac: string | null
  alreadyAdded: boolean
  existingName: string | null
}

export interface DisplayStatus {
  power: string | null
  battery: { level: number; charging: boolean; healthy: boolean; present: boolean } | null
  deviceName: string | null
  networkStandby: boolean | null
  serialNumber?: string | null
  softwareVersion?: string | null
  sleepTimer: { remainingMs: number; minutes: number; sleepAt: number } | null
  clock?: DisplayClock | null
}

/** What time the display thinks it is */
export interface DisplayClock {
  /** Its local time, to the minute ("2026-11-19T08:01"), or null if unreadable */
  time: string | null
  /** Seconds ahead of this app's clock; negative when behind */
  drift: number | null
  /** Set when the app just put it right: how far out it was */
  syncedFrom?: number | null
  checkedAt: number
  serverTime?: string
  timeZone?: string
  /** Asleep: the last reading */
  cached?: boolean
}

/** An image waiting to reach a display */
export interface Delivery {
  id: string
  label: string | null
  source: "push" | "edit" | "queue" | "schedule" | "span" | "feed"
  /** pending: waiting for its next try; failed: stopped until a setting is fixed or it's retried */
  state: "pending" | "sending" | "failed"
  attempts: number
  createdAt: number
  lastAttemptAt: number | null
  nextAttemptAt: number | null
  error: string | null
}

export type IntervalUnit = "minutes" | "hours" | "days" | "weeks"

export interface Schedule {
  enabled: boolean
  /** "times" wakes at set times of day; "interval" every so often */
  by: "times" | "interval"
  /** "HH:MM", this app's local time */
  times: string[]
  /** Days it runs on, 0 = Sunday */
  days: number[]
  intervalValue: number
  intervalUnit: IntervalUnit
  /** An interval only between these times each day; null counts from the last wake */
  between: { from: string; to: string } | null
  /** Next wake (epoch ms), managed by the server */
  nextWakeAt?: number | null
  /** Whether the display took its own wake timer when last set */
  wakeTimer?: "set" | "refused" | null
  /** How it's woken: over the network (standby + MAC), or by its own timer */
  wakeMethod?: "network" | "timer"
}

/** Presentation override: how a queued image should be shown, not what it is */
export interface QueueEdit {
  /** How the art maps to the frame; "transform" is the free-transform editor */
  mode?: "crop" | "fit" | "stretch" | "transform"
  /** Rotation in degrees (90° steps + fine adjustment), applied first */
  rotation: number
  /** Crop rect in the rotated image's pixel space (react-easy-crop convention) */
  crop: { x: number; y: number; width: number; height: number } | null
  /** Fit mode: scale relative to contain-fit (values < 1 shrink the art) */
  zoom?: number
  /** Transform mode: displayed image size as fractions of the frame size */
  scaleX?: number
  scaleY?: number
  /** Fit mode: image center offset from frame center, as fractions of frame size */
  offset?: { x: number; y: number }
  /** Letterbox / background color */
  bg?: string
  /** Transform mode: corner radius on the placed image, in display pixels */
  radius?: number
  /** Transform mode: border drawn around the placed image */
  border?: { color: string; width: number } | null
  /** Tone/color adjustment for e-paper, applied to the art only. null uses the default profile. */
  adjust?: Adjust | null
}

/** A gallery library item served by the backend */
export interface GalleryItem {
  id: string
  category: string
  file: string
  title: string
  /** Added in the app, so it can be deleted again */
  uploaded?: boolean
}

export interface QueueImage {
  id: string
  filename: string
  addedAt: string
  edit?: QueueEdit | null
  editedAt?: string
  /** Legacy field from the old crop-at-upload flow; no longer applied */
  outputRotation?: number
}

export interface QueueData {
  images: QueueImage[]
  currentIndex: number
}

export interface Provider {
  id: string
  name: string
  feedUrl: string
  builtin: boolean
  type?: string
}

export interface ProviderConfig {
  sourceMode: "queue" | "provider"
  activeProvider: string
  providers: Provider[]
}

export interface ProviderPreview {
  title: string
  imageUrl: string | null
  source: string
  date: string | null
}

export type SleepMode = "manual" | "scheduled"

/** How much picture hides between neighbouring screens, in millimetres */
export interface SpanGap {
  /** Each display's frame, from the edge of the picture to the outside edge */
  bezelMm: number
  /** Space between displays side by side */
  spaceXMm: number
  /** Space between rows */
  spaceYMm: number
}

/** One screen's place on a wall, in panel pixels */
export interface WallScreen { id: string; x: number; y: number; w: number; h: number }

/** A group's displays as one big canvas, frames and gaps included */
export interface WallLayout {
  width: number
  height: number
  screens: WallScreen[]
}

/** Displays hung together, showing one image spanned across all of them */
export interface DisplayGroup {
  id: string
  name: string
  displayIds: string[]
  gap: SpanGap
  /** The last image sent across the group */
  span: { edit: QueueEdit; layout: WallLayout; updatedAt: string } | null
}

export interface SpanResult {
  displayId: string
  name: string
  ok: boolean
  /** delivered, queued (goes out when it can be reached) or failed */
  state: "delivered" | "queued" | "failed" | "replaced"
  error?: string
}
