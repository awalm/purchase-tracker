from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ocr_service_common import (
    extract_bestbuy_receipt_number_from_metadata,
    extract_generic_line_items,
    extract_receipt_number,
    extract_receipt_number_from_texts,
    extract_structured,
)


def test_extract_receipt_number_supports_invoice_no_label() -> None:
    assert extract_receipt_number("Invoice No: 6389863470710438287") == "6389863470710438287"


def test_extract_receipt_number_prefers_invoice_over_gst_hst_registration() -> None:
    line = "GST/HST Reg No: 877845941RT0001  Invoice No: 6389863470710438287"
    assert extract_receipt_number(line) == "6389863470710438287"


def test_extract_structured_uses_invoice_no_for_receipt_number() -> None:
    parsed = extract_structured([
        {"text": "Microsoft Store", "confidence": 0.99},
        {"text": "GST/HST Reg No: 877845941RT0001", "confidence": 0.99},
        {"text": "Invoice No: 6389863470710438287", "confidence": 0.99},
    ])

    assert parsed["fixture_used"] == "generic"
    assert parsed["receipt_number"] == "6389863470710438287"


def test_extract_receipt_number_does_not_treat_refunds_word_as_reference_id() -> None:
    assert extract_receipt_number("Refunds and/or returns may be granted") is None


def test_extract_structured_reads_invoice_id_from_next_line_after_label() -> None:
    parsed = extract_structured([
        {"text": "Steam Support <noreply@steampowered.com>", "confidence": 0.99},
        {"text": "Invoice:", "confidence": 0.99},
        {"text": "429657545369864156", "confidence": 0.99},
    ])

    assert parsed["receipt_number"] == "429657545369864156"


def test_extract_structured_steam_detects_multiple_models_and_quantities() -> None:
    parsed = extract_structured([
        {"text": "Steam Support <noreply@steampowered.com>", "confidence": 0.99},
        {"text": "Date issued:", "confidence": 0.98},
        {"text": "5 Nov, 2025 @ 9:04pm EST", "confidence": 0.98},
        {"text": "Invoice:", "confidence": 0.99},
        {"text": "429657545369864156", "confidence": 0.99},
        {"text": "Steam Deck 512 GB", "confidence": 0.92},
        {"text": "Steam Deck 512", "confidence": 0.92},
        {"text": "CDN$ 689.00", "confidence": 0.95},
        {"text": "CDN$ 689.00", "confidence": 0.95},
        {"text": "Steam Deck 1 TB OLED", "confidence": 0.93},
        {"text": "Steam Deck 1 TB OLED", "confidence": 0.93},
        {"text": "CDN$ 819.00", "confidence": 0.95},
        {"text": "CDN$ 819.00", "confidence": 0.95},
        {"text": "Total:", "confidence": 0.95},
        {"text": "Import Fees:", "confidence": 0.95},
        {"text": "Subtotal:", "confidence": 0.95},
        {"text": "CDN$ 3,408.08", "confidence": 0.95},
        {"text": "CDN$ 3,016.00", "confidence": 0.95},
        {"text": "CDN$ 392.08", "confidence": 0.95},
    ])

    assert parsed["fixture_used"] == "steam"
    assert parsed["subtotal"] == "3016.00"
    assert parsed["tax"] == "392.08"
    assert parsed["total"] == "3408.08"
    assert len(parsed["line_items"]) == 2

    by_description = {
        line["description"].lower(): line for line in parsed["line_items"]
    }

    line_512 = next(
        line for desc, line in by_description.items() if "steam deck 512" in desc
    )
    line_1tb = next(
        line for desc, line in by_description.items() if "steam deck 1 tb" in desc
    )

    assert line_512["quantity"] == 2
    assert line_512["unit_cost"] == "689.00"
    assert line_512["line_total"] == "1378.00"

    assert line_1tb["quantity"] == 2
    assert line_1tb["unit_cost"] == "819.00"
    assert line_1tb["line_total"] == "1638.00"


def test_extract_bestbuy_receipt_number_from_metadata_uses_s_r_t_and_date() -> None:
    texts = [
        "BEST BUY",
        "S-977  R-57  BUS.DATE-03/25/2026",
        "T-2119",
    ]

    assert (
        extract_bestbuy_receipt_number_from_metadata(texts)
        == "S977-R57-T2119_20260325"
    )


def test_extract_receipt_number_from_texts_generates_bestbuy_id_when_missing_explicit_receipt() -> None:
    texts = [
        "BEST BUY",
        "S:977",
        "R-57 BUS.DATE-03/25/2026",
        "T-2119",
        "TOTAL 1,581.89",
    ]

    assert (
        extract_receipt_number_from_texts(texts, "Best Buy", "2026-03-25")
        == "S977-R57-T2119_20260325"
    )


def test_extract_bestbuy_receipt_number_from_metadata_keeps_explicit_r_t_labels() -> None:
    texts = [
        "BEUST",
        "S-965",
        "R-1",
        "BUS.DATE-11/17/2025",
        "T-5381",
    ]

    assert (
        extract_bestbuy_receipt_number_from_metadata(texts)
        == "S965-R1-T5381_20251117"
    )


def test_extract_bestbuy_receipt_number_from_metadata_handles_noisy_s_and_bus_date() -> None:
    texts = [
        "BEST",
        "BUY",
        "15-943110 R-3 008-B0S:DATE-19/17/20257 917",
        "T-2185",
    ]

    assert (
        extract_bestbuy_receipt_number_from_metadata(texts)
        == "S943-R3-T2185_20251117"
    )


def test_extract_structured_amazon_prefers_qty_price_item_and_reconciled_totals() -> None:
    parsed = extract_structured([
        {"text": "amazon.ca", "confidence": 0.99},
        {"text": "Invoice date / Date de facturation: 14 November 2025", "confidence": 0.99},
        {"text": "Invoice # / # de facture:", "confidence": 0.99},
        {"text": "CA53AEQIOACCUI", "confidence": 0.99},
        {"text": "Roku Streaming StickTm Plus 2025 4K and HDR", "confidence": 0.97},
        {"text": "3 $29.99", "confidence": 0.97},
        {"text": "Total payable / Total a payer", "confidence": 0.98},
        {"text": "$101.67", "confidence": 0.98},
        {"text": "Federal tax /", "confidence": 0.98},
        {"text": "$11.70", "confidence": 0.98},
        {"text": "$96.96", "confidence": 0.95},
        {"text": "(excl. tax)", "confidence": 0.95},
    ])

    assert parsed["fixture_used"] == "amazon"
    assert parsed["vendor_name"] == "Amazon"
    assert parsed["receipt_number"] == "CA53AEQIOACCUI"
    assert parsed["receipt_date"] == "2025-11-14"
    assert parsed["subtotal"] == "89.97"
    assert parsed["tax"] == "11.70"
    assert parsed["total"] == "101.67"
    assert len(parsed["line_items"]) == 1

    first = parsed["line_items"][0]
    assert "roku streaming stick" in first["description"].lower()
    assert first["quantity"] == 3
    assert first["unit_cost"] == "29.99"
    assert first["line_total"] == "89.97"


def test_extract_generic_line_items_preserves_receipt_order() -> None:
    lines = [
        {"text": "Echo Show 5 Black", "confidence": 0.82},
        {"text": "$69.99", "confidence": 0.82},
        {"text": "Echo Dot 5th Kids Dragon", "confidence": 0.98},
        {"text": "$39.99", "confidence": 0.98},
    ]

    extracted = extract_generic_line_items(lines)

    assert len(extracted) == 2
    assert extracted[0]["description"].lower() == "echo show 5 black"
    assert extracted[1]["description"].lower() == "echo dot 5th kids dragon"


def test_extract_structured_bestbuy_12_items_varied_groups_duplicates_without_cross_variant_merge() -> None:
    parsed = extract_structured([
        {"text": "UP", "confidence": 0.99},
        {"text": "BEUST", "confidence": 0.99},
        {"text": "Proof you're on the nice list.", "confidence": 0.99},
        {"text": "50 Ashtonbee Rd., Unit 2", "confidence": 0.99},
        {"text": "Scarboraugh", "confidence": 0.99},
        {"text": "S-965", "confidence": 0.99},
        {"text": "R-1", "confidence": 0.99},
        {"text": "BUS.DATE-11/17/2025", "confidence": 0.99},
        {"text": "T-5381", "confidence": 0.99},
        {"text": "Dhanya", "confidence": 0.99},
        {"text": "SALE", "confidence": 0.99},
        {"text": "Echo Shou5 3rdGen CH", "confidence": 0.99},
        {"text": "$69.99", "confidence": 0.99},
        {"text": "17186479", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Shou5 3rdGen GW", "confidence": 0.99},
        {"text": "$69.99", "confidence": 0.99},
        {"text": "17186481", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Pop Glacier Wh", "confidence": 0.99},
        {"text": "$32.99", "confidence": 0.99},
        {"text": "17103992", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Pap Glacier Wh", "confidence": 0.99},
        {"text": "$32.99", "confidence": 0.99},
        {"text": "17103992", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Dot 5th Kids FD", "confidence": 0.99},
        {"text": "$40.99", "confidence": 0.99},
        {"text": "16538036", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Dot 5th Kids FD", "confidence": 0.99},
        {"text": "$40.99", "confidence": 0.99},
        {"text": "16538036", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Pop Charcoal", "confidence": 0.99},
        {"text": "$32.99", "confidence": 0.99},
        {"text": "17103993", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Pap Charcoal", "confidence": 0.99},
        {"text": "$32.99", "confidence": 0.99},
        {"text": "17103993", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Dot 5th Kid Oul", "confidence": 0.99},
        {"text": "$40.99", "confidence": 0.99},
        {"text": "16538037", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Dot 5th Kid Oul", "confidence": 0.99},
        {"text": "$40.99", "confidence": 0.99},
        {"text": "16538037", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Dot 5th Char", "confidence": 0.99},
        {"text": "$39.99", "confidence": 0.99},
        {"text": "C", "confidence": 0.99},
        {"text": "16538040", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "Echo Dot 5th Char", "confidence": 0.99},
        {"text": "$39.99", "confidence": 0.99},
        {"text": "16538040", "confidence": 0.99},
        {"text": "H", "confidence": 0.99},
        {"text": "12 Sale iten(s)", "confidence": 0.99},
        {"text": "SUBTOTAL", "confidence": 0.99},
        {"text": "$515.88", "confidence": 0.99},
        {"text": "SALE", "confidence": 0.99},
        {"text": "TAX HST", "confidence": 0.99},
        {"text": "13.00% of $515.88", "confidence": 0.99},
        {"text": "$67.06", "confidence": 0.99},
        {"text": "TOTAL", "confidence": 0.99},
        {"text": "$582.94", "confidence": 0.99},
    ])

    assert parsed["receipt_date"] == "2025-11-17"
    assert parsed["fixture_used"] == "bestbuy"
    assert parsed["vendor_name"] == "Best Buy"
    assert parsed["receipt_number"] == "S965-R1-T5381_20251117"
    assert parsed["subtotal"] == "515.88"
    assert parsed["tax"] == "67.06"
    assert parsed["total"] == "582.94"
    assert len(parsed["line_items"]) == 7

    expected_by_desc = {
        "echo show5 3rdgen ch": (1, "69.99", "69.99"),
        "echo show5 3rdgen gw": (1, "69.99", "69.99"),
        "echo pop glacier wh": (2, "32.99", "65.98"),
        "echo dot 5th kids fd": (2, "40.99", "81.98"),
        "echo pop charcoal": (2, "32.99", "65.98"),
        "echo pop 5th kid owl": (2, "40.99", "81.98"),
        "echo dot 5th char": (2, "39.99", "79.98"),
    }

    by_desc = {line["description"].lower(): line for line in parsed["line_items"]}
    for desc, (qty, unit, total) in expected_by_desc.items():
        assert desc in by_desc, f"Expected line item '{desc}'"
        line = by_desc[desc]
        assert line["quantity"] == qty
        assert line["unit_cost"] == unit
        assert line["line_total"] == total


def test_extract_structured_bestbuy_merges_noisy_suffix_duplicate_and_counts_qty() -> None:
    parsed = extract_structured([
        {"text": "BEST BUY", "confidence": 0.99},
        {"text": "BUS.DATE-11/17/2025", "confidence": 0.99},
        {"text": "Echo Shou 8 Glacier", "confidence": 0.98},
        {"text": "$129.99", "confidence": 0.98},
        {"text": "Echo Shaw 8 Glacier", "confidence": 0.95},
        {"text": "$129.99", "confidence": 0.95},
        {"text": "Echo Dot 5th Blue aaja A99 ac", "confidence": 0.76},
        {"text": "$39.99", "confidence": 0.76},
        {"text": "Echo Dot 5th Blue", "confidence": 0.90},
        {"text": "$39.99", "confidence": 0.90},
        {"text": "SUBTOTAL", "confidence": 0.99},
        {"text": "$339.96", "confidence": 0.99},
        {"text": "TAX HST", "confidence": 0.99},
        {"text": "13.00% of $339.96", "confidence": 0.99},
        {"text": "$44.19", "confidence": 0.99},
        {"text": "TOTAL", "confidence": 0.99},
        {"text": "$384.15", "confidence": 0.99},
    ])

    assert len(parsed["line_items"]) == 2

    by_desc = {line["description"].lower(): line for line in parsed["line_items"]}
    show_line = next(
        line
        for desc, line in by_desc.items()
        if "echo sho" in desc and "8 glacier" in desc
    )
    dot_line = next(
        line
        for desc, line in by_desc.items()
        if "echo dot 5th blue" in desc
    )

    assert show_line["quantity"] == 2
    assert show_line["unit_cost"] == "129.99"
    assert show_line["line_total"] == "259.98"

    assert dot_line["quantity"] == 2
    assert dot_line["unit_cost"] == "39.99"
    assert dot_line["line_total"] == "79.98"

    descriptions = list(by_desc.keys())
    assert all("a99" not in desc and "aaja" not in desc for desc in descriptions)
    assert all(
        "subtotal" not in desc and "tax" not in desc and "total" not in desc
        for desc in descriptions
    )


def test_extract_structured_bestbuy_extracts_payment_method_from_adjacent_lines() -> None:
    parsed = extract_structured([
        {"text": "BEST", "confidence": 0.99},
        {"text": "BUY", "confidence": 0.99},
        {"text": "15-943110 R-3 008-B0S:DATE-19/17/20257 917", "confidence": 0.95},
        {"text": "T-2185", "confidence": 0.99},
        {"text": "Amex", "confidence": 0.99},
        {"text": "ACCOUNTA*******1003", "confidence": 0.99},
        {"text": "SUBTOTAL", "confidence": 0.99},
        {"text": "$339.96", "confidence": 0.99},
        {"text": "TAX HST", "confidence": 0.99},
        {"text": "$44.19", "confidence": 0.99},
        {"text": "TOTAL", "confidence": 0.99},
        {"text": "$384.15", "confidence": 0.99},
    ])

    assert parsed["vendor_name"] == "Best Buy"
    assert parsed["receipt_number"] == "S943-R3-T2185_20251117"
    assert parsed["payment_method"] == "Amex (1003)"
