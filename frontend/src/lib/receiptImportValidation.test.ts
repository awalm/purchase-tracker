import { describe, expect, it } from "vitest"
import {
  findDuplicateMappedImportItems,
  mergeMappedImportLines,
} from "./receiptImportValidation"

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

describe("mergeMappedImportLines", () => {
  it("separates env fee lines as sub-items instead of merging into parent unit cost", () => {
    const result = mergeMappedImportLines([
      {
        itemId: "item-ps5",
        description: "PS5 SLIM DISC",
        quantity: 2,
        unitCost: "519.99",
        notes: "PS5 SLIM DISC",
      },
      {
        itemId: "item-ps5",
        description: "Env Fee: Home AU&Rec",
        quantity: 2,
        unitCost: "3.75",
        notes: "Env Fee: Home AU&Rec",
      },
    ])

    expect(result.mergedLines).toEqual([
      {
        itemId: "item-ps5",
        quantity: 2,
        unitCost: "519.99",
        notes: "PS5 SLIM DISC",
      },
    ])
    expect(result.feeLines).toEqual([
      {
        parentItemId: "item-ps5",
        itemId: "item-ps5",
        description: "Env Fee: Home AU&Rec",
        quantity: 2,
        unitCost: 3.75,
        notes: "Env Fee: Home AU&Rec",
      },
    ])
  })

  it("sums quantity across non-fee lines mapped to the same item", () => {
    const result = mergeMappedImportLines([
      {
        itemId: "item-show",
        description: "Echo Show 5 White",
        quantity: 1,
        unitCost: "69.99",
        notes: "Echo Show 5 White",
      },
      {
        itemId: "item-show",
        description: "Echo Show 5 White",
        quantity: 1,
        unitCost: "69.99",
        notes: "Echo Show 5 White",
      },
    ])

    expect(result.mergedLines).toEqual([
      {
        itemId: "item-show",
        quantity: 2,
        unitCost: "69.99",
        notes: "Echo Show 5 White",
      },
    ])
    expect(result.feeLines).toEqual([])
  })
})
