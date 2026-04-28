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
                      ↳ {sub.description} (saves as sub-item)
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

          {manualLines.map((line) => {
            const isAdjustment = line.lineType === "adjustment"
            // For adjustments, collect item lines that can be parents
            const parentableItems = isAdjustment
              ? [
                  // Parsed lines that are mapped to items
                  ...parsedReceipt.line_items
                    .map((li, idx) => ({ li, idx }))
                    .filter(({ idx }) => !isLineDeleted(overrides.deletedLineIndexes, idx))
                    .map(({ li, idx }) => {
                      const itemId = resolveImportedItemId(autoMatchCtx, overrides, idx, li.description)
                      if (!itemId) return null
                      const itemName = items.find((it) => it.id === itemId)?.name || itemId
                      return { itemId, itemName }
                    })
                    .filter((x): x is { itemId: string; itemName: string } => x !== null),
                  // Manual item lines that are mapped
                  ...manualLines
                    .filter((ml) => ml.lineType === "item" && ml.itemId)
                    .map((ml) => ({
                      itemId: ml.itemId,
                      itemName: items.find((it) => it.id === ml.itemId)?.name || ml.itemId,
                    })),
                ]
                  // Deduplicate by itemId
                  .filter((v, i, arr) => arr.findIndex((x) => x.itemId === v.itemId) === i)
              : []

            return (
            <TableRow key={line.id} className={isAdjustment ? "bg-amber-50 dark:bg-amber-950/20" : ""}>
              <TableCell className="align-top">
                <div className="flex items-center gap-1">
                  {isAdjustment && (
                    <span className="inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900 dark:text-amber-200 shrink-0">
                      ADJ
                    </span>
                  )}
                  <Input
                    value={line.description}
                    onChange={(e) =>
                      onManualLineChange(line.id, { description: e.target.value })
                    }
                    placeholder={isAdjustment ? "e.g. Amazon $100 promo" : "Manual line description"}
                  />
                </div>
              </TableCell>
              <TableCell className="align-top">
                {isAdjustment ? (
                  <div className="space-y-1">
                    {/* Parent item selector */}
                    <Select
                      value={line.parentItemId || "__none__"}
                      onValueChange={(value) =>
                        onManualLineChange(line.id, {
                          parentItemId: value === "__none__" ? "" : value,
                          // Auto-set item to same as parent
                          itemId: value === "__none__" ? "" : value,
                        })
                      }
                    >
                      <SelectTrigger className="w-full min-w-0 h-auto min-h-9 whitespace-normal py-2 [&>span]:line-clamp-2 [&>span]:whitespace-normal [&>span]:break-all">
                        <SelectValue placeholder="Adjust which item?" />
                      </SelectTrigger>
                      <SelectContent className="max-w-[min(90vw,32rem)]">
                        <SelectItem value="__none__">Select parent line</SelectItem>
                        {parentableItems.map((pi) => (
                          <SelectItem key={pi.itemId} value={pi.itemId}>
                            <span className="block whitespace-normal break-all leading-snug line-clamp-2">
                              {truncateOptionLabel(pi.itemName, 120)}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
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
                )}
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
                  value={line.unitCost}
                  onChange={(e) =>
                    onManualLineChange(line.id, { unitCost: e.target.value })
                  }
                  placeholder={isAdjustment ? "-100.00" : ""}
                />
              </TableCell>
              <TableCell className="align-top text-center text-xs text-muted-foreground">
                <span title={isAdjustment ? "e.g. promo discount, bundle credit" : undefined}>
                  Manual
                </span>
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
            )
          })}

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
