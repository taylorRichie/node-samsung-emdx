import type { IntervalUnit, Schedule } from "./types"

export function formatTime12h(hour: number, minute: number) {
  const ampm = hour >= 12 ? "PM" : "AM"
  const h = hour % 12 || 12
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`
}

export const to24h = (hour: number, minute: number) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`

const UNIT_LABELS: Record<IntervalUnit, [string, string]> = {
  minutes: ["minute", "minutes"],
  hours: ["hour", "hours"],
  days: ["day", "days"],
  weeks: ["week", "weeks"],
}

export function scheduleSentence(schedule: Schedule, sourceLabel: string) {
  if (!schedule.enabled) return "Automatic wake is off — the display keeps its current image."
  let when: string
  if (schedule.by === "interval") {
    const v = schedule.intervalValue ?? 1
    const unit = UNIT_LABELS[schedule.intervalUnit ?? "days"]
    when = v === 1 ? `every ${unit[0]}` : `every ${v} ${unit[1]}`
  } else {
    const rep = schedule.repeat === "weekdays" ? "on weekdays" : schedule.repeat === "once" ? "once" : "daily"
    when = `at ${formatTime12h(schedule.hour, schedule.minute)} ${rep}`
  }
  return `Display will wake ${when} and replace the image with ${sourceLabel}.`
}
