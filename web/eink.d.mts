/** Tone/color adjustment applied to the art (not the background/border) */
export interface Adjust {
  /** -100..100 */
  brightness: number
  /** -100..100 */
  contrast: number
  /** -100..100; -100 is grayscale */
  saturation: number
  /** -100..100; positive lifts midtones (gamma) */
  midtones: number
  /** 0..100; unsharp mask at output resolution */
  sharpen: number
}

export declare const ADJUST_KEYS: readonly (keyof Adjust)[]
export declare function sanitizeAdjust(a: unknown): Adjust | null
export declare function adjustPixels(data: Uint8Array | Uint8ClampedArray, channels: number, a: Partial<Adjust>): void
export declare function sharpenOptions(amount: number | undefined): { sigma: number; m1: number; m2: number } | null

export interface PanelColor {
  name: string
  nominal: [number, number, number]
  panel: [number, number, number]
}
export declare const PANEL_PALETTE: readonly PanelColor[]
export declare function ditherToPanel(data: Uint8ClampedArray, width: number, height: number): void
export declare function boxDownscale(data: Uint8ClampedArray, width: number, height: number, s: number):
  { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }
