import os
import tempfile
from pathlib import Path
from typing import Any

import cv2
import fitz
import numpy as np
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from paddleocr import PaddleOCR

from ocr_service_common import env_bool, env_float, extract_structured, score_structured


app = FastAPI(title="bg-tracker-receipt-ocr-classic")

_classic_ocr: PaddleOCR | None = None


def get_classic_ocr() -> PaddleOCR:
    global _classic_ocr
    if _classic_ocr is None:
        lang = os.getenv("PADDLEOCR_LANG", "en")
        device = os.getenv("OCR_CLASSIC_DEVICE", "cpu")
        use_gpu = device.lower().startswith("gpu")

        # Prefer the PaddleOCR 3.x initialization shape first.
        try:
            _classic_ocr = PaddleOCR(
                lang=lang,
                use_doc_orientation_classify=env_bool("OCR_CLASSIC_USE_DOC_ORIENTATION", False),
                use_doc_unwarping=env_bool("OCR_CLASSIC_USE_DOC_UNWARPING", False),
                use_textline_orientation=env_bool("OCR_CLASSIC_USE_TEXTLINE_ORIENTATION", False),
                text_det_box_thresh=env_float("OCR_CLASSIC_TEXT_DET_BOX_THRESH", 0.45, 0.0),
                text_det_unclip_ratio=env_float("OCR_CLASSIC_TEXT_DET_UNCLIP_RATIO", 1.8, 0.1),
                text_rec_score_thresh=env_float("OCR_CLASSIC_TEXT_REC_SCORE_THRESH", 0.20, 0.0),
                device=device,
            )
        except TypeError:
            # Fallback for PaddleOCR 2.x API.
            _classic_ocr = PaddleOCR(
                lang=lang,
                use_angle_cls=env_bool("OCR_CLASSIC_USE_TEXTLINE_ORIENTATION", False),
                use_gpu=use_gpu,
                show_log=False,
            )
    return _classic_ocr


def _extract_lines_from_predict_results(results: list[Any]) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for result in results:
        payload: Any = result
        if not isinstance(payload, dict) and hasattr(payload, "to_dict"):
            try:
                payload = payload.to_dict()
            except Exception:
                payload = None
        if not isinstance(payload, dict):
            continue

        texts = payload.get("rec_texts") or []
        scores = payload.get("rec_scores") or []
        if isinstance(texts, str):
            texts = [texts]

        for i, text in enumerate(texts):
            if not text:
                continue
            confidence = 0.0
            if i < len(scores):
                try:
                    confidence = float(scores[i])
                except (TypeError, ValueError):
                    confidence = 0.0
            lines.append({"text": str(text), "confidence": confidence})
    return lines


def _run_classic_ocr(ocr: PaddleOCR, image_or_path: Any) -> list[dict[str, Any]]:
    predict_fn = getattr(ocr, "predict", None)
    if callable(predict_fn):
        predict_results = list(predict_fn(image_or_path))
        return _extract_lines_from_predict_results(predict_results)

    legacy_ocr_fn = getattr(ocr, "ocr", None)
    if callable(legacy_ocr_fn):
        legacy_results = legacy_ocr_fn(
            image_or_path,
            cls=env_bool("OCR_CLASSIC_USE_TEXTLINE_ORIENTATION", False),
        )
        return _extract_lines_from_legacy_results(legacy_results)

    raise RuntimeError("Classic engine could not find a supported PaddleOCR API (predict/ocr).")


def _extract_lines_from_legacy_results(results: Any) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if not isinstance(node, (list, tuple)):
            return

        if len(node) >= 2 and isinstance(node[0], (list, tuple)):
            second = node[1]
            if isinstance(second, (list, tuple)) and len(second) >= 1 and isinstance(second[0], str):
                text = second[0].strip()
                if text:
                    confidence = 0.0
                    if len(second) >= 2:
                        try:
                            confidence = float(second[1])
                        except (TypeError, ValueError):
                            confidence = 0.0
                    lines.append({"text": text, "confidence": confidence})
                return
            if isinstance(second, str):
                text = second.strip()
                if text:
                    lines.append({"text": text, "confidence": 0.0})
                return

        for child in node:
            walk(child)

    walk(results)
    return lines


def _rotate_bound(image: np.ndarray, angle: float) -> np.ndarray:
    height, width = image.shape[:2]
    center = (width / 2, height / 2)
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    cos = abs(matrix[0, 0])
    sin = abs(matrix[0, 1])

    new_width = int((height * sin) + (width * cos))
    new_height = int((height * cos) + (width * sin))

    matrix[0, 2] += (new_width / 2) - center[0]
    matrix[1, 2] += (new_height / 2) - center[1]
    return cv2.warpAffine(
        image,
        matrix,
        (new_width, new_height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _auto_crop_document(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return image

    contour = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(contour)
    if area < 0.20 * (height * width):
        return image

    x, y, crop_w, crop_h = cv2.boundingRect(contour)
    pad_x = int(crop_w * 0.02)
    pad_y = int(crop_h * 0.02)

    x0 = max(0, x - pad_x)
    y0 = max(0, y - pad_y)
    x1 = min(width, x + crop_w + pad_x)
    y1 = min(height, y + crop_h + pad_y)

    cropped = image[y0:y1, x0:x1]
    if cropped.size == 0:
        return image
    return cropped


def _deskew(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.bitwise_not(gray)
    thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(thresh > 0))
    if len(coords) < 200:
        return image

    angle = cv2.minAreaRect(coords)[-1]
    if angle < -45:
        angle = -(90 + angle)
    else:
        angle = -angle

    if abs(angle) > 20:
        return image

    return _rotate_bound(image, angle)


def _enhance_for_ocr(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    gray = cv2.fastNlMeansDenoising(gray, None, 15, 7, 21)
    bw = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        35,
        11,
    )
    return cv2.cvtColor(bw, cv2.COLOR_GRAY2BGR)


def _build_image_candidates(image: np.ndarray) -> list[tuple[str, np.ndarray]]:
    base = _auto_crop_document(image)
    base = _deskew(base)
    enhanced = _enhance_for_ocr(base)

    variants: list[tuple[str, np.ndarray]] = [
        ("base", base),
        ("enhanced", enhanced),
        ("rot90", cv2.rotate(base, cv2.ROTATE_90_CLOCKWISE)),
        ("rot270", cv2.rotate(base, cv2.ROTATE_90_COUNTERCLOCKWISE)),
    ]

    deduped: list[tuple[str, np.ndarray]] = []
    seen_shapes: set[tuple[str, int, int]] = set()
    for name, img in variants:
        key = (name, img.shape[0], img.shape[1])
        if key in seen_shapes:
            continue
        seen_shapes.add(key)
        deduped.append((name, img))
    return deduped


def _score_lines(lines: list[dict[str, Any]]) -> float:
    if not lines:
        return -1.0
    avg_conf = sum(line["confidence"] for line in lines) / max(1, len(lines))
    text = " ".join(line["text"].lower() for line in lines)
    keyword_bonus = 0.0
    for kw in ("total", "subtotal", "tax", "invoice", "receipt"):
        if kw in text:
            keyword_bonus += 0.2
    return len(lines) * avg_conf + keyword_bonus


def _ocr_best_from_candidates(candidates: list[tuple[str, np.ndarray]]) -> list[dict[str, Any]]:
    ocr = get_classic_ocr()
    best_lines: list[dict[str, Any]] = []
    best_score = -1.0

    for _, image in candidates:
        lines = _run_classic_ocr(ocr, image)
        score = _score_lines(lines)
        if score > best_score:
            best_score = score
            best_lines = lines

    return best_lines


def _images_from_pdf(path: str | Path) -> list[np.ndarray]:
    images: list[np.ndarray] = []
    doc = fitz.open(str(path))
    try:
        for page in doc:
            pix = page.get_pixmap(dpi=300, alpha=False)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 4:
                arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
            else:
                arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
            images.append(arr)
    finally:
        doc.close()
    return images


def parse_receipt_path_with_score(path: str | Path) -> tuple[dict[str, Any], float]:
    path = str(path)

    if path.lower().endswith(".pdf"):
        lines: list[dict[str, Any]] = []
        pages = _images_from_pdf(path)
        for image in pages:
            candidates = _build_image_candidates(image)
            lines.extend(_ocr_best_from_candidates(candidates))
        if not lines:
            raise ValueError("No text detected in receipt image")
        structured = extract_structured(lines)
        return structured, score_structured(structured)

    image = cv2.imread(path)
    if image is None:
        raise ValueError("Unable to decode image")

    candidates = _build_image_candidates(image)

    best_structured: dict[str, Any] | None = None
    best_score = -1.0
    best_lines: list[dict[str, Any]] = []

    for _, candidate in candidates:
        lines = _run_classic_ocr(get_classic_ocr(), candidate)
        if not lines:
            continue

        structured = extract_structured(lines)
        score = score_structured(structured)
        if score > best_score:
            best_score = score
            best_structured = structured
            best_lines = lines

    if best_structured is None and not best_lines:
        raise ValueError("No text detected in receipt image")

    if best_structured is not None:
        return best_structured, best_score

    fallback_structured = extract_structured(best_lines)
    return fallback_structured, score_structured(fallback_structured)


def parse_receipt_path(path: str | Path) -> dict[str, Any]:
    structured, score = parse_receipt_path_with_score(path)
    structured.setdefault("warnings", [])
    structured["confidence_score"] = round(score, 2)
    structured["parse_engine"] = "paddleocr"
    structured["parse_version"] = os.getenv("OCR_CLASSIC_PARSE_VERSION", "paddleocr-classic-v1")
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
            raise HTTPException(status_code=422, detail=f"Classic OCR failed: {exc}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001, reload=False)
