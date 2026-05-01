import * as React from "react"
import { Check, ChevronsUpDown, Search, Plus, Globe } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { TravelLocation } from "@/api"

interface LocationGroup {
  label: string
  locations: TravelLocation[]
}

interface LocationSearchProps {
  locations: TravelLocation[]
  groups?: LocationGroup[]
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
  groups,
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

  const filterLocs = React.useCallback((locs: TravelLocation[]) => {
    if (!search) return locs
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    return locs.filter((l) => {
      const text = `${l.label} ${l.address}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
  }, [search])

  const filteredLocations = React.useMemo(() => filterLocs(locations), [locations, filterLocs])

  const filteredGroups = React.useMemo(() => {
    if (!groups) return null
    return groups.map((g) => ({ ...g, locations: filterLocs(g.locations) })).filter((g) => g.locations.length > 0)
  }, [groups, filterLocs])

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
            {filteredGroups && filteredGroups.length > 0 ? (
              filteredGroups.map((group, gi) => (
                <div key={group.label}>
                  {gi > 0 && <div className="border-t my-1" />}
                  <div className="px-2 py-1 flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{group.label}</span>
                    {gi > 0 && onAddNew && (
                      <button
                        className="text-[10px] font-medium text-primary hover:underline flex items-center gap-0.5"
                        onClick={() => { setOpen(false); setSearch(""); onAddNew() }}
                      >
                        <Plus className="h-2.5 w-2.5" />New
                      </button>
                    )}
                  </div>
                  {group.locations.map((loc) => (
                    <div
                      key={loc.id}
                      className={cn(
                        "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent hover:text-accent-foreground",
                        value === loc.id && "bg-accent"
                      )}
                      onClick={() => handleSelect(loc.id)}
                    >
                      <Check className={cn("mr-2 h-3 w-3 flex-shrink-0", value === loc.id ? "opacity-100" : "opacity-0")} />
                      <div className="flex-1 min-w-0">
                        <span className="font-medium">{loc.label}</span>
                        {loc.address && <span className="text-muted-foreground ml-1 truncate">— {loc.address}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ))
            ) : filteredLocations.length === 0 ? (
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
            {onAddNew && !filteredGroups && (
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
