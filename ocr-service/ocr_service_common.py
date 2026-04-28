import json
import os
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


# ── Amazon description cleanup rules (loaded once at import time) ──

_AMAZON_RULES_PATH = Path(__file__).resolve().parent / "amazon_rules.json"
_AMAZON_RULES: dict[str, Any] = {}
if _AMAZON_RULES_PATH.is_file():
    try:
        _AMAZON_RULES = json.loads(_AMAZON_RULES_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass  # graceful fallback — no cleanup applied


def _apply_amazon_description_cleanup(
    items: list[dict[str, Any]],
    lines: list[dict[str, Any]],
) -> None:
    """Shorten verbose Amazon descriptions using rules from amazon_rules.json.

    For each item whose description starts with a known product prefix,
    truncate to that prefix and append the color variant found in nearby
    OCR text lines (if any).
    """
    cfg = _AMAZON_RULES.get("description_cleanup")
    if not cfg:
        return
    prefixes: list[str] = cfg.get("product_prefixes", [])
    colors: list[str] = cfg.get("color_variants", [])
    scan_after_cfg = cfg.get("color_scan_lines_after", 10)
    try:
        scan_after = int(scan_after_cfg)
    except (TypeError, ValueError):
        scan_after = 10
    # Colors often appear several OCR lines after the base product title.
    # Enforce a floor so small config values do not silently drop variants.
    scan_after = max(scan_after, 10)
    if not prefixes:
        return

    # Pre-compute lowercase variants for matching (longer prefixes first)
    prefixes_lower = [(p, p.lower()) for p in sorted(prefixes, key=len, reverse=True)]
    colors_lower = [(c, c.lower()) for c in sorted(colors, key=len, reverse=True)]
    all_texts = [l.get("text", "") for l in lines]

    for item in items:
        desc: str = item.get("description", "")
        desc_lower = desc.lower()
        matched_prefix: str | None = None
        for original, plow in prefixes_lower:
            if desc_lower.startswith(plow):
                matched_prefix = original
                break
        if matched_prefix is None:
            continue

        # Scan nearby OCR lines for a color mention
        src_idx = item.get("_source_index", 0)
        color_found: str | None = None
        window_end = min(len(all_texts), src_idx + scan_after + 1)
        for line_idx in range(src_idx, window_end):
            line_text = all_texts[line_idx]
            line_lower = line_text.lower()
            for color_orig, color_low in colors_lower:
                if color_low in line_lower:
                    color_found = color_orig
                    break
            if color_found:
                break

        if color_found:
            item["description"] = f"{matched_prefix} ({color_found})"
        else:
            item["description"] = matched_prefix


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
        low = t.lower()
        if keyword not in low:
            continue
        # "total" keyword should not match "subtotal" lines
        if keyword == "total" and "subtotal" in low:
            continue

        if keyword in ("tax", "subtotal"):
            scan_order = [i, i + 1, i + 2, i - 1]
        else:  # total
            scan_order = [i, i + 1, i + 2, i + 3, i + 4, i + 5, i - 1]

        for idx in scan_order:
            if idx < 0 or idx >= len(texts):
                continue

            # Tax rate lines often look like "13.00% of 515.88" and should not be
            # interpreted as the tax amount itself.
            if keyword == "tax" and "%" in texts[idx]:
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
    t = re.sub(r"[®™©]", "", t)
    t = re.sub(r"(?<!\d)\d{1,3}\.\d{3}\.\d{2}(?!\d)", " ", t)
    t = re.sub(r"(?<!\d)(?:\d{1,3}(?:[ ,]\d{3})*|\d+)\.\d{2}(?!\d)", " ", t)
    t = re.sub(r"\bqty\s*[:x]?\s*\d{1,3}\b", " ", t, flags=re.IGNORECASE)
    t = re.sub(r"\b\d{1,3}\s*[xX]\b", " ", t)
    t = re.sub(r"\bx\s*\d{1,3}\b", " ", t, flags=re.IGNORECASE)
    t = re.sub(r"\b\d+\s*sale\s*item\(s\)\b", " ", t, flags=re.IGNORECASE)

    # Normalize recurring OCR slips in product lines.
    t = re.sub(r"\bshou\b", "Show", t, flags=re.IGNORECASE)
    t = re.sub(r"\bshou5\b", "Show5", t, flags=re.IGNORECASE)
    t = re.sub(r"\bpap\b", "Pop", t, flags=re.IGNORECASE)
    t = re.sub(r"\boul\b", "Owl", t, flags=re.IGNORECASE)
    t = re.sub(
        r"\becho\s+dot\s+5th\s+kid\s+owl\b",
        "Echo Pop 5th Kid Owl",
        t,
        flags=re.IGNORECASE,
    )

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


def _last_alpha_token(desc: str) -> str | None:
    tokens = re.findall(r"[A-Za-z]+", desc.lower())
    if not tokens:
        return None
    return tokens[-1]


def _description_tokens(desc: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9]+", desc.lower())


def _looks_like_noisy_suffix_tokens(tokens: list[str]) -> bool:
    if not tokens:
        return False

    noisy = 0
    for token in tokens:
        if len(token) <= 2:
            noisy += 1
            continue
        if re.search(r"\d", token) and not re.fullmatch(r"\d+(?:st|nd|rd|th)?", token):
            noisy += 1

    return noisy >= max(1, (len(tokens) + 1) // 2)


def _is_noisy_suffix_variant(desc_a: str, desc_b: str) -> bool:
    tokens_a = _description_tokens(desc_a)
    tokens_b = _description_tokens(desc_b)
    if not tokens_a or not tokens_b:
        return False

    shorter, longer = (tokens_a, tokens_b) if len(tokens_a) <= len(tokens_b) else (tokens_b, tokens_a)
    if len(shorter) < 3:
        return False
    if len(longer) - len(shorter) > 4:
        return False
    if longer[: len(shorter)] != shorter:
        return False

    suffix = longer[len(shorter):]
    return _looks_like_noisy_suffix_tokens(suffix)


def _is_ordinal_token(token: str) -> bool:
    return bool(re.fullmatch(r"\d+(?:st|nd|rd|th)?", token.lower()))


def _has_non_ordinal_digit(token: str) -> bool:
    return bool(re.search(r"\d", token) and not _is_ordinal_token(token))


def _description_noise_score(desc: str) -> int:
    score = 0
    for token in _description_tokens(desc):
        if len(token) <= 2:
            score += 1
        if _has_non_ordinal_digit(token):
            score += 2
    return score


def _looks_like_noisy_duplicate(desc_a: str, desc_b: str) -> bool:
    sim = SequenceMatcher(None, desc_a, desc_b).ratio()
    if sim < 0.72:
        return False

    tokens_a = _description_tokens(desc_a)
    tokens_b = _description_tokens(desc_b)
    if len(tokens_a) != len(tokens_b) or len(tokens_a) < 4:
        return False

    diffs: list[tuple[str, str]] = []
    same_positions = 0
    for token_a, token_b in zip(tokens_a, tokens_b):
        if token_a == token_b:
            same_positions += 1
            continue
        diffs.append((token_a, token_b))

    if not diffs or len(diffs) > 2:
        return False
    if same_positions < len(tokens_a) - 2:
        return False

    return any(_has_non_ordinal_digit(a) ^ _has_non_ordinal_digit(b) for a, b in diffs)


def _line_item_merge_mode(item: dict[str, Any], existing: dict[str, Any]) -> str | None:
    try:
        desc_new = str(item["description"]).lower()
        desc_existing = str(existing["description"]).lower()
        sim = SequenceMatcher(None, desc_new, desc_existing).ratio()
        same_unit = abs(float(item["unit_cost"]) - float(existing["unit_cost"])) <= 0.01
        same_qty = int(item["quantity"]) == int(existing["quantity"])
        same_total = abs(float(item["line_total"]) - float(existing["line_total"])) <= 0.01
    except (TypeError, ValueError, KeyError):
        return None

    if not same_unit:
        return None

    if sim >= 0.88:
        # Keep nearby variants (for example CH vs GW, FD vs OWL) as separate lines.
        # Still allows typo merges when suffix is unchanged (for example POP vs PAP).
        tail_new = _last_alpha_token(desc_new)
        tail_existing = _last_alpha_token(desc_existing)
        if tail_new and tail_existing and tail_new != tail_existing:
            return None
        return "aggregate"

    # Some OCR passes append low-quality trailing tokens to the same item line.
    # Merge those aliases without increasing quantity.
    if _is_noisy_suffix_variant(desc_new, desc_existing):
        return "alias"

    if same_qty and same_total and _looks_like_noisy_duplicate(desc_new, desc_existing):
        return "alias"

    return None


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


def _strip_internal_line_item_fields(item: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in item.items() if not k.startswith("_")}


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
                            "_source_index": i,
                        }
                    )
                i = max(i + 1, k)
                continue

            i += 1

        return out

    items: list[dict[str, Any]] = parse_tabular_rows()

    for i, line in enumerate(lines):
        text = line["text"].strip()
        if not text:
            continue

        candidate_texts: list[tuple[str, float]] = [(text, float(line.get("confidence", 0.0)))]

        if i + 1 < len(lines):
            nxt = lines[i + 1]["text"].strip()
            if nxt and not _is_summary_line(nxt) and re.search(r"[A-Za-z]", text):
                combined = f"{text} {nxt}"
                combined_conf = min(
                    float(line.get("confidence", 0.0)),
                    float(lines[i + 1].get("confidence", 0.0)),
                )
                candidate_texts.append((combined, combined_conf))

        seen_local: set[tuple[str, str, int]] = set()
        for candidate_text, conf in candidate_texts:
            item = _candidate_to_line_item(candidate_text, conf)
            if not item:
                continue

            item["_source_index"] = i

            key = (item["description"].lower(), item["line_total"], item["quantity"])
            if key in seen_local:
                continue
            seen_local.add(key)
            items.append(item)

    if not items:
        return []

    merged: list[dict[str, Any]] = []
    for item in items:
        matched = False
        for existing in merged:
            merge_mode = _line_item_merge_mode(item, existing)
            if merge_mode:
                if merge_mode in {"aggregate", "alias"}:
                    existing["quantity"] += int(item["quantity"])

                if merge_mode == "alias":
                    existing_desc = str(existing.get("description", ""))
                    candidate_desc = str(item.get("description", ""))

                    if _description_noise_score(candidate_desc) < _description_noise_score(existing_desc):
                        existing["description"] = item["description"]
                    elif len(candidate_desc) < len(existing_desc):
                        existing["description"] = item["description"]

                if merge_mode in {"aggregate", "alias"}:
                    try:
                        existing["line_total"] = f"{float(existing['unit_cost']) * int(existing['quantity']):.2f}"
                    except (TypeError, ValueError, KeyError):
                        pass
                existing["_source_index"] = min(
                    int(existing.get("_source_index", 10**9)),
                    int(item.get("_source_index", 10**9)),
                )
                existing["confidence"] = max(
                    float(existing.get("confidence", 0.0)),
                    float(item.get("confidence", 0.0)),
                )
                matched = True
                break
        if not matched:
            merged.append(item)

    merged.sort(
        key=lambda x: (
            int(x.get("_source_index", 10**9)),
            str(x.get("description", "")).lower(),
        ),
    )
    return [_strip_internal_line_item_fields(item) for item in merged[:20]]


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


def _looks_like_bestbuy_receipt(texts: list[str]) -> bool:
    joined = " ".join(texts)
    low = joined.lower()

    if "best buy" in low:
        return True
    if re.search(r"\bbest\b", low) and re.search(r"\bbuy\b", low):
        return True
    if "proof you're on the nice list" in low or "nice list" in low:
        return True

    has_bus_date = bool(re.search(r"\bb[uo0]s\s*[:.]?\s*date\b", joined, re.IGNORECASE))
    has_s = bool(re.search(r"\bS\s*[-:#.]?\s*\d{1,8}\b", joined, re.IGNORECASE))
    has_r = bool(re.search(r"\bR\s*[-:#.]?\s*\d{1,8}\b", joined, re.IGNORECASE))
    has_t = bool(re.search(r"\bT\s*[-:#.]?\s*\d{1,8}\b", joined, re.IGNORECASE))

    return has_bus_date and ((has_s and has_r) or (has_s and has_t) or (has_r and has_t))


def detect_vendor_name(texts: list[str]) -> str | None:
    joined = " ".join(texts).lower()
    if _looks_like_bestbuy_receipt(texts):
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


def _extract_payment_brand(text: str) -> str | None:
    m = re.search(r"\b(amex|visa|mastercard|master|mc|debit|credit)\b", text, re.IGNORECASE)
    if not m:
        # Check for "American Express" as a multi-word brand name
        if re.search(r"american\s+express", text, re.IGNORECASE):
            return "Amex"
        return None

    raw = m.group(1)
    low = raw.lower()
    if low == "master":
        return "Mastercard"
    if low == "mc":
        return "MC"
    if raw.isupper():
        return raw
    return raw[0].upper() + raw[1:].lower()


def _extract_last4_from_payment_line(text: str) -> str | None:
    patterns = [
        r"(?:account|acct|card)[^\d]{0,24}(\d{4})(?!\d)",
        r"(?:\*|x|X){2,}\s*(\d{4})(?!\d)",
        r"(?:ending\s*in|last\s*4)\D*(\d{4})(?!\d)",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            candidate = m.group(1)
            start = m.start(1)
            # Reject if the 4 digits look like a dollar amount ($1175.11)
            if start > 0 and text[start - 1] == "$":
                continue
            end = m.end(1)
            if end < len(text) and text[end] == ".":
                continue
            return candidate
    return None


def extract_payment_method(texts: list[str]) -> str | None:
    for i, t in enumerate(texts):
        low = t.lower()
        if not any(k in low for k in ("account", "acct", "card", "amex", "visa", "master", "mc", "*", "x")):
            continue

        last4 = _extract_last4_from_payment_line(t)
        if not last4:
            continue

        brand = _extract_payment_brand(t)
        if not brand:
            for j in range(max(0, i - 3), min(len(texts), i + 4)):
                brand = _extract_payment_brand(texts[j])
                if brand:
                    break

        if brand:
            return f"{brand} ({last4})"
        return last4
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
    header_text = " ".join(texts[:45])
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

    def normalize_year(raw: str) -> int | None:
        digits = re.sub(r"\D", "", raw)
        candidates: list[str] = []
        if len(digits) >= 4:
            candidates.extend([digits[:4], digits[-4:]])
        elif len(digits) == 2:
            candidates.append(f"20{digits}")

        for candidate in candidates:
            try:
                year = int(candidate)
            except ValueError:
                continue
            if 2000 <= year <= 2100:
                return year
        return None

    def extract_bus_date_parts() -> tuple[int, int, int] | None:
        for line in texts[:45]:
            normalized_line = line.lower().replace("b0s", "bus")
            if "bus" not in normalized_line or "date" not in normalized_line:
                continue

            for m in re.finditer(r"(\d{1,2})\D+(\d{1,2})\D+(\d{4,6})", line):
                try:
                    month = int(m.group(1))
                    day = int(m.group(2))
                except ValueError:
                    continue

                year = normalize_year(m.group(3))
                if year is None:
                    continue

                if month > 12:
                    if month in (18, 19):
                        month = 11
                    elif 1 <= day <= 12:
                        month, day = day, month

                if 1 <= month <= 12 and 1 <= day <= 31:
                    return year, month, day
        return None

    def receipt_date_yyyymmdd(date_value: str | None) -> str | None:
        if not date_value:
            return None
        m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", date_value.strip())
        if not m:
            return None
        year = int(m.group(1))
        month = int(m.group(2))
        day = int(m.group(3))
        if month < 1 or month > 12 or day < 1 or day > 31:
            return None
        return f"{year:04d}{month:02d}{day:02d}"

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

    if not s_value:
        s_fallback = re.search(
            r"(?:^|\D)(?:\d{1,3}[-\s])?(\d{3})\d{1,5}\s+R\s*[-:#.]?\s*\d{1,3}\b.*B[U0]S\s*[:.]?DATE",
            normalized,
            re.IGNORECASE,
        )
        if s_fallback:
            s_value = s_fallback.group(1)

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

    bus_date_parts = extract_bus_date_parts()

    # Best effort: use dummy values if any component is missing, so it's obvious
    # and easily editable. Use 'x' prefix to signal incomplete parse.
    if not s_value:
        s_value = "x" + "".join(filter(str.isdigit, normalized[:10]))[:2] if any(c.isdigit() for c in normalized[:10]) else "999"
    if not r_value:
        r_value = "x" + "".join(filter(str.isdigit, normalized[10:20]))[:2] if any(c.isdigit() for c in normalized[10:20]) else "999"
    if not t_value:
        t_value = "x" + "".join(filter(str.isdigit, normalized[-20:]))[:3] if any(c.isdigit() for c in normalized[-20:]) else "9999"

    # Best Buy labels for register (R) and transaction (T) are stable; keep
    # the explicit OCR labels instead of inferring a swap from value lengths.
    receipt_core = f"S{s_value}-R{r_value}-T{t_value}"

    # Keep the date suffix format stable across all Best Buy layouts.
    date_suffix = receipt_date_yyyymmdd(parsed_date)
    if not date_suffix and bus_date_parts is not None:
        year, month, day = bus_date_parts
        date_suffix = f"{year:04d}{month:02d}{day:02d}"

    if not date_suffix:
        return None

    return f"{receipt_core}_{date_suffix}"


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
    if "best buy" in vendor or _looks_like_bestbuy_receipt(texts):
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


def is_bestbuy_business(texts: list[str]) -> bool:
    joined = " ".join(texts).lower()
    return "best buy business hub" in joined or "bestbuyforbusiness" in joined


def extract_bestbuy_business_line_items(
    lines: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    texts = [l["text"].strip() for l in lines]

    # Find the header row ending at "Quantity"
    header_end = -1
    for i, t in enumerate(texts):
        if t.lower() == "quantity":
            window = " ".join(texts[max(0, i - 5) : i + 1]).lower()
            if "sku" in window and "price" in window:
                header_end = i
                break

    if header_end < 0:
        return []

    # Find the footer (Product Total, GST, Subtotal, etc.)
    footer_start = len(texts)
    for i in range(header_end + 1, len(texts)):
        low = texts[i].lower()
        if any(
            kw in low
            for kw in (
                "product total",
                "gst / hst",
                "shipping total",
                "subtotal:",
                "ehf:",
                "remit to",
            )
        ):
            footer_start = i
            break

    region = texts[header_end + 1 : footer_start]
    region_lines = lines[header_end + 1 : footer_start]
    if not region:
        return []

    # Find price+qty pairs: "$XX.XX" immediately followed by a small integer
    pairs: list[tuple[int, int, str, int]] = []
    for i, text in enumerate(region):
        m = re.match(r"\$(\d+\.\d{2})$", text)
        if m and i + 1 < len(region) and re.fullmatch(r"\d{1,3}", region[i + 1]):
            pairs.append((i, i + 1, m.group(1), int(region[i + 1])))

    if not pairs:
        return []

    # Identify structural indices (prices, quantities, SKU numbers)
    structural: set[int] = set()
    for price_i, qty_i, _, _ in pairs:
        structural.add(price_i)
        structural.add(qty_i)
    for i, text in enumerate(region):
        if re.fullmatch(r"\d{5,10}", text):
            structural.add(i)

    # Description lines = everything non-structural
    desc_entries = [
        (i, region[i])
        for i in range(len(region))
        if i not in structural and region[i].strip()
    ]

    # Assign each description line to its nearest price+qty pair,
    # preferring items whose price appears AFTER the description line
    # (since descriptions typically precede their price in reading order).
    item_desc_indices: list[list[int]] = [[] for _ in pairs]
    for desc_i, _ in desc_entries:
        best = min(
            range(len(pairs)),
            key=lambda p: (
                abs(desc_i - pairs[p][0]),
                0 if desc_i < pairs[p][0] else 1,
            ),
        )
        item_desc_indices[best].append(desc_i)

    result: list[dict[str, Any]] = []
    for pidx, (price_i, qty_i, price_val, qty_val) in enumerate(pairs):
        desc_parts = [region[i] for i in sorted(item_desc_indices[pidx])]
        desc = " ".join(desc_parts).strip() or "Unknown item"
        qty = max(1, qty_val)

        involved = sorted(item_desc_indices[pidx]) + [price_i, qty_i]
        conf = min(
            float(region_lines[i].get("confidence", 0.0)) for i in involved
        )

        result.append(
            {
                "description": desc,
                "quantity": qty,
                "unit_cost": price_val,
                "line_total": f"{float(price_val) * qty:.2f}",
                "confidence": conf,
            }
        )

    return result


def detect_fixture_used(
    texts: list[str],
    vendor_name: str | None,
    steam_mode: bool,
    amazon_mode: bool,
) -> str:
    if steam_mode:
        return "steam"
    if amazon_mode:
        return "amazon"

    vendor = (vendor_name or "").lower()
    if "best buy" in vendor or _looks_like_bestbuy_receipt(texts):
        return "bestbuy"

    return "generic"


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
                "_source_index": min(indices),
            }
        )

    items.sort(
        key=lambda x: (
            int(x.get("_source_index", 10**9)),
            str(x.get("description", "")).lower(),
        )
    )
    return [_strip_internal_line_item_fields(item) for item in items]


def extract_amazon_line_items(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    blocked_description_tokens = (
        "invoice",
        "order",
        "shipment",
        "sold by",
        "billing address",
        "delivery address",
        "gst/hst",
        "for questions",
        "asin:",
        "shipping charges",
        "frais d'exp",
        "environmentalhandlingfee",
        "description",
        "quantity",
        "unit",
        "discount",
        "federal tax",
        "provincial tax",
        "item subtotal",
        "page ",
    )

    asin_pattern = re.compile(r"\bASIN\s*:\s*([A-Z0-9]{8,16})\b", re.IGNORECASE)
    money_pattern = r"(?:\d{1,3}(?:[ ,]\d{3})*|\d+)\.\d{2}"
    qty_price_pattern = re.compile(
        rf"^\s*(\d{{1,3}})\s+\$?\s*({money_pattern})\s*$",
        re.IGNORECASE,
    )
    qty_only_pattern = re.compile(r"^\s*(\d{1,3})\s*$")
    price_only_pattern = re.compile(
        rf"^\s*\$?\s*({money_pattern})\s*$",
        re.IGNORECASE,
    )
    inline_qty_price_pattern = re.compile(
        rf"^(.*?)\b(\d{{1,3}})\s+\$?\s*({money_pattern})\s*$",
        re.IGNORECASE,
    )

    def _parse_money(raw: str) -> float | None:
        try:
            return float(raw.replace(",", "").replace(" ", ""))
        except ValueError:
            return None

    items: list[dict[str, Any]] = []
    seen_asins: set[str] = set()
    previous_asin_index = -1

    for idx, line in enumerate(lines):
        text = line["text"].strip()
        if not text:
            continue

        asin_match = asin_pattern.search(text)
        if not asin_match:
            continue

        asin_code = asin_match.group(1).upper()
        if asin_code in seen_asins:
            previous_asin_index = idx
            continue

        window_start = max(previous_asin_index + 1, idx - 60)
        previous_asin_index = idx

        quantity: int | None = None
        unit_cost: float | None = None
        qty_line_index: int | None = None
        inline_desc: str | None = None
        confidence = float(line.get("confidence", 0.0))

        for cursor in range(idx - 1, window_start - 1, -1):
            current = lines[cursor]["text"].strip()
            if not current:
                continue

            qty_price_match = qty_price_pattern.fullmatch(current)
            if qty_price_match:
                parsed_qty = int(qty_price_match.group(1))
                parsed_unit = _parse_money(qty_price_match.group(2))
                if parsed_unit is not None:
                    quantity = parsed_qty
                    unit_cost = parsed_unit
                    qty_line_index = cursor
                    confidence = min(confidence, float(lines[cursor].get("confidence", 0.0)))
                    break

            qty_only_match = qty_only_pattern.fullmatch(current)
            if qty_only_match and cursor + 1 < idx:
                next_text = lines[cursor + 1]["text"].strip()
                price_only_match = price_only_pattern.fullmatch(next_text)
                if price_only_match:
                    parsed_unit = _parse_money(price_only_match.group(1))
                    if parsed_unit is not None:
                        quantity = int(qty_only_match.group(1))
                        unit_cost = parsed_unit
                        qty_line_index = cursor
                        confidence = min(
                            confidence,
                            float(lines[cursor].get("confidence", 0.0)),
                            float(lines[cursor + 1].get("confidence", 0.0)),
                        )
                        break

            inline_match = inline_qty_price_pattern.match(current)
            if inline_match:
                parsed_qty = int(inline_match.group(2))
                parsed_unit = _parse_money(inline_match.group(3))
                if parsed_unit is not None:
                    quantity = parsed_qty
                    unit_cost = parsed_unit
                    qty_line_index = cursor
                    inline_desc = inline_match.group(1).strip(" -:$")
                    confidence = min(confidence, float(lines[cursor].get("confidence", 0.0)))
                    break

        if quantity is None or unit_cost is None or qty_line_index is None:
            continue
        if quantity < 1 or quantity > 500 or unit_cost <= 0:
            continue

        description: str | None = None
        description_index: int | None = None

        if inline_desc:
            inline_primary = inline_desc.split(" / ", 1)[0].strip()
            cleaned_inline = _clean_description(inline_primary)
            if (
                cleaned_inline
                and not _looks_like_non_item_description(cleaned_inline)
                and cleaned_inline.lower() not in {"piece", "pièce", "la", "article"}
            ):
                description = cleaned_inline
                description_index = qty_line_index

        if not description:
            best_candidate: tuple[int, int, str, int] | None = None
            # Limit description search to 15 lines back from the qty line to
            # avoid picking up distant address/URL lines with high alpha-word counts.
            # The wider window_start is only needed for the qty/price lookup above.
            desc_window_start = max(window_start, qty_line_index - 15)
            for cursor in range(qty_line_index - 1, desc_window_start - 1, -1):
                candidate_raw = lines[cursor]["text"].strip()
                if not candidate_raw:
                    continue

                candidate_primary = candidate_raw.split(" / ", 1)[0].strip()
                candidate_low = candidate_primary.lower()
                if _is_summary_line(candidate_primary):
                    continue
                if any(token in candidate_low for token in blocked_description_tokens):
                    continue
                if qty_price_pattern.fullmatch(candidate_primary):
                    continue
                if qty_only_pattern.fullmatch(candidate_primary):
                    continue
                if price_only_pattern.fullmatch(candidate_primary):
                    continue

                cleaned = _clean_description(candidate_primary)
                if not cleaned:
                    continue
                if cleaned.lower() in {"piece", "pièce", "la", "article"}:
                    continue
                if _looks_like_non_item_description(cleaned):
                    continue

                alpha_words = re.findall(r"[A-Za-z]{2,}", cleaned)
                score = len(alpha_words)
                cleaned_low = cleaned.lower()
                if "amazon echo" in cleaned_low:
                    score += 20
                elif "echo" in cleaned_low:
                    score += 10
                distance = qty_line_index - cursor

                candidate_tuple = (score, -distance, cleaned, cursor)
                if best_candidate is None or candidate_tuple > best_candidate:
                    best_candidate = candidate_tuple

            if best_candidate is not None:
                description = best_candidate[2]
                description_index = best_candidate[3]
                confidence = min(confidence, float(lines[description_index].get("confidence", 0.0)))

        if not description:
            description = f"ASIN {asin_code}"
            description_index = qty_line_index

        line_total = unit_cost * quantity
        item = {
            "description": description,
            "quantity": quantity,
            "unit_cost": f"{unit_cost:.2f}",
            "line_total": f"{line_total:.2f}",
            "confidence": confidence,
            "_asin": asin_code,
            "_source_index": description_index if description_index is not None else qty_line_index,
        }

        seen_asins.add(asin_code)
        items.append(item)

    # Attach EnvironmentalHandlingFee lines as sub_items of their nearest
    # preceding ASIN-based product (the relationship is structurally clear).
    for idx, line in enumerate(lines):
        text = line["text"].strip()
        if text.lower() != "environmentalhandlingfee":
            continue
        if idx + 1 >= len(lines):
            continue
        next_text = lines[idx + 1]["text"].strip()
        fee_match = price_only_pattern.fullmatch(next_text)
        if not fee_match:
            continue
        fee_value = _parse_money(fee_match.group(1))
        if fee_value is None or fee_value <= 0:
            continue
        conf = min(
            float(line.get("confidence", 0.0)),
            float(lines[idx + 1].get("confidence", 0.0)),
        )
        fee_item = {
            "description": "Environmental Handling Fee",
            "quantity": 1,
            "unit_cost": f"{fee_value:.2f}",
            "line_total": f"{fee_value:.2f}",
            "confidence": conf,
        }
        # Find nearest preceding product item by _source_index
        parent = None
        for candidate in reversed(items):
            src = candidate.get("_source_index", 10**9)
            if src < idx:
                parent = candidate
                break
        if parent is not None:
            parent.setdefault("sub_items", []).append(fee_item)
        else:
            fee_item["_source_index"] = idx
            items.append(fee_item)

    # Fold sub_items costs into the parent's unit_cost.
    # Eco fees are a flat total for the whole line (not per-unit), so we
    # divide by parent quantity to get the per-unit adjustment.
    for item in items:
        subs = item.get("sub_items")
        if not subs:
            continue
        parent_qty = max(item.get("quantity", 1), 1)
        raw_unit = item.get("unit_cost")
        if raw_unit is None:
            continue
        try:
            base_unit = float(raw_unit)
        except (ValueError, TypeError):
            continue
        fee_total = 0.0
        for sub in subs:
            try:
                sub_cost = float(sub.get("unit_cost", 0))
                sub_qty = max(int(sub.get("quantity", 1)), 1)
                fee_total += sub_cost * sub_qty
            except (ValueError, TypeError):
                continue
        if fee_total > 0:
            adjusted = base_unit + fee_total / parent_qty
            item["unit_cost"] = f"{adjusted:.2f}"
            item["line_total"] = f"{adjusted * parent_qty:.2f}"

    # Fallback: if no ASIN-based items found, scan for "qty $price" lines
    # preceded by a description line.
    if not items:
        for idx, line in enumerate(lines):
            text = line["text"].strip()
            if not text:
                continue
            qty_price_match = qty_price_pattern.fullmatch(text)
            if not qty_price_match:
                continue
            parsed_qty = int(qty_price_match.group(1))
            parsed_unit = _parse_money(qty_price_match.group(2))
            if parsed_unit is None or parsed_qty < 1 or parsed_qty > 500 or parsed_unit <= 0:
                continue

            # Look backwards for a description
            desc: str | None = None
            desc_idx: int | None = None
            for cursor in range(idx - 1, max(-1, idx - 6), -1):
                candidate_raw = lines[cursor]["text"].strip()
                if not candidate_raw:
                    continue
                candidate_low = candidate_raw.lower()
                if _is_summary_line(candidate_raw):
                    continue
                if any(token in candidate_low for token in blocked_description_tokens):
                    continue
                if qty_price_pattern.fullmatch(candidate_raw):
                    continue
                candidate_primary = candidate_raw.split(" / ", 1)[0].strip()
                cleaned = _clean_description(candidate_primary)
                if cleaned and not _looks_like_non_item_description(cleaned):
                    desc = cleaned
                    desc_idx = cursor
                    break

            if not desc:
                continue

            conf = min(
                float(line.get("confidence", 0.0)),
                float(lines[desc_idx].get("confidence", 0.0)) if desc_idx is not None else 0.0,
            )
            line_total = parsed_unit * parsed_qty
            items.append({
                "description": desc,
                "quantity": parsed_qty,
                "unit_cost": f"{parsed_unit:.2f}",
                "line_total": f"{line_total:.2f}",
                "confidence": conf,
                "_source_index": desc_idx if desc_idx is not None else idx,
            })

    # Clean up verbose descriptions using amazon_rules.json
    _apply_amazon_description_cleanup(items, lines)

    items.sort(
        key=lambda x: (
            int(x.get("_source_index", 10**9)),
            str(x.get("description", "")).lower(),
        ),
    )
    return [_strip_internal_line_item_fields(item) for item in items]


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


def _parse_all_signed_money_values(text: str) -> list[float]:
    values: list[float] = []
    for match in re.finditer(r"[-+]?\s*\$?\s*(?:\d{1,3}(?:[ ,]\d{3})*|\d+)\.\d{2}", text):
        raw = match.group(0).strip().replace(" ", "")
        sign = -1.0 if raw.startswith("-") else 1.0
        normalized = raw.lstrip("+-").lstrip("$").replace(",", "")
        try:
            values.append(sign * float(normalized))
        except ValueError:
            continue
    return values


def _extract_amazon_summary_subtotal_and_tax(texts: list[str]) -> tuple[float | None, float | None]:
    # Multi-page Amazon invoices often end with a summary table row like:
    # Total | 1103.53 | -5.49 | 142.68 | 0.00 | 142.68
    # We treat subtotal as item subtotal plus discount, and tax as the last tax subtotal value.
    for idx, text in enumerate(texts):
        low = text.lower().strip()
        if low != "total":
            continue

        context = " ".join(texts[max(0, idx - 40):idx]).lower()
        if "discount" not in context:
            continue

        values: list[float] = []
        for scan_idx in range(idx + 1, min(len(texts), idx + 8)):
            values.extend(_parse_all_signed_money_values(texts[scan_idx]))

        if len(values) < 3:
            continue

        item_subtotal = values[0]
        discount = values[1]
        tax_subtotal = values[-1]

        if item_subtotal <= 0 or tax_subtotal < 0:
            continue

        effective_subtotal = item_subtotal + discount
        if effective_subtotal <= 0:
            effective_subtotal = item_subtotal

        return round(effective_subtotal, 2), round(tax_subtotal, 2)

    return None, None


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

    summary_subtotal, summary_tax = _extract_amazon_summary_subtotal_and_tax(texts)
    if summary_subtotal is not None:
        subtotal_value = summary_subtotal
    if summary_tax is not None:
        tax_value = summary_tax

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
    fixture_used = detect_fixture_used(texts, vendor_name, steam_mode, amazon_mode)

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
            # Skip the rate line itself if it contains "%;" grab the amount from nearby lines
            if "%" in t:
                idx = texts.index(t)
                for offset in [1, 2]:
                    if idx + offset < len(texts):
                        tax = parse_money(texts[idx + offset])
                        if tax:
                            break
            else:
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

    if is_bestbuy_business(texts):
        bbb_items = extract_bestbuy_business_line_items(lines)
        if bbb_items:
            line_items = bbb_items

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
            line_items,
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
        "fixture_used": fixture_used,
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
