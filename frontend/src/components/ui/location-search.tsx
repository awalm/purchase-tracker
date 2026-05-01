import * as React from "react"
import { Check, ChevronsUpDown, Search, Plus, Globe } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { TravelLocation } from "@/api"

interface LocationSearchProps {
  locations: TravelLocation[]
  value: string
  onValueChange: (value: string) => void
  onAddNew?: () => void
  allowClear?: boolean
  placeholder?: string
  className?: string
  triggerClassName?: string
  initialSearch?: string
}

export function LocationSearch({
  locations,
  value,
  onValueChange,
  onAddNew,
  allowClear = false,
  placeholder = "Search locations...",
  className,
  triggerClassName,
  initialSearch = "",
}: LocationSearchProps) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState(initialSearch)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const selectedLocation = locations.find((l) => l.id === value)

  const filteredLocations = React.useMemo(() => {
    if (!search) return locations
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    return locations.filter((l) => {
      const text = `${l.label} ${l.address}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
  }, [locations, search])

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const handleSelect = (id: string) => {
    onValueChange(id)
    setOpen(false)
    setSearch("")
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <Button
        type="button"
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className={cn("w-full justify-between font-normal", triggerClassName)}
        onClick={() => {
          if (!open) setSearch(initialSearch)
          setOpen(!open)
          setTimeout(() => inputRef.current?.focus(), 0)
        }}
      >
        {selectedLocation ? (
          <span className="truncate text-xs">{selectedLocation.label}</span>
        ) : value === "__none__" ? (
          <span className="truncate text-xs">No Store (Online)</span>
        ) : (
          <span className="text-muted-foreground text-xs">Select location...</span>
        )}
        <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
      </Button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[280px] rounded-md border bg-white shadow-lg dark:bg-slate-950">
          <div className="flex items-center border-b px-3 py-2">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <Input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={placeholder}
              className="border-0 p-0 h-7 text-xs focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {allowClear && (
              <div
                className={cn(
                  "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent hover:text-accent-foreground",
                  value === "__none__" && "bg-accent"
                )}
                onClick={() => handleSelect("__none__")}
              >
                <Check
                  className={cn(
                    "mr-2 h-3 w-3 flex-shrink-0",
                    value === "__none__" ? "opacity-100" : "opacity-0"
                  )}
                />
                <Globe className="mr-1.5 h-3 w-3 flex-shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground italic">No Store (Online)</span>
              </div>
            )}
            {filteredLocations.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                No locations found
              </div>
            ) : (
              filteredLocations.map((loc) => (
                <div
                  key={loc.id}
                  className={cn(
                    "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent hover:text-accent-foreground",
                    value === loc.id && "bg-accent"
                  )}
                  onClick={() => handleSelect(loc.id)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-3 w-3 flex-shrink-0",
                      value === loc.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="font-medium">{loc.label}</span>
                    {loc.address && (
                      <span className="text-muted-foreground ml-1 truncate">— {loc.address}</span>
                    )}
                  </div>
                </div>
              ))
            )}
            {onAddNew && (
              <div
                className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-xs font-medium text-primary hover:bg-accent border-t mt-1"
                onClick={() => {
                  setOpen(false)
                  setSearch("")
                  onAddNew()
                }}
              >
                <Plus className="mr-2 h-3 w-3" />
                Add New Location
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
