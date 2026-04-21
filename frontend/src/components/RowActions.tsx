import { Button } from "@/components/ui/button"
import { Pencil, Trash2 } from "lucide-react"

interface RowActionsProps {
  onEdit?: () => void
  onDelete?: () => void
  deleteDisabled?: boolean
  deleteTitle?: string
}

export function RowActions({ onEdit, onDelete, deleteDisabled = false, deleteTitle }: RowActionsProps) {
  return (
    <div className="flex gap-1">
      {onEdit && (
        <Button size="icon" variant="ghost" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      {onDelete && (
        <Button
          size="icon"
          variant="ghost"
          className="text-red-600"
          onClick={onDelete}
          disabled={deleteDisabled}
          title={deleteTitle}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
