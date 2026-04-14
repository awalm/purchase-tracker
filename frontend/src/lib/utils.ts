import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "$0.00"
  const num = typeof value === "string" ? parseFloat(value) : value
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num)
}

export function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "0"
  const num = typeof value === "string" ? parseFloat(value) : value
  if (Number.isNaN(num)) return "0"
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(num)
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-"
  return new Date(value).toLocaleDateString()
}
