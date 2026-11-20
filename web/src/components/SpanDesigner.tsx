import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Input } from "@/components/ui/input"
import { ImageDesigner, NumField, Section, type DesignResult, type Wall } from "@/components/ImageDesigner"
import { withWakeHint } from "@/lib/wakeHint"
import { DEFAULT_GAP, latestGap, nextGroupName, wallLayout } from "@/lib/span"
import type { DisplayConfig, DisplayGroup, ProfileId, QueueEdit, Scene, SpanGap, SpanResult } from "@/lib/types"

/** An image about to be spanned across some displays */
export interface SpanJob {
  displayIds: string[]
  /** The saved group for exactly these displays, if there is one */
  groupId: string | null
  src: string
  /** A picked file isn't on the server yet, so it goes up with the design */
  file: File | null
  initial: QueueEdit | null
}

interface SpanDesignerProps {
  job: SpanJob
  displays: DisplayConfig[]
  scenes: Scene[]
  groups: DisplayGroup[]
  defaultProfile: ProfileId
  onClose: () => void
  /** The group was saved, and its image sent */
  onSent: () => void
}

type SpanResponse = { sent: number; queued: number; results: SpanResult[]; error?: string }

async function postSpan(groupId: string, body: FormData | object): Promise<SpanResponse> {
  const res = await fetch(`api/groups/${groupId}/span`, body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({})) as SpanResponse
  if (!res.ok) throw new Error(data.error || "Couldn't send")
  return data
}

/**
 * Says how the send went. A display that couldn't be reached gets its slice
 * as soon as it can; one that's stopped (a wrong PIN, say) can be retried.
 */
function report(groupId: string, groupName: string, { results }: SpanResponse) {
  const sent = results.filter(r => r.state === "delivered")
  const waiting = results.filter(r => r.state === "queued")
  const failed = results.filter(r => r.state === "failed")
  if (!waiting.length && !failed.length) {
    toast.success(`Sent to ${sent.length} display${sent.length === 1 ? "" : "s"}`)
    return
  }
  if (waiting.length) {
    toast.info(`Sent to ${sent.length} of ${results.length}. ${waiting.length} waiting`, {
      description: `${waiting.map(r => r.name).join(", ")} ${waiting.length === 1 ? "gets its" : "get their"} slice as soon as ${waiting.length === 1 ? "it" : "they"} can be reached.`,
      duration: 12_000,
    })
  }
  if (!failed.length) return
  const retry = async () => {
    try {
      const data = await withWakeHint(groupName, () => postSpan(groupId, { only: failed.map(r => r.displayId) }))
      report(groupId, groupName, data)
    } catch (err) {
      toast.error(`Couldn't send: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }
  toast.error(`Not sent to ${failed.length} display${failed.length === 1 ? "" : "s"}`, {
    description: failed.map(r => `${r.name}: ${r.error ?? "failed"}`).join("\n"),
    duration: 20_000,
    action: { label: failed.length === 1 ? "Retry" : `Retry ${failed.length}`, onClick: retry },
  })
}

/**
 * The image designer laid over a whole group: one picture across all its
 * displays, with the frames and gaps between them taken out of it.
 */
export function SpanDesigner({ job, displays, scenes, groups, defaultProfile, onClose, onSent }: SpanDesignerProps) {
  const group = groups.find(g => g.id === job.groupId) ?? null
  const [name, setName] = useState(() => group?.name ?? nextGroupName(groups))
  const [gap, setGap] = useState<SpanGap>(() => group?.gap ?? latestGap(groups))
  const [applying, setApplying] = useState(false)

  const members = useMemo(
    () => job.displayIds.map(id => displays.find(d => d.id === id)).filter((d): d is DisplayConfig => !!d),
    [job.displayIds, displays],
  )
  const plan = useMemo(() => wallLayout(members, scenes, gap), [members, scenes, gap])
  const wall = useMemo<Wall>(() => ({
    width: plan.width,
    height: plan.height,
    bezel: plan.bezelPx,
    screens: plan.screens.map(s => ({ ...s, label: members.find(d => d.id === s.id)?.name ?? "" })),
  }), [plan, members])

  const setGapField = (key: keyof SpanGap) => (v: number) =>
    setGap(g => ({ ...g, [key]: Math.max(0, Math.min(2000, Math.round(v * 10) / 10)) }))

  const send = async (edit: DesignResult) => {
    setApplying(true)
    try {
      // Saving first gives the image a group to belong to
      const saveRes = await fetch(group ? `api/groups/${group.id}` : "api/groups", {
        method: group ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || nextGroupName(groups), gap, displayIds: job.displayIds }),
      })
      const saved = await saveRes.json().catch(() => ({})) as DisplayGroup & { error?: string }
      if (!saveRes.ok) throw new Error(saved.error || "Couldn't save the group")

      const layout = { width: plan.width, height: plan.height, screens: plan.screens }
      let body: FormData | object = { edit, layout }
      if (job.file) {
        const form = new FormData()
        form.append("image", job.file)
        form.append("edit", JSON.stringify(edit))
        form.append("layout", JSON.stringify(layout))
        body = form
      }
      const data = await withWakeHint(saved.name, () => postSpan(saved.id, body))
      onSent()
      report(saved.id, saved.name, data)
    } catch (err) {
      toast.error(`Couldn't send: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setApplying(false)
    }
  }

  const hiddenX = Math.round((gap.bezelMm * 2 + gap.spaceXMm) * 10) / 10
  const hiddenY = Math.round((gap.bezelMm * 2 + gap.spaceYMm) * 10) / 10
  const isDefault = gap.bezelMm === DEFAULT_GAP.bezelMm && gap.spaceXMm === DEFAULT_GAP.spaceXMm && gap.spaceYMm === DEFAULT_GAP.spaceYMm

  const wallSection = (
    <Section
      title="Wall"
      aside={!isDefault && (
        <button
          type="button"
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setGap(DEFAULT_GAP)}
        >
          Reset
        </button>
      )}
    >
      <Input
        aria-label="Group name"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder={nextGroupName(groups)}
        className="h-8 text-xs"
      />
      <p className="text-[11px] text-muted-foreground">
        {members.length} displays{plan.rows > 1 ? ` in ${plan.rows} rows` : " side by side"} · {plan.width} × {plan.height}
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        <NumField
          label="Frame" unit="mm" value={gap.bezelMm} onCommit={setGapField("bezelMm")} live
          title="Each display's frame, from the edge of the picture to the outside edge. About 14 mm on the EMDX. Set 0 to ignore frames."
        />
        <NumField
          label="Gap" unit="mm" value={gap.spaceXMm} onCommit={setGapField("spaceXMm")} live
          title="Space between displays hung side by side, frame edge to frame edge"
        />
        {plan.rows > 1 && (
          <NumField
            label="Row gap" unit="mm" value={gap.spaceYMm} onCommit={setGapField("spaceYMm")} live className="col-span-2"
            title="Space between rows of displays, frame edge to frame edge"
          />
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {hiddenX} mm of picture hides between screens side by side ({plan.gapX} px)
        {plan.rows > 1 && <>, {hiddenY} mm between rows ({plan.gapY} px)</>}. It carries on behind the
        frames, so straight lines stay straight. Arrange the displays on the canvas the way they hang.
      </p>
    </Section>
  )

  return (
    <ImageDesigner
      imageUrl={job.src}
      aspect={plan.width / plan.height}
      wall={wall}
      initialSize="fill"
      sections={wallSection}
      title={name.trim() || nextGroupName(groups)}
      subtitle={`${job.file ? "New image" : "Spanned now"} across ${members.length} displays`}
      initial={job.initial}
      defaultProfile={defaultProfile}
      primaryLabel={`Send to ${members.length} displays`}
      onPrimary={send}
      applying={applying}
      onClose={onClose}
    />
  )
}
