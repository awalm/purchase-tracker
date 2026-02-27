import * as React from "react"
import { Check, ChevronsUpDown, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ActiveItem } from "@/types"

interface ItemSearchProps {
  items: ActiveItem[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
}

export function ItemSearch({ 
  items, 
  value, 
  onValueChange, 
  placeholder = "Search items..." 
}: ItemSearchProps) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const containerRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const selectedItem = items.find(item => item.id === value)

  // Filter items based on search (name or vendor)
  const filteredItems = React.useMemo(() => {
    if (!search) return items.slice(0, 20) // Show first 20 (most recent) when no search
    const searchLower = search.toLowerCase()
    return items.filter(item => 
      item.name.toLowerCase().includes(searchLower) ||
      item.vendor_name.toLowerCase().includes(searchLower)
    ).slice(0, 50) // Limit results to 50
  }, [items, search])

  // Close dropdown when clicking outside
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const handleSelect = (itemId: string) => {
    onValueChange(itemId)
    setOpen(false)
    setSearch("")
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className="w-full justify-between font-normal"
        onClick={() => {
          setOpen(!open)
          setTimeout(() => inputRef.current?.focus(), 0)
        }}
      >
        {selectedItem ? (
          <span className="truncate">
            {selectedItem.name} <span className="text-muted-foreground">({selectedItem.vendor_name})</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Select item...</span>
        )}
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
      
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg">
          <div className="flex items-center border-b px-3 py-2">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <Input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={placeholder}
              className="border-0 p-0 h-8 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {filteredItems.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No items found
              </div>
            ) : (
              <>
                {!search && (
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    Recently added
                  </div>
                )}
                {filteredItems.map((item) => (
                  <div
                    key={item.id}
                    className={cn(
                      "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground",
                      value === item.id && "bg-accent"
                    )}
                    onClick={() => handleSelect(item.id)}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === item.id ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <div className="flex-1 truncate">
                      <span className="font-medium">{item.name}</span>
                      <span className="ml-2 text-muted-foreground">({item.vendor_name})</span>
                    </div>
                  </div>
                ))}
                {!search && items.length > 20 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground text-center border-t mt-1">
                    Type to search {items.length - 20} more items...
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
