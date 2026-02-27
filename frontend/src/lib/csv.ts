/**
 * CSV Export Utility
 * Converts arrays of objects to CSV and triggers a browser download.
 */

export type CsvColumn<T> = {
  /** Header label in the CSV */
  header: string
  /** Function to extract the cell value from a row */
  accessor: (row: T) => string | number | null | undefined
}

/**
 * Converts data to a CSV string and triggers a file download.
 */
export function exportToCsv<T>(
  filename: string,
  columns: CsvColumn<T>[],
  data: T[]
): void {
  const headers = columns.map((c) => escapeCsvField(c.header))
  const rows = data.map((row) =>
    columns.map((c) => {
      const val = c.accessor(row)
      if (val === null || val === undefined) return ""
      return escapeCsvField(String(val))
    })
  )

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n")

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${filename}_${new Date().toISOString().split("T")[0]}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
