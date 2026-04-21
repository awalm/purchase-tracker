type VendorItemMappingEntry = {
  itemId: string
  sourceText: string
  updatedAt: string
}

type VendorItemMappingStore = Record<string, Record<string, VendorItemMappingEntry>>

type MappingCandidate = {
  sourceText: string
  itemId: string
}

const STORAGE_KEY = "bg-tracker.vendor-item-mapping-cache.v1"

const normalizeSourceText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "")

const readStore = (): VendorItemMappingStore => {
  if (typeof window === "undefined" || !window.localStorage) {
    return {}
  }

  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") {
      console.warn("[vendor-item-mapping-cache] Invalid cache payload shape")
      return {}
    }

    return parsed as VendorItemMappingStore
  } catch (error) {
    console.warn("[vendor-item-mapping-cache] Failed to parse cache payload", error)
    return {}
  }
}

const writeStore = (store: VendorItemMappingStore): void => {
  if (typeof window === "undefined" || !window.localStorage) {
    return
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (error) {
    console.warn("[vendor-item-mapping-cache] Failed to persist cache payload", error)
  }
}

export const getCachedVendorItemId = (
  vendorId: string,
  sourceText: string
): string | null => {
  const trimmedVendorId = vendorId.trim()
  const normalizedSource = normalizeSourceText(sourceText)
  if (!trimmedVendorId || !normalizedSource) {
    return null
  }

  const store = readStore()
  return store[trimmedVendorId]?.[normalizedSource]?.itemId || null
}

export const rememberVendorItemMapping = (
  vendorId: string,
  sourceText: string,
  itemId: string
): void => {
  rememberVendorItemMappings(vendorId, [{ sourceText, itemId }])
}

export const rememberVendorItemMappings = (
  vendorId: string,
  mappings: MappingCandidate[]
): void => {
  const trimmedVendorId = vendorId.trim()
  if (!trimmedVendorId || mappings.length === 0) {
    return
  }

  const store = readStore()
  const vendorStore = { ...(store[trimmedVendorId] || {}) }
  const nowIso = new Date().toISOString()

  for (const mapping of mappings) {
    const normalizedSource = normalizeSourceText(mapping.sourceText)
    const trimmedItemId = mapping.itemId.trim()

    if (!normalizedSource || !trimmedItemId) {
      continue
    }

    vendorStore[normalizedSource] = {
      itemId: trimmedItemId,
      sourceText: mapping.sourceText.trim(),
      updatedAt: nowIso,
    }
  }

  store[trimmedVendorId] = vendorStore
  writeStore(store)
}
