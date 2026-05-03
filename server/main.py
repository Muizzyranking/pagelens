import os
import time
import json
import logging
from collections import defaultdict
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s"
)
log = logging.getLogger("pagelens")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
)

ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost,http://127.0.0.1,chrome-extension://your-extension-id",
).split(",")

RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "10"))
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "60"))

MAX_CONTENT_CHARS = 40_000

_rate_store: dict[str, list[float]] = defaultdict(list)


def check_rate_limit(ip: str) -> None:
    now = time.time()
    calls = _rate_store[ip]
    _rate_store[ip] = [t for t in calls if now - t < RATE_LIMIT_WINDOW]
    if len(_rate_store[ip]) >= RATE_LIMIT_REQUESTS:
        retry_after = int(RATE_LIMIT_WINDOW - (now - _rate_store[ip][0]))
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded. Try again in {retry_after}s.",
            headers={"Retry-After": str(retry_after)},
        )
    _rate_store[ip].append(now)


class SummarizeRequest(BaseModel):
    content: str = Field(..., min_length=50, description="Extracted page text")
    title: str = Field("", max_length=300, description="Page title")
    url: str = Field("", max_length=2000, description="Page URL")
    summary_length: str = Field("standard", description="brief | standard | detailed")

    @field_validator("content")
    @classmethod
    def truncate_content(cls, v: str) -> str:
        return v[:MAX_CONTENT_CHARS]

    @field_validator("summary_length")
    @classmethod
    def validate_length(cls, v: str) -> str:
        if v not in ("brief", "standard", "detailed"):
            return "standard"
        return v


class SummaryResponse(BaseModel):
    summary: list[str]
    key_insights: list[str]
    reading_time_minutes: int
    highlight_phrases: list[str]
    word_count: int


BULLET_COUNTS = {"brief": 3, "standard": 5, "detailed": 8}


def build_prompt(req: SummarizeRequest) -> str:
    bullets = BULLET_COUNTS.get(req.summary_length, 5)
    return f"""You are PageLens, a precise web page summarizer.
Analyze the content below and respond with ONLY a valid JSON object — no markdown fences, no extra text.

Page title: {req.title or "Unknown"}
Page URL:   {req.url or "Unknown"}

Required JSON shape:
{{
  "summary": ["{bullets} concise bullet strings summarizing the main content"],
  "key_insights": ["2-3 non-obvious insights or takeaways"],
  "reading_time_minutes": <integer, estimated reading time>,
  "highlight_phrases": ["5-8 exact short phrases from the text worth highlighting"],
  "word_count": <integer, approximate word count of the original content>
}}

Rules:
- summary must have exactly {bullets} items
- key_insights must have 2-3 items
- highlight_phrases must be verbatim short phrases (3-8 words) that appear in the text. The longer the article, the more highlight_phrases you should return.
- reading_time_minutes: assume 200 words/min reading speed
- Return ONLY the JSON object, nothing else

Content to summarize:
---
{req.content}
---"""


app = FastAPI(
    title="PageLens API",
    version="1.0.0",
    description="Proxy server for the PageLens Chrome extension.",
    docs_url="/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health():
    """Quick liveness check — useful for Render health checks."""
    key_set = bool(GEMINI_API_KEY)
    return {"status": "ok", "model": GEMINI_MODEL, "api_key_set": key_set}


@app.post("/summarize", response_model=dict)
async def summarize(req: SummarizeRequest, request: Request) -> Any:
    if not GEMINI_API_KEY:
        log.error("GEMINI_API_KEY not set")
        raise HTTPException(
            status_code=503, detail="Server misconfigured: API key missing."
        )

    client_ip = request.client.host if request.client else "unknown"
    check_rate_limit(client_ip)

    prompt = build_prompt(req)
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 4096,
        },
    }

    log.info(
        f"Summarizing '{req.title[:60]}' for {client_ip} (length={req.summary_length})"
    )
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(GEMINI_URL, json=payload)
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Gemini API timed out. Try again.")
    except httpx.RequestError as e:
        log.error(f"Network error calling Gemini: {e}")
        raise HTTPException(status_code=502, detail="Could not reach Gemini API.")

    if resp.status_code != 200:
        log.error(f"Gemini error {resp.status_code}: {resp.text[:200]}")
        raise HTTPException(
            status_code=502, detail=f"Gemini API error: {resp.status_code}"
        )

    try:
        gemini_data = resp.json()
        raw_text = gemini_data["candidates"][0]["content"]["parts"][0]["text"]
        raw_text = (
            raw_text.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
        )
        summary_data = json.loads(raw_text)
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        log.error(f"Failed to parse Gemini response: {e} | raw: {resp.text[:300]}")
        raise HTTPException(
            status_code=502, detail="Unexpected response format from Gemini."
        )

    for array_field in ("summary", "key_insights", "highlight_phrases"):
        val = summary_data.get(array_field)
        if val is None:
            summary_data[array_field] = []
        elif isinstance(val, str):
            parts = [
                p.strip(" •-–")
                for p in val.replace(";", "\n").splitlines()
                if p.strip()
            ]
            summary_data[array_field] = parts if parts else [val]
        elif not isinstance(val, list):
            summary_data[array_field] = [str(val)]

    for int_field in ("reading_time_minutes", "word_count"):
        val = summary_data.get(int_field)
        if val is None:
            summary_data[int_field] = 0
        else:
            try:
                summary_data[int_field] = int(val)
            except (TypeError, ValueError):
                summary_data[int_field] = 0

    if not summary_data["summary"]:
        raise HTTPException(status_code=502, detail="Gemini returned an empty summary.")

    log.info(f"Summary complete — {summary_data.get('word_count', '?')} words")
    return summary_data


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
