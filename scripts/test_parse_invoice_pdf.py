#!/usr/bin/env python3
"""Tests for parse_invoice_pdf.py

Run:  python3 -m pytest scripts/test_parse_invoice_pdf.py -v
  or: cd scripts && python3 -m pytest test_parse_invoice_pdf.py -v
"""
import os
import sys

import pytest

# Make the scripts dir importable
sys.path.insert(0, os.path.dirname(__file__))
from parse_invoice_pdf import _is_stop_row, _try_parse_line_item, parse_invoice


# ──────────────────────────────────────────────
#  _is_stop_row
# ──────────────────────────────────────────────

class TestIsStopRow:
    """Rows containing sentinel keywords must stop line-item parsing."""

    def test_remaining_balance(self):
        assert _is_stop_row("Remaining Balance $1,005.70") is True

    def test_subtotal(self):
        assert _is_stop_row("SUBTOTAL 7828.00") is True

    def test_remarks(self):
        assert _is_stop_row("Remarks / Payment Instructions:") is True

    def test_total(self):
        assert _is_stop_row("TOTAL -$ 8,845.64-") is True

    def test_total_tax(self):
        assert _is_stop_row("TOTAL TAX 1017.64") is True

    def test_payment(self):
        assert _is_stop_row("Payment Received -$7,839.94") is True

    def test_balance_due(self):
        assert _is_stop_row("Balance Due: $500.00") is True

    def test_notes(self):
        assert _is_stop_row("Notes: shipped via FedEx") is True

    def test_thank_you(self):
        assert _is_stop_row("Thank you for your business") is True

    def test_case_insensitive(self):
        assert _is_stop_row("subtotal 100") is True
        assert _is_stop_row("REMAINING BALANCE 0") is True

    def test_normal_item_not_stopped(self):
        assert _is_stop_row("Steam Deck 1 TB OLED 4 821.00 3284.00") is False

    def test_empty_string_not_stopped(self):
        assert _is_stop_row("") is False

    def test_just_numbers_not_stopped(self):
        assert _is_stop_row("0.00") is False


# ──────────────────────────────────────────────
#  _try_parse_line_item
# ──────────────────────────────────────────────

class TestTryParseLineItem:
    """Line-item parser validation and rejection tests."""

    def test_valid_item(self):
        cells = ["Steam Deck 1 TB OLED", "4", "821.00", "3284.00"]
        item = _try_parse_line_item(cells)
        assert item is not None
        assert item["description"] == "Steam Deck 1 TB OLED"
        assert item["qty"] == 4
        assert item["unit_price"] == "821.00"
        assert item["subtotal"] == "3284.00"

    def test_valid_item_with_commas(self):
        cells = ["Widget", "10", "1,200.50", "12,005.00"]
        item = _try_parse_line_item(cells)
        assert item is not None
        assert item["unit_price"] == "1200.50"
        assert item["subtotal"] == "12005.00"

    def test_valid_item_with_dollar_signs(self):
        cells = ["Gadget", "2", "$50.00", "$100.00"]
        item = _try_parse_line_item(cells)
        assert item is not None
        assert item["subtotal"] == "100.00"

    def test_rejects_zero_subtotal(self):
        """Rows with 0.00 subtotal (empty invoice lines) must be rejected."""
        cells = ["", "", "", "0.00"]
        assert _try_parse_line_item(cells) is None

    def test_rejects_only_zero(self):
        """A row that's just ['0.00'] must be rejected."""
        cells = ["0.00"]
        assert _try_parse_line_item(cells) is None

    def test_rejects_too_few_cells(self):
        cells = ["Widget", "5"]
        assert _try_parse_line_item(cells) is None

    def test_rejects_no_description(self):
        """If only 3 non-empty cells (qty, price, subtotal), no description → reject."""
        cells = ["", "4", "100.00", "400.00"]
        assert _try_parse_line_item(cells) is None

    def test_rejects_qty_zero(self):
        cells = ["Widget", "0", "100.00", "0.00"]
        assert _try_parse_line_item(cells) is None

    def test_accepts_negative_qty_refund(self):
        """Negative qty represents a refund/credit — should parse successfully."""
        cells = ["Widget", "-2", "100.00", "-200.00"]
        item = _try_parse_line_item(cells)
        assert item is not None
        assert item["qty"] == -2
        assert item["unit_price"] == "100.00"
        assert item["subtotal"] == "-200.00"

    def test_accepts_negative_qty_with_dollar_sign(self):
        """Negative subtotal with $ sign: -$200.00"""
        cells = ["Widget", "-1", "$525.00", "-$525.00"]
        item = _try_parse_line_item(cells)
        assert item is not None
        assert item["qty"] == -1
        assert item["unit_price"] == "525.00"
        assert item["subtotal"] == "-525.00"

    def test_accepts_negative_qty_trailing_minus(self):
        """Some PDFs put minus after the number: 525.00-"""
        cells = ["Widget", "-1", "525.00", "525.00-"]
        item = _try_parse_line_item(cells)
        assert item is not None
        assert item["qty"] == -1
        assert item["subtotal"] == "-525.00"

    def test_accepts_negative_qty_parenthesized(self):
        """Accounting-style negatives: (525.00)"""
        cells = ["Widget", "-1", "525.00", "(525.00)"]
        item = _try_parse_line_item(cells)
        assert item is not None
        assert item["qty"] == -1
        assert item["subtotal"] == "-525.00"

    def test_rejects_negative_price(self):
        cells = ["Widget", "2", "-50.00", "-100.00"]
        assert _try_parse_line_item(cells) is None

    def test_rejects_math_mismatch(self):
        """qty * unit_price should ≈ subtotal. If way off, reject."""
        # 3 * 100 = 300, but subtotal says 500 → reject
        cells = ["Widget", "3", "100.00", "500.00"]
        assert _try_parse_line_item(cells) is None

    def test_allows_small_rounding(self):
        """Allow tiny rounding differences (within $0.02 per unit)."""
        # 3 * 33.33 = 99.99, subtotal = 100.00 → diff = 0.01, tolerance = 0.06 → ok
        cells = ["Widget", "3", "33.33", "100.00"]
        item = _try_parse_line_item(cells)
        assert item is not None
        assert item["subtotal"] == "100.00"

    def test_rejects_non_numeric_qty(self):
        cells = ["Widget", "abc", "100.00", "300.00"]
        assert _try_parse_line_item(cells) is None

    def test_rejects_non_numeric_price(self):
        cells = ["Widget", "3", "abc", "300.00"]
        assert _try_parse_line_item(cells) is None

    def test_rejects_sentinel_looking_row(self):
        """Rows like ['Remaining Balance', '$1,005.70'] should fail naturally
        (not enough cells for description+qty+price+subtotal)."""
        cells = ["Remaining Balance", "$1,005.70"]
        assert _try_parse_line_item(cells) is None

    def test_empty_cells_list(self):
        assert _try_parse_line_item([]) is None

    def test_all_empty_strings(self):
        assert _try_parse_line_item(["", "", "", ""]) is None

    def test_multiword_description(self):
        cells = ["Xbox Series X", "–", "2TB Galaxy Black Special Edition", "2", "890.00", "1780.00"]
        item = _try_parse_line_item(cells)
        assert item is not None
        assert "Xbox" in item["description"]
        assert item["qty"] == 2


# ──────────────────────────────────────────────
#  parse_invoice (integration test with the real PDF)
# ──────────────────────────────────────────────

SAMPLE_PDF = os.path.join(
    os.path.dirname(__file__),
    "..", "references", "offline", "Invoice # 2 - Partially Paid.pdf"
)


@pytest.mark.skipif(
    not os.path.exists(SAMPLE_PDF),
    reason="Sample PDF not found"
)
class TestParseInvoicePdf:
    """Integration tests against the real sample invoice PDF."""

    @pytest.fixture(scope="class")
    def parsed(self):
        return parse_invoice(SAMPLE_PDF)

    def test_invoice_number(self, parsed):
        assert parsed["invoice_number"] == "2"

    def test_invoice_date(self, parsed):
        assert parsed["invoice_date"] == "2025-11-18"

    def test_bill_to_contains_company(self, parsed):
        assert "BSC Canada" in parsed["bill_to"]

    def test_bill_to_contains_name(self, parsed):
        assert "Abid Manji" in parsed["bill_to"]

    def test_exactly_three_line_items(self, parsed):
        """Must get exactly the 3 real items — NOT the 0.00 placeholder rows."""
        assert len(parsed["line_items"]) == 3

    def test_line_item_steam_deck_1tb(self, parsed):
        item = parsed["line_items"][0]
        assert "Steam Deck 1 TB OLED" in item["description"]
        assert item["qty"] == 4
        assert item["unit_price"] == "821.00"
        assert item["subtotal"] == "3284.00"

    def test_line_item_steam_deck_512gb(self, parsed):
        item = parsed["line_items"][1]
        assert "Steam Deck 512 GB OLED" in item["description"]
        assert item["qty"] == 4
        assert item["unit_price"] == "691.00"
        assert item["subtotal"] == "2764.00"

    def test_line_item_xbox(self, parsed):
        item = parsed["line_items"][2]
        assert "Xbox" in item["description"]
        assert item["qty"] == 2
        assert item["unit_price"] == "890.00"
        assert item["subtotal"] == "1780.00"

    def test_no_zero_items(self, parsed):
        """None of the 0.00 placeholder rows should appear."""
        for item in parsed["line_items"]:
            assert float(item["subtotal"]) > 0
            assert item["qty"] >= 1

    def test_math_correct_for_all_items(self, parsed):
        """qty * unit_price == subtotal for every item."""
        for item in parsed["line_items"]:
            expected = item["qty"] * float(item["unit_price"])
            assert abs(expected - float(item["subtotal"])) < 0.02

    def test_subtotal(self, parsed):
        assert parsed["subtotal"] == "7828.00"

    def test_tax_rate(self, parsed):
        assert parsed["tax_rate"] == "13.00"

    def test_tax_amount(self, parsed):
        assert parsed["tax_amount"] == "1017.64"

    def test_total(self, parsed):
        assert parsed["total"] == "8845.64"

    def test_total_equals_subtotal_plus_tax(self, parsed):
        expected = float(parsed["subtotal"]) + float(parsed["tax_amount"])
        assert abs(expected - float(parsed["total"])) < 0.01

    def test_line_items_sum_to_subtotal(self, parsed):
        """Sum of line item subtotals should match the invoice subtotal."""
        items_total = sum(float(item["subtotal"]) for item in parsed["line_items"])
        assert abs(items_total - float(parsed["subtotal"])) < 0.01

    def test_notes_is_none_or_empty(self, parsed):
        """The remarks section in this PDF is empty."""
        assert parsed["notes"] is None or parsed["notes"] == ""
