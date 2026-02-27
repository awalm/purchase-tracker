import * as React from "react"
import { Input } from "./input"

/**
 * A date input that accepts pasted dates like "11/14/2025" or "11-14-2025"
 * and normalizes them to YYYY-MM-DD for the native date input.
 */
export function DateInput({
  value,
  onChange,
  ...props
}: {
  value: string
  onChange: (value: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").trim()
    const normalized = tryParseDate(pasted)
    if (normalized) {
      e.preventDefault()
      onChange(normalized)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
  }

  return (
    <Input
      type="date"
      value={value}
      onChange={handleChange}
      onPaste={handlePaste}
      {...props}
    />
  )
}

/** Try to parse common date formats into YYYY-MM-DD */
function tryParseDate(str: string): string | null {
  // MM/DD/YYYY or MM-DD-YYYY
  let m = str.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/)
  if (m) {
    const [, month, day, year] = m
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  }
  // YYYY/MM/DD or YYYY-MM-DD (already ISO-ish)
  m = str.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/)
  if (m) {
    const [, year, month, day] = m
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  }
  return null
}
