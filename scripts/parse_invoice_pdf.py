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
       - A non-zero integer qty (positive for purchases, negative for refunds/credits)
       - A positive unit_price
       - A non-zero subtotal (sign matches qty)
       - abs(qty) * unit_price ≈ abs(subtotal)  (within $0.02 per unit — rounding tolerance)
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


def _expand_multiline_row(cells: list) -> list[list]:
    """Expand a table row where cells contain newlines into multiple rows.

    Some PDFs pack multiple items into a single table row using \\n within
    cells.  E.g. ['PS VR2\\nPS5 Digital', '7\\n1', '423.00\\n453.00', ...]
    becomes two separate rows.  If no cell has a newline, returns [cells].
    """
    max_lines = max((c.count('\n') + 1 for c in cells if c), default=1)
    if max_lines <= 1:
        return [cells]

    rows = []
    for i in range(max_lines):
        row = []
        for c in cells:
            parts = c.split('\n')
            row.append(parts[i].strip() if i < len(parts) else "")
        rows.append(row)
    return rows


def _try_parse_line_item(cells: list) -> dict | None:
    """Try to parse a table row into a line item.

    Valid line items must have:
      - A non-empty text description
      - A non-zero integer qty (positive for purchases, negative for refunds)
      - A non-zero unit_price (positive)
      - A non-zero subtotal (sign matches qty sign)
      - abs(qty) * unit_price must be close to abs(subtotal) (within $0.02 per unit)

    Returns dict or None if the row isn't a valid item.
    """
    non_empty = [c for c in cells if c]

    if len(non_empty) < 4:
        # Need at least: description, qty, unit_price, subtotal
        return None

    try:
        subtotal_raw = non_empty[-1].replace(',', '').replace('$', '').replace('(', '-').replace(')', '').strip()
        price_raw = non_empty[-2].replace(',', '').replace('$', '').replace('(', '-').replace(')', '').strip()
        # Strip trailing minus (some PDFs put the minus after, e.g. "525.00-")
        if subtotal_raw.endswith('-') and not subtotal_raw.startswith('-'):
            subtotal_raw = '-' + subtotal_raw[:-1]
        if price_raw.endswith('-') and not price_raw.startswith('-'):
            price_raw = '-' + price_raw[:-1]
        subtotal = float(subtotal_raw)
        unit_price = float(price_raw)
        qty = int(non_empty[-3])
    except (ValueError, IndexError):
        return None

    desc = " ".join(non_empty[:-3]).strip()

    if not desc:
        return None
    if qty == 0:
        return None
    if unit_price <= 0:
        return None

    # Math sanity: qty * unit_price should ≈ subtotal
    expected = qty * unit_price
    if abs(expected - subtotal) > 0.02 * abs(qty):
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

    # --- Extract invoice date ---
    # Try YYYY-MM-DD first, then MM/DD/YYYY
    m = re.search(r'(\d{4}-\d{2}-\d{2})', full_text)
    if m:
        result["invoice_date"] = m.group(1)
    else:
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
    # Parse between DESCRIPTION/QTY header rows and stop sentinels.
    # Supports multi-page invoices that repeat the header row.
    in_items = False
    for row in all_table_rows:
        cells = [c.strip() if c else "" for c in row]
        joined = " ".join(cells).strip()

        # Detect header row — start/resume parsing after this
        if "DESCRIPTION" in joined and "QTY" in joined:
            in_items = True
            continue

        if not in_items:
            continue

        # Stop at sentinel rows but allow resuming at next header
        if _is_stop_row(joined):
            in_items = False
            continue

        # Expand multi-line cells: some PDFs pack multiple items into
        # a single table row using newlines within cells.
        expanded_rows = _expand_multiline_row(cells)
        for exp_cells in expanded_rows:
            item = _try_parse_line_item(exp_cells)
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
        m = re.search(r'(?<!SUB)TOTAL\s*[-–—]?\s*\$?\s*([\d,]+\.?\d*)', full_text)
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