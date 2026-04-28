import { useState, useMemo } from "react"
import { Link } from "react-router-dom"
import { useUnreconciledItems } from "@/hooks/useApi"
import { formatCurrency, formatDate } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/ui/date-input"
import { ExportCsvButton } from "@/components/ExportCsvButton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { UnreconciledReceiptItem } from "@/api"
import type { CsvColumn } from "@/lib/csv"

const csvColumns: CsvColumn<UnreconciledReceiptItem>[] = [
  { header: "Receipt #", accessor: (r) => r.receipt_number },
  { header: "Receipt Date", accessor: (r) => r.receipt_date },
  { header: "Vendor", accessor: (r) => r.vendor_name },
  { header: "Item", accessor: (r) => r.item_name },
  { header: "Line Qty", accessor: (r) => String(r.line_quantity) },
  { header: "Unit Cost", accessor: (r) => r.unit_cost },
  { header: "Line Total", accessor: (r) => r.line_total },
  { header: "Invoiced Qty", accessor: (r) => String(r.allocated_to_invoice_qty) },
  { header: "Unreconciled Qty", accessor: (r) => String(r.unreconciled_qty) },
  { header: "Unreconciled Value", accessor: (r) => r.unreconciled_value },
]

export default function UnreconciledItemsPage() {
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [vendorFilter, setVendorFilter] = useState("")

  const { data: items = [], isLoading, error } = useUnreconciledItems(
    fromDate || undefined,
    toDate || undefined,
  )

  const vendorNames = useMemo(() => {
    const names = new Set(items.map((i) => i.vendor_name))
    return [...names].sort()
  }, [items])

  const filteredItems = useMemo(() => {
    if (!vendorFilter) return items
    return items.filter((i) => i.vendor_name === vendorFilter)
  }, [items, vendorFilter])

  const totalUnreconciledQty = filteredItems.reduce((s, r) => s + r.unreconciled_qty, 0)
  const totalUnreconciledValue = filteredItems.reduce(
    (s, r) => s + parseFloat(r.unreconciled_value),
    0,
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Unreconciled Receipt Items</h1>
        <ExportCsvButton
          filename="unreconciled-items"
          columns={csvColumns}
          data={filteredItems}
          size="sm"
        />
      </div>

      <div className="flex items-end gap-4">
        <div>
          <label className="text-sm font-medium mb-1 block">From</label>
          <DateInput value={fromDate} onChange={setFromDate} className="w-44" />
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">To</label>
          <DateInput value={toDate} onChange={setToDate} className="w-44" />
        </div>
        {(fromDate || toDate) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setFromDate(""); setToDate("") }}
          >
            Clear
          </Button>
        )}
        <div>
          <label className="text-sm font-medium mb-1 block">Vendor</label>
          <Select value={vendorFilter || "all"} onValueChange={(v) => setVendorFilter(v === "all" ? "" : v)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All vendors" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All vendors</SelectItem>
              {vendorNames.map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{totalUnreconciledQty}</div>
            <p className="text-sm text-muted-foreground">Unreconciled Qty</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{formatCurrency(totalUnreconciledValue.toFixed(2))}</div>
            <p className="text-sm text-muted-foreground">Unreconciled Value</p>
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded">
          Failed to load unreconciled items.
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : filteredItems.length === 0 ? (
        <p className="text-muted-foreground">No unreconciled receipt items found.</p>
      ) : (
        <div className="border rounded-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Line Qty</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead className="text-right">Invoiced</TableHead>
                <TableHead className="text-right">Unreconciled</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((item) => (
                <TableRow key={item.receipt_line_item_id}>
                  <TableCell>
                    <Link
                      to={`/receipts/${item.receipt_id}`}
                      className="text-blue-600 hover:underline"
                    >
                      {item.receipt_number}
                    </Link>
                  </TableCell>
                  <TableCell>{formatDate(item.receipt_date)}</TableCell>
                  <TableCell>{item.vendor_name}</TableCell>
                  <TableCell>
                    <Link
                      to={`/items/${item.item_id}`}
                      className="text-blue-600 hover:underline"
                    >
                      {item.item_name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">{item.line_quantity}</TableCell>
                  <TableCell className="text-right">{formatCurrency(item.unit_cost)}</TableCell>
                  <TableCell className="text-right">{item.allocated_to_invoice_qty}</TableCell>
                  <TableCell className="text-right font-medium">{item.unreconciled_qty}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(item.unreconciled_value)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
