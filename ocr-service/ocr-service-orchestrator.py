from ocr_service_orchestrator import _http_workers


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "ocr_service_orchestrator:app",
        host="0.0.0.0",
        port=8001,
        reload=False,
        workers=_http_workers(),
    )
