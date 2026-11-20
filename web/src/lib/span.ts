// The wall layout is shared with the server (web/span.mjs), so the span
// designer and sends from the API cut the same slices
export {
  PIXEL_PITCH_MM, DEFAULT_GAP, mmToPx, sameMembers, panelSize, canvasRect, wallLayout, latestGap, nextGroupName,
  type WallPlan,
} from "../../span.mjs"
