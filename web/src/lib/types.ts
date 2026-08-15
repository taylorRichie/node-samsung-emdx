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
  /** Artistic rotation in 90° steps, applied before crop */
  rotation: number
  /** Crop rect in the rotated image's pixel space (react-easy-crop convention) */
  crop: { x: number; y: number; width: number; height: number } | null
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
