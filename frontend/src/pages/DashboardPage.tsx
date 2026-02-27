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
import { ExportCsvButton } from "@/components/ExportCsvButton"
import { formatCurrency } from "@/lib/utils"

export default function DashboardPage() {
  const { data: vendorStats = [], isLoading: loadingVendors } = useVendorSummary()
  const { data: destStats = [], isLoading: loadingDests } = useDestinationSummary()

  if (loadingVendors || loadingDests) {
    return <div className="text-muted-foreground">Loading...</div>
  }

  const totalPurchases = destStats.reduce((sum, d) => sum + (d.total_purchases || 0), 0)
  const totalQuantity = destStats.reduce((sum, d) => sum + (d.total_quantity || 0), 0)
  const totalSpent = vendorStats.reduce((sum, v) => sum + parseFloat(v.total_spent || "0"), 0)
  const totalRevenue = destStats.reduce((sum, d) => sum + parseFloat(d.total_revenue || "0"), 0)
  const totalCommission = destStats.reduce((sum, d) => sum + parseFloat(d.total_commission || "0"), 0)
  const totalTaxPaid = destStats.reduce((sum, d) => sum + parseFloat(d.total_tax_paid || "0"), 0)
  const totalTaxOwed = destStats.reduce((sum, d) => sum + parseFloat(d.total_tax_owed || "0"), 0)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
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
              Total Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatCurrency(totalRevenue)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Commission
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold ${totalCommission >= 0 ? "text-green-600" : "text-red-600"}`}>{formatCurrency(totalCommission)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              HST Paid
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-600">{formatCurrency(totalTaxPaid)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              HST Owed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-amber-600">{formatCurrency(totalTaxOwed)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>By Destination</CardTitle>
          <ExportCsvButton
            filename="dashboard_destinations"
            columns={[
              { header: "Destination", accessor: (d) => `${d.destination_code} - ${d.destination_name}` },
              { header: "Invoices", accessor: (d) => d.total_invoices },
              { header: "Purchases", accessor: (d) => d.total_purchases },
              { header: "Quantity", accessor: (d) => d.total_quantity },
              { header: "Cost", accessor: (d) => d.total_cost },
              { header: "Revenue", accessor: (d) => d.total_revenue },
              { header: "Commission", accessor: (d) => d.total_commission },
              { header: "HST Paid", accessor: (d) => d.total_tax_paid },
              { header: "HST Owed", accessor: (d) => d.total_tax_owed },
            ]}
            data={destStats}
            size="sm"
            label="Export"
          />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Destination</TableHead>
                <TableHead className="text-right">Invoices</TableHead>
                <TableHead className="text-right">Purchases</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Commission</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {destStats.map((d) => (
                <TableRow key={d.destination_id}>
                  <TableCell>
                    {d.destination_code} - {d.destination_name}
                  </TableCell>
                  <TableCell className="text-right">{d.total_invoices || 0}</TableCell>
                  <TableCell className="text-right">{d.total_purchases || 0}</TableCell>
                  <TableCell className="text-right">{d.total_quantity || 0}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(d.total_cost)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(d.total_revenue)}
                  </TableCell>
                  <TableCell className={`text-right ${parseFloat(d.total_commission || "0") >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {formatCurrency(d.total_commission)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>By Vendor</CardTitle>
          <ExportCsvButton
            filename="dashboard_vendors"
            columns={[
              { header: "Vendor", accessor: (v) => v.vendor_name },
              { header: "Purchases", accessor: (v) => v.total_purchases },
              { header: "Quantity", accessor: (v) => v.total_quantity },
              { header: "Total Spent", accessor: (v) => v.total_spent },
            ]}
            data={vendorStats}
            size="sm"
            label="Export"
          />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Purchases</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Total Spent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendorStats.map((v) => (
                <TableRow key={v.vendor_id}>
                  <TableCell>{v.vendor_name}</TableCell>
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
