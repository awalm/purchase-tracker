import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  getCachedVendorItemId,
  rememberVendorItemMappings,
} from "./vendorItemMappingCache"

type MemoryStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  clear: () => void
}

const createMemoryStorage = (): MemoryStorage => {
  const data = new Map<string, string>()

  return {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
    clear: () => {
      data.clear()
    },
  }
}

describe("vendorItemMappingCache", () => {
  beforeEach(() => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: createMemoryStorage(),
    }
  })

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it("stores and retrieves mappings by vendor", () => {
    rememberVendorItemMappings("vendor-1", [
      { sourceText: "Echo Dot 5th Char", itemId: "item-a" },
    ])

    expect(getCachedVendorItemId("vendor-1", "Echo Dot 5th Char")).toBe("item-a")
    expect(getCachedVendorItemId("vendor-2", "Echo Dot 5th Char")).toBeNull()
  })

  it("normalizes source text for lookups", () => {
    rememberVendorItemMappings("vendor-1", [
      { sourceText: "Echo Pop Glacier Wh", itemId: "item-b" },
    ])

    expect(getCachedVendorItemId("vendor-1", "echo-pop glacier wh")).toBe("item-b")
    expect(getCachedVendorItemId("vendor-1", "Echo Pop   Glacier   Wh")).toBe("item-b")
  })

  it("updates existing normalized key with latest mapped item", () => {
    rememberVendorItemMappings("vendor-1", [
      { sourceText: "Echo Show5 3rdGen GW", itemId: "item-old" },
    ])

    rememberVendorItemMappings("vendor-1", [
      { sourceText: "Echo Show5 3rdGen GW", itemId: "item-new" },
    ])

    expect(getCachedVendorItemId("vendor-1", "Echo Show5 3rdGen GW")).toBe("item-new")
  })
})
