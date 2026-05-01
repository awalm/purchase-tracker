import React, { useState, useMemo, useCallback } from "react"
import {
  useTripLogs,
  useUpdateTripLog,
  useDeleteTripLog,
  useReceiptLocations,
} from "@/hooks/useApi"
import { travel } from "@/api"
import type { TravelTripLog, TravelSegment, TripLogWithSegments } from "@/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/date-input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Briefcase,
  Home,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  Trash2,
  CheckCircle,
  FileText,
  MapPin,
  Car,
} from "lucide-react"

function formatKm(km: number | null | undefined): string {
  if (km == null) return "—"
  return km.toFixed(1) + " km"
}

function formatMetersAsKm(meters: number | null | undefined): string {
  if (meters == null) return "—"
  return (meters / 1000).toFixed(1) + " km"
}

function classificationBadge(classification: string) {
  switch (classification) {
    case "business":
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-green-100 text-green-800"><Briefcase className="h-3 w-3" /> Business</span>
    case "personal":
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-blue-100 text-blue-800"><Home className="h-3 w-3" /> Personal</span>
    default:
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-600"><HelpCircle className="h-3 w-3" /> Unclassified</span>
  }
}

function sourceBadge(source: string) {
  switch (source) {
    case "timeline":
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800"><Car className="h-3 w-3" /> Timeline</span>
    case "receipt":
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800"><MapPin className="h-3 w-3" /> Receipt</span>
    case "merged":
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-purple-100 text-purple-800">Merged</span>
    default:
      return <span className="text-xs text-muted-foreground">{source}</span>
  }
}

export default function MileageLogPage() {
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const [segmentCache, setSegmentCache] = useState<Map<string, TravelSegment[]>>(new Map())
  const [loadingSegments, setLoadingSegments] = useState<Set<string>>(new Set())
  const [editingLogId, setEditingLogId] = useState<string | null>(null)
  const [logPurpose, setLogPurpose] = useState("")
  const [logNotes, setLogNotes] = useState("")

  const { data: allLogs, isLoading } = useTripLogs()
  const { data: receiptLocations } = useReceiptLocations(fromDate || undefined, toDate || undefined)
  const updateTripLogMutation = useUpdateTripLog()
  const deleteTripLogMutation = useDeleteTripLog()

  // Filter logs by date range
  const filteredLogs = useMemo(() => {
    if (!allLogs) return []
    return allLogs.filter((log) => {
      if (fromDate && log.trip_date < fromDate) return false
      if (toDate && log.trip_date > toDate) return false
      return true
    })
  }, [allLogs, fromDate, toDate])

  // Summary stats
  const stats = useMemo(() => {
    const logs = filteredLogs
    return {
      totalDays: logs.length,
      confirmedDays: logs.filter((l) => l.status === "confirmed").length,
      totalKm: logs.reduce((sum, l) => sum + l.total_km, 0),
      businessKm: logs.reduce((sum, l) => sum + l.business_km, 0),
    }
  }, [filteredLogs])

  // Receipts grouped by date
  const receiptsByDate = useMemo(() => {
    const map = new Map<string, typeof receiptLocations>()
    if (!receiptLocations) return map
    for (const r of receiptLocations) {
      if (!r.receipt_date) continue
      const existing = map.get(r.receipt_date) || []
      existing.push(r)
      map.set(r.receipt_date, existing)
    }
    return map
  }, [receiptLocations])

  const toggleDate = useCallback(async (log: TravelTripLog) => {
    const date = log.trip_date
    setExpandedDates((prev) => {
      const next = new Set(prev)
      if (next.has(date)) {
        next.delete(date)
      } else {
        next.add(date)
        // Fetch segments if not cached
        if (!segmentCache.has(date)) {
          setLoadingSegments((s) => new Set(s).add(date))
          travel.tripLogs.get(log.id).then((result: TripLogWithSegments) => {
            setSegmentCache((c) => {
              const next = new Map(c)
              next.set(date, result.segments)
              return next
            })
            setLoadingSegments((s) => {
              const next = new Set(s)
              next.delete(date)
              return next
            })
          }).catch(() => {
            setLoadingSegments((s) => {
              const next = new Set(s)
              next.delete(date)
              return next
            })
          })
        }
      }
      return next
    })
  }, [segmentCache])

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Mileage Log</h1>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{stats.totalDays}</div>
            <div className="text-xs text-muted-foreground">Total Days</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{stats.confirmedDays}</div>
            <div className="text-xs text-muted-foreground">Confirmed</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">{formatKm(stats.totalKm)}</div>
            <div className="text-xs text-muted-foreground">Total Distance</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold text-green-700">{formatKm(stats.businessKm)}</div>
            <div className="text-xs text-muted-foreground">Business Distance</div>
          </CardContent>
        </Card>
      </div>

      {/* Date Filters */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">From:</label>
          <DateInput value={fromDate} onChange={setFromDate} className="w-36" />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium">To:</label>
          <DateInput value={toDate} onChange={setToDate} className="w-36" />
        </div>
        {(fromDate || toDate) && (
          <Button variant="ghost" size="sm" onClick={() => { setFromDate(""); setToDate("") }}>
            Clear
          </Button>
        )}
      </div>

      {/* Log Table */}
      {filteredLogs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Trip Log Entries</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Business</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs.map((log) => {
                  const isExpanded = expandedDates.has(log.trip_date)
                  const segs = segmentCache.get(log.trip_date) || []
                  const isLoadingSegs = loadingSegments.has(log.trip_date)
                  const dateReceipts = receiptsByDate.get(log.trip_date) || []
                  return (
                    <React.Fragment key={log.id}>
                      <TableRow
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() => toggleDate(log)}
                      >
                        <TableCell className="w-8">
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell className="font-medium">{log.trip_date}</TableCell>
                        <TableCell>{sourceBadge(log.source)}</TableCell>
                        <TableCell className="text-right">{formatKm(log.total_km)}</TableCell>
                        <TableCell className="text-right text-green-700">{formatKm(log.business_km)}</TableCell>
                        <TableCell className="max-w-xs truncate text-sm">{log.purpose || <span className="text-muted-foreground italic">No purpose</span>}</TableCell>
                        <TableCell>
                          {log.status === "confirmed" ? (
                            <span className="inline-flex items-center gap-1 text-xs text-green-700">
                              <CheckCircle className="h-3.5 w-3.5" /> Confirmed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                              <FileText className="h-3.5 w-3.5" /> Draft
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                            {log.status === "draft" ? (
                              <Button
                                size="sm"
                                className="h-6 text-xs bg-green-600 hover:bg-green-700"
                                onClick={() => updateTripLogMutation.mutate({ id: log.id, status: "confirmed" })}
                              >
                                Confirm
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 text-xs"
                                onClick={() => updateTripLogMutation.mutate({ id: log.id, status: "draft" })}
                              >
                                Unconfirm
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow className="bg-green-50/50">
                          <TableCell colSpan={8} className="px-4 py-3">
                            {/* Purpose / Notes editing */}
                            <div className="flex flex-col gap-2 mb-3">
                              <div className="flex items-center gap-2">
                                <label className="text-xs font-medium w-16">Purpose:</label>
                                {editingLogId === log.id ? (
                                  <input
                                    className="text-xs border rounded px-2 py-1 flex-1"
                                    value={logPurpose}
                                    onChange={(e) => setLogPurpose(e.target.value)}
                                    placeholder="Business purpose for this trip"
                                  />
                                ) : (
                                  <span className="text-xs flex-1">{log.purpose || <span className="text-muted-foreground italic">No purpose set</span>}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <label className="text-xs font-medium w-16">Notes:</label>
                                {editingLogId === log.id ? (
                                  <textarea
                                    className="text-xs border rounded px-2 py-1 flex-1"
                                    rows={2}
                                    value={logNotes}
                                    onChange={(e) => setLogNotes(e.target.value)}
                                    placeholder="Additional notes..."
                                  />
                                ) : (
                                  <span className="text-xs flex-1">{log.notes || <span className="text-muted-foreground italic">No notes</span>}</span>
                                )}
                              </div>
                              <div className="flex gap-2 items-center">
                                <div className="flex-1" />
                                {editingLogId === log.id ? (
                                  <>
                                    <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setEditingLogId(null)}>Cancel</Button>
                                    <Button size="sm" className="h-6 text-xs" onClick={() => {
                                      updateTripLogMutation.mutate({ id: log.id, purpose: logPurpose, notes: logNotes })
                                      setEditingLogId(null)
                                    }}>Save Changes</Button>
                                  </>
                                ) : (
                                  <>
                                    <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => {
                                      setEditingLogId(log.id)
                                      setLogPurpose(log.purpose)
                                      setLogNotes(log.notes)
                                    }}>Edit</Button>
                                    <Button variant="ghost" size="sm" className="h-6 text-xs text-red-500" onClick={() => deleteTripLogMutation.mutate(log.id)}>
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>

                            {/* Segments */}
                            {isLoadingSegs ? (
                              <div className="text-xs text-muted-foreground py-2">Loading segments...</div>
                            ) : segs.length > 0 ? (
                              <div className="mb-3">
                                <div className="text-xs font-medium mb-1">Segments</div>
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-muted-foreground border-b">
                                      <th className="text-left py-1 pr-2">Route</th>
                                      <th className="text-right py-1 pr-2">Distance</th>
                                      <th className="text-center py-1">Classification</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {segs.filter((s) => s.segment_type === "drive").map((seg) => (
                                      <tr key={seg.id} className="border-b border-slate-100">
                                        <td className="py-1 pr-2">{seg.from_location || "?"} → {seg.to_location || "?"}</td>
                                        <td className="text-right py-1 pr-2">{formatMetersAsKm(seg.distance_meters)}</td>
                                        <td className="text-center py-1">{classificationBadge(seg.classification)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ) : (
                              <div className="text-xs text-muted-foreground py-2 mb-3">No segments recorded</div>
                            )}

                            {/* Receipts for this date */}
                            {dateReceipts.length > 0 && (
                              <div>
                                <div className="text-xs font-medium mb-1">Receipts</div>
                                <div className="flex flex-wrap gap-2">
                                  {dateReceipts.map((r) => (
                                    <div key={r.id} className="bg-white border rounded px-2 py-1 text-xs">
                                      <span className="font-medium">{r.vendor_name}</span>
                                      <span className="text-muted-foreground ml-1">${parseFloat(r.total).toFixed(2)}</span>
                                      {r.store_label && <div className="text-muted-foreground text-[10px]">{r.store_label}</div>}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <div className="text-center py-16 text-muted-foreground">
          No mileage log entries yet. Import from Timeline or Receipts to get started.
        </div>
      )}
    </div>
  )
}
