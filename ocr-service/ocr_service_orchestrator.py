import asyncio
import tempfile
import os
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from starlette.concurrency import run_in_threadpool

from ocr_service_classic_engine import (
    get_classic_ocr,
    parse_receipt_path_with_score as parse_classic_with_score,
)
from ocr_service_common import env_bool, env_float, env_int, is_low_confidence
from ocr_service_llm_engine import (
    check_vl_engine_available,
    parse_receipt_path_with_score as parse_vl_with_score,
)


app = FastAPI(title="bg-tracker-receipt-ocr")
_parse_limiter = asyncio.Semaphore(env_int("OCR_PARSE_CONCURRENCY_PER_WORKER", 1, 1))


@app.on_event("startup")
async def _warm_classic_model_on_startup() -> None:
    if env_bool("OCR_CLASSIC_PRELOAD_ON_STARTUP", True):
        await run_in_threadpool(get_classic_ocr)


def _http_workers() -> int:
    default_workers = 1
    return env_int("OCR_HTTP_WORKERS", default_workers, 1)


def _parse_version_for_engine(engine: str) -> str:
    if engine == "paddleocr-vl":
        return os.getenv("OCR_VL_PARSE_VERSION", "paddleocr-vl-v1")
    if engine == "paddleocr":
        return os.getenv("OCR_CLASSIC_PARSE_VERSION", "paddleocr-classic-v1")
    return os.getenv("OCR_PARSE_VERSION", "ocr-v1")


def _attach_engine_metadata(parsed: dict[str, Any], score: float, engine: str) -> dict[str, Any]:
    parsed.setdefault("warnings", [])
    parsed["confidence_score"] = round(score, 2)
    parsed["parse_engine"] = engine
    parsed["parse_version"] = _parse_version_for_engine(engine)
    return parsed


def _engine_display_name(engine: str) -> str:
    if engine == "paddleocr-vl":
        return "PaddleOCR-VL"
    return "PaddleOCR"


def _append_warning_with_final_engine(parsed: dict[str, Any], warning: str, engine: str) -> None:
    parsed.setdefault("warnings", [])
    parsed["warnings"].append(f"{warning} Final engine: {_engine_display_name(engine)}.")


def parse_receipt_path(path: str | Path) -> dict[str, Any]:
    path = str(path)
    threshold = env_float("OCR_LOW_CONFIDENCE_THRESHOLD", 8.0, 0.0)

    classic_result: dict[str, Any] | None = None
    classic_score = -1.0
    classic_error: Exception | None = None

    try:
        classic_result, classic_score = parse_classic_with_score(path)
        classic_result = _attach_engine_metadata(classic_result, classic_score, "paddleocr")
    except Exception as exc:
        classic_error = exc

    if classic_result is not None and classic_error is None:
        if not is_low_confidence(classic_result, classic_score, threshold):
            return classic_result
        fallback_reason = f"Low-confidence parse (score {classic_score:.2f} < {threshold:.2f})"
    else:
        fallback_reason = f"Classic PaddleOCR failed: {classic_error}"

    if not env_bool("OCR_VL_ENABLED", True):
        if classic_result is not None:
            _append_warning_with_final_engine(
                classic_result,
                f"{fallback_reason}; PaddleOCR-VL fallback disabled by OCR_VL_ENABLED=0.",
                "paddleocr",
            )
            return classic_result
        raise RuntimeError(
            f"{fallback_reason}; PaddleOCR-VL fallback disabled by OCR_VL_ENABLED=0 and no "
            "PaddleOCR result was available."
        )

    vl_available, vl_unavailable_reason = check_vl_engine_available()
    if not vl_available:
        vl_reason = vl_unavailable_reason or "unknown reason"
        if classic_result is not None:
            _append_warning_with_final_engine(
                classic_result,
                f"{fallback_reason}; PaddleOCR-VL fallback unavailable ({vl_reason}).",
                "paddleocr",
            )
            return classic_result
        raise RuntimeError(
            f"{fallback_reason}; PaddleOCR-VL fallback unavailable ({vl_reason}) and no "
            "PaddleOCR result was available."
        )

    if classic_result is not None and classic_error is None:
        classic_result.setdefault("warnings", [])
        classic_result["warnings"].append(f"{fallback_reason}; trying PaddleOCR-VL fallback.")

    try:
        vl_result, vl_score = parse_vl_with_score(path)
        vl_result = _attach_engine_metadata(vl_result, vl_score, "paddleocr-vl")
        vl_result.setdefault("warnings", [])
        vl_result["warnings"].append(
            f"{fallback_reason}; switched to PaddleOCR-VL fallback (score {vl_score:.2f}). "
            "Final engine: PaddleOCR-VL."
        )
        return vl_result
    except Exception as exc:
        msg = f"PaddleOCR-VL fallback failed ({exc})"
        if classic_error is not None:
            raise RuntimeError(
                f"{fallback_reason}; {msg}; no PaddleOCR result was available."
            ) from exc
        if env_bool("OCR_VL_STRICT", False):
            raise RuntimeError(
                f"{fallback_reason}; {msg}; strict mode requires VL fallback."
            ) from exc
        if classic_result is not None:
            _append_warning_with_final_engine(classic_result, f"{fallback_reason}; {msg}", "paddleocr")
            return classic_result
        raise RuntimeError(msg) from exc


def parse_receipt_path_with_mode(path: str | Path, mode: str) -> dict[str, Any]:
    normalized = mode.strip().lower()

    if normalized == "auto":
        return parse_receipt_path(path)

    if normalized == "classic":
        classic_result, classic_score = parse_classic_with_score(str(path))
        classic_result = _attach_engine_metadata(classic_result, classic_score, "paddleocr")
        _append_warning_with_final_engine(
            classic_result,
            "Forced OCR mode: PaddleOCR (classic).",
            "paddleocr",
        )
        return classic_result

    if normalized == "vl":
        vl_available, vl_unavailable_reason = check_vl_engine_available()
        if not vl_available:
            vl_reason = vl_unavailable_reason or "unknown reason"
            raise RuntimeError(
                f"Forced OCR mode 'vl' requested, but PaddleOCR-VL is unavailable ({vl_reason})."
            )
        vl_result, vl_score = parse_vl_with_score(str(path))
        vl_result = _attach_engine_metadata(vl_result, vl_score, "paddleocr-vl")
        _append_warning_with_final_engine(vl_result, "Forced OCR mode: PaddleOCR-VL.", "paddleocr-vl")
        return vl_result

    raise ValueError("Invalid mode. Supported values: auto, classic, vl.")


@app.get("/health")
def health() -> dict[str, Any]:
    vl_available, vl_unavailable_reason = check_vl_engine_available()
    return {
        "status": "ok",
        "ocr_vl_enabled": env_bool("OCR_VL_ENABLED", True),
        "ocr_vl_available": vl_available,
        "ocr_vl_unavailable_reason": vl_unavailable_reason,
    }


@app.post("/parse-receipt")
async def parse_receipt(
    file: UploadFile = File(...),
    mode: str = Query("auto"),
) -> dict[str, Any]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing file name")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    suffix = Path(file.filename).suffix.lower() or ".jpg"
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".pdf"}:
        suffix = ".jpg"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(data)
        tmp.flush()

        try:
            async with _parse_limiter:
                return await run_in_threadpool(parse_receipt_path_with_mode, tmp.name, mode)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"OCR failed: {exc}")


if __name__ == "__main__":
    uvicorn.run(
        "ocr_service_orchestrator:app",
        host="0.0.0.0",
        port=8001,
        reload=False,
        workers=_http_workers(),
    )
