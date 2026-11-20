import type { IntervalUnit, Schedule } from "./types"

export function formatTime12h(hour: number, minute: number) {
  const ampm = hour >= 12 ? "PM" : "AM"
  const h = hour % 12 || 12
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`
}

/** "07:30" → "7:30 AM" */
export const formatHHMM = (t: string) => formatTime12h(Number(t.slice(0, 2)), Number(t.slice(3, 5)))

const UNIT_LABELS: Record<IntervalUnit, [string, string]> = {
  minutes: ["minute", "minutes"],
  hours: ["hour", "hours"],
  days: ["day", "days"],
  weeks: ["week", "weeks"],
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** "a, b and c" */
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`

function daysPhrase(days: number[] | undefined) {
  const d = [...new Set(days?.length ? days : [0, 1, 2, 3, 4, 5, 6])].sort()
  if (d.length === 7) return "every day"
  if (d.join() === "1,2,3,4,5") return "on weekdays"
  if (d.join() === "0,6") return "at weekends"
  // Monday first
  return `on ${list([...d.filter(x => x !== 0), ...d.filter(x => x === 0)].map(x => DAY_NAMES[x]))}`
}

export function scheduleSentence(schedule: Schedule, sourceLabel: string) {
  if (!schedule.enabled) return "Automatic wake is off. The display keeps its current image."
  let when: string
  if (schedule.by === "interval") {
    const v = schedule.intervalValue ?? 1
    const unit = UNIT_LABELS[schedule.intervalUnit ?? "days"]
    when = v === 1 ? `every ${unit[0]}` : `every ${v} ${unit[1]}`
    if (schedule.between && (schedule.intervalUnit === "minutes" || schedule.intervalUnit === "hours")) {
      when += ` from ${formatHHMM(schedule.between.from)} to ${formatHHMM(schedule.between.to)} ${daysPhrase(schedule.days)}`
    }
  } else {
    const times = [...(schedule.times ?? [])].sort().map(formatHHMM)
    when = `at ${list(times)} ${daysPhrase(schedule.days)}`
  }
  return `The display wakes ${when} and shows ${sourceLabel}.`
}
