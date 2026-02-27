import { useState, useRef, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { Upload, CheckCircle, XCircle, AlertCircle, Download, Loader2, Eye } from "lucide-react"
import type { PreviewResult, PreviewRow } from "@/api"

interface ImportResult {
  success_count: number
  error_count: number
  duplicate_count: number
  errors: { row: number; message: string; original_data: string }[]
  failed_rows_csv: string
}

interface ImportDialogProps<T> {
  entityName: string
  columns: { name: string; required: boolean; description: string }[]
  exampleCsv: string
  onImport: (csvData: string) => Promise<ImportResult>
  onPreview: (csvData: string) => Promise<PreviewResult<T>>
  renderPreviewTable: (rows: PreviewRow<T>[]) => ReactNode
  isPending: boolean
  onSuccess?: () => void
}

type Step = "upload" | "preview" | "result"

export function ImportDialog<T>({
  entityName,
  columns,
  exampleCsv,
  onImport,
  onPreview,
  renderPreviewTable,
  isPending,
  onSuccess,
}: ImportDialogProps<T>) {
  const [isOpen, setIsOpen] = useState(false)
  const [step, setStep] = useState<Step>("upload")
  const [csvContent, setCsvContent] = useState("")
  const [fileName, setFileName] = useState("")
  const [preview, setPreview] = useState<PreviewResult<T> | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setFileName(file.name)
    setPreview(null)
    setResult(null)
    setError(null)

    const reader = new FileReader()
    reader.onload = (event) => {
      setCsvContent(event.target?.result as string)
    }
    reader.readAsText(file)
  }

  const handlePreview = async () => {
    if (!csvContent) return

    setIsLoading(true)
    setError(null)
    
    try {
      const previewResult = await onPreview(csvContent)
      setPreview(previewResult)
      setStep("preview")
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  const handleImport = async () => {
    if (!csvContent) return

    setIsLoading(true)
    setError(null)
    
    try {
      const importResult = await onImport(csvContent)
      setResult(importResult)
      setStep("result")
      if (importResult.error_count === 0 && onSuccess) {
        onSuccess()
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(errorMessage)
      setResult({
        success_count: 0,
        error_count: 1,
        duplicate_count: 0,
        errors: [{ row: 0, message: errorMessage, original_data: "" }],
        failed_rows_csv: "",
      })
      setStep("result")
    } finally {
      setIsLoading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file?.name.endsWith(".csv")) {
      setFileName(file.name)
      setPreview(null)
      setResult(null)
      setError(null)
      const reader = new FileReader()
      reader.onload = (event) => {
        setCsvContent(event.target?.result as string)
      }
      reader.readAsText(file)
    }
  }

  const resetState = () => {
    setCsvContent("")
    setFileName("")
    setPreview(null)
    setResult(null)
    setStep("upload")
    setIsLoading(false)
    setError(null)
  }

  const goBackToUpload = () => {
    setPreview(null)
    setStep("upload")
    setError(null)
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      setIsOpen(open)
      if (!open) resetState()
    }}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="h-4 w-4 mr-2" />
          Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Import {entityName}
            {step === "preview" && " - Preview"}
            {step === "result" && " - Results"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step 1: Upload */}
          {step === "upload" && (
            <>
              {/* Drop Zone */}
              <div
                className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-6 text-center cursor-pointer hover:border-muted-foreground/50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <Upload className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
                <p className="font-medium">
                  {fileName || "Drop CSV file here or click to browse"}
                </p>
              </div>

              {/* CSV Content Preview (raw) */}
              {csvContent && (
                <div className="space-y-2">
                  <Label>File Content (first 5 lines)</Label>
                  <pre className="bg-muted p-3 rounded-lg text-xs overflow-x-auto max-h-24">
                    {csvContent.split("\n").slice(0, 5).join("\n")}
                  </pre>
                  {error && (
                    <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-md text-sm">
                      <strong>Error:</strong> {error}
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button onClick={handlePreview} disabled={isLoading || isPending}>
                      {isLoading || isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Loading Preview...
                        </>
                      ) : (
                        <>
                          <Eye className="h-4 w-4 mr-2" />
                          Preview Import
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {/* Format Guide */}
              {!csvContent && (
                <div className="space-y-3 text-sm">
                  <div>
                    <h4 className="font-medium mb-1">Required Columns</h4>
                    <ul className="text-muted-foreground space-y-0.5">
                      {columns.filter(c => c.required).map(c => (
                        <li key={c.name}>
                          <code className="bg-muted px-1">{c.name}</code> - {c.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {columns.some(c => !c.required) && (
                    <div>
                      <h4 className="font-medium mb-1">Optional Columns</h4>
                      <ul className="text-muted-foreground space-y-0.5">
                        {columns.filter(c => !c.required).map(c => (
                          <li key={c.name}>
                            <code className="bg-muted px-1">{c.name}</code> - {c.description}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div>
                    <h4 className="font-medium mb-1">Example</h4>
                    <pre className="bg-muted p-2 rounded text-xs overflow-x-auto">
                      {exampleCsv}
                    </pre>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Step 2: Preview */}
          {step === "preview" && preview && (
            <>
              {/* Summary */}
              <div className="flex items-center gap-4 p-3 bg-muted rounded-lg">
                <div className="flex items-center gap-2">
                  {preview.error_count === 0 ? (
                    <CheckCircle className="h-5 w-5 text-green-600" />
                  ) : preview.valid_count > 0 ? (
                    <AlertCircle className="h-5 w-5 text-yellow-600" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-600" />
                  )}
                  <span className="font-medium">
                    {preview.valid_count} valid row{preview.valid_count !== 1 ? 's' : ''} to import
                  </span>
                </div>
                {preview.duplicate_count > 0 && (
                  <span className="text-yellow-600 text-sm">
                    {preview.duplicate_count} duplicate{preview.duplicate_count !== 1 ? 's' : ''}
                  </span>
                )}
                {preview.error_count - preview.duplicate_count > 0 && (
                  <span className="text-red-600 text-sm">
                    {preview.error_count - preview.duplicate_count} error{preview.error_count - preview.duplicate_count !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {/* Valid Rows Table */}
              {preview.valid_rows.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-green-700">✓ Will be imported ({preview.valid_count})</Label>
                  <div className="max-h-64 overflow-auto border rounded-lg">
                    {renderPreviewTable(preview.valid_rows)}
                  </div>
                </div>
              )}

              {/* Error Rows */}
              {preview.error_rows.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-red-700">✗ Will be skipped ({preview.error_count})</Label>
                  <div className="max-h-48 overflow-y-auto border rounded-lg">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-16">Row</TableHead>
                          <TableHead>Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.error_rows.slice(0, 20).map((error, idx) => (
                          <TableRow key={idx}>
                            <TableCell>{error.row}</TableCell>
                            <TableCell className="text-red-600 text-sm">{error.message}</TableCell>
                          </TableRow>
                        ))}
                        {preview.error_rows.length > 20 && (
                          <TableRow>
                            <TableCell colSpan={2} className="text-muted-foreground">
                              ...and {preview.error_rows.length - 20} more errors
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-md text-sm">
                  <strong>Error:</strong> {error}
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-between">
                <Button variant="outline" onClick={goBackToUpload}>
                  ← Back
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setIsOpen(false)}>
                    Cancel
                  </Button>
                  <Button 
                    onClick={handleImport} 
                    disabled={isLoading || isPending || preview.valid_count === 0}
                  >
                    {isLoading || isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Importing...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Accept & Import {preview.valid_count} Row{preview.valid_count !== 1 ? 's' : ''}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* Step 3: Result */}
          {step === "result" && result && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                {result.error_count === 0 ? (
                  <CheckCircle className="h-5 w-5 text-green-600" />
                ) : result.success_count > 0 ? (
                  <AlertCircle className="h-5 w-5 text-yellow-600" />
                ) : (
                  <XCircle className="h-5 w-5 text-red-600" />
                )}
                <span className="font-medium">
                  {result.success_count} imported successfully
                  {result.duplicate_count > 0 && `, ${result.duplicate_count} duplicates`}
                  {result.error_count - result.duplicate_count > 0 && `, ${result.error_count - result.duplicate_count} errors`}
                </span>
              </div>

              {result.failed_rows_csv && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const blob = new Blob([result.failed_rows_csv], { type: "text/csv" })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement("a")
                    a.href = url
                    a.download = `failed_${entityName.toLowerCase()}_import.csv`
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download Failed Rows
                </Button>
              )}

              {result.errors.length > 0 && (
                <div className="max-h-48 overflow-y-auto border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">Row</TableHead>
                        <TableHead>Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.errors.slice(0, 20).map((error, idx) => (
                        <TableRow key={idx}>
                          <TableCell>{error.row}</TableCell>
                          <TableCell className="text-red-600 text-sm">{error.message}</TableCell>
                        </TableRow>
                      ))}
                      {result.errors.length > 20 && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-muted-foreground">
                            ...and {result.errors.length - 20} more errors
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={resetState}>
                  Import Another
                </Button>
                <Button onClick={() => setIsOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
