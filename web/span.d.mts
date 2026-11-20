export interface SpanGap { bezelMm: number; spaceXMm: number; spaceYMm: number }
export interface WallScreen { id: string; x: number; y: number; w: number; h: number }

interface SpanDisplay {
  id: string
  canvasX: number
  canvasY: number
  canvasWidth: number
  canvasHeight: number
  rotation?: number
  sceneId?: string | null
  quad?: { x: number; y: number }[] | null
}
interface SpanScene { id: string; canvasX: number; canvasY: number }
interface SpanGroup { gap: SpanGap; name: string; span?: { updatedAt: string } | null }

export interface WallPlan {
  width: number
  height: number
  screens: WallScreen[]
  rows: number
  /** Hidden picture between neighbours, frames included, in pixels */
  gapX: number
  gapY: number
  /** One display's frame, in pixels */
  bezelPx: number
}

export declare const PIXEL_PITCH_MM: number
export declare const DEFAULT_GAP: SpanGap
export declare function mmToPx(mm: number): number
export declare function sameMembers(a: string[], b: string[]): boolean
export declare function panelSize(d: { rotation?: number }): { w: number; h: number }
export declare function canvasRect(d: SpanDisplay, sceneById: Map<string, SpanScene>): { x: number; y: number; w: number; h: number }
export declare function wallLayout(members: SpanDisplay[], scenes: SpanScene[], gap: SpanGap): WallPlan
export declare function sizedEdit(iw: number, ih: number, W: number, H: number, fit?: "fit" | "fill" | "stretch", bg?: string): {
  mode: "transform"; rotation: number; scaleX: number; scaleY: number; offset: { x: number; y: number }; bg: string
}
export declare function latestGap(groups: SpanGroup[]): SpanGap
export declare function nextGroupName(groups: { name: string }[]): string
