import type { DisplayStatus } from "./types"

/**
 * Single source of truth for a display's liveness, used by the list panel,
 * properties header, and queue warnings so they can never disagree.
 *
 * The EM32DX is e-paper: MDC power reads "Off" whenever the panel isn't mid-
 * refresh, even though the display is reachable and accepts pushes. So
 * reachability (a status probe answered at all) is what "awake" means here:
 *  - awake:  the status probe answered — MDC is up, pushes will work
 *  - asleep: no answer — deep sleep (radio off); needs its power button or a
 *            scheduled wake before anything can be pushed
 */
export type DisplayState = "awake" | "asleep"

export function displayState(status: DisplayStatus | null | undefined): DisplayState {
  return status ? "awake" : "asleep"
}

export type Orientation = "portrait" | "landscape"

/** The viewer's rotation, which the server keeps in step with the display */
export function displayOrientation(display: { rotation?: number }): Orientation {
  return (((display.rotation ?? 0) % 180) + 180) % 180 === 90 ? "landscape" : "portrait"
}

/** Frame aspect (w/h) of a display, following its orientation */
export function displayAspect(d: { canvasWidth: number; canvasHeight: number; rotation?: number }) {
  const landscape = displayOrientation(d) === "landscape"
  const w = landscape ? d.canvasHeight : d.canvasWidth
  const h = landscape ? d.canvasWidth : d.canvasHeight
  return h > 0 ? w / h : 9 / 16
}
