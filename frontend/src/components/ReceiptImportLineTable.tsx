import type { ParsedReceipt } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { EmptyTableRow } from "@/components/EmptyTableRow"
import { Trash2 } from "lucide-react"
import {
  resolveImportedDescription,
  resolveImportedItemId,
  isLineDeleted,
  type ManualImportLine,
  type ImportLineOverrides,
} from "@/lib/receiptImportHelpers"
import { truncateOptionLabel } from "@/lib/receiptImportValidation"

type AutoMatchContext = {
  vendorId: string
  items: Array<{ id: string; name: string }>
  itemIdSet: Set<string>
}

type ReceiptImportLineTableProps = {
  parsedReceipt: ParsedReceipt
  overrides: ImportLineOverrides
  manualLines: ManualImportLine[]
  items: Array<{ id: string; name: string }>
  autoMatchCtx: AutoMatchContext
  totalLineCount: number
  onDescriptionChange: (index: number, value: string, originalDescription: string) => void
  onItemChange: (index: number, value: string) => void
  onQtyChange: (index: number, value: string) => void
  onUnitCostChange: (index: number, value: string) => void
  onDeleteParsedLine: (index: number) => void
  onCreateItem: (target: { kind: "parsed"; index: number } | { kind: "manual"; lineId: string }) => void
  onManualLineChange: (lineId: string, updates: Partial<Omit<ManualImportLine, "id">>) => void
  onManualLineRemove: (lineId: string) => void
}

export function ReceiptImportLineTable({
  parsedReceipt,
  overrides,
  manualLines,
  items,
  autoMatchCtx,
  totalLineCount,
  onDescriptionChange,
  onItemChange,
  onQtyChange,
  onUnitCostChange,
  onDeleteParsedLine,
  onCreateItem,
  onManualLineChange,
  onManualLineRemove,
}: ReceiptImportLineTableProps) {
  return (
    <div className="border rounded-md overflow-hidden [&>div]:overflow-hidden">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[28%]">Description</TableHead>
            <TableHead className="w-[34%]">Map Item</TableHead>
            <TableHead className="w-[10%] text-right">Qty</TableHead>
            <TableHead className="w-[12%] text-right">Unit Cost</TableHead>
            <TableHead className="w-[8%] text-center">Confidence</TableHead>
            <TableHead className="w-[8%] text-center">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {parsedReceipt.line_items
            .map((li, idx) => ({ li, idx }))
            .filter(({ idx }) => !isLineDeleted(overrides.deletedLineIndexes, idx))
            .flatMap(({ li, idx }) => {
              const selectedItemId =
                resolveImportedItemId(autoMatchCtx, overrides, idx, li.description) || "__none__"
              const descriptionValue = resolveImportedDescription(
                overrides.lineDescriptionOverrides,
                idx,
                li.description
              )
              const qtyValue = overrides.lineQtyOverrides[idx] ?? String(li.quantity)
              const unitCostValue = overrides.lineUnitCostOverrides[idx] ?? (li.unit_cost || "")

              const parentRow = (
                <TableRow key={`${idx}-${li.description}`}>
                  <TableCell className="align-top">
                    <Input
                      value={descriptionValue}
                      onChange={(e) => onDescriptionChange(idx, e.target.value, li.description)}
                      placeholder="Line description"
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <Select
                      value={selectedItemId}
                      onValueChange={(v) => {
                        if (v === "__create__") {
                          onCreateItem({ kind: "parsed", index: idx })
                          return
                        }
                        onItemChange(idx, v)
                      }}
                    >
                      <SelectTrigger className="w-full min-w-0 h-auto min-h-9 whitespace-normal py-2 [&>span]:line-clamp-2 [&>span]:whitespace-normal [&>span]:break-all">
                        <SelectValue placeholder="Map item" />
                      </SelectTrigger>
                      <SelectContent className="max-w-[min(90vw,32rem)]">
                        <SelectItem value="__none__">Unmapped</SelectItem>
                        <SelectItem value="__create__">
                          <span className="text-blue-600">+ Create New Item</span>
                        </SelectItem>
                        {items.map((it) => (
                          <SelectItem key={it.id} value={it.id}>
                            <span className="block whitespace-normal break-all leading-snug line-clamp-2">
                              {truncateOptionLabel(it.name, 120)}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      className="text-right"
                      type="number"
                      min={1}
                      value={qtyValue}
                      onChange={(e) => onQtyChange(idx, e.target.value)}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      className="text-right"
                      type="number"
                      step="0.01"
                      min="0"
                      value={unitCostValue}
                      onChange={(e) => onUnitCostChange(idx, e.target.value)}
                    />
                  </TableCell>
                  <TableCell className="align-top text-center text-xs text-muted-foreground">
                    {li.confidence !== null ? `${Math.round(li.confidence * 100)}%` : "-"}
                  </TableCell>
                  <TableCell className="align-top text-center">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="text-red-600"
                      onClick={() => onDeleteParsedLine(idx)}
                      title="Remove parsed line"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              )

              const subRows = (li.sub_items || []).map((sub, subIdx) => {
                return (
                  <TableRow key={`${idx}-sub-${subIdx}`} className="bg-muted/30">
                    <TableCell className="align-top pl-6 text-xs text-muted-foreground italic" colSpan={2}>
                      ↳ {sub.description} (included in unit cost)
                    </TableCell>
                    <TableCell className="align-top text-right text-xs text-muted-foreground">
                      {sub.quantity}
                    </TableCell>
                    <TableCell className="align-top text-right text-xs text-muted-foreground">
                      {sub.unit_cost ?? "—"}
                    </TableCell>
                    <TableCell className="align-top text-center text-xs text-muted-foreground">
                      {sub.confidence !== null && sub.confidence !== undefined
                        ? `${Math.round(sub.confidence * 100)}%`
                        : "—"}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                )
              })

              return [parentRow, ...subRows]
            })}

          {manualLines.map((line) => (
            <TableRow key={line.id}>
              <TableCell className="align-top">
                <Input
                  value={line.description}
                  onChange={(e) =>
                    onManualLineChange(line.id, { description: e.target.value })
                  }
                  placeholder="Manual line description"
                />
              </TableCell>
              <TableCell className="align-top">
                <Select
                  value={line.itemId || "__none__"}
                  onValueChange={(value) => {
                    if (value === "__create__") {
                      onCreateItem({ kind: "manual", lineId: line.id })
                      return
                    }
                    onManualLineChange(line.id, {
                      itemId: value === "__none__" ? "" : value,
                    })
                  }}
                >
                  <SelectTrigger className="w-full min-w-0 h-auto min-h-9 whitespace-normal py-2 [&>span]:line-clamp-2 [&>span]:whitespace-normal [&>span]:break-all">
                    <SelectValue placeholder="Map item" />
                  </SelectTrigger>
                  <SelectContent className="max-w-[min(90vw,32rem)]">
                    <SelectItem value="__none__">Unmapped</SelectItem>
                    <SelectItem value="__create__">
                      <span className="text-blue-600">+ Create New Item</span>
                    </SelectItem>
                    {items.map((it) => (
                      <SelectItem key={it.id} value={it.id}>
                        <span className="block whitespace-normal break-all leading-snug line-clamp-2">
                          {truncateOptionLabel(it.name, 120)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="align-top">
                <Input
                  className="text-right"
                  type="number"
                  min={1}
                  value={line.quantity}
                  onChange={(e) =>
                    onManualLineChange(line.id, { quantity: e.target.value })
                  }
                />
              </TableCell>
              <TableCell className="align-top">
                <Input
                  className="text-right"
                  type="number"
                  step="0.01"
                  min="0"
                  value={line.unitCost}
                  onChange={(e) =>
                    onManualLineChange(line.id, { unitCost: e.target.value })
                  }
                />
              </TableCell>
              <TableCell className="align-top text-center text-xs text-muted-foreground">
                Manual
              </TableCell>
              <TableCell className="align-top text-center">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="text-red-600"
                  onClick={() => onManualLineRemove(line.id)}
                  title="Remove line"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}

          {totalLineCount === 0 && (
            <EmptyTableRow
              colSpan={6}
              message="No line items extracted yet. Add one manually or retry parsing."
            />
          )}
        </TableBody>
      </Table>
    </div>
  )
}
