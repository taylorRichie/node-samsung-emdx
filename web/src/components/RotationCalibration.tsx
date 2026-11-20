import { useState } from "react"
import { toast } from "sonner"
import { ArrowUp, Check, Crosshair, Loader2, Lock, LockOpen, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SettingGroup, SettingRow } from "@/components/ui/setting-row"
import type { DisplayConfig } from "@/lib/types"

const DIRECTIONS = [
  { deg: 0, label: "up" },
  { deg: 90, label: "right" },
  { deg: 180, label: "down" },
  { deg: 270, label: "left" },
] as const

interface RotationCalibrationProps {
  display: DisplayConfig
  onLockChange: (locked: boolean) => void
  onChanged: () => void
}

/** Sends a test arrow, then asks which way it points on the physical display */
export function RotationCalibration({ display, onLockChange, onChanged }: RotationCalibrationProps) {
  const api = `api/displays/${display.id}`
  const [step, setStep] = useState<"idle" | "sending" | "awaiting" | "finishing">("idle")
  const [picked, setPicked] = useState<number | null>(null)
  const locked = !!display.upLocked

  const start = async () => {
    setStep("sending")
    setPicked(null)
    try {
      const res = await fetch(`${api}/calibrate/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || "Failed to send the test image")
      onChanged()
      setStep("awaiting")
    } catch (err) {
      toast.error(`Rotation test failed: ${err instanceof Error ? err.message : "Unknown error"}. If the display is asleep, wake it first.`)
      setStep("idle")
    }
  }

  const finish = async (observed: number | null) => {
    setStep("finishing")
    try {
      const res = await fetch(`${api}/calibrate/finish`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observed }),
      })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error || "Calibration failed")
      if (observed !== null) toast.success("Rotation saved. The previous image is back.")
      else toast.info("Cancelled. The previous image is back.")
      onChanged()
    } catch (err) {
      toast.error(`Rotation test failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally { setStep("idle") }
  }

  return (
    <SettingGroup title="Which way is up" description="Images look upside down or sideways? Send a test arrow and tell the app where it points.">
      {step === "awaiting" ? (
        <div className="space-y-3 p-3.5">
          <p className="text-[13px]">Which way does the arrow point on your display?</p>
          <div className="flex items-center gap-1.5">
            {DIRECTIONS.map(({ deg, label }) => (
              <button
                key={deg}
                type="button"
                aria-label={`Arrow points ${label}`}
                aria-pressed={picked === deg}
                className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${
                  picked === deg ? "border-primary bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                onClick={() => setPicked(deg)}
              >
                <ArrowUp className="h-4 w-4" style={{ transform: `rotate(${deg}deg)` }} />
              </button>
            ))}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => finish(null)}>
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
            <Button size="sm" className="gap-1.5" disabled={picked === null} onClick={() => { if (picked !== null) finish(picked) }}>
              <Check className="h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </div>
      ) : step === "idle" ? (
        <>
          <SettingRow label="Rotation test" hint="Replaces the image for a moment, then puts it back.">
            <Button variant="outline" size="sm" className="gap-1.5" disabled={locked} onClick={start}>
              <Crosshair className="h-3.5 w-3.5" /> Send test arrow
            </Button>
          </SettingRow>
          <SettingRow label="Lock rotation" hint="Protects a finished setup from accidental changes.">
            <span className="flex items-center gap-2">
              {locked ? <Lock className="h-3.5 w-3.5 text-muted-foreground" /> : <LockOpen className="h-3.5 w-3.5 text-muted-foreground" />}
              <Switch aria-label="Lock rotation" checked={locked} onCheckedChange={onLockChange} />
            </span>
          </SettingRow>
        </>
      ) : (
        <div className="flex items-center gap-2 p-3.5 text-[13px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {step === "sending" ? "Sending the test arrow…" : "Saving and putting the previous image back…"}
        </div>
      )}
    </SettingGroup>
  )
}
