import { useState, useEffect, useRef } from "react"
import "vanilla-colorful"

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "hex-color-picker": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { color?: string }
    }
  }
}

interface ColorPickerProps {
  value: string
  onChange: (hex: string) => void
  title?: string
  /** Extra control rendered inside the popover footer (e.g. a pipette) */
  extra?: React.ReactNode
}

/**
 * Swatch button that opens a vanilla-colorful popover with a hex field.
 * Closes on outside click; the swatch reflects the live value.
 */
export function ColorPicker({ value, onChange, title, extra }: ColorPickerProps) {
  const [open, setOpen] = useState(false)
  const [hexDraft, setHexDraft] = useState(value)
  const rootRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLElement>(null)

  useEffect(() => { setHexDraft(value) }, [value])

  // vanilla-colorful emits a custom "color-changed" event
  useEffect(() => {
    const el = pickerRef.current
    if (!el || !open) return
    const handler = (e: Event) => onChange((e as CustomEvent<{ value: string }>).detail.value)
    el.addEventListener("color-changed", handler)
    return () => el.removeEventListener("color-changed", handler)
  }, [open, onChange])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])

  const commitHex = (raw: string) => {
    const v = raw.startsWith("#") ? raw : `#${raw}`
    if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toLowerCase())
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        className="h-7 w-9 rounded-md border border-border p-0.5"
        title={title}
        onClick={() => setOpen(v => !v)}
      >
        <span className="block h-full w-full rounded-[4px] border border-black/20" style={{ background: value }} />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full mb-2 z-50 rounded-lg border border-border bg-background p-2 shadow-xl space-y-2 w-[216px]">
          <hex-color-picker ref={pickerRef} color={value} style={{ width: "200px", height: "160px" }} />
          <div className="flex items-center gap-1.5">
            <input
              value={hexDraft}
              onChange={e => setHexDraft(e.target.value)}
              onBlur={e => commitHex(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") commitHex((e.target as HTMLInputElement).value) }}
              className="h-7 flex-1 min-w-0 rounded-md border border-border bg-transparent px-2 text-xs font-mono"
              spellCheck={false}
            />
            {extra}
          </div>
        </div>
      )}
    </div>
  )
}
