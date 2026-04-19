from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ocr_service_common import (
    extract_bestbuy_receipt_number_from_metadata,
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
        == "BB-S977-R57-T2119-20260325"
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
        == "BB-S977-R57-T2119-20260325"
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
