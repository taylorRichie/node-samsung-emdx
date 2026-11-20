import * as React from "react"
import { cn } from "@/lib/utils"

interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value?: number[]
  onValueChange?: (value: number[]) => void
  min?: number
  max?: number
  step?: number
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, style, value = [0], onValueChange, min = 0, max = 100, step = 1, ...props }, ref) => {
    const percent = (v: number) => ((v - min) / (max - min)) * 100
    // A range that spans zero fills outward from zero
    const origin = min < 0 && max > 0 ? percent(0) : 0
    const at = percent(value[0])
    return (
      <input
        type="range"
        ref={ref}
        min={min}
        max={max}
        step={step}
        value={value[0]}
        onChange={e => onValueChange?.([Number(e.target.value)])}
        className={cn("range", className)}
        style={{ "--from": `${Math.min(origin, at)}%`, "--to": `${Math.max(origin, at)}%`, ...style } as React.CSSProperties}
        {...props}
      />
    )
  }
)
Slider.displayName = "Slider"

export { Slider }
