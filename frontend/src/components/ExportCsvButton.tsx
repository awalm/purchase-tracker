import { Button } from "@/components/ui/button"
import { Download } from "lucide-react"
import { exportToCsv, type CsvColumn } from "@/lib/csv"

interface ExportCsvButtonProps<T> {
  filename: string
  columns: CsvColumn<T>[]
  data: T[]
  size?: "default" | "sm"
  label?: string
}

export function ExportCsvButton<T>({
  filename,
  columns,
  data,
  size = "default",
  label = "Export CSV",
}: ExportCsvButtonProps<T>) {
  return (
    <Button
      variant="outline"
      size={size}
      onClick={() => exportToCsv(filename, columns, data)}
      disabled={data.length === 0}
    >
      <Download className="h-4 w-4 mr-2" />
      {label}
    </Button>
  )
}
