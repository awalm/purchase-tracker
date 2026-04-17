import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/status-badge"
import { PURCHASE_STATUSES } from "@/lib/constants"

interface StatusSelectProps {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
}

export function StatusSelect({ value, onValueChange, disabled = false }: StatusSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className="w-28 h-8" disabled={disabled}>
        <StatusBadge status={value} />
      </SelectTrigger>
      <SelectContent>
        {PURCHASE_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {s.replace("_", " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
