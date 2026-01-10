import { cn } from "@/lib/utils"

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  in_transit: "bg-blue-100 text-blue-800",
  delivered: "bg-green-100 text-green-800",
  damaged: "bg-red-100 text-red-800",
  returned: "bg-gray-100 text-gray-800",
  lost: "bg-gray-600 text-white",
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-1 text-xs font-medium",
        statusColors[status] || "bg-gray-100 text-gray-800"
      )}
    >
      {status.replace("_", " ")}
    </span>
  )
}
