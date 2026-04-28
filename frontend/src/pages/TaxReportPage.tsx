import { useState, useMemo, Fragment } from "react"
import { Link } from "react-router-dom"
import { useDestinations, useTaxReport } from "@/hooks/useApi"
import { formatCurrency, formatDate } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/date-input"
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
import { ChevronDown, ChevronRight } from "lucide-react"
import type { TaxReportAllocation, TaxReportPurchase } from "@/api"

interface CostTier {
  unit_cost: string
  total_qty: number
  total_allocated: number
  commission: number
  allocations: TaxReportAllocation[]
}

function groupAllocationsByCost(purchase: TaxReportPurchase): CostTier[] {
  const map = new Map<string, CostTier>()
  const sellPrice = parseFloat(purchase.invoice_unit_price)

  for (const alloc of purchase.allocations) {
    const costKey = alloc.unit_cost
    let tier = map.get(costKey)
    if (!tier) {
      tier = {
        unit_cost: costKey,
        total_qty: 0,
        total_allocated: 0,
        commission: 0,
        allocations: [],
      }
      map.set(costKey, tier)
    }
    tier.allocations.push(alloc)
    tier.total_qty += alloc.allocated_qty
    tier.total_allocated += parseFloat(alloc.allocated_total)
    tier.commission += alloc.allocated_qty * (sellPrice - parseFloat(alloc.unit_cost))
  }

  return Array.from(map.values()).sort((a, b) =>
    parseFloat(a.unit_cost) - parseFloat(b.unit_cost)
  )
}

export default function TaxReportPage() {
  const { data: destinations = [] } = useDestinations()
  const [destinationId, setDestinationId] = useState("")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [expandedInvoices, setExpandedInvoices] = useState<Set<string>>(new Set())

  const { data: report, isLoading, error } = useTaxReport(
    destinationId || undefined,
    fromDate || undefined,
    toDate || undefined,
  )

  const toggleInvoice = (invoiceId: string) => {
    setExpandedInvoices((prev) => {
      const next = new Set(prev)
      if (next.has(invoiceId)) {
        next.delete(invoiceId)
      } else {
        next.add(invoiceId)
      }
      return next
    })
  }

  const expandAll = () => {
    if (!report) return
    setExpandedInvoices(new Set(report.invoices.map((inv) => inv.invoice_id)))
  }

  const collapseAll = () => {
    setExpandedInvoices(new Set())
  }

  // Parse error details for tax validation errors
  const errorDetails = useMemo(() => {
    if (!error) return null
    const msg = (error as Error).message || ""
    try {
      const parsed = JSON.parse(msg)
      if (parsed.missing_tax_rates) return parsed
    } catch {
      // not a validation error
    }
    return null
  }, [error])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tax Report</h1>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Destination</label>
              <Select value={destinationId} onValueChange={setDestinationId}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Select destination" />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.code} — {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">From</label>
              <DateInput value={fromDate} onChange={setFromDate} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">To</label>
              <DateInput value={toDate} onChange={setToDate} />
            </div>
          </div>
        </CardContent>
      </Card>

      {!destinationId && (
        <p className="text-muted-foreground text-sm">Select a destination to generate the tax report.</p>
      )}

      {isLoading && <p className="text-muted-foreground">Loading...</p>}

      {errorDetails && (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="pt-6 space-y-2">
            <p className="text-sm font-medium text-red-800">{errorDetails.error}</p>
            {errorDetails.missing_tax_rates?.map((m: { invoice_id: string; invoice_number: string; message: string }) => (
              <p key={m.invoice_id} className="text-xs text-red-700">
                <Link to={`/invoices/${m.invoice_id}`} className="underline hover:text-red-900">
                  Invoice #{m.invoice_number}
                </Link>{" "}
                — missing tax rate
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {error && !errorDetails && (
        <p className="text-red-600 text-sm">Error loading report: {(error as Error).message}</p>
      )}

      {report && !error && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Cost
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(report.total_cost)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Revenue
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(report.total_revenue)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Commission
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(report.total_commission)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  HST on Cost
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(report.total_hst_on_cost)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  HST on Commission
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(report.total_hst_on_commission)}</div>
              </CardContent>
            </Card>
          </div>

          {/* Invoice Breakdown */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Breakdown by Invoice</CardTitle>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={expandAll}>Expand All</Button>
                  <Button variant="ghost" size="sm" onClick={collapseAll}>Collapse All</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {report.invoices.length === 0 ? (
                <p className="text-muted-foreground text-sm">No locked invoices found for the selected filters.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8"></TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Tax Rate</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="text-right">HST on Cost</TableHead>
                      <TableHead className="text-right">HST on Commission</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.invoices.map((invoice) => {
                      const isExpanded = expandedInvoices.has(invoice.invoice_id)

                      return (
                        <Fragment key={invoice.invoice_id}>
                          <TableRow
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => toggleInvoice(invoice.invoice_id)}
                          >
                            <TableCell>
                              {isExpanded
                                ? <ChevronDown className="h-4 w-4" />
                                : <ChevronRight className="h-4 w-4" />}
                            </TableCell>
                            <TableCell>
                              <Link
                                to={`/invoices/${invoice.invoice_id}`}
                                className="text-primary hover:underline font-mono"
                                onClick={(e) => e.stopPropagation()}
                              >
                                #{invoice.invoice_number}
                              </Link>
                            </TableCell>
                            <TableCell>{formatDate(invoice.invoice_date)}</TableCell>
                            <TableCell>{invoice.tax_rate}%</TableCell>
                            <TableCell className="text-right">{formatCurrency(invoice.total_cost)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(invoice.total_revenue)}</TableCell>
                            <TableCell className="text-right font-medium">{formatCurrency(invoice.total_commission)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(invoice.total_hst_on_cost)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(invoice.total_hst_on_commission)}</TableCell>
                          </TableRow>

                          {isExpanded && (
                            <TableRow>
                              <TableCell colSpan={9} className="bg-muted/30 py-3">
                                <div className="ml-6 border-l-2 border-muted-foreground/20 pl-4 space-y-4">
                                  {invoice.purchases.map((purchase, pIdx) => {
                                    const costTiers = groupAllocationsByCost(purchase)
                                    const hasMultipleTiers = costTiers.length > 1

                                    return (
                                      <div key={pIdx} className="space-y-2">
                                        {/* Purchase header */}
                                        <div className="flex items-center gap-3 text-sm">
                                          <span className="font-medium">{purchase.item_name}</span>
                                          <span className="text-muted-foreground">×{purchase.quantity}</span>
                                          <span className="text-muted-foreground">
                                            sell {formatCurrency(purchase.invoice_unit_price)}
                                          </span>
                                          <span className="ml-auto font-medium text-green-700">
                                            commission {formatCurrency(purchase.commission)}
                                          </span>
                                        </div>

                                        {/* Receipt allocations grouped by unit cost */}
                                        {costTiers.map((tier, tIdx) => (
                                          <div key={tIdx} className="space-y-1">
                                            {hasMultipleTiers && (
                                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                <span className="font-medium">
                                                  At {formatCurrency(tier.unit_cost)} × {tier.total_qty}
                                                </span>
                                                <span>→</span>
                                                <span className="text-green-700">
                                                  {formatCurrency(tier.commission)} commission
                                                </span>
                                              </div>
                                            )}
                                            <div className="border rounded-md bg-background overflow-hidden">
                                              <Table>
                                                <TableHeader>
                                                  <TableRow>
                                                    <TableHead>Receipt</TableHead>
                                                    <TableHead>Vendor</TableHead>
                                                    <TableHead>Date</TableHead>
                                                    <TableHead className="text-right">Qty</TableHead>
                                                    <TableHead className="text-right">Unit Cost</TableHead>
                                                    <TableHead className="text-right">Allocated Total</TableHead>
                                                  </TableRow>
                                                </TableHeader>
                                                <TableBody>
                                                  {tier.allocations.map((a, aIdx) => (
                                                    <TableRow key={aIdx}>
                                                      <TableCell>
                                                        <Link
                                                          to={`/receipts/${a.receipt_id}`}
                                                          className="text-primary hover:underline font-mono text-xs"
                                                        >
                                                          {a.receipt_number}
                                                        </Link>
                                                      </TableCell>
                                                      <TableCell>{a.vendor_name}</TableCell>
                                                      <TableCell>{formatDate(a.receipt_date)}</TableCell>
                                                      <TableCell className="text-right">{a.allocated_qty}</TableCell>
                                                      <TableCell className="text-right">{formatCurrency(a.unit_cost)}</TableCell>
                                                      <TableCell className="text-right">{formatCurrency(a.allocated_total)}</TableCell>
                                                    </TableRow>
                                                  ))}
                                                </TableBody>
                                              </Table>
                                            </div>
                                          </div>
                                        ))}

                                        {purchase.allocations.length === 0 && (
                                          <p className="text-xs text-amber-600">No receipt allocations linked</p>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      )
                    })}

                    {/* Totals row */}
                    <TableRow className="font-bold border-t-2">
                      <TableCell />
                      <TableCell colSpan={3}>Totals</TableCell>
                      <TableCell className="text-right">{formatCurrency(report.total_cost)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(report.total_revenue)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(report.total_commission)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(report.total_hst_on_cost)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(report.total_hst_on_commission)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
