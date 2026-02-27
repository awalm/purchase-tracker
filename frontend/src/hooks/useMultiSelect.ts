import { useState, useCallback } from "react"

export function useMultiSelect<T extends { id: string }>(items: T[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isDeleting, setIsDeleting] = useState(false)

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))
    )
  }, [items])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const handleBulkDelete = useCallback(
    async (deleteFn: (id: string) => Promise<unknown>, entityName: string) => {
      if (selectedIds.size === 0) return
      if (!confirm(`Delete ${selectedIds.size} selected ${entityName}?`)) return

      setIsDeleting(true)
      try {
        await Promise.all(Array.from(selectedIds).map((id) => deleteFn(id)))
        setSelectedIds(new Set())
      } finally {
        setIsDeleting(false)
      }
    },
    [selectedIds]
  )

  return {
    selectedIds,
    isDeleting,
    toggleSelect,
    toggleSelectAll,
    clearSelection,
    handleBulkDelete,
    allSelected: items.length > 0 && selectedIds.size === items.length,
  }
}
