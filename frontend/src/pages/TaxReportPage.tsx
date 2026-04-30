import { useState, useMemo, Fragment, useCallback } from "react"
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
import { ChevronDown, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown, Download } from "lucide-react"
import type { TaxReportAllocation, TaxReportPurchase, TaxReportInvoice, TaxReportSummary as TaxReportSummaryType } from "@/api"
import * as XLSX from "xlsx"

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

type SortKey = "invoice_number" | "invoice_date" | "tax_rate" | "total_cost" | "total_revenue" | "total_commission" | "total_hst_on_cost" | "total_hst_on_commission" | "hst_charged"
type SortDir = "asc" | "desc"

function compareInvoices(a: TaxReportInvoice, b: TaxReportInvoice, key: SortKey, dir: SortDir): number {
  let cmp = 0
  switch (key) {
    case "invoice_number": {
      // Try numeric sort, fall back to string
      const aNum = parseFloat(a.invoice_number)
      const bNum = parseFloat(b.invoice_number)
      cmp = !isNaN(aNum) && !isNaN(bNum) ? aNum - bNum : a.invoice_number.localeCompare(b.invoice_number)
      break
    }
    case "invoice_date":
      cmp = a.invoice_date.localeCompare(b.invoice_date)
      break
    case "tax_rate":
      cmp = parseFloat(a.tax_rate) - parseFloat(b.tax_rate)
      break
    default:
      cmp = parseFloat(a[key]) - parseFloat(b[key])
      break
  }
  return dir === "asc" ? cmp : -cmp
}

function buildExportRows(invoices: TaxReportInvoice[]) {
  return invoices.map((inv) => ({
    "Invoice": `#${inv.invoice_number}`,
    "Date": inv.invoice_date,
    "Tax Rate (%)": parseFloat(inv.tax_rate),
    "Cost": parseFloat(inv.total_cost),
    "Revenue": parseFloat(inv.total_revenue),
    "Commission": parseFloat(inv.total_commission),
    "HST on Cost": parseFloat(inv.total_hst_on_cost),
    "HST on Commission": parseFloat(inv.total_hst_on_commission),
    "HST Charged": parseFloat(inv.hst_charged),
  }))
}

// ── T2125 Summary Table with drilldowns ──

interface CogsItemSummary {
  item_name: string
  total_qty: number
  total_cost: number
  allocations: { receipt_id: string; receipt_number: string; receipt_date: string; vendor_name: string; allocated_qty: number; unit_cost: number; allocated_total: number }[]
}

function buildCogsBreakdown(report: TaxReportSummaryType): CogsItemSummary[] {
  const map = new Map<string, CogsItemSummary>()
  for (const inv of report.invoices) {
    for (const p of inv.purchases) {
      if (p.purchase_type === "refund") continue
      const existing = map.get(p.item_name)
      const entry = existing || { item_name: p.item_name, total_qty: 0, total_cost: 0, allocations: [] }
      entry.total_qty += p.quantity
      entry.total_cost += parseFloat(p.total_cost)
      for (const a of p.allocations) {
        entry.allocations.push({
          receipt_id: a.receipt_id,
          receipt_number: a.receipt_number,
          receipt_date: a.receipt_date,
          vendor_name: a.vendor_name,
          allocated_qty: a.allocated_qty,
          unit_cost: parseFloat(a.unit_cost),
          allocated_total: parseFloat(a.allocated_total),
        })
      }
      if (!existing) map.set(p.item_name, entry)
    }
  }
  return Array.from(map.values()).sort((a, b) => b.total_cost - a.total_cost)
}

interface RevenueInvoiceSummary {
  invoice_id: string
  invoice_number: string
  invoice_date: string
  subtotal: number
  tax: number
  total: number
}

function buildRevenueBreakdown(report: TaxReportSummaryType): RevenueInvoiceSummary[] {
  return report.invoices.map((inv) => ({
    invoice_id: inv.invoice_id,
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date,
    subtotal: parseFloat(inv.total_revenue),
    tax: parseFloat(inv.hst_charged),
    total: parseFloat(inv.total_revenue) + parseFloat(inv.hst_charged),
  })).sort((a, b) => a.invoice_date.localeCompare(b.invoice_date))
}

function T2125Summary({ report }: { report: TaxReportSummaryType }) {
  const [expandedLines, setExpandedLines] = useState<Set<string>>(new Set())
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())

  const toggleLine = (key: string) => {
    setExpandedLines((prev) => {
      const next = new Set(prev)
      if (next.has(key)) { next.delete(key) } else { next.add(key) }
      return next
    })
  }
  const toggleItem = (key: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev)
      if (next.has(key)) { next.delete(key) } else { next.add(key) }
      return next
    })
  }

  const cogsItems = useMemo(() => buildCogsBreakdown(report), [report])
  const revenueInvoices = useMemo(() => buildRevenueBreakdown(report), [report])

  const grossSales = parseFloat(report.total_revenue)
  const cogsAllocated = parseFloat(report.total_cost) - parseFloat(report.lost_items_cost)
  const lostCost = parseFloat(report.lost_items_cost)
  const totalCogs = parseFloat(report.total_cost)
  const grossProfit = grossSales - totalCogs
  const hstCollected = parseFloat(report.total_hst_charged)
  const hstOnCost = parseFloat(report.total_hst_on_cost)
  const hstOnCommission = parseFloat(report.total_hst_on_commission)
  const netHstOwing = hstOnCommission

  const hasLost = lostCost > 0

  type LineRow = {
    key: string
    lineNum?: string
    label: string
    amount: number
    indent?: number
    bold?: boolean
    drilldown?: boolean
    separator?: boolean
    className?: string
  }

  const lines: LineRow[] = [
    { key: "header-income", lineNum: "", label: "INCOME", amount: 0, bold: true, separator: true },
    { key: "8000", lineNum: "8000", label: "Gross sales, commissions or fees", amount: grossSales, drilldown: true },
    { key: "gross-incl-tax", lineNum: "", label: "Gross sales (incl. tax)", amount: grossSales + hstCollected, indent: 1, className: "text-muted-foreground" },
    { key: "8299", lineNum: "8299", label: "Gross business income", amount: grossSales, bold: true },
    { key: "header-cogs", lineNum: "", label: "COST OF GOODS SOLD", amount: 0, bold: true, separator: true },
    { key: "8450", lineNum: "8450", label: "Other costs (purchase cost of goods)", amount: cogsAllocated, drilldown: true },
    ...(hasLost ? [{ key: "8450-lost", lineNum: "", label: "Lost/stolen inventory (write-off)", amount: lostCost, indent: 1, drilldown: true, className: "text-red-700" }] : []),
    { key: "cogs-total", lineNum: "", label: "Total COGS", amount: totalCogs, bold: true },
    { key: "cogs-incl-tax", lineNum: "", label: "Total COGS (incl. tax)", amount: totalCogs + hstOnCost, indent: 1, className: "text-muted-foreground" },
    { key: "8519", lineNum: "8519", label: "Gross profit", amount: grossProfit, bold: true },
    { key: "header-hst", lineNum: "", label: "HST SUMMARY (for GST/HST return)", amount: 0, bold: true, separator: true },
    { key: "hst-collected", lineNum: "", label: "HST collected on invoices", amount: hstCollected, drilldown: true },
    { key: "hst-on-cost", lineNum: "", label: "HST paid on purchases (ITC)", amount: hstOnCost, drilldown: true },
    { key: "hst-on-commission", lineNum: "", label: "HST on commission (net owing)", amount: netHstOwing, bold: true },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>T2125 — Statement of Business Activities</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead className="w-20">Line</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right w-40">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => {
              if (line.separator) {
                return (
                  <TableRow key={line.key} className="bg-muted/50 border-t-2">
                    <TableCell />
                    <TableCell />
                    <TableCell className="font-bold text-xs uppercase tracking-wider text-muted-foreground py-2">{line.label}</TableCell>
                    <TableCell />
                  </TableRow>
                )
              }

              const isExpanded = expandedLines.has(line.key)
              const canExpand = line.drilldown

              return (
                <Fragment key={line.key}>
                  <TableRow
                    className={`${canExpand ? "cursor-pointer hover:bg-muted/50" : ""} ${line.className || ""}`}
                    onClick={canExpand ? () => toggleLine(line.key) : undefined}
                  >
                    <TableCell className="py-2">
                      {canExpand && (isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)}
                    </TableCell>
                    <TableCell className="py-2 font-mono text-xs text-muted-foreground">{line.lineNum}</TableCell>
                    <TableCell className={`py-2 ${line.bold ? "font-bold" : ""} ${line.indent ? "pl-8" : ""}`}>
                      {line.label}
                    </TableCell>
                    <TableCell className={`py-2 text-right ${line.bold ? "font-bold" : ""} ${line.className || ""}`}>
                      {line.amount !== 0 || !line.separator ? formatCurrency(line.amount) : ""}
                    </TableCell>
                  </TableRow>

                  {/* Drilldown: Gross Sales → invoices */}
                  {isExpanded && line.key === "8000" && (
                    <TableRow>
                      <TableCell colSpan={4} className="bg-muted/20 py-2 px-0">
                        <div className="ml-12 mr-4">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Invoice</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead className="text-right">Subtotal (pre-tax)</TableHead>
                                <TableHead className="text-right">HST Charged</TableHead>
                                <TableHead className="text-right">Total</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {revenueInvoices.map((inv) => (
                                <TableRow key={inv.invoice_id}>
                                  <TableCell>
                                    <Link to={`/invoices/${inv.invoice_id}`} className="text-primary hover:underline font-mono">
                                      #{inv.invoice_number}
                                    </Link>
                                  </TableCell>
                                  <TableCell>{formatDate(inv.invoice_date)}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(inv.subtotal)}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(inv.tax)}</TableCell>
                                  <TableCell className="text-right font-medium">{formatCurrency(inv.total)}</TableCell>
                                </TableRow>
                              ))}
                              <TableRow className="font-bold border-t">
                                <TableCell colSpan={2}>Total</TableCell>
                                <TableCell className="text-right">{formatCurrency(grossSales)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(hstCollected)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(grossSales + hstCollected)}</TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}

                  {/* Drilldown: COGS → items → receipts */}
                  {isExpanded && line.key === "8450" && (
                    <TableRow>
                      <TableCell colSpan={4} className="bg-muted/20 py-2 px-0">
                        <div className="ml-12 mr-4 space-y-0">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-8"></TableHead>
                                <TableHead>Item</TableHead>
                                <TableHead className="text-right">Qty Sold</TableHead>
                                <TableHead className="text-right">Total Cost</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {cogsItems.map((item) => {
                                const itemKey = `cogs-${item.item_name}`
                                const itemExpanded = expandedItems.has(itemKey)
                                return (
                                  <Fragment key={itemKey}>
                                    <TableRow
                                      className="cursor-pointer hover:bg-muted/50"
                                      onClick={() => toggleItem(itemKey)}
                                    >
                                      <TableCell className="py-1.5">
                                        {itemExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                      </TableCell>
                                      <TableCell className="py-1.5 font-medium">{item.item_name}</TableCell>
                                      <TableCell className="py-1.5 text-right">{item.total_qty}</TableCell>
                                      <TableCell className="py-1.5 text-right">{formatCurrency(item.total_cost)}</TableCell>
                                    </TableRow>
                                    {itemExpanded && (
                                      <TableRow>
                                        <TableCell colSpan={4} className="bg-background py-1 px-0">
                                          <div className="ml-10 mr-2">
                                            <Table>
                                              <TableHeader>
                                                <TableRow>
                                                  <TableHead>Receipt</TableHead>
                                                  <TableHead>Vendor</TableHead>
                                                  <TableHead>Date</TableHead>
                                                  <TableHead className="text-right">Qty</TableHead>
                                                  <TableHead className="text-right">Unit Cost</TableHead>
                                                  <TableHead className="text-right">Total</TableHead>
                                                </TableRow>
                                              </TableHeader>
                                              <TableBody>
                                                {item.allocations.map((a, aIdx) => (
                                                  <TableRow key={aIdx}>
                                                    <TableCell>
                                                      <Link to={`/receipts/${a.receipt_id}`} className="text-primary hover:underline font-mono text-xs">
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
                                        </TableCell>
                                      </TableRow>
                                    )}
                                  </Fragment>
                                )
                              })}
                              <TableRow className="font-bold border-t">
                                <TableCell />
                                <TableCell>Total COGS (allocated)</TableCell>
                                <TableCell className="text-right">{cogsItems.reduce((s, i) => s + i.total_qty, 0)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(cogsAllocated)}</TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}

                  {/* Drilldown: Lost items */}
                  {isExpanded && line.key === "8450-lost" && (
                    <TableRow>
                      <TableCell colSpan={4} className="bg-red-50/50 py-2 px-0">
                        <div className="ml-12 mr-4">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Item</TableHead>
                                <TableHead>Receipt</TableHead>
                                <TableHead>Vendor</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead className="text-right">Qty</TableHead>
                                <TableHead className="text-right">Unit Cost</TableHead>
                                <TableHead className="text-right">Total</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {report.lost_items.map((item, idx) => (
                                <TableRow key={idx}>
                                  <TableCell className="font-medium">{item.item_name}</TableCell>
                                  <TableCell>
                                    <Link to={`/receipts/${item.receipt_id}`} className="text-primary hover:underline font-mono text-xs">
                                      {item.receipt_number}
                                    </Link>
                                  </TableCell>
                                  <TableCell>{item.vendor_name}</TableCell>
                                  <TableCell>{formatDate(item.receipt_date)}</TableCell>
                                  <TableCell className="text-right">{item.quantity}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(item.unit_cost)}</TableCell>
                                  <TableCell className="text-right text-red-700 font-medium">{formatCurrency(item.line_total)}</TableCell>
                                </TableRow>
                              ))}
                              <TableRow className="font-bold border-t">
                                <TableCell colSpan={6}>Total Lost</TableCell>
                                <TableCell className="text-right text-red-700">{formatCurrency(lostCost)}</TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}

                  {/* Drilldown: HST collected → per-invoice */}
                  {isExpanded && line.key === "hst-collected" && (
                    <TableRow>
                      <TableCell colSpan={4} className="bg-muted/20 py-2 px-0">
                        <div className="ml-12 mr-4">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Invoice</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead className="text-right">Subtotal</TableHead>
                                <TableHead className="text-right">HST Charged</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {revenueInvoices.map((inv) => (
                                <TableRow key={inv.invoice_id}>
                                  <TableCell>
                                    <Link to={`/invoices/${inv.invoice_id}`} className="text-primary hover:underline font-mono">
                                      #{inv.invoice_number}
                                    </Link>
                                  </TableCell>
                                  <TableCell>{formatDate(inv.invoice_date)}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(inv.subtotal)}</TableCell>
                                  <TableCell className="text-right font-medium">{formatCurrency(inv.tax)}</TableCell>
                                </TableRow>
                              ))}
                              <TableRow className="font-bold border-t">
                                <TableCell colSpan={2}>Total</TableCell>
                                <TableCell className="text-right">{formatCurrency(grossSales)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(hstCollected)}</TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}

                  {/* Drilldown: HST paid (ITC) → per-invoice + lost */}
                  {isExpanded && line.key === "hst-on-cost" && (
                    <TableRow>
                      <TableCell colSpan={4} className="bg-muted/20 py-2 px-0">
                        <div className="ml-12 mr-4">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Invoice</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead className="text-right">Cost</TableHead>
                                <TableHead className="text-right">HST on Cost (ITC)</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {report.invoices
                                .slice()
                                .sort((a, b) => a.invoice_date.localeCompare(b.invoice_date))
                                .map((inv) => (
                                  <TableRow key={inv.invoice_id}>
                                    <TableCell>
                                      <Link to={`/invoices/${inv.invoice_id}`} className="text-primary hover:underline font-mono">
                                        #{inv.invoice_number}
                                      </Link>
                                    </TableCell>
                                    <TableCell>{formatDate(inv.invoice_date)}</TableCell>
                                    <TableCell className="text-right">{formatCurrency(inv.total_cost)}</TableCell>
                                    <TableCell className="text-right font-medium">{formatCurrency(inv.total_hst_on_cost)}</TableCell>
                                  </TableRow>
                                ))}
                              {hasLost && (
                                <TableRow className="text-red-700">
                                  <TableCell colSpan={2}>Lost/stolen inventory</TableCell>
                                  <TableCell className="text-right">{formatCurrency(lostCost)}</TableCell>
                                  <TableCell className="text-right font-medium">{formatCurrency(parseFloat(report.lost_items_tax))}</TableCell>
                                </TableRow>
                              )}
                              <TableRow className="font-bold border-t">
                                <TableCell colSpan={2}>Total</TableCell>
                                <TableCell className="text-right">{formatCurrency(totalCogs)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(hstOnCost)}</TableCell>
                              </TableRow>
                            </TableBody>
                          </Table>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export default function TaxReportPage() {
  const { data: destinations = [] } = useDestinations()
  const [destinationId, setDestinationId] = useState("")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [expandedInvoices, setExpandedInvoices] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>("invoice_date")
  const [sortDir, setSortDir] = useState<SortDir>("asc")

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

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir(key === "invoice_date" ? "asc" : "desc")
    }
  }

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />
    return sortDir === "asc"
      ? <ArrowUp className="h-3 w-3 ml-1" />
      : <ArrowDown className="h-3 w-3 ml-1" />
  }

  const sortedInvoices = useMemo(() => {
    if (!report) return []
    return [...report.invoices].sort((a, b) => compareInvoices(a, b, sortKey, sortDir))
  }, [report, sortKey, sortDir])

  const exportCSV = useCallback(() => {
    if (!report) return
    const rows = buildExportRows(sortedInvoices)
    if (rows.length === 0) return

    const headers = Object.keys(rows[0])
    const csvLines = [
      headers.join(","),
      ...rows.map((row) =>
        headers.map((h) => {
          const val = row[h as keyof typeof row]
          return typeof val === "string" && val.includes(",") ? `"${val}"` : String(val)
        }).join(",")
      ),
    ]
    const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `tax-report${fromDate ? `-from-${fromDate}` : ""}${toDate ? `-to-${toDate}` : ""}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [report, sortedInvoices, fromDate, toDate])

  const exportExcel = useCallback(() => {
    if (!report) return
    if (sortedInvoices.length === 0) return

    const wb = XLSX.utils.book_new()

    // ── Sheet 1: Summary ──
    const summaryRows = sortedInvoices.map((inv) => ({
      "Invoice": `#${inv.invoice_number}`,
      "Date": inv.invoice_date,
      "Tax Rate (%)": parseFloat(inv.tax_rate),
      "Cost": parseFloat(inv.total_cost),
      "Revenue": parseFloat(inv.total_revenue),
      "Commission": parseFloat(inv.total_commission),
      "HST on Cost": parseFloat(inv.total_hst_on_cost),
      "HST on Commission": parseFloat(inv.total_hst_on_commission),
      "HST Charged": parseFloat(inv.hst_charged),
    }))
    summaryRows.push({
      "Invoice": "TOTALS",
      "Date": "",
      "Tax Rate (%)": "" as unknown as number,
      "Cost": parseFloat(report.total_cost),
      "Revenue": parseFloat(report.total_revenue),
      "Commission": parseFloat(report.total_commission),
      "HST on Cost": parseFloat(report.total_hst_on_cost),
      "HST on Commission": parseFloat(report.total_hst_on_commission),
      "HST Charged": parseFloat(report.total_hst_charged),
    })
    const wsSummary = XLSX.utils.json_to_sheet(summaryRows)
    const summaryRange = XLSX.utils.decode_range(wsSummary["!ref"] || "A1")
    for (let R = summaryRange.s.r + 1; R <= summaryRange.e.r; R++) {
      for (const C of [3, 4, 5, 6, 7, 8]) {
        const cell = wsSummary[XLSX.utils.encode_cell({ r: R, c: C })]
        if (cell) cell.z = '$#,##0.00'
      }
    }
    wsSummary["!cols"] = [
      { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 14 }, { wch: 14 }, { wch: 14 },
      { wch: 14 }, { wch: 18 }, { wch: 14 },
    ]
    XLSX.utils.book_append_sheet(wb, wsSummary, "Summary")

    // ── Sheet 2: Detail (every purchase + receipt allocation) ──
    const detailData: Record<string, string | number>[] = []

    for (const inv of sortedInvoices) {
      // Invoice header row
      detailData.push({
        "Invoice": `#${inv.invoice_number}`,
        "Date": inv.invoice_date,
        "Item": "",
        "Type": "",
        "Qty": "",
        "Sell Price": "",
        "Receipt": "",
        "Vendor": "",
        "Receipt Date": "",
        "Alloc Qty": "",
        "Unit Cost": "",
        "Alloc Total": "",
        "Commission": parseFloat(inv.total_commission),
        "HST on Cost": parseFloat(inv.total_hst_on_cost),
        "HST on Commission": parseFloat(inv.total_hst_on_commission),
        "HST Charged": parseFloat(inv.hst_charged),
      })

      for (const purchase of inv.purchases) {
        const costTiers = groupAllocationsByCost(purchase)

        if (purchase.allocations.length === 0) {
          // Purchase with no allocations
          detailData.push({
            "Invoice": "",
            "Date": "",
            "Item": purchase.item_name,
            "Type": purchase.purchase_type,
            "Qty": purchase.quantity,
            "Sell Price": parseFloat(purchase.invoice_unit_price),
            "Receipt": "",
            "Vendor": "",
            "Receipt Date": "",
            "Alloc Qty": "",
            "Unit Cost": "",
            "Alloc Total": "",
            "Commission": parseFloat(purchase.commission),
            "HST on Cost": parseFloat(purchase.hst_on_cost),
            "HST on Commission": parseFloat(purchase.hst_on_commission),
            "HST Charged": "",
          })
        } else {
          // First allocation row includes purchase info
          let firstRow = true
          for (const tier of costTiers) {
            for (const alloc of tier.allocations) {
              detailData.push({
                "Invoice": "",
                "Date": "",
                "Item": firstRow ? purchase.item_name : "",
                "Type": firstRow ? purchase.purchase_type : "",
                "Qty": firstRow ? purchase.quantity : "",
                "Sell Price": firstRow ? parseFloat(purchase.invoice_unit_price) : "",
                "Receipt": alloc.receipt_number,
                "Vendor": alloc.vendor_name,
                "Receipt Date": alloc.receipt_date,
                "Alloc Qty": alloc.allocated_qty,
                "Unit Cost": parseFloat(alloc.unit_cost),
                "Alloc Total": parseFloat(alloc.allocated_total),
                "Commission": firstRow ? parseFloat(purchase.commission) : "",
                "HST on Cost": firstRow ? parseFloat(purchase.hst_on_cost) : "",
                "HST on Commission": firstRow ? parseFloat(purchase.hst_on_commission) : "",
                "HST Charged": "",
              })
              firstRow = false
            }
          }
        }
      }

      // Blank separator row between invoices
      detailData.push({} as Record<string, string | number>)
    }

    const wsDetail = XLSX.utils.json_to_sheet(detailData)
    // Format currency columns in detail sheet
    const detailRange = XLSX.utils.decode_range(wsDetail["!ref"] || "A1")
    const detailCurrencyCols = [5, 10, 11, 12, 13, 14, 15] // Sell Price, Unit Cost, Alloc Total, Commission, HST cols
    for (let R = detailRange.s.r + 1; R <= detailRange.e.r; R++) {
      for (const C of detailCurrencyCols) {
        const cell = wsDetail[XLSX.utils.encode_cell({ r: R, c: C })]
        if (cell && typeof cell.v === "number") cell.z = '$#,##0.00'
      }
    }
    wsDetail["!cols"] = [
      { wch: 12 }, { wch: 12 }, { wch: 35 }, { wch: 8 },
      { wch: 6 }, { wch: 12 }, { wch: 28 }, { wch: 18 },
      { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 },
      { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 14 },
    ]
    XLSX.utils.book_append_sheet(wb, wsDetail, "Detail")

    XLSX.writeFile(wb, `tax-report${fromDate ? `-from-${fromDate}` : ""}${toDate ? `-to-${toDate}` : ""}.xlsx`)
  }, [report, sortedInvoices, fromDate, toDate])

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
          {/* T2125 Summary Table */}
          <T2125Summary report={report} />

          {/* Invoice Breakdown */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Breakdown by Invoice</CardTitle>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={exportCSV} title="Export to CSV">
                    <Download className="h-4 w-4 mr-1" />
                    CSV
                  </Button>
                  <Button variant="outline" size="sm" onClick={exportExcel} title="Export to Excel">
                    <Download className="h-4 w-4 mr-1" />
                    Excel
                  </Button>
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
                      <TableHead className="cursor-pointer select-none" onClick={() => handleSort("invoice_number")}>
                        <span className="inline-flex items-center">Invoice <SortIcon col="invoice_number" /></span>
                      </TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => handleSort("invoice_date")}>
                        <span className="inline-flex items-center">Date <SortIcon col="invoice_date" /></span>
                      </TableHead>
                      <TableHead className="cursor-pointer select-none" onClick={() => handleSort("tax_rate")}>
                        <span className="inline-flex items-center">Tax Rate <SortIcon col="tax_rate" /></span>
                      </TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("total_cost")}>
                        <span className="inline-flex items-center justify-end">Cost <SortIcon col="total_cost" /></span>
                      </TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("total_revenue")}>
                        <span className="inline-flex items-center justify-end">Revenue <SortIcon col="total_revenue" /></span>
                      </TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("total_commission")}>
                        <span className="inline-flex items-center justify-end">Commission <SortIcon col="total_commission" /></span>
                      </TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("total_hst_on_cost")}>
                        <span className="inline-flex items-center justify-end">HST on Cost <SortIcon col="total_hst_on_cost" /></span>
                      </TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("total_hst_on_commission")}>
                        <span className="inline-flex items-center justify-end">HST on Commission <SortIcon col="total_hst_on_commission" /></span>
                      </TableHead>
                      <TableHead className="text-right cursor-pointer select-none" onClick={() => handleSort("hst_charged")}>
                        <span className="inline-flex items-center justify-end">HST Charged <SortIcon col="hst_charged" /></span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedInvoices.map((invoice) => {
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
                            <TableCell className="text-right">{formatCurrency(invoice.hst_charged)}</TableCell>
                          </TableRow>

                          {isExpanded && (
                            <TableRow>
                              <TableCell colSpan={10} className="bg-muted/30 py-3">
                                <div className="ml-6 border-l-2 border-muted-foreground/20 pl-4 space-y-4">
                                  {invoice.purchases.map((purchase, pIdx) => {
                                    const costTiers = groupAllocationsByCost(purchase)
                                    const hasMultipleTiers = costTiers.length > 1

                                    return (
                                      <div key={pIdx} className="space-y-2">
                                        {/* Purchase header */}
                                        <div className="flex items-center gap-3 text-sm">
                                          <span className="font-medium">{purchase.item_name}</span>
                                          {purchase.purchase_type === "refund" && (
                                            <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">REFUND</span>
                                          )}
                                          <span className="text-muted-foreground">×{purchase.quantity}</span>
                                          <span className="text-muted-foreground">
                                            sell {formatCurrency(
                                              parseFloat(purchase.bonus_revenue) > 0
                                                ? ((purchase.quantity * parseFloat(purchase.invoice_unit_price) + parseFloat(purchase.bonus_revenue)) / purchase.quantity).toFixed(2)
                                                : purchase.invoice_unit_price
                                            )}
                                          </span>
                                          <span className={`ml-auto font-medium ${parseFloat(purchase.commission) < 0 ? "text-red-700" : "text-green-700"}`}>
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
                                              <Table className="table-fixed">
                                                <TableHeader>
                                                  <TableRow>
                                                    <TableHead className="w-[30%]">Receipt</TableHead>
                                                    <TableHead className="w-[20%]">Vendor</TableHead>
                                                    <TableHead className="w-[14%]">Date</TableHead>
                                                    <TableHead className="w-[8%] text-right">Qty</TableHead>
                                                    <TableHead className="w-[14%] text-right">Unit Cost</TableHead>
                                                    <TableHead className="w-[14%] text-right">Allocated Total</TableHead>
                                                  </TableRow>
                                                </TableHeader>
                                                <TableBody>
                                                  {tier.allocations.map((a, aIdx) => (
                                                    <TableRow key={aIdx}>
                                                      <TableCell className="truncate">
                                                        <Link
                                                          to={`/receipts/${a.receipt_id}`}
                                                          className="text-primary hover:underline font-mono text-xs"
                                                        >
                                                          {a.receipt_number}
                                                        </Link>
                                                      </TableCell>
                                                      <TableCell className="truncate">{a.vendor_name}</TableCell>
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
                      <TableCell className="text-right">{formatCurrency(report.total_hst_charged)}</TableCell>
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
