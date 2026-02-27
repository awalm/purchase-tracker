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
}

export function StatusSelect({ value, onValueChange }: StatusSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="w-28 h-8">
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
