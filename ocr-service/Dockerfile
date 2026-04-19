FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgl1 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy OCR service source files explicitly to avoid missing-module issues.
COPY ocr_service_common.py ./
COPY ocr_service_classic_engine.py ./
COPY ocr_service_llm_engine.py ./
COPY ocr_service_orchestrator.py ./
COPY ocr-service-orchestrator.py ./

EXPOSE 8001

CMD ["python", "ocr-service-orchestrator.py"]
