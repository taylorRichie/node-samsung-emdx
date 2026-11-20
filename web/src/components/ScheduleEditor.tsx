import { Plus, X } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Segmented } from "@/components/ui/segmented"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { IntervalUnit, Schedule } from "@/lib/types"

// Monday first; values are Date.getDay() numbers
const DAYS: { value: number; short: string; name: string }[] = [
  { value: 1, short: "M", name: "Monday" },
  { value: 2, short: "T", name: "Tuesday" },
  { value: 3, short: "W", name: "Wednesday" },
  { value: 4, short: "T", name: "Thursday" },
  { value: 5, short: "F", name: "Friday" },
  { value: 6, short: "S", name: "Saturday" },
  { value: 0, short: "S", name: "Sunday" },
]

/** An hour after the last time, for the next one added */
function nextTime(times: string[]) {
  const sorted = [...times].sort()
  const last = sorted[sorted.length - 1]
  if (!last) return "08:00"
  const h = (Number(last.slice(0, 2)) + 1) % 24
  return `${String(h).padStart(2, "0")}:${last.slice(3)}`
}

function DayPicker({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label="Days">
      {DAYS.map(d => {
        const on = days.includes(d.value)
        return (
          <button
            key={d.value}
            type="button"
            title={d.name}
            aria-label={d.name}
            aria-pressed={on}
            className={cn(
              "h-7 w-7 rounded-full text-[11px] font-medium transition-colors",
              on ? "bg-primary text-primary-foreground" : "bg-secondary/70 text-muted-foreground hover:text-foreground",
            )}
            // At least one day stays on
            onClick={() => onChange(on ? (days.length > 1 ? days.filter(x => x !== d.value) : days) : [...days, d.value].sort())}
          >
            {d.short}
          </button>
        )
      })}
    </div>
  )
}

/** When a display wakes for its schedule: set times of day, or every so often */
export function ScheduleEditor({ schedule, onChange }: { schedule: Schedule; onChange: (patch: Partial<Schedule>) => void }) {
  const times = schedule.times?.length ? schedule.times : ["08:00"]
  // A window within the day only means something for wakes more often than daily
  const subDaily = schedule.intervalUnit === "minutes" || schedule.intervalUnit === "hours"
  const between = subDaily ? schedule.between : null
  const setTime = (i: number, value: string) => {
    if (!/^\d\d:\d\d$/.test(value)) return
    onChange({ times: times.map((t, j) => (j === i ? value : t)) })
  }

  return (
    <div className="space-y-2.5">
      <Segmented
        stretch
        label="Wake"
        value={schedule.by}
        onChange={by => onChange({ by })}
        options={[
          { value: "times", label: "At set times" },
          { value: "interval", label: "Every…" },
        ]}
      />

      {schedule.by === "times" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {times.map((t, i) => (
            <div key={i} className="flex items-center rounded-lg border border-input bg-background/60 pr-0.5">
              <Input
                type="time"
                aria-label={`Wake time ${i + 1}`}
                value={t}
                onChange={e => setTime(i, e.target.value)}
                className="h-7 w-[92px] border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-0"
              />
              {times.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onChange({ times: times.filter((_, j) => j !== i) })}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          {times.length < 24 && (
            <button
              type="button"
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onChange({ times: [...times, nextTime(times)] })}
            >
              <Plus className="h-3.5 w-3.5" /> Add time
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Every</span>
            <Input
              type="number" min={1} aria-label="Every"
              value={schedule.intervalValue ?? 1}
              onChange={e => onChange({ intervalValue: Math.max(1, parseInt(e.target.value) || 1) })}
              className="h-8 w-16 text-xs"
            />
            <Select
              value={schedule.intervalUnit ?? "hours"}
              onValueChange={v => onChange({ intervalUnit: v as IntervalUnit, ...(v === "days" || v === "weeks" ? { between: null } : {}) })}
            >
              <SelectTrigger aria-label="Interval unit" className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">Minutes</SelectItem>
                <SelectItem value="hours">Hours</SelectItem>
                <SelectItem value="days">Days</SelectItem>
                <SelectItem value="weeks">Weeks</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {subDaily && (
            <label className="flex cursor-pointer items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Only during the day</span>
              <Switch
                aria-label="Only between two times"
                checked={!!between}
                onCheckedChange={on => onChange({ between: on ? { from: "08:00", to: "22:00" } : null })}
              />
            </label>
          )}
          {between && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">From</span>
              <Input
                type="time" aria-label="From"
                value={between.from}
                onChange={e => { if (e.target.value) onChange({ between: { ...between, from: e.target.value } }) }}
                className="h-8 w-[100px] text-xs"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="time" aria-label="To"
                value={between.to}
                onChange={e => { if (e.target.value) onChange({ between: { ...between, to: e.target.value } }) }}
                className="h-8 w-[100px] text-xs"
              />
            </div>
          )}
        </div>
      )}

      {/* Days matter when it wakes at times of day */}
      {(schedule.by === "times" || between) && (
        <DayPicker days={schedule.days?.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6]} onChange={days => onChange({ days })} />
      )}
    </div>
  )
}
