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
}

export type IntervalUnit = "minutes" | "hours" | "days" | "weeks"

export interface Schedule {
  enabled: boolean
  /** "time" wakes at a fixed time of day; "interval" wakes every N units */
  by?: "time" | "interval"
  hour: number
  minute: number
  repeat: string
  intervalValue?: number
  intervalUnit?: IntervalUnit
  /** Next interval wake (epoch ms), managed by the server */
  nextWakeAt?: number | null
}

/** Presentation override: how a queued image should be shown, not what it is */
export interface QueueEdit {
  /** How the art maps to the frame: crop fills, fit letterboxes, stretch distorts */
  mode?: "crop" | "fit" | "stretch"
  /** Rotation in degrees (90° steps + fine adjustment), applied first */
  rotation: number
  /** Crop rect in the rotated image's pixel space (react-easy-crop convention) */
  crop: { x: number; y: number; width: number; height: number } | null
  /** Fit mode: scale relative to contain-fit (values < 1 shrink the art) */
  zoom?: number
  /** Fit mode: image center offset from frame center, as fractions of frame size */
  offset?: { x: number; y: number }
  /** Letterbox / background color */
  bg?: string
}

/** A gallery library item served by the backend */
export interface GalleryItem {
  id: string
  category: string
  file: string
  title: string
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
