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
}

export interface DisplayStatus {
  power: string | null
  battery: { level: number; charging: boolean; healthy: boolean; present: boolean } | null
  deviceName: string | null
  sleepTimer: { remainingMs: number; minutes: number; sleepAt: number } | null
}

export interface Schedule {
  enabled: boolean
  hour: number
  minute: number
  repeat: string
}

export interface QueueImage {
  id: string
  filename: string
  addedAt: string
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
