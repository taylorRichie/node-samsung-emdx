import { toast } from "sonner"

/** What a send answered: the display has it, or it's waiting until it can be reached */
export interface SendResult {
  delivered: boolean
  message?: string
}

/**
 * Reads a send's response. 200 means the display has the image; 202 means it's
 * waiting and goes out as soon as the display can be reached. Anything else
 * throws with the server's reason.
 */
export async function readSend(res: Response): Promise<SendResult> {
  const data = await res.json().catch(() => ({})) as { error?: string; message?: string }
  if (res.status === 202) return { delivered: false, message: data.message }
  if (!res.ok) throw new Error(data.error || "Couldn't send")
  return { delivered: true }
}

export function toastSend(name: string, result: SendResult) {
  if (result.delivered) toast.success(`Sent to ${name}`)
  else toast.info(`Waiting to send to ${name}`, { description: result.message, duration: 10_000 })
}

/** "in 3 min", "in 40 s" */
export function fromNow(ts: number) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000))
  return s < 60 ? `in ${s} s` : `in ${Math.round(s / 60)} min`
}

/** "on time", "2 min behind", "1 h ahead" */
export function driftText(drift: number | null | undefined) {
  if (drift == null) return "unreadable"
  const abs = Math.abs(drift)
  if (abs < 60) return "on time"
  const amount = abs >= 5400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 60)} min`
  return `${amount} ${drift > 0 ? "ahead" : "behind"}`
}
