import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DEFAULT_EXPECTED_TAX_RATE,
  EXPECTED_TAX_RATE_STORAGE_KEY,
  getStoredExpectedTaxRate,
} from "@/lib/receiptSummary"

export default function OptionsPage() {
  const [expectedTaxRate, setExpectedTaxRate] = useState<number>(getStoredExpectedTaxRate)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Options</h1>

      <Card>
        <CardHeader>
          <CardTitle>Tax Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs space-y-2">
            <Label htmlFor="expected-tax-rate">Expected Tax Rate (%)</Label>
            <Input
              id="expected-tax-rate"
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={expectedTaxRate}
              onChange={(e) => {
                const val = parseFloat(e.target.value)
                if (!isNaN(val) && val >= 0 && val <= 100) {
                  setExpectedTaxRate(val)
                  localStorage.setItem(EXPECTED_TAX_RATE_STORAGE_KEY, String(val))
                }
              }}
            />
            <p className="text-sm text-muted-foreground">
              Receipts with an effective tax rate different from this will be flagged with an
              "Unexpected Tax Rate" warning. Default: {DEFAULT_EXPECTED_TAX_RATE}%.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
