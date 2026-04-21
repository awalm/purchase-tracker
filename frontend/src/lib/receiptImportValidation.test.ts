import { describe, expect, it } from "vitest"
import { findDuplicateMappedImportItems } from "./receiptImportValidation"

describe("findDuplicateMappedImportItems", () => {
  it("returns no duplicates when each mapped item is unique", () => {
    const duplicates = findDuplicateMappedImportItems([
      { lineNumber: 1, itemId: "item-a", itemName: "Echo Dot" },
      { lineNumber: 2, itemId: "item-b", itemName: "Echo Show" },
      { lineNumber: 3, itemId: "item-c", itemName: "Echo Pop" },
    ])

    expect(duplicates).toEqual([])
  })

  it("groups duplicate mapped item ids with all line numbers", () => {
    const duplicates = findDuplicateMappedImportItems([
      { lineNumber: 1, itemId: "item-a", itemName: "Echo Dot 5th Kids Dragon" },
      { lineNumber: 2, itemId: "item-a", itemName: "Echo Dot 5th Kids Dragon" },
      { lineNumber: 3, itemId: "item-b", itemName: "Echo Show 5 White" },
      { lineNumber: 4, itemId: "item-a", itemName: "Echo Dot 5th Kids Dragon" },
    ])

    expect(duplicates).toEqual([
      {
        itemId: "item-a",
        itemName: "Echo Dot 5th Kids Dragon",
        lineNumbers: [1, 2, 4],
      },
    ])
  })

  it("ignores empty item ids when checking duplicates", () => {
    const duplicates = findDuplicateMappedImportItems([
      { lineNumber: 1, itemId: "", itemName: "" },
      { lineNumber: 2, itemId: null, itemName: null },
      { lineNumber: 3, itemId: undefined, itemName: undefined },
      { lineNumber: 4, itemId: "item-a", itemName: "Echo Dot" },
      { lineNumber: 5, itemId: "item-a", itemName: "Echo Dot" },
    ])

    expect(duplicates).toEqual([
      {
        itemId: "item-a",
        itemName: "Echo Dot",
        lineNumbers: [4, 5],
      },
    ])
  })
})
