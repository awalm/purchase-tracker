import multiprocessing as mp
import os
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile

from ocr_service_common import env_int, extract_structured, score_structured


app = FastAPI(title="bg-tracker-receipt-ocr-vl")


def _format_vl_exception(exc: Exception) -> str:
    message = str(exc).strip()
    if not message:
        message = exc.__class__.__name__
    return f"{exc.__class__.__name__}: {message}"


@lru_cache(maxsize=1)
def check_vl_engine_available() -> tuple[bool, str | None]:
    try:
        from paddleocr import PaddleOCRVL  # noqa: F401

        return True, None
    except Exception as exc:
        if isinstance(exc, ImportError) and "PaddleOCRVL" in str(exc):
            return (
                False,
                "ImportError: PaddleOCRVL is not available in the installed paddleocr package.",
            )
        return False, _format_vl_exception(exc)


def _extract_vl_text_lines(markdown_result: Any) -> list[str]:
    text = ""
    if isinstance(markdown_result, dict):
        text = str(markdown_result.get("markdown_texts") or "")
    elif markdown_result is not None:
        text = str(markdown_result)

    return [line.strip() for line in text.splitlines() if line.strip()]


def _vl_worker(path: str, cfg: dict[str, Any], out_queue: Any) -> None:
    try:
        os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

        ld_prefix = cfg.get("ld_library_path_prefix")
        if ld_prefix:
            existing = os.getenv("LD_LIBRARY_PATH", "")
            if ld_prefix not in existing.split(":"):
                os.environ["LD_LIBRARY_PATH"] = f"{ld_prefix}:{existing}" if existing else ld_prefix

        # Import lazily so environments that only use classic OCR do not pay the VL import cost.
        try:
            from paddleocr import PaddleOCRVL
        except Exception as exc:
            raise RuntimeError(
                "PaddleOCR-VL unavailable in this environment. "
                "The installed paddleocr package does not expose PaddleOCRVL."
            ) from exc

        pipeline = PaddleOCRVL(
            device=cfg["device"],
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_layout_detection=False,
            use_queues=False,
        )

        first = next(
            pipeline.predict_iter(
                path,
                max_new_tokens=cfg["max_new_tokens"],
                max_pixels=cfg["max_pixels"],
            ),
            None,
        )
        if first is None:
            raise RuntimeError("PaddleOCR-VL returned no pages")

        vl_lines = _extract_vl_text_lines(getattr(first, "markdown", None))
        if not vl_lines:
            raise RuntimeError("PaddleOCR-VL returned empty markdown_texts")

        structured = extract_structured([{"text": line, "confidence": 0.95} for line in vl_lines])
        structured["raw_text_lines"] = vl_lines
        out_queue.put({"ok": True, "structured": structured})
    except Exception as exc:
        out_queue.put({"ok": False, "error": _format_vl_exception(exc)})


def parse_receipt_path_with_score(path: str | Path) -> tuple[dict[str, Any], float]:
    path = str(path)

    ctx = mp.get_context("spawn")
    out_queue = ctx.Queue(maxsize=1)

    cfg = {
        "device": os.getenv("OCR_VL_DEVICE", "gpu:0"),
        "max_new_tokens": env_int("OCR_VL_MAX_NEW_TOKENS", 64, 16),
        "max_pixels": env_int("OCR_VL_MAX_PIXELS", 512 * 512, 65536),
        "timeout_seconds": env_int("OCR_VL_TIMEOUT_SECONDS", 30, 5),
        "ld_library_path_prefix": os.getenv("OCR_VL_LD_LIBRARY_PATH_PREFIX", "/usr/lib/wsl/lib"),
    }

    proc = ctx.Process(target=_vl_worker, args=(path, cfg, out_queue), daemon=True)
    proc.start()
    proc.join(cfg["timeout_seconds"])

    if proc.is_alive():
        proc.terminate()
        proc.join(5)
        raise TimeoutError(f"PaddleOCR-VL timed out after {cfg['timeout_seconds']}s")

    if out_queue.empty():
        raise RuntimeError("PaddleOCR-VL exited without output")

    result = out_queue.get()
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "Unknown PaddleOCR-VL failure"))

    structured = result["structured"]
    return structured, score_structured(structured)


def parse_receipt_path(path: str | Path) -> dict[str, Any]:
    structured, score = parse_receipt_path_with_score(path)
    structured.setdefault("warnings", [])
    structured["confidence_score"] = round(score, 2)
    structured["parse_engine"] = "paddleocr-vl"
    structured["parse_version"] = os.getenv("OCR_VL_PARSE_VERSION", "paddleocr-vl-v1")
    return structured


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/parse-receipt")
async def parse_receipt(file: UploadFile = File(...)) -> dict[str, Any]:
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
            return parse_receipt_path(tmp.name)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"VL OCR failed: {exc}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001, reload=False)
