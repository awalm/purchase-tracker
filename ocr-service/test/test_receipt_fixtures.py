from pathlib import Path
import json
import http.client
import mimetypes
import uuid

import pytest


ROOT = Path(__file__).resolve().parents[1]
REQUEST_TIMEOUT_SECONDS = 300
RECEIPT_DATA_DIR = ROOT / "test" / "receipt_data"


def build_multipart_body(
    file_path: Path,
    content_type: str,
    field_name: str = "file",
) -> tuple[bytes, str]:
    boundary = f"----bgtracker-{uuid.uuid4().hex}"
    file_bytes = file_path.read_bytes()
    body = b""
    body += f"--{boundary}\r\n".encode("utf-8")
    body += (
        f'Content-Disposition: form-data; name="{field_name}"; filename="{file_path.name}"\r\n'.encode("utf-8")
    )
    body += f"Content-Type: {content_type}\r\n\r\n".encode("utf-8")
    body += file_bytes
    body += b"\r\n"
    body += f"--{boundary}--\r\n".encode("utf-8")
    return body, boundary


def guess_content_type(file_path: Path) -> str:
    guessed, _ = mimetypes.guess_type(file_path.name)
    return guessed or "application/octet-stream"


def discover_fixture_specs() -> list[dict]:
    fixtures: list[dict] = []
    for expected_file in sorted(RECEIPT_DATA_DIR.rglob("*_EXP.json")):
        payload = json.loads(expected_file.read_text(encoding="utf-8"))
        source_name = payload.get("source_file")
        assert isinstance(source_name, str) and source_name, (
            f"Fixture {expected_file} must define a non-empty 'source_file'."
        )

        expected = payload.get("expected")
        assert isinstance(expected, dict), (
            f"Fixture {expected_file} must define an 'expected' object."
        )

        sample_file = expected_file.parent / source_name
        content_type = payload.get("content_type")
        if not content_type:
            content_type = guess_content_type(sample_file)

        fixture_name = str(expected_file.relative_to(RECEIPT_DATA_DIR))
        fixture_name = fixture_name.removesuffix("_EXP.json")
        fixtures.append(
            {
                "name": fixture_name,
                "file": sample_file,
                "content_type": content_type,
                "expected": expected,
            }
        )

    assert fixtures, "No receipt fixture sidecars found under test/receipt_data"
    return fixtures


FIXTURES = discover_fixture_specs()


@pytest.mark.parametrize("fixture", FIXTURES, ids=[fixture["name"] for fixture in FIXTURES])
def test_receipt_fixture_extracts_expected_fields(fixture: dict) -> None:
    sample_file = fixture["file"]
    expected = fixture["expected"]

    assert sample_file.exists(), f"Missing test fixture: {sample_file}"

    body, boundary = build_multipart_body(sample_file, fixture["content_type"])
    conn = http.client.HTTPConnection("localhost", 8001, timeout=REQUEST_TIMEOUT_SECONDS)
    try:
        conn.request(
            "POST",
            "/parse-receipt",
            body=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        response = conn.getresponse()
        payload = response.read().decode("utf-8")
    finally:
        conn.close()

    assert response.status == 200, (
        f"Expected OCR endpoint 200 but got {response.status}. Body: {payload}"
    )

    result = json.loads(payload)

    print(f"[{fixture['name']}] Extracted summary:", {
        "receipt_number": result.get("receipt_number"),
        "receipt_date": result.get("receipt_date"),
        "subtotal": result.get("subtotal"),
        "tax": result.get("tax"),
        "total": result.get("total"),
        "payment_method": result.get("payment_method"),
        "line_items": len(result.get("line_items", [])),
    })

    assert isinstance(result, dict)
    assert "raw_text_lines" in result
    assert len(result.get("raw_text_lines", [])) > 0

    raw_joined = " ".join(result.get("raw_text_lines", [])).lower()
    for token in expected.get("raw_text_contains", []):
        assert token in raw_joined, f"Expected '{token}' in OCR text for fixture {fixture['name']}"

    assert result.get("receipt_number") == expected.get("receipt_number")
    assert result.get("receipt_date") == expected.get("receipt_date")
    assert result.get("subtotal") == expected.get("subtotal")
    assert result.get("tax") == expected.get("tax")
    assert result.get("total") == expected.get("total")
    assert result.get("payment_method") == expected.get("payment_method")
    assert len(result.get("line_items", [])) == expected.get("line_items_count")

    if expected.get("line_items_expected"):
        parsed_lines = result["line_items"]
        for expected_line in expected["line_items_expected"]:
            matched = next(
                (
                    line
                    for line in parsed_lines
                    if expected_line["description_contains"] in line["description"].lower()
                ),
                None,
            )
            assert matched is not None, (
                f"Missing expected line item containing '{expected_line['description_contains']}'"
            )
            assert matched["quantity"] == expected_line["quantity"]
            assert matched["unit_cost"] == expected_line["unit_cost"]
            if "line_total" in expected_line:
                assert matched["line_total"] == expected_line["line_total"]
    elif expected.get("line_items_count", 0) > 0:
        first = result["line_items"][0]
        assert expected["line_item_description_contains"] in first["description"].lower()
        assert first["quantity"] == expected["line_item_qty"]
        assert first["unit_cost"] == expected["line_item_unit_cost"]

    warnings = result.get("warnings", [])
    for warning in expected.get("warnings_contains", []):
        assert warning in warnings, f"Expected warning '{warning}' for fixture {fixture['name']}"
