import os
import re
from difflib import SequenceMatcher
from typing import Any


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int, min_value: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(min_value, value)


def env_float(name: str, default: float, min_value: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return max(min_value, value)


def parse_money(text: str) -> str | None:
    m = re.search(r"(?<!\d)(\d{1,3}(?:[ ,]\d{3})*|\d+)\.\d{2}(?!\d)", text)
    if not m:
        return None
    return m.group(0).replace(" ", "").replace(",", "")


def parse_all_money(text: str) -> list[str]:
    values: list[str] = []

    # OCR often emits malformed thousand separators like 1.399.90.
    for m in re.finditer(r"(?<!\d)\d{1,3}\.\d{3}\.\d{2}(?!\d)", text):
        raw = m.group(0)
        values.append(raw.replace(".", "", 1))

    text_without_malformed = re.sub(r"(?<!\d)\d{1,3}\.\d{3}\.\d{2}(?!\d)", " ", text)

    for m in re.finditer(r"(?<!\d)(?:\d{1,3}(?:[ ,]\d{3})*|\d+)\.\d{2}(?!\d)", text_without_malformed):
        values.append(m.group(0).replace(" ", "").replace(",", ""))
    return values


def parse_amount_from_keyword_window(texts: list[str], keyword: str) -> str | None:
    candidate_values: list[float] = []
    for i, t in enumerate(texts):
        if keyword not in t.lower():
            continue

        if keyword in ("tax", "subtotal"):
            scan_order = [i, i - 1, i + 1, i + 2]
        else:  # total
            scan_order = [i, i + 1, i + 2, i + 3, i + 4, i + 5, i - 1]

        for idx in scan_order:
            if idx < 0 or idx >= len(texts):
                continue
            for raw in parse_all_money(texts[idx]):
                try:
                    candidate_values.append(float(raw))
                except ValueError:
                    continue

            if keyword in ("tax", "subtotal") and candidate_values:
                break

    if not candidate_values:
        return None
    if keyword == "total":
        return f"{max(candidate_values):.2f}"
    return f"{candidate_values[0]:.2f}"


def parse_date(text: str) -> str | None:
    m = re.search(r"(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})", text)
    if m:
        raw = m.group(1).replace("/", "-")
        parts = raw.split("-")
        if len(parts[0]) == 4:
            y, mo, d = parts
        else:
            mo, d, y = parts
            if len(y) == 2:
                y = f"20{y}"
        try:
            return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
        except Exception:
            pass

    month_names = {
        "jan": 1,
        "january": 1,
        "feb": 2,
        "february": 2,
        "mar": 3,
        "march": 3,
        "apr": 4,
        "april": 4,
        "may": 5,
        "jun": 6,
        "june": 6,
        "jul": 7,
        "july": 7,
        "aug": 8,
        "august": 8,
        "sep": 9,
        "sept": 9,
        "september": 9,
        "oct": 10,
        "october": 10,
        "nov": 11,
        "november": 11,
        "dec": 12,
        "december": 12,
    }

    m_named = re.search(r"\b(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})\b", text)
    if m_named:
        d_raw, mon_raw, y_raw = m_named.groups()
        mon = month_names.get(mon_raw.lower())
        if mon is not None:
            try:
                return f"{int(y_raw):04d}-{int(mon):02d}-{int(d_raw):02d}"
            except Exception:
                return None

    m_named2 = re.search(r"\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b", text)
    if m_named2:
        mon_raw, d_raw, y_raw = m_named2.groups()
        mon = month_names.get(mon_raw.lower())
        if mon is not None:
            try:
                return f"{int(y_raw):04d}-{int(mon):02d}-{int(d_raw):02d}"
            except Exception:
                return None

    return None


def extract_receipt_date_from_texts(texts: list[str]) -> str | None:
    # Prefer explicit invoice/receipt issue-date labels when present.
    for i, t in enumerate(texts):
        low = t.lower()
        if "date issued" not in low and "issued on" not in low:
            continue

        parsed = parse_date(t)
        if parsed:
            return parsed

        for j in range(i + 1, min(i + 4, len(texts))):
            parsed_next = parse_date(texts[j])
            if parsed_next:
                return parsed_next

    # Next-best: lines that look like explicit date headers.
    for i, t in enumerate(texts):
        low = t.lower().strip()
        if low.startswith("date"):
            parsed = parse_date(t)
            if parsed:
                return parsed
            if i + 1 < len(texts):
                parsed_next = parse_date(texts[i + 1])
                if parsed_next:
                    return parsed_next

    for t in texts:
        parsed = parse_date(t)
        if parsed:
            return parsed

    return None


SUMMARY_TOKENS = (
    "subtotal",
    "sub total",
    "tax",
    "hst",
    "gst",
    "pst",
    "vat",
    "total",
    "amount due",
    "balance",
    "change",
    "tender",
    "payment",
    "card",
    "account",
    "cash",
    "sale",
    "amex",
    "visa",
    "mastercard",
    "debit",
    "credit",
    "(cad)",
)


def _is_summary_line(text: str) -> bool:
    low = text.lower()
    return any(token in low for token in SUMMARY_TOKENS)


def _infer_qty(text: str) -> int | None:
    patterns = [
        r"\bqty\s*[:x]?\s*(\d{1,3})\b",
        r"\b(\d{1,3})\s*[xX]\b",
        r"\bx\s*(\d{1,3})\b",
        r"\b(\d{1,3})\s*@\s*\d",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            try:
                qty = int(m.group(1))
                if 1 <= qty <= 500:
                    return qty
            except ValueError:
                continue
    return None


def _clean_description(text: str) -> str:
    t = text
    t = re.sub(r"(?<!\d)\d{1,3}\.\d{3}\.\d{2}(?!\d)", " ", t)
    t = re.sub(r"(?<!\d)(?:\d{1,3}(?:[ ,]\d{3})*|\d+)\.\d{2}(?!\d)", " ", t)
    t = re.sub(r"\bqty\s*[:x]?\s*\d{1,3}\b", " ", t, flags=re.IGNORECASE)
    t = re.sub(r"\b\d{1,3}\s*[xX]\b", " ", t)
    t = re.sub(r"\bx\s*\d{1,3}\b", " ", t, flags=re.IGNORECASE)
    t = re.sub(r"\b\d+\s*sale\s*item\(s\)\b", " ", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+", " ", t).strip(" -:$")
    return t


def _looks_like_non_item_description(desc: str) -> bool:
    low = desc.lower().strip()
    if not low:
        return True

    bad_tokens = (
        "sale",
        "tax",
        "subtotal",
        "total",
        "amount",
        "account",
        "amex",
        "visa",
        "master",
        "(cad)",
        "cash",
        "payment",
    )
    if any(tok in low for tok in bad_tokens):
        return True

    alpha_tokens = re.findall(r"[A-Za-z]{2,}", desc)
    if len(alpha_tokens) < 2:
        return True
    return False


def _candidate_to_line_item(text: str, confidence: float) -> dict[str, Any] | None:
    if not text or _is_summary_line(text):
        return None

    money_raw = parse_all_money(text)
    if not money_raw:
        return None

    amounts: list[float] = []
    for m in money_raw:
        try:
            amounts.append(float(m))
        except ValueError:
            continue
    if not amounts:
        return None

    qty = _infer_qty(text) or 1
    line_total = amounts[-1]
    unit_cost = amounts[-2] if len(amounts) >= 2 else amounts[-1]

    if qty == 1 and len(amounts) >= 2:
        ratio = line_total / unit_cost if unit_cost > 0 else 0
        rounded = int(round(ratio)) if ratio > 0 else 0
        if 1 <= rounded <= 500 and abs(ratio - rounded) <= 0.05:
            qty = rounded

    if qty > 1 and len(amounts) == 1:
        unit_cost = line_total / qty

    if qty > 1 and abs((unit_cost * qty) - line_total) > max(0.05, line_total * 0.02):
        inferred_unit = line_total / qty
        if inferred_unit > 0:
            unit_cost = inferred_unit

    desc = _clean_description(text)
    if _looks_like_non_item_description(desc):
        return None

    if len(amounts) == 1 and qty == 1:
        # Single-money lines are noisy; keep only clearly item-like multi-token descriptions.
        if len(desc.split()) < 3:
            return None

    return {
        "description": desc,
        "quantity": qty,
        "unit_cost": f"{unit_cost:.2f}",
        "line_total": f"{line_total:.2f}",
        "confidence": confidence,
    }


def extract_generic_line_items(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def parse_tabular_rows() -> list[dict[str, Any]]:
        texts = [l["text"].strip() for l in lines]
        header_idx = -1
        for i, t in enumerate(texts):
            neighborhood = " ".join(texts[max(0, i - 4):i + 5]).lower()
            low = t.lower()
            if "qty" in low and ("item" in low or "unit price" in neighborhood):
                header_idx = i
                break
        if header_idx < 0:
            return []

        out: list[dict[str, Any]] = []
        i = header_idx + 1
        while i < len(texts):
            low = texts[i].lower()
            if "total amount" in low:
                break

            if _is_summary_line(texts[i]) or not texts[i]:
                i += 1
                continue

            desc_parts: list[str] = []
            qty: int | None = None
            j = i
            while j < len(texts) and j < i + 8:
                cur = texts[j].strip()
                if not cur:
                    j += 1
                    continue
                if re.fullmatch(r"\d+(?:\.0+)?", cur):
                    try:
                        qty = int(float(cur))
                    except ValueError:
                        qty = 1
                    j += 1
                    break
                if _is_summary_line(cur):
                    break
                desc_parts.append(cur)
                j += 1

            if qty is None or not desc_parts:
                i += 1
                continue

            amounts: list[float] = []
            k = j
            while k < len(texts) and k < j + 8:
                cur = texts[k].strip()
                if "total amount" in cur.lower():
                    break
                for m in parse_all_money(cur):
                    try:
                        amounts.append(float(m))
                    except ValueError:
                        continue
                if len(amounts) >= 2 and re.search(r"[A-Za-z]{3,}", cur):
                    break
                k += 1

            if amounts:
                unit_cost = amounts[0]
                line_total = amounts[1] if len(amounts) >= 2 else amounts[0]
                desc = _clean_description(" ".join(desc_parts))
                if not _looks_like_non_item_description(desc):
                    conf = min(
                        float(lines[x].get("confidence", 0.0))
                        for x in range(i, min(k + 1, len(lines)))
                    )
                    out.append(
                        {
                            "description": desc,
                            "quantity": max(1, qty),
                            "unit_cost": f"{unit_cost:.2f}",
                            "line_total": f"{line_total:.2f}",
                            "confidence": conf,
                        }
                    )
                i = max(i + 1, k)
                continue

            i += 1

        return out

    items: list[dict[str, Any]] = parse_tabular_rows()
    seen: set[tuple[str, str, int]] = set()

    for i, line in enumerate(lines):
        text = line["text"].strip()
        if not text:
            continue

        candidate_texts: list[tuple[str, float]] = [(text, float(line.get("confidence", 0.0)))]

        if i + 1 < len(lines):
            nxt = lines[i + 1]["text"].strip()
            if nxt and not _is_summary_line(nxt):
                combined = f"{text} {nxt}"
                combined_conf = min(
                    float(line.get("confidence", 0.0)),
                    float(lines[i + 1].get("confidence", 0.0)),
                )
                candidate_texts.append((combined, combined_conf))

        for candidate_text, conf in candidate_texts:
            item = _candidate_to_line_item(candidate_text, conf)
            if not item:
                continue

            key = (item["description"].lower(), item["line_total"], item["quantity"])
            if key in seen:
                continue
            seen.add(key)
            items.append(item)

    if not items:
        return []

    merged: list[dict[str, Any]] = []
    for item in items:
        matched = False
        for existing in merged:
            try:
                sim = SequenceMatcher(
                    None,
                    item["description"].lower(),
                    existing["description"].lower(),
                ).ratio()
                same_unit = abs(float(item["unit_cost"]) - float(existing["unit_cost"])) <= 0.01
            except (TypeError, ValueError, KeyError):
                sim = 0.0
                same_unit = False

            if sim >= 0.82 and same_unit:
                existing["quantity"] += int(item["quantity"])
                try:
                    existing["line_total"] = f"{float(existing['unit_cost']) * int(existing['quantity']):.2f}"
                except (TypeError, ValueError, KeyError):
                    pass
                existing["confidence"] = max(
                    float(existing.get("confidence", 0.0)),
                    float(item.get("confidence", 0.0)),
                )
                matched = True
                break
        if not matched:
            merged.append(item)

    merged.sort(
        key=lambda x: (x["confidence"], x["quantity"], len(x["description"])),
        reverse=True,
    )
    return merged[:20]


def extract_item_count_hint(texts: list[str]) -> int | None:
    for t in texts:
        m = re.search(r"\b(\d{1,3})\s+(?:sale\s+)?ite[mn]\(?s\)?\b", t, re.IGNORECASE)
        if not m:
            m = re.search(r"\b(\d{1,3})\s+(?:sale\s+)?items?\b", t, re.IGNORECASE)
        if m:
            try:
                value = int(m.group(1))
                if 1 <= value <= 500:
                    return value
            except ValueError:
                continue
    return None


def detect_vendor_name(texts: list[str]) -> str | None:
    joined = " ".join(texts).lower()
    if "best buy" in joined:
        return "Best Buy"
    if "amazon." in joined:
        return "Amazon"
    if "microsoft" in joined:
        return "Microsoft"
    if "steampowered.com" in joined or "steam support" in joined or "the steam team" in joined:
        return "Steam"

    skip = {
        "receipt",
        "invoice",
        "tax",
        "subtotal",
        "total",
        "account",
        "card",
        "date",
        "time",
    }
    for t in texts[:12]:
        clean = re.sub(r"[^A-Za-z0-9 &.'-]", " ", t).strip()
        if len(clean) < 4:
            continue
        low = clean.lower()
        if any(token in low for token in skip):
            continue
        if re.search(r"[A-Za-z]{3,}", clean):
            return clean[:80]
    return None


def extract_payment_method(texts: list[str]) -> str | None:
    patterns = [
        r"account\s*#?\s*[*xX\-\s]*(\d{4})(?!\d)",
        r"account\s*#?\s*[:\-\s*]*\d*(\d{4})(?!\d)",
        r"card\s*(?:ending\s*in|last\s*4)?\s*[:#\-\s*]*(\d{4})(?!\d)",
    ]

    for t in texts:
        low = t.lower()
        if not any(k in low for k in ("account", "card", "amex", "visa", "master", "mc")):
            continue
        for pat in patterns:
            m = re.search(pat, t, re.IGNORECASE)
            if m:
                return m.group(1)
    return None


def extract_receipt_number(text: str) -> str | None:
    def clean_candidate(raw: str) -> str | None:
        candidate = raw.strip()
        candidate = re.sub(r"^[#:\-\s]+", "", candidate)
        candidate = re.sub(r"[^A-Za-z0-9-]", "", candidate)
        if len(candidate) < 3:
            return None
        if not re.search(r"\d", candidate):
            return None
        return candidate

    def looks_like_tax_registration_number(value: str) -> bool:
        compact = value.upper().replace("-", "")
        if re.fullmatch(r"\d{9}RT\d{4}", compact):
            return True
        return False

    normalized = re.sub(r"[：﹕]", ":", text)

    # Explicit invoice labels are the highest-confidence source.
    invoice_patterns = [
        r"\binvoice\s*(?:no\.?|num\.?|number)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9-]{2,})\b",
        r"\binvoice\s*#\s*([A-Z0-9][A-Z0-9-]{2,})\b",
    ]
    for pat in invoice_patterns:
        for m in re.finditer(pat, normalized, re.IGNORECASE):
            cleaned = clean_candidate(m.group(1))
            if not cleaned or looks_like_tax_registration_number(cleaned):
                continue
            return cleaned

    # Fallback patterns, while filtering tax-registration references.
    fallback_patterns = [
        r"\breceipt\s*(?:no\.?|num\.?|number|#)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9-]{2,})\b",
        r"\breceipt\s*[:#\-]\s*([A-Z0-9][A-Z0-9-]{2,})\b",
        r"\bref(?:erence)?\b\s*[:#\-]\s*([A-Z0-9][A-Z0-9-]{2,})\b",
        r"#\s*([A-Z0-9][A-Z0-9-]{2,})\b",
    ]
    for pat in fallback_patterns:
        for m in re.finditer(pat, normalized, re.IGNORECASE):
            cleaned = clean_candidate(m.group(1))
            if not cleaned:
                continue

            context = normalized[max(0, m.start() - 24):m.start()].lower()
            if any(token in context for token in ("gst", "hst", "tax", "reg", "registration")):
                continue
            if looks_like_tax_registration_number(cleaned):
                continue
            return cleaned

    return None


def extract_bestbuy_receipt_number_from_metadata(
    texts: list[str],
    receipt_date: str | None = None,
) -> str | None:
    header_text = " ".join(texts[:30])
    normalized = re.sub(r"\s+", " ", header_text)

    def extract_part(patterns: list[str]) -> str | None:
        for pattern in patterns:
            m = re.search(pattern, normalized, re.IGNORECASE)
            if not m:
                continue
            value = m.group(1)
            if value:
                return value
        return None

    s_value = extract_part([
        r"\bS\s*[-:#]?\s*(\d{1,8})\b",
        r"\bS\s*[:.]\s*(\d{1,8})\b",
    ])
    r_value = extract_part([
        r"\bR\s*[-:#]?\s*(\d{1,8})\b",
        r"\bR\s*[:.]\s*(\d{1,8})\b",
    ])
    t_value = extract_part([
        r"\bT\s*[-:#]?\s*(\d{1,8})\b",
        r"\bT\s*[:.]\s*(\d{1,8})\b",
    ])

    parsed_date = receipt_date
    if not parsed_date:
        for t in texts[:30]:
            low = t.lower()
            if "bus.date" in low or "bus date" in low or "date" in low:
                parsed_date = parse_date(t)
                if parsed_date:
                    break

    if not parsed_date:
        parsed_date = extract_receipt_date_from_texts(texts)

    if not s_value or not r_value or not t_value or not parsed_date:
        return None

    date_compact = parsed_date.replace("-", "")
    return f"BB-S{s_value}-R{r_value}-T{t_value}-{date_compact}"


def extract_receipt_number_from_texts(
    texts: list[str],
    vendor_name: str | None = None,
    receipt_date: str | None = None,
) -> str | None:
    combined = " ".join(texts)
    combined_match = extract_receipt_number(combined)
    if combined_match:
        return combined_match

    for i, t in enumerate(texts):
        candidate = extract_receipt_number(t)
        if candidate:
            return candidate

        if re.search(r"\binvoice\s*(?:no\.?|num\.?|number)?\b", t, re.IGNORECASE):
            for j in range(i + 1, min(i + 13, len(texts))):
                next_line = texts[j].strip()
                m = re.search(r"\b([A-Z0-9][A-Z0-9-]{2,})\b", next_line, re.IGNORECASE)
                if m:
                    sibling_candidate = m.group(1).strip()
                    sibling_candidate = re.sub(r"[^A-Za-z0-9-]", "", sibling_candidate)
                    if not sibling_candidate or not re.search(r"\d", sibling_candidate):
                        continue
                    if not re.fullmatch(r"\d{9}RT\d{4}", sibling_candidate.upper().replace("-", "")):
                        return sibling_candidate

                m_digits = re.search(r"\b(\d{10,25})\b", next_line)
                if m_digits:
                    return m_digits.group(1)

    vendor = (vendor_name or detect_vendor_name(texts) or "").lower()
    if "best buy" in vendor:
        generated = extract_bestbuy_receipt_number_from_metadata(texts, receipt_date)
        if generated:
            return generated

    return None


def is_steam_receipt(texts: list[str]) -> bool:
    joined = " ".join(texts).lower()
    return (
        "steampowered.com" in joined
        or "steam support" in joined
        or "the steam team" in joined
    )


def is_amazon_receipt(texts: list[str]) -> bool:
    joined = " ".join(texts).lower()
    return "amazon." in joined and "invoice" in joined


def extract_steam_totals(texts: list[str]) -> tuple[str | None, str | None, str | None]:
    summary_anchor: int | None = None
    for i, t in enumerate(texts):
        low = t.lower()
        if "subtotal" in low and "cdn" not in low:
            summary_anchor = i

    if summary_anchor is None:
        return None, None, None

    region = texts[summary_anchor:min(len(texts), summary_anchor + 18)]
    amounts: list[float] = []
    for line in region:
        for raw in parse_all_money(line):
            try:
                amounts.append(float(raw))
            except ValueError:
                continue

    if not amounts:
        return None, None, None

    total_value = max(amounts)

    subtotal_value: float | None = None
    fee_value: float | None = None

    candidate_fees = sorted({round(a, 2) for a in amounts if a < total_value - 0.01})
    for c in candidate_fees:
        target_subtotal = round(total_value - c, 2)
        if any(abs(a - target_subtotal) <= 0.02 for a in amounts):
            fee_value = c
            subtotal_value = target_subtotal
            break

    if subtotal_value is None and len(amounts) >= 2:
        sorted_desc = sorted(amounts, reverse=True)
        subtotal_value = sorted_desc[1]
        delta = total_value - subtotal_value
        if delta >= 0:
            fee_value = delta

    subtotal_str = f"{subtotal_value:.2f}" if subtotal_value is not None else None
    fee_str = f"{fee_value:.2f}" if fee_value is not None else None
    total_str = f"{total_value:.2f}"
    return subtotal_str, fee_str, total_str


def _steam_model_key(text: str) -> str | None:
    normalized = re.sub(r"\s+", " ", text.lower()).strip()
    if "steam deck" not in normalized:
        return None
    if re.search(r"\b1\s*tb\b", normalized):
        return "steam_deck_1tb_oled"
    if re.search(r"\b512(?:\s*gb)?\b", normalized):
        return "steam_deck_512gb_oled"
    return None


def _steam_model_description(model_key: str) -> str:
    if model_key == "steam_deck_512gb_oled":
        return "Steam Deck 512 GB OLED"
    return "Steam Deck 1 TB OLED"


def extract_steam_line_items(texts: list[str], total_str: str | None) -> list[dict[str, Any]]:
    summary_anchor: int | None = None
    for i, t in enumerate(texts):
        if "subtotal" in t.lower() and "cdn" not in t.lower():
            summary_anchor = i

    search_end = summary_anchor if summary_anchor is not None else len(texts)
    search_start = max(0, search_end - 72)

    model_occurrences: dict[str, list[int]] = {}
    for idx in range(search_start, search_end):
        model_key = _steam_model_key(texts[idx])
        if model_key:
            model_occurrences.setdefault(model_key, []).append(idx)

    if not model_occurrences:
        return []

    excluded_values: set[float] = set()
    steam_subtotal, steam_fee, steam_total = extract_steam_totals(texts)
    for candidate in (total_str, steam_total, steam_subtotal, steam_fee):
        if not candidate:
            continue
        try:
            excluded_values.add(round(float(candidate), 2))
        except ValueError:
            continue

    money_hits: list[tuple[int, float]] = []
    for idx, line in enumerate(texts):
        for raw in parse_all_money(line):
            try:
                value = round(float(raw), 2)
            except ValueError:
                continue
            if value < 50:
                continue
            money_hits.append((idx, value))

    if not money_hits:
        return []

    window_start = max(0, search_start - 4)
    window_end = min(len(texts), search_end + 16)

    def choose_unit_price(indices: list[int]) -> float | None:
        first_idx = min(indices)
        candidate_stats: dict[float, dict[str, float]] = {}
        for money_idx, value in money_hits:
            if money_idx < window_start or money_idx >= window_end:
                continue
            if any(abs(value - blocked) <= 0.02 for blocked in excluded_values):
                continue
            min_distance = min(abs(money_idx - source_idx) for source_idx in indices)
            if min_distance > 10:
                continue

            stats = candidate_stats.setdefault(
                value,
                {
                    "count": 0.0,
                    "after_count": 0.0,
                    "distance_sum": 0.0,
                    "min_distance": 9999.0,
                },
            )
            stats["count"] += 1
            if money_idx >= first_idx:
                stats["after_count"] += 1
            stats["distance_sum"] += float(min_distance)
            if min_distance < stats["min_distance"]:
                stats["min_distance"] = float(min_distance)

        if not candidate_stats:
            return None

        def sort_key(item: tuple[float, dict[str, float]]) -> tuple[float, float, float, float, float]:
            value, stats = item
            count = stats["count"]
            after_count = stats["after_count"]
            avg_distance = stats["distance_sum"] / count if count > 0 else 9999.0
            min_distance = stats["min_distance"]
            # Prefer values seen most often, then prices appearing after model text,
            # then closer prices around that model occurrence.
            return (-count, -after_count, avg_distance, min_distance, value)

        return sorted(candidate_stats.items(), key=sort_key)[0][0]

    items: list[dict[str, Any]] = []
    ordered_keys = ["steam_deck_512gb_oled", "steam_deck_1tb_oled"]

    for model_key in ordered_keys:
        indices = model_occurrences.get(model_key)
        if not indices:
            continue

        unit_price = choose_unit_price(indices)
        if unit_price is None:
            continue

        price_occurrences = sum(
            1
            for money_idx, value in money_hits
            if window_start <= money_idx < window_end
            and abs(value - unit_price) <= 0.02
        )
        quantity = max(1, len(indices), price_occurrences)
        line_total = unit_price * quantity

        items.append(
            {
                "description": _steam_model_description(model_key),
                "quantity": quantity,
                "unit_cost": f"{unit_price:.2f}",
                "line_total": f"{line_total:.2f}",
                "confidence": 0.96,
            }
        )

    return items


def extract_amazon_line_items(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    blocked_tokens = (
        "invoice",
        "order",
        "shipment",
        "sold by",
        "billing address",
        "delivery address",
        "gst/hst",
        "for questions",
        "asin:",
        "amazon",
    )

    items: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int]] = set()

    for idx, line in enumerate(lines):
        text = line["text"].strip()
        if not text:
            continue

        qty_price = re.fullmatch(
            r"\s*(\d{1,3})\s+\$?\s*((?:\d{1,3}(?:[ ,]\d{3})*|\d+)\.\d{2})\s*",
            text,
        )
        if not qty_price:
            continue

        try:
            quantity = int(qty_price.group(1))
            unit_cost = float(qty_price.group(2).replace(",", "").replace(" ", ""))
        except ValueError:
            continue

        if quantity < 1 or quantity > 500 or unit_cost <= 0:
            continue

        description: str | None = None
        confidence = float(line.get("confidence", 0.0))

        for back in range(1, 5):
            desc_idx = idx - back
            if desc_idx < 0:
                break

            candidate = lines[desc_idx]["text"].strip()
            if not candidate:
                continue

            low = candidate.lower()
            if _is_summary_line(candidate):
                continue
            if any(token in low for token in blocked_tokens):
                continue
            if len(re.findall(r"[A-Za-z]{2,}", candidate)) < 2:
                continue

            cleaned = _clean_description(candidate)
            if _looks_like_non_item_description(cleaned):
                continue

            description = cleaned
            confidence = min(confidence, float(lines[desc_idx].get("confidence", 0.0)))
            break

        if not description:
            continue

        line_total = unit_cost * quantity
        item = {
            "description": description,
            "quantity": quantity,
            "unit_cost": f"{unit_cost:.2f}",
            "line_total": f"{line_total:.2f}",
            "confidence": confidence,
        }
        key = (item["description"].lower(), item["unit_cost"], item["quantity"])
        if key in seen:
            continue
        seen.add(key)
        items.append(item)

    items.sort(
        key=lambda x: (x["confidence"], x["quantity"], float(x["line_total"])),
        reverse=True,
    )
    return items


def _money_values_in_window(texts: list[str], start: int, end: int) -> list[float]:
    values: list[float] = []
    window_start = max(0, start)
    window_end = min(len(texts), end)
    for idx in range(window_start, window_end):
        for raw in parse_all_money(texts[idx]):
            try:
                values.append(float(raw))
            except ValueError:
                continue
    return values


def extract_amazon_totals(
    texts: list[str],
    line_items: list[dict[str, Any]] | None = None,
) -> tuple[str | None, str | None, str | None]:
    total_value: float | None = None
    subtotal_value: float | None = None
    tax_value: float | None = None

    for idx, text in enumerate(texts):
        low = text.lower()
        if "total payable" not in low and "total a payer" not in low:
            continue
        totals = [v for v in _money_values_in_window(texts, idx, idx + 5) if v > 0]
        if not totals:
            continue
        candidate_total = max(totals)
        if total_value is None or candidate_total > total_value:
            total_value = candidate_total

    tax_candidates: list[float] = []
    for idx, text in enumerate(texts):
        low = text.lower()
        if "federal tax" not in low and "taxe federale" not in low:
            continue
        nearby_values = [v for v in _money_values_in_window(texts, idx, idx + 4) if v > 0]
        if nearby_values:
            tax_candidates.append(nearby_values[0])

    if tax_candidates:
        filtered_tax = tax_candidates
        if total_value is not None:
            filtered_tax = [v for v in filtered_tax if v < total_value - 0.01]
        if filtered_tax:
            tax_value = max(filtered_tax)

    subtotal_candidates: list[float] = []
    for idx, text in enumerate(texts):
        if "excl. tax" not in text.lower():
            continue
        subtotal_candidates.extend(v for v in _money_values_in_window(texts, idx - 2, idx + 2) if v > 0)

    if subtotal_candidates:
        if total_value is not None:
            filtered_subtotal = [v for v in subtotal_candidates if v < total_value - 0.01]
            subtotal_value = max(filtered_subtotal) if filtered_subtotal else max(subtotal_candidates)
        else:
            subtotal_value = max(subtotal_candidates)

    line_items_subtotal: float | None = None
    if line_items:
        subtotal_acc = 0.0
        for item in line_items:
            try:
                value = float(item.get("line_total"))
            except (TypeError, ValueError):
                continue
            if value <= 0:
                continue
            subtotal_acc += value
        if subtotal_acc > 0:
            line_items_subtotal = round(subtotal_acc, 2)

    if line_items_subtotal is not None:
        subtotal_value = line_items_subtotal

    if subtotal_value is None and total_value is not None and tax_value is not None:
        subtotal_candidate = round(total_value - tax_value, 2)
        if subtotal_candidate >= 0:
            subtotal_value = subtotal_candidate

    if tax_value is None and total_value is not None and subtotal_value is not None:
        tax_candidate = round(total_value - subtotal_value, 2)
        if tax_candidate >= 0:
            tax_value = tax_candidate

    if total_value is None and subtotal_value is not None and tax_value is not None:
        total_value = round(subtotal_value + tax_value, 2)

    subtotal_str = f"{subtotal_value:.2f}" if subtotal_value is not None else None
    tax_str = f"{tax_value:.2f}" if tax_value is not None else None
    total_str = f"{total_value:.2f}" if total_value is not None else None
    return subtotal_str, tax_str, total_str


def extract_structured(lines: list[dict[str, Any]]) -> dict[str, Any]:
    texts = [line["text"] for line in lines]
    vendor_name = detect_vendor_name(texts)
    steam_mode = is_steam_receipt(texts)
    amazon_mode = is_amazon_receipt(texts)

    total = parse_amount_from_keyword_window(texts, "total")
    subtotal = parse_amount_from_keyword_window(texts, "subtotal")
    tax = parse_amount_from_keyword_window(texts, "tax")
    receipt_date = extract_receipt_date_from_texts(texts)
    receipt_number = extract_receipt_number_from_texts(texts, vendor_name, receipt_date)
    payment_method = extract_payment_method(texts)

    for t in texts:
        low = t.lower()
        if total is None and ("total" in low or "amount due" in low):
            total = parse_money(t)
        if subtotal is None and "subtotal" in low:
            subtotal = parse_money(t)
        if tax is None and ("tax" in low or "hst" in low or "gst" in low):
            tax = parse_money(t)
        if receipt_date is None:
            receipt_date = parse_date(t)

    if total is None:
        amounts = [parse_money(t) for t in texts]
        amounts = [a for a in amounts if a is not None]
        if amounts:
            total = amounts[-1]

    line_items = extract_generic_line_items(lines)
    item_count_hint = extract_item_count_hint(texts)

    if subtotal is None and line_items:
        subtotal_value = 0.0
        for line_item in line_items:
            try:
                subtotal_value += float(line_item["line_total"])
            except (TypeError, ValueError, KeyError):
                continue
        if subtotal_value > 0:
            subtotal = f"{subtotal_value:.2f}"

    if item_count_hint and len(line_items) == 1:
        line_item = line_items[0]
        if int(line_item.get("quantity", 1)) < item_count_hint:
            try:
                unit = float(line_item["unit_cost"])
                line_item["quantity"] = item_count_hint
                line_item["line_total"] = f"{unit * item_count_hint:.2f}"
            except (TypeError, ValueError, KeyError):
                pass

    if tax is None and subtotal is not None and total is not None:
        try:
            tax_value = float(total) - float(subtotal)
            if tax_value >= 0:
                tax = f"{tax_value:.2f}"
        except ValueError:
            pass

    if steam_mode:
        vendor_name = "Steam"
        steam_subtotal, steam_fee, steam_total = extract_steam_totals(texts)
        if steam_subtotal is not None:
            subtotal = steam_subtotal
        if steam_fee is not None:
            tax = steam_fee
        if steam_total is not None:
            total = steam_total

        steam_line_items = extract_steam_line_items(texts, total)
        if steam_line_items:
            line_items = steam_line_items

    if amazon_mode:
        vendor_name = "Amazon"
        amazon_line_items = extract_amazon_line_items(lines)
        if amazon_line_items:
            line_items = amazon_line_items

        amazon_subtotal, amazon_tax, amazon_total = extract_amazon_totals(
            texts,
            amazon_line_items,
        )
        if amazon_subtotal is not None:
            subtotal = amazon_subtotal
        if amazon_tax is not None:
            tax = amazon_tax
        if amazon_total is not None:
            total = amazon_total

    warnings: list[str] = []
    if not line_items:
        warnings.append("No confident line items extracted; user confirmation required.")
    if not total:
        warnings.append("Total could not be confidently detected.")

    return {
        "vendor_name": vendor_name,
        "receipt_number": receipt_number,
        "receipt_date": receipt_date,
        "subtotal": subtotal,
        "tax": tax,
        "total": total,
        "payment_method": payment_method,
        "line_items": line_items,
        "warnings": warnings,
        "raw_text_lines": texts,
    }


def score_structured(parsed: dict[str, Any]) -> float:
    score = 0.0
    if parsed.get("vendor_name"):
        score += 2.0
    if parsed.get("receipt_date"):
        score += 1.0
    if parsed.get("total"):
        score += 3.0
    if parsed.get("subtotal"):
        score += 1.5
    if parsed.get("tax"):
        score += 1.0
    if parsed.get("payment_method"):
        score += 1.0

    line_items = parsed.get("line_items") or []
    if line_items:
        score += 2.5 + min(len(line_items), 5) * 0.5

    warnings = parsed.get("warnings") or []
    score -= len(warnings) * 0.75
    return score


def is_low_confidence(parsed: dict[str, Any], score: float, threshold: float) -> bool:
    if score < threshold:
        return True
    if not parsed.get("total"):
        return True
    if not parsed.get("line_items"):
        return True
    return False
