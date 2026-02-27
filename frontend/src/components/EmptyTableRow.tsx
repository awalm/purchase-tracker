import { TableRow, TableCell } from "@/components/ui/table"

interface EmptyTableRowProps {
  colSpan: number
  message?: string
  children?: React.ReactNode
}

export function EmptyTableRow({ colSpan, message = "No data yet", children }: EmptyTableRowProps) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-center text-muted-foreground">
        {children || message}
      </TableCell>
    </TableRow>
  )
}
