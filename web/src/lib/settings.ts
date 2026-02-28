const STORAGE_KEY = "samsung-emdx-settings"

export interface DisplaySettings {
  host: string
  pin: string
  mac: string
  sleepAfter: number
}

const DEFAULTS: DisplaySettings = {
  host: "",
  pin: "",
  mac: "",
  sleepAfter: 20,
}

export function loadSettings(): DisplaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: DisplaySettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export async function loadDefaultsFromServer(): Promise<DisplaySettings | null> {
  try {
    const res = await fetch("/api/defaults")
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}
