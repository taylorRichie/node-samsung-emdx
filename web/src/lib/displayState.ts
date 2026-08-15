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
