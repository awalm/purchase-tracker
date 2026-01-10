import { useVendorSummary, useDestinationSummary } from "@/hooks/useApi"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { formatCurrency } from "@/lib/utils"

export default function DashboardPage() {
  const { data: vendorStats = [], isLoading: loadingVendors } = useVendorSummary()
  const { data: destStats = [], isLoading: loadingDests } = useDestinationSummary()

  if (loadingVendors || loadingDests) {
    return <div className="text-muted-foreground">Loading...</div>
  }

  const totalPurchases = destStats.reduce((sum, d) => sum + (d.total_purchases || 0), 0)
  const totalQuantity = destStats.reduce((sum, d) => sum + (d.total_quantity || 0), 0)
  const totalProfit = destStats.reduce((sum, d) => sum + parseFloat(d.total_profit || "0"), 0)
  const totalSpent = vendorStats.reduce((sum, v) => sum + parseFloat(v.total_spent || "0"), 0)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Purchases
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{totalPurchases}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Quantity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{totalQuantity}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Spent
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatCurrency(totalSpent)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Profit
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-3xl font-bold ${
                totalProfit >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {formatCurrency(totalProfit)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By Destination</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Destination</TableHead>
                <TableHead className="text-right">Purchases</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Profit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {destStats.map((d) => (
                <TableRow key={d.destination_id}>
                  <TableCell>
                    {d.destination_code} - {d.destination_name}
                  </TableCell>
                  <TableCell className="text-right">{d.total_purchases || 0}</TableCell>
                  <TableCell className="text-right">{d.total_quantity || 0}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(d.total_cost)}
                  </TableCell>
                  <TableCell
                    className={`text-right ${
                      parseFloat(d.total_profit || "0") >= 0
                        ? "text-green-600"
                        : "text-red-600"
                    }`}
                  >
                    {formatCurrency(d.total_profit)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By Vendor</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead className="text-right">Purchases</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Total Spent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendorStats.map((v) => (
                <TableRow key={v.vendor_id}>
                  <TableCell>{v.vendor_name}</TableCell>
                  <TableCell className="text-right">{v.total_invoices || 0}</TableCell>
                  <TableCell className="text-right">{v.total_purchases || 0}</TableCell>
                  <TableCell className="text-right">{v.total_quantity || 0}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(v.total_spent)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
