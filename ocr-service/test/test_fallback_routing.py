from copy import deepcopy

import ocr_service_orchestrator as orchestrator
import pytest


def _classic_result() -> dict:
    return {
        "vendor_name": "Test Vendor",
        "receipt_number": None,
        "receipt_date": "2026-01-01",
        "subtotal": None,
        "tax": None,
        "total": None,
        "payment_method": None,
        "line_items": [],
        "warnings": [],
        "raw_text_lines": ["test line"],
    }


def _vl_result() -> dict:
    return {
        "vendor_name": "Test Vendor",
        "receipt_number": "INV-001",
        "receipt_date": "2026-01-01",
        "subtotal": "100.00",
        "tax": "13.00",
        "total": "113.00",
        "payment_method": "1234",
        "line_items": [
            {
                "description": "Test Item",
                "quantity": 1,
                "unit_cost": "100.00",
                "line_total": "100.00",
                "confidence": 0.95,
            }
        ],
        "warnings": [],
        "raw_text_lines": ["Test Item 100.00"],
    }


def test_orchestrator_routes_to_vl_on_low_confidence_classic(monkeypatch) -> None:
    monkeypatch.setenv("OCR_LOW_CONFIDENCE_THRESHOLD", "8.0")
    monkeypatch.setenv("OCR_VL_ENABLED", "1")
    monkeypatch.delenv("OCR_VL_STRICT", raising=False)

    monkeypatch.setattr(
        orchestrator,
        "parse_classic_with_score",
        lambda _: (deepcopy(_classic_result()), 2.0),
    )
    monkeypatch.setattr(
        orchestrator,
        "parse_vl_with_score",
        lambda _: (deepcopy(_vl_result()), 9.5),
    )
    monkeypatch.setattr(orchestrator, "check_vl_engine_available", lambda: (True, None))

    parsed = orchestrator.parse_receipt_path("dummy-path.pdf")

    assert parsed["parse_engine"] == "paddleocr-vl"
    assert parsed["confidence_score"] == 9.5
    assert any("Low-confidence parse (score 2.00 < 8.00)" in w for w in parsed["warnings"])
    assert any("switched to PaddleOCR-VL fallback (score 9.50)" in w for w in parsed["warnings"])
    assert any("Final engine: PaddleOCR-VL." in w for w in parsed["warnings"])


def test_orchestrator_routes_to_vl_when_classic_errors(monkeypatch) -> None:
    monkeypatch.setenv("OCR_LOW_CONFIDENCE_THRESHOLD", "8.0")
    monkeypatch.setenv("OCR_VL_ENABLED", "1")
    monkeypatch.delenv("OCR_VL_STRICT", raising=False)

    def _raise_classic(_: str) -> tuple[dict, float]:
        raise RuntimeError("classic unavailable")

    monkeypatch.setattr(orchestrator, "parse_classic_with_score", _raise_classic)
    monkeypatch.setattr(orchestrator, "check_vl_engine_available", lambda: (True, None))
    monkeypatch.setattr(
        orchestrator,
        "parse_vl_with_score",
        lambda _: (deepcopy(_vl_result()), 7.0),
    )

    parsed = orchestrator.parse_receipt_path("dummy-path.pdf")

    assert parsed["parse_engine"] == "paddleocr-vl"
    assert parsed["confidence_score"] == 7.0
    assert any("Classic PaddleOCR failed: classic unavailable" in w for w in parsed["warnings"])
    assert any("switched to PaddleOCR-VL fallback (score 7.00)" in w for w in parsed["warnings"])


def test_forced_classic_mode_skips_vl(monkeypatch) -> None:
    monkeypatch.setattr(
        orchestrator,
        "parse_classic_with_score",
        lambda _: (deepcopy(_classic_result()), 6.0),
    )

    def _raise_if_called(_: str) -> tuple[dict, float]:
        raise AssertionError("VL parser should not run in forced classic mode")

    monkeypatch.setattr(orchestrator, "parse_vl_with_score", _raise_if_called)

    parsed = orchestrator.parse_receipt_path_with_mode("dummy-path.pdf", "classic")

    assert parsed["parse_engine"] == "paddleocr"
    assert parsed["confidence_score"] == 6.0
    assert any("Forced OCR mode: PaddleOCR (classic)." in w for w in parsed["warnings"])
    assert any("Final engine: PaddleOCR." in w for w in parsed["warnings"])


def test_forced_classic_mode_failure_does_not_retry_vl(monkeypatch) -> None:
    def _raise_classic(_: str) -> tuple[dict, float]:
        raise RuntimeError("classic failed")

    def _raise_if_vl_called(_: str) -> tuple[dict, float]:
        raise AssertionError("VL parser must not run when forced classic mode fails")

    monkeypatch.setattr(orchestrator, "parse_classic_with_score", _raise_classic)
    monkeypatch.setattr(orchestrator, "parse_vl_with_score", _raise_if_vl_called)

    with pytest.raises(RuntimeError, match="classic failed"):
        orchestrator.parse_receipt_path_with_mode("dummy-path.pdf", "classic")


def test_forced_vl_mode_skips_classic(monkeypatch) -> None:
    def _raise_if_called(_: str) -> tuple[dict, float]:
        raise AssertionError("Classic parser should not run in forced VL mode")

    monkeypatch.setattr(orchestrator, "parse_classic_with_score", _raise_if_called)
    monkeypatch.setattr(orchestrator, "check_vl_engine_available", lambda: (True, None))
    monkeypatch.setattr(
        orchestrator,
        "parse_vl_with_score",
        lambda _: (deepcopy(_vl_result()), 9.0),
    )

    parsed = orchestrator.parse_receipt_path_with_mode("dummy-path.pdf", "vl")

    assert parsed["parse_engine"] == "paddleocr-vl"
    assert parsed["confidence_score"] == 9.0
    assert any("Forced OCR mode: PaddleOCR-VL." in w for w in parsed["warnings"])
    assert any("Final engine: PaddleOCR-VL." in w for w in parsed["warnings"])


def test_forced_vl_mode_failure_does_not_retry_classic(monkeypatch) -> None:
    def _raise_if_classic_called(_: str) -> tuple[dict, float]:
        raise AssertionError("Classic parser must not run when forced VL mode fails")

    def _raise_vl(_: str) -> tuple[dict, float]:
        raise RuntimeError("vl failed")

    monkeypatch.setattr(orchestrator, "parse_classic_with_score", _raise_if_classic_called)
    monkeypatch.setattr(orchestrator, "check_vl_engine_available", lambda: (True, None))
    monkeypatch.setattr(orchestrator, "parse_vl_with_score", _raise_vl)

    with pytest.raises(RuntimeError, match="vl failed"):
        orchestrator.parse_receipt_path_with_mode("dummy-path.pdf", "vl")


def test_orchestrator_uses_classic_when_vl_unavailable(monkeypatch) -> None:
    monkeypatch.setenv("OCR_LOW_CONFIDENCE_THRESHOLD", "8.0")
    monkeypatch.setenv("OCR_VL_ENABLED", "1")
    monkeypatch.delenv("OCR_VL_STRICT", raising=False)

    monkeypatch.setattr(
        orchestrator,
        "parse_classic_with_score",
        lambda _: (deepcopy(_classic_result()), 2.0),
    )
    monkeypatch.setattr(
        orchestrator,
        "check_vl_engine_available",
        lambda: (False, "ImportError: PaddleOCRVL is not available in installed paddleocr package."),
    )

    parsed = orchestrator.parse_receipt_path("dummy-path.pdf")

    assert parsed["parse_engine"] == "paddleocr"
    assert any("PaddleOCR-VL fallback unavailable" in w for w in parsed["warnings"])
    assert any("Final engine: PaddleOCR." in w for w in parsed["warnings"])


def test_invalid_forced_mode_raises_value_error() -> None:
    with pytest.raises(ValueError, match="Invalid mode"):
        orchestrator.parse_receipt_path_with_mode("dummy-path.pdf", "unsupported")
