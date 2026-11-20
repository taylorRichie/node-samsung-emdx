import { toast } from "sonner"

/**
 * Runs a send to a display. The server wakes a sleeping display first, which
 * can take a minute or more, so if it's still going after a few seconds this
 * says what's happening and what to do for one in deep sleep.
 */
export async function withWakeHint<T>(displayName: string, send: () => Promise<T>): Promise<T> {
  let hint: string | number | undefined
  const timer = setTimeout(() => {
    hint = toast.loading(`Waiting for ${displayName} to wake… If it's in deep sleep, press its power button.`)
  }, 4000)
  try {
    return await send()
  } finally {
    clearTimeout(timer)
    if (hint !== undefined) toast.dismiss(hint)
  }
}
