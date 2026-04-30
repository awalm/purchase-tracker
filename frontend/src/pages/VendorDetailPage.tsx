import { useMemo, useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  useVendor,
  useVendorImportAliases,
  useCreateVendorImportAlias,
  useDeleteVendorImportAlias,
  usePurchases,
  useReceipts,
} from "@/hooks/useApi"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { ArrowLeft, Plus, Trash2 } from "lucide-react"
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils"
import { assessPurchaseReconciliation } from "@/lib/purchaseReconciliation"

type PriceHistoryRow = {
  item_id: string
  item_name: string
  purchase_count: number
  total_qty: number
  total_spend: number
  avg_unit: number
  min_unit: number
  max_unit: number
  last_unit: number
  last_purchase: string
}

function parseMoney(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? "0")
  return Number.isFinite(parsed) ? parsed : 0
}

export default function VendorDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const vendorId = id || ""

  const { data: vendor, isLoading: vendorLoading } = useVendor(vendorId)
  const { data: aliases = [], isLoading: aliasesLoading } = useVendorImportAliases(vendorId)

  useEffect(() => {
    document.title = vendor ? `${vendor.name} — BG Tracker` : "Vendor — BG Tracker"
  }, [vendor?.name])

  const { data: purchases = [], isLoading: purchasesLoading } = usePurchases({
    vendor_id: vendorId,
    limit: 1000,
  })
  const { data: allReceipts = [], isLoading: receiptsLoading } = useReceipts()

  const createAlias = useCreateVendorImportAlias(vendorId)
  const deleteAlias = useDeleteVendorImportAlias(vendorId)

  const [newAlias, setNewAlias] = useState("")

  const vendorReceipts = useMemo(
    () => allReceipts.filter((receipt) => receipt.vendor_id === vendorId),
    [allReceipts, vendorId]
  )

  const totalQuantity = purchases.reduce((sum, purchase) => sum + purchase.quantity, 0)
  const totalSpent = purchases.reduce((sum, purchase) => {
    const totalCost = parseMoney(purchase.total_cost)
    if (totalCost > 0) return sum + totalCost
    return sum + parseMoney(purchase.purchase_cost) * purchase.quantity
  }, 0)
  const totalReceiptAmount = vendorReceipts.reduce(
    (sum, receipt) => sum + parseMoney(receipt.total),
    0
  )
  const uniqueItems = new Set(purchases.map((purchase) => purchase.item_id)).size
  const avgUnit = totalQuantity > 0 ? totalSpent / totalQuantity : 0

  const priceHistory = useMemo<PriceHistoryRow[]>(() => {
    const byItem = new Map<string, PriceHistoryRow>()

    for (const purchase of purchases) {
      const unit = parseMoney(purchase.purchase_cost)
      const qty = purchase.quantity
      const spend = parseMoney(purchase.total_cost) || unit * qty
      const existing = byItem.get(purchase.item_id)

      if (!existing) {
        byItem.set(purchase.item_id, {
          item_id: purchase.item_id,
          item_name: purchase.item_name,
          purchase_count: 1,
          total_qty: qty,
          total_spend: spend,
          avg_unit: unit,
          min_unit: unit,
          max_unit: unit,
          last_unit: unit,
          last_purchase: purchase.purchase_date,
        })
        continue
      }

      existing.purchase_count += 1
      existing.total_qty += qty
      existing.total_spend += spend
      existing.min_unit = Math.min(existing.min_unit, unit)
      existing.max_unit = Math.max(existing.max_unit, unit)

      if (new Date(purchase.purchase_date).getTime() > new Date(existing.last_purchase).getTime()) {
        existing.last_purchase = purchase.purchase_date
        existing.last_unit = unit
      }
    }

    const rows = Array.from(byItem.values()).map((row) => ({
      ...row,
      avg_unit: row.total_qty > 0 ? row.total_spend / row.total_qty : 0,
    }))

    rows.sort((a, b) => b.total_spend - a.total_spend)
    return rows
  }, [purchases])

  const recentPurchases = purchases.slice(0, 30)
  const recentReceipts = [...vendorReceipts]
    .sort((a, b) => new Date(b.receipt_date).getTime() - new Date(a.receipt_date).getTime())
    .slice(0, 20)

  const handleAddAlias = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = newAlias.trim()
    if (!trimmed) return
    await createAlias.mutateAsync(trimmed)
    setNewAlias("")
  }

  const handleDeleteAlias = async (alias: { id: string; raw_alias: string }) => {
    if (!confirm(`Delete alias "${alias.raw_alias}"?`)) return
    await deleteAlias.mutateAsync(alias.id)
  }

  if (vendorLoading || purchasesLoading || receiptsLoading || aliasesLoading) {
    return <div className="text-muted-foreground">Loading...</div>
  }

  if (!vendor) {
    return <div className="text-red-600">Vendor not found</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/vendors")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{vendor.name}</h1>
          <p className="text-sm text-muted-foreground">
            Vendor drilldown for receipts, totals, and price history
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Receipts</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{vendorReceipts.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Receipt Total</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(totalReceiptAmount)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Purchases</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{purchases.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Qty</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatNumber(totalQuantity)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Avg Unit Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(avgUnit)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {uniqueItems} items, {formatCurrency(totalSpent)} total spend
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Import/OCR Aliases</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleAddAlias} className="flex flex-col gap-2 md:flex-row md:items-end">
            <div className="space-y-2 flex-1">
              <Label htmlFor="newAlias">Add Alias</Label>
              <Input
                id="newAlias"
                placeholder="e.g. Costco Wholesale #302"
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={createAlias.isPending}>
              <Plus className="h-4 w-4 mr-2" />
              Add Alias
            </Button>
          </form>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Alias</TableHead>
                <TableHead>Normalized Key</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {aliases.map((alias) => (
                <TableRow key={alias.id}>
                  <TableCell>{alias.raw_alias}</TableCell>
                  <TableCell className="font-mono text-xs">{alias.normalized_alias}</TableCell>
                  <TableCell>{formatDate(alias.updated_at)}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-red-600"
                      onClick={() => handleDeleteAlias(alias)}
                      disabled={deleteAlias.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {aliases.length === 0 && (
                <EmptyTableRow colSpan={4} message="No aliases yet for this vendor" />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Price History by Item</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Purchases</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Avg Unit</TableHead>
                <TableHead>Last Unit</TableHead>
                <TableHead>Min / Max</TableHead>
                <TableHead>Total Spend</TableHead>
                <TableHead>Last Purchase</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {priceHistory.map((row) => (
                <TableRow key={row.item_id}>
                  <TableCell>
                    <Link className="text-blue-600 hover:underline" to={`/items/${row.item_id}`}>
                      {row.item_name}
                    </Link>
                  </TableCell>
                  <TableCell>{row.purchase_count}</TableCell>
                  <TableCell>{formatNumber(row.total_qty)}</TableCell>
                  <TableCell>{formatCurrency(row.avg_unit)}</TableCell>
                  <TableCell>{formatCurrency(row.last_unit)}</TableCell>
                  <TableCell>
                    {formatCurrency(row.min_unit)} / {formatCurrency(row.max_unit)}
                  </TableCell>
                  <TableCell>{formatCurrency(row.total_spend)}</TableCell>
                  <TableCell>{formatDate(row.last_purchase)}</TableCell>
                </TableRow>
              ))}
              {priceHistory.length === 0 && (
                <EmptyTableRow colSpan={8} message="No purchase history yet for this vendor" />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Purchases</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Unit Cost</TableHead>
                <TableHead>Total Cost</TableHead>
                <TableHead>Receipt</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Reconciliation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentPurchases.map((purchase) => {
                const reconciliation = assessPurchaseReconciliation({
                  quantity: purchase.quantity,
                  purchase_cost: purchase.purchase_cost,
                  receipt_id: purchase.receipt_id,
                  invoice_id: purchase.invoice_id,
                  invoice_unit_price: purchase.invoice_unit_price,
                  destination_code: purchase.destination_code,
                  invoiceLocked: purchase.invoice_reconciliation_state === "locked",
                })

                return (
                <TableRow key={purchase.purchase_id}>
                  <TableCell>{formatDate(purchase.purchase_date)}</TableCell>
                  <TableCell>
                    <Link className="text-blue-600 hover:underline" to={`/items/${purchase.item_id}`}>
                      {purchase.item_name}
                    </Link>
                  </TableCell>
                  <TableCell>{purchase.quantity}</TableCell>
                  <TableCell>{formatCurrency(purchase.purchase_cost)}</TableCell>
                  <TableCell>
                    {formatCurrency(parseMoney(purchase.total_cost) || parseMoney(purchase.purchase_cost) * purchase.quantity)}
                  </TableCell>
                  <TableCell>
                    {purchase.receipt_id ? (
                      <Link className="text-blue-600 hover:underline" to={`/receipts/${purchase.receipt_id}`}>
                        {purchase.receipt_number || "View"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {purchase.invoice_id ? (
                      <Link className="text-blue-600 hover:underline" to={`/invoices/${purchase.invoice_id}`}>
                        {purchase.invoice_number || "View"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {reconciliation.isReconciled ? (
                      <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                        Reconciled
                      </span>
                    ) : reconciliation.isReadyToReconcile ? (
                      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                        Ready to reconcile
                      </span>
                    ) : (
                      <div className="space-y-1">
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                          Needs attention
                        </span>
                        {reconciliation.reasons.slice(0, 2).map((reason) => (
                          <div key={reason} className="text-[11px] text-amber-700">
                            {reason}
                          </div>
                        ))}
                        {reconciliation.reasons.length > 2 && (
                          <div className="text-[11px] text-muted-foreground">
                            +{reconciliation.reasons.length - 2} more
                          </div>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
                )
              })}
              {recentPurchases.length === 0 && (
                <EmptyTableRow colSpan={8} message="No purchases yet for this vendor" />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Vendor Receipts</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Purchases</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentReceipts.map((receipt) => (
                <TableRow key={receipt.id}>
                  <TableCell>
                    <Link className="text-blue-600 hover:underline" to={`/receipts/${receipt.id}`}>
                      {receipt.receipt_number}
                    </Link>
                  </TableCell>
                  <TableCell>{formatDate(receipt.receipt_date)}</TableCell>
                  <TableCell>{formatCurrency(receipt.total)}</TableCell>
                  <TableCell>{formatNumber(receipt.purchase_count || 0)}</TableCell>
                </TableRow>
              ))}
              {recentReceipts.length === 0 && (
                <EmptyTableRow colSpan={4} message="No receipts yet for this vendor" />
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
