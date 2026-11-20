// Renders the full-quality panel preview off the main thread, so sliders and
// dragging stay smooth while it works.
import { boxDownscale, ditherToPanel, previewSharpen } from "../../eink.mjs"

export interface PanelJob {
  key: string
  buffer: ArrayBuffer
  width: number
  height: number
  /** Dithered this many times finer than the result, then averaged down */
  up: number
  sharpen: number
}

export interface PanelResult {
  key: string
  buffer: ArrayBuffer
  width: number
  height: number
}

const worker = self as unknown as Worker

worker.onmessage = ({ data: job }: MessageEvent<PanelJob>) => {
  const px = new Uint8ClampedArray(job.buffer)
  previewSharpen(px, job.width, job.height, job.sharpen)
  ditherToPanel(px, job.width, job.height)
  const small = job.up > 1 ? boxDownscale(px, job.width, job.height, job.up) : { data: px, width: job.width, height: job.height }
  const buffer = small.data.buffer as ArrayBuffer
  const result: PanelResult = { key: job.key, buffer, width: small.width, height: small.height }
  worker.postMessage(result, [buffer])
}
