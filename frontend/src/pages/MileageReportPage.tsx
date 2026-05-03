import { useState, useMemo } from "react"
import { useTripLogs } from "@/hooks/useApi"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { travel } from "@/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Car, TrendingUp, AlertTriangle } from "lucide-react"

export default function MileageReportPage() {
  const { data: allLogs = [] } = useTripLogs()
  const { data: yearlyMileageData = [] } = useQuery({ queryKey: ["travel", "yearly-mileage"], queryFn: () => travel.yearlyMileage.list() })
  const queryClient = useQueryClient()
  const [yearFilter, setYearFilter] = useState<string>("all")
  const [editingKm, setEditingKm] = useState<Record<number, string>>({})

  // Only confirmed logs count for reporting
  const confirmedLogs = useMemo(() => allLogs.filter((l) => l.status === "confirmed"), [allLogs])

  const availableYears = useMemo(() => {
    const years = new Set(confirmedLogs.map((l) => parseInt(l.trip_date.slice(0, 4))))
    return Array.from(years).sort((a, b) => b - a)
  }, [confirmedLogs])

  const filteredLogs = useMemo(() => {
    if (yearFilter === "all") return confirmedLogs
    return confirmedLogs.filter((l) => l.trip_date.startsWith(yearFilter))
  }, [confirmedLogs, yearFilter])

  // Stats
  const totalTrips = filteredLogs.length
  const totalKm = filteredLogs.reduce((s, l) => s + l.total_km, 0)
  const businessKm = filteredLogs.reduce((s, l) => s + l.business_km, 0)
  const personalKm = totalKm - businessKm

  // Per-year breakdown
  const yearBreakdown = useMemo(() => {
    const years = yearFilter === "all" ? availableYears : [parseInt(yearFilter)]
    return years.map((year) => {
      const logs = confirmedLogs.filter((l) => l.trip_date.startsWith(String(year)))
      const biz = logs.reduce((s, l) => s + l.business_km, 0)
      const tot = logs.reduce((s, l) => s + l.total_km, 0)
      const pers = tot - biz
      const yearlyEntry = yearlyMileageData.find((y) => y.year === year)
      const odometerKm = yearlyEntry?.total_km
      const bizPct = odometerKm && odometerKm > 0 ? (biz / odometerKm) * 100 : null
      return { year, trips: logs.length, totalKm: tot, businessKm: biz, personalKm: pers, odometerKm, bizPct }
    })
  }, [confirmedLogs, yearFilter, availableYears, yearlyMileageData])

  const handleOdometerSave = (year: number, value: string) => {
    const val = parseFloat(value)
    if (!isNaN(val) && val > 0) {
      travel.yearlyMileage.upsert(year, val).then(() => {
        queryClient.invalidateQueries({ queryKey: ["travel", "yearly-mileage"] })
        setEditingKm((prev) => { const next = { ...prev }; delete next[year]; return next })
      })
    } else {
      setEditingKm((prev) => { const next = { ...prev }; delete next[year]; return next })
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Mileage Report</h1>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">Year:</label>
          <Select value={yearFilter} onValueChange={setYearFilter}>
            <SelectTrigger className="w-28 h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Years</SelectItem>
              {availableYears.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-xs text-muted-foreground mb-0.5">Confirmed Trips</div>
            <div className="text-2xl font-bold">{totalTrips}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-xs text-muted-foreground mb-0.5">Total Logged km</div>
            <div className="text-2xl font-bold">{totalKm.toFixed(1)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-xs text-muted-foreground mb-0.5">Business km</div>
            <div className="text-2xl font-bold text-green-700">{businessKm.toFixed(1)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-xs text-muted-foreground mb-0.5">Personal km</div>
            <div className="text-2xl font-bold text-blue-600">{personalKm.toFixed(1)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Per-Year Breakdown with Odometer Entry */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2"><Car className="h-4 w-4" />Yearly Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {yearBreakdown.length === 0 ? (
            <div className="text-sm text-muted-foreground">No confirmed trip logs yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Year</TableHead>
                  <TableHead className="text-right">Trips</TableHead>
                  <TableHead className="text-right">Logged km</TableHead>
                  <TableHead className="text-right">Business km</TableHead>
                  <TableHead className="text-right">Personal km</TableHead>
                  <TableHead className="text-right">Odometer km</TableHead>
                  <TableHead className="text-right">Business %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {yearBreakdown.map((row) => (
                  <TableRow key={row.year}>
                    <TableCell className="font-medium">{row.year}</TableCell>
                    <TableCell className="text-right">{row.trips}</TableCell>
                    <TableCell className="text-right">{row.totalKm.toFixed(1)}</TableCell>
                    <TableCell className="text-right text-green-700 font-medium">{row.businessKm.toFixed(1)}</TableCell>
                    <TableCell className="text-right text-blue-600">{row.personalKm.toFixed(1)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <input
                          type="number"
                          className="w-24 h-7 text-sm border rounded px-2 text-right"
                          placeholder="Enter km"
                          value={editingKm[row.year] ?? (row.odometerKm != null ? String(row.odometerKm) : "")}
                          onChange={(e) => setEditingKm((prev) => ({ ...prev, [row.year]: e.target.value }))}
                          onBlur={() => handleOdometerSave(row.year, editingKm[row.year] ?? "")}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {row.bizPct != null ? (
                        <span className="font-bold text-green-700 flex items-center justify-end gap-1">
                          <TrendingUp className="h-3.5 w-3.5" />{row.bizPct.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground flex items-center justify-end gap-1" title="Enter odometer km to calculate">
                          <AlertTriangle className="h-3 w-3" />—
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Trip Log Detail */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Confirmed Trip Logs ({filteredLogs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {filteredLogs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No confirmed trips for this period.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead className="text-right">Total km</TableHead>
                  <TableHead className="text-right">Business km</TableHead>
                  <TableHead className="text-right">Personal km</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs
                  .sort((a, b) => a.trip_date.localeCompare(b.trip_date))
                  .map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="font-medium text-sm">{log.trip_date}</TableCell>
                    <TableCell className="text-sm text-muted-foreground truncate max-w-[250px]">{log.purpose || "—"}</TableCell>
                    <TableCell className="text-right text-sm">{log.total_km.toFixed(1)}</TableCell>
                    <TableCell className="text-right text-sm text-green-700 font-medium">{log.business_km.toFixed(1)}</TableCell>
                    <TableCell className="text-right text-sm text-blue-600">{(log.total_km - log.business_km).toFixed(1)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{log.source}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground">
        Only confirmed/saved trip logs are included in this report. Draft logs are excluded.
      </div>
    </div>
  )
}
