import { useState } from "react"
import { Loader2, Settings } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { AppSettings } from "@/lib/types"
import { addressFromBrowser } from "@/lib/utils"

interface ServerSettingsDialogProps {
  settings: AppSettings | null
  onSave: (patch: { serverAddress: string; timeZone: string }) => Promise<void>
  onClose: () => void
}

/** Mounted only while open, so the fields start from the saved values each time */
export function ServerSettingsDialog({ settings, onSave, onClose }: ServerSettingsDialogProps) {
  const [address, setAddress] = useState(settings?.serverAddress ?? addressFromBrowser())
  const [timeZone, setTimeZone] = useState(settings?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave({ serverAddress: address.trim(), timeZone: timeZone.trim() })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save settings")
    } finally { setSaving(false) }
  }

  return (
    <Dialog open onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" /> Server settings
          </DialogTitle>
          <DialogDescription>How your displays reach this app</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">This computer's IP address</Label>
            <Input
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder={settings?.detectedAddress ?? "192.168.1.20"}
              className="h-9"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              {settings?.detectedAddress
                ? `Displays download images from this address. Leave it blank to use ${settings.detectedAddress}, which was detected automatically.`
                : "Displays download images from this address. It can't be detected in Docker Desktop. On a Mac, run ipconfig getifaddr en0 to find it."}
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Time zone</Label>
            <Input value={timeZone} onChange={e => setTimeZone(e.target.value)} placeholder="America/New_York" className="h-9" />
            <p className="text-[11px] text-muted-foreground">Used for scheduled wake times and syncing a display's clock.</p>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
