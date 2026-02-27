#!/usr/bin/env python3
"""Parse an invoice PDF and output structured JSON.

Usage: python3 parse_invoice_pdf.py <path_to_pdf>

Outputs JSON with:
  invoice_number, invoice_date, bill_to, 
  line_items [{description, qty, unit_price, subtotal}],
  subtotal, tax_rate, tax_amount, total, notes

Line-item parsing heuristic:
  1. Only look at table rows BETWEEN the DESCRIPTION/QTY header row
     and the first "stop sentinel" row (Remarks, SUBTOTAL, Remaining Balance,
     Payment, TOTAL, Balance Due, Amount Due, Notes, Thank you).
  2. A valid line item must have:
       - A non-empty text description (not just numbers)
       - An integer qty >= 1
       - A positive unit_price
       - A positive subtotal
       - qty * unit_price ≈ subtotal  (within $0.02 per unit — rounding tolerance)
  3. Rows that are just "0.00" placeholders, or have no description,
     or fail the math check, are silently skipped.
"""
import json
import re
import sys

import pdfplumber


# Sentinel keywords that mark the END of line items.
_STOP_KEYWORDS = [
    "remaining balance",
    "subtotal",
    "remarks",
    "payment",
    "total",
    "balance due",
    "amount due",
    "notes",
    "thank you",
]


def _is_stop_row(joined: str) -> bool:
    """Return True if this row signals the end of line items."""
    lower = joined.lower()
    return any(kw in lower for kw in _STOP_KEYWORDS)


def _try_parse_line_item(cells: list) -> dict | None:
    """Try to parse a table row into a line item.

    Valid line items must have:
      - A non-empty text description
      - An integer qty >= 1
      - A positive unit_price
      - A positive subtotal
      - qty * unit_price must be close to subtotal (within $0.02 per unit)

    Returns dict or None if the row isn't a valid item.
    """
    non_empty = [c for c in cells if c]

    if len(non_empty) < 4:
        # Need at least: description, qty, unit_price, subtotal
        return None

    try:
        subtotal = float(non_empty[-1].replace(',', '').replace('$', ''))
        unit_price = float(non_empty[-2].replace(',', '').replace('$', ''))
        qty = int(non_empty[-3])
    except (ValueError, IndexError):
        return None

    desc = " ".join(non_empty[:-3]).strip()

    if not desc:
        return None
    if qty < 1:
        return None
    if unit_price <= 0 or subtotal <= 0:
        return None

    # Math sanity: qty * unit_price should ≈ subtotal
    expected = qty * unit_price
    if abs(expected - subtotal) > 0.02 * qty:
        return None

    return {
        "description": desc,
        "qty": qty,
        "unit_price": f"{unit_price:.2f}",
        "subtotal": f"{subtotal:.2f}",
    }


def parse_invoice(path: str) -> dict:
    pdf = pdfplumber.open(path)

    full_text = ""
    all_table_rows = []

    for page in pdf.pages:
        text = page.extract_text() or ""
        full_text += text + "\n"

        tables = page.extract_tables()
        for table in tables:
            all_table_rows.extend(table)

    pdf.close()

    result = {
        "invoice_number": None,
        "invoice_date": None,
        "bill_to": None,
        "line_items": [],
        "subtotal": None,
        "tax_rate": None,
        "tax_amount": None,
        "total": None,
        "notes": None,
    }

    # --- Extract invoice number ---
    m = re.search(r'INVOICE\s*#\s*(\S+)', full_text)
    if m:
        result["invoice_number"] = m.group(1)

    # --- Extract invoice date (MM/DD/YYYY) ---
    m = re.search(r'(\d{1,2}/\d{1,2}/\d{4})', full_text)
    if m:
        parts = m.group(1).split('/')
        if len(parts) == 3:
            mm, dd, yyyy = parts
            result["invoice_date"] = f"{yyyy}-{mm.zfill(2)}-{dd.zfill(2)}"

    # --- Extract BILL TO block ---
    m = re.search(r'BILL\s+TO\s*\n(.*?)(?=DESCRIPTION)', full_text, re.DOTALL)
    if m:
        result["bill_to"] = m.group(1).strip()

    # --- Extract line items from table rows ---
    # ONLY between DESCRIPTION header and first stop sentinel.
    in_items = False
    for row in all_table_rows:
        cells = [c.strip() if c else "" for c in row]
        joined = " ".join(cells).strip()

        # Detect header row — start parsing after this
        if "DESCRIPTION" in joined and "QTY" in joined:
            in_items = True
            continue

        if not in_items:
            continue

        # Stop at sentinel rows
        if _is_stop_row(joined):
            break

        # Try to parse; skip rows that don't match
        item = _try_parse_line_item(cells)
        if item:
            result["line_items"].append(item)

    # --- Extract subtotal, tax, total from text ---
    m = re.search(r'SUBTOTAL\s+(\$?[\d,]+\.?\d*)', full_text)
    if m:
        result["subtotal"] = m.group(1).replace('$', '').replace(',', '')

    m = re.search(r'(?:GST|HST|TAX)[/HST]*\s+([\d.]+)%', full_text)
    if m:
        result["tax_rate"] = m.group(1)

    m = re.search(r'TOTAL\s+TAX\s+(\$?[\d,]+\.?\d*)', full_text)
    if m:
        result["tax_amount"] = m.group(1).replace('$', '').replace(',', '')

    # Look for standalone TOTAL (not "TOTAL TAX")
    if result["tax_amount"]:
        lines = full_text.split('\n')
        for line in lines:
            line_stripped = line.strip()
            if re.match(r'^TOTAL\s', line_stripped) and 'TAX' not in line_stripped:
                nums = re.findall(r'[\d,]+\.\d{2}', line_stripped)
                if nums:
                    result["total"] = nums[-1].replace(',', '')
                    break

    if not result["total"]:
        m = re.search(r'TOTAL\s*[-–—]?\s*\$?\s*([\d,]+\.?\d*)', full_text)
        if m:
            result["total"] = m.group(1).replace(',', '')

    # Compute total from subtotal + tax if we have both but no total
    if not result["total"] and result["subtotal"] and result["tax_amount"]:
        try:
            result["total"] = f"{float(result['subtotal']) + float(result['tax_amount']):.2f}"
        except ValueError:
            pass

    # --- Extract remarks/notes ---
    m = re.search(r'Remarks\s*/?\s*Payment\s+Instructions:\s*(.*?)(?=SUBTOTAL)', full_text, re.DOTALL | re.IGNORECASE)
    if m:
        notes = m.group(1).strip()
        if notes:
            result["notes"] = notes

    return result


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: parse_invoice_pdf.py <pdf_path>"}))
        sys.exit(1)

    try:
        data = parse_invoice(sys.argv[1])
        print(json.dumps(data))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)