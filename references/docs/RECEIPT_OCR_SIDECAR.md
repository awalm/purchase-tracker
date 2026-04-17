# Receipt OCR Sidecar (PaddleOCR)

This project can run receipt OCR as an optional local sidecar container.

## Why sidecar
- Keep API/backend contract in Rust.
- Keep OCR model/runtime isolated and replaceable.
- Fail loudly if OCR service is down.

## Services
- Rust backend endpoint: `POST /api/import/receipt-image`
- OCR sidecar endpoint: `POST /parse-receipt`

## Service architecture
- `ocr-service-orchestrator.py`: API entrypoint and confidence-based routing.
- `ocr-service.py`: classic PaddleOCR engine endpoint (det/rec path only).
- `ocr-service-llm.py`: PaddleOCR-VL engine endpoint.

Internal modules:
- `ocr_service_orchestrator.py`: orchestrator logic.
- `ocr_service_classic_engine.py`: classic OCR implementation.
- `ocr_service_llm_engine.py`: VL implementation.
- `ocr_service_common.py`: shared parsing/scoring helpers.

## Start with OCR enabled
```bash
ENABLE_RECEIPT_OCR=1 ./start.sh
```

Optional port override:
```bash
ENABLE_RECEIPT_OCR=1 RECEIPT_OCR_PORT=8001 ./start.sh
```

## Backend config
Set OCR service URL (already present in `backend/.env`):

`OCR_SERVICE_URL=http://localhost:8001`

## Parse response shape
The Rust endpoint returns:
- `vendor_name`
- `receipt_number`
- `receipt_date`
- `subtotal`
- `tax`
- `total`
- `line_items[]` (`description`, `quantity`, `unit_cost`, `line_total`, `confidence`)
- `warnings[]`
- `raw_text_lines[]` (best-effort OCR text)
- `confidence_score` (heuristic parse score)
- `parse_engine` (`paddleocr` or `paddleocr-vl`)

## Low-Confidence VL fallback
The sidecar now parses with classic PaddleOCR first. If the parse is low-confidence,
it attempts a bounded PaddleOCR-VL fallback and switches to the VL result when fallback succeeds.

Environment controls:
- `OCR_CLASSIC_DEVICE` (default `gpu:0`): classic OCR device. Use `cpu` only if your host supports the Paddle CPU pipeline reliably.
- `OCR_CLASSIC_USE_DOC_ORIENTATION` (default `0`): keep disabled for lower memory.
- `OCR_CLASSIC_USE_DOC_UNWARPING` (default `0`): keep disabled for lower memory.
- `OCR_CLASSIC_USE_TEXTLINE_ORIENTATION` (default `0`): keep disabled unless needed.
- `OCR_VL_ENABLED` (default `1`): enable/disable VL fallback.
- `OCR_LOW_CONFIDENCE_THRESHOLD` (default `8.0`): below this score, VL fallback is attempted.
- `OCR_VL_DEVICE` (default `gpu:0`): VL device (`gpu:0` or `cpu`).
- `OCR_VL_MAX_NEW_TOKENS` (default `64`): hard generation cap to prevent unbounded decode.
- `OCR_VL_MAX_PIXELS` (default `262144`): hard image size cap for VL inference.
- `OCR_VL_TIMEOUT_SECONDS` (default `120`): process timeout for VL fallback.
- `OCR_VL_STRICT` (default `0`): if `1`, fallback failures raise an error instead of returning classic OCR.

If classic OCR succeeds but fallback fails and `OCR_VL_STRICT=0`, the sidecar keeps the classic parse and adds a visible warning.
If classic OCR fails and VL fallback also fails, the sidecar raises an error (fail-loud).

## PaddleOCR-VL runtime prerequisites
For Blackwell/RTX 50-series GPUs, use a cu129-compatible stack:

```bash
python -m pip install paddlepaddle-gpu==3.3.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu129/
python -m pip install -U "paddleocr[doc-parser]"
export LD_LIBRARY_PATH=/usr/lib/wsl/lib:$LD_LIBRARY_PATH
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
```

## Notes
- This is best-effort extraction. UI must require user confirmation before save.
- Current line-item extraction is heuristic and intentionally conservative.
- If OCR is unavailable or fails, backend returns a visible `502` error.
- First parse can be slow (model warm-up/download). The compose service mounts `./data/ocr-cache` to `/root/.paddleocr` so model files are reused across restarts.
