# PageLens — AI Page Summarizer

> A Chrome Extension (Manifest V3) that extracts, summarizes, and highlights content from any webpage using Gemini AI — with a FastAPI proxy server that keeps your API key secure.

![PageLens popup showing a structured summary with bullet points, key insights, reading time, and highlight controls]

---

## Table of Contents

1. [Features](#features)
2. [Quick Start](#quick-start)
3. [Installation](#installation)
4. [Architecture](#architecture)
5. [AI Integration](#ai-integration)
6. [Security Decisions](#security-decisions)
7. [Trade-offs](#trade-offs)
8. [Development Guide](#development-guide)

---

## Features

- **Structured summaries** — bullet-point summary, key insights, reading time, word count
- **Inline highlighting** — key phrases wrapped directly in the page DOM
- **Floating sidebar fallback** — auto-activates if the page blocks DOM injection
- **24-hour cache** — re-opening the popup on a cached URL is instant, no API call
- **User settings** — highlight mode, summary length (brief/standard/detailed), theme, server URL
- **Secure by design** — API key lives only on the server, never in the extension
- **Graceful errors** — rate limit messages, server-down detection, CSP fallbacks

---

## Quick Start

### Prerequisites

- Google Chrome (or Chromium) v114+
- Python 3.10+
- A [Gemini API key](https://aistudio.google.com/app/apikey) (free tier works)

---

## Installation

### 1 — Set up the server

```bash
cd server
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY
```

```bash
uv venv
uv pip install -r requirements.txt
```

```bash
uv run python main.py
# Server running at http://localhost:8000
# Docs at http://localhost:8000/docs
```

Verify it works:
```bash
curl http://localhost:8000/health
# {"status":"ok","model":"gemini-2.0-flash","api_key_set":true}
```

### 2 — Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repository
5. The PageLens icon will appear in your Chrome toolbar

### 3 — Add your extension ID to the server

After loading the extension, Chrome assigns it a unique ID (shown on the extensions page, e.g. `abcdefghijklmnopabcdefghijklmnop`).

Add it to `server/.env`:

```
ALLOWED_ORIGINS=http://localhost,http://127.0.0.1,chrome-extension://YOUR_EXTENSION_ID_HERE
```

Restart the server after editing `.env`.

### 4 — Use it

1. Navigate to any article or blog post
2. Click the PageLens icon in the Chrome toolbar
3. Click **Summarize Page**
4. The summary appears in ~3–5 seconds
5. Click **Highlight** to mark key phrases on the page

---

## Architecture

```
┌─────────────────────────── Chrome ──────────────────────────────┐
│                                                                  │
│  ┌──────────────┐   chrome.runtime    ┌────────────────────────┐│
│  │  Popup UI    │ ◄─────────────────► │  Background Service    ││
│  │  popup.js    │   message passing   │  Worker                ││
│  └──────────────┘                     │  service-worker.js     ││
│                                       │                        ││
│  ┌──────────────┐   chrome.runtime    │  • Orchestrates flow   ││
│  │ Content      │ ◄─────────────────► │  • Calls FastAPI       ││
│  │ Script       │                     │  • Manages cache       ││
│  │              │                     └────────────────────────┘│
│  │ • Readability│                              │ fetch()         │
│  │ • Highlights │   chrome.storage.local       │ HTTPS           │
│  │ • Sidebar    │ ◄──────────────────────────► │                 │
│  └──────────────┘   summaries + settings       ▼                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                                         │
                              ┌──────────▼──────────┐
                              │   FastAPI Server     │
                              │   localhost:8000     │
                              │                      │
                              │  POST /summarize     │
                              │  GET  /health        │
                              │                      │
                              │  • Validates input   │
                              │  • Injects API key   │
                              │  • Rate limits       │
                              │  • Returns JSON      │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │   Gemini API         │
                              │   gemini-2.0-flash   │
                              └─────────────────────┘
```

### File structure

```
ai-summarizer/
├── extension/
│   ├── manifest.json              # MV3 config, permissions
│   ├── popup/
│   │   ├── popup.html             # UI shell
│   │   ├── popup.css              # Design system + states
│   │   └── popup.js               # State machine, message passing
│   ├── background/
│   │   └── service-worker.js      # API calls, cache, routing
│   ├── content/
│   │   ├── readability.min.js     # Content extraction heuristics
│   │   ├── content-script.js      # DOM inject, highlights, sidebar
│   │   └── highlight.css          # Injected page styles
│   ├── settings/
│   │   ├── settings.html          # Options page
│   │   ├── settings.css           # Settings UI styles
│   │   └── settings.js            # Load/save settings logic
│   └── assets/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
│
└── server/
    ├── main.py                    # FastAPI application
    ├── .env.example               # Config template (safe to commit)
    ├── .env                       # Real secrets (never committed)
    └── requirements.txt
```

### Message flow

Every summarize action follows this sequence:

```
Popup                Background SW           Content Script        FastAPI
  │                       │                       │                  │
  │──SUMMARIZE_PAGE───────►│                       │                  │
  │                       │──PING─────────────────►│                  │
  │                       │◄──ok───────────────────│                  │
  │                       │                       │                  │
  │                       │  [check cache]         │                  │
  │                       │                       │                  │
  │                       │──EXTRACT_CONTENT───────►│                  │
  │                       │◄──{content,title,url}──│                  │
  │                       │                       │                  │
  │                       │──POST /summarize──────────────────────────►│
  │                       │◄──{summary JSON}───────────────────────────│
  │                       │                       │                  │
  │                       │  [write cache]         │                  │
  │◄──{ok, summary}───────│                       │                  │
  │                       │                       │                  │
  │──APPLY_HIGHLIGHTS─────────────────────────────►│                  │
```

### Caching

Summaries are stored in `chrome.storage.local` keyed by URL:

```
cache:https://example.com/article → { summary: {...}, ts: 1234567890 }
```

TTL is 24 hours. On every load the background SW checks the cache first — a hit returns immediately with no API call. Stale entries are pruned on access. Users can clear per-URL cache (Clear button in popup) or all summaries (Settings → Data).

---

## AI Integration

### Provider

**Gemini 2.0 Flash** via the REST API (`generativelanguage.googleapis.com`). Flash is chosen for its speed (~2–3s for typical articles) and generous free tier.

### Prompt design

The server sends a single-shot prompt instructing Gemini to return **only valid JSON** with a fixed schema:

```json
{
  "summary": ["bullet 1", "bullet 2", "..."],
  "key_insights": ["insight 1", "..."],
  "reading_time_minutes": 4,
  "highlight_phrases": ["exact phrase from text", "..."],
  "word_count": 1240
}
```

Key choices:
- `responseMimeType: "application/json"` in the generation config tells Gemini to constrain its output, reducing parse failures
- Temperature `0.3` — low enough for consistency, high enough to avoid robotic phrasing
- `highlight_phrases` are required to be **verbatim short phrases** from the source text (3–8 words), making DOM matching reliable
- Content is truncated to 40,000 characters (~10k tokens) before sending — covers virtually all articles without hitting context limits

### Content extraction

`readability.min.js` uses a scoring heuristic to identify the main article body:

1. Checks semantic tags first (`<article>`, `<main>`, `[role=main]`)
2. Scores all `<div>`, `<section>`, `<td>` candidates by text length, comma density (prose indicator), and link density (nav indicator)
3. Strips noise elements: `<nav>`, `<aside>`, `<footer>`, `<header>`, and elements matching ad/sidebar/nav class patterns
4. Returns clean text via `textContent` — no HTML, no XSS risk

---

## Security Decisions

### API key isolation
The Gemini API key exists **only** in `server/.env`. The extension never sees it. The background service worker calls the local FastAPI server over HTTP (localhost); the server makes the actual Gemini call with the key injected server-side.

### CORS lockdown
The server's `ALLOWED_ORIGINS` list only accepts requests from known Chrome extension origins (`chrome-extension://YOUR_ID`) and localhost. All other origins are rejected by FastAPI's CORS middleware before the route handler runs.

### Minimal permissions
The extension requests only:
- `activeTab` — read the current tab's URL/title
- `storage` — cache summaries and settings
- `scripting` — inject content script on demand if not already loaded

No `tabs`, no `history`, no `<all_urls>` host permission. The `host_permissions` entry covers only `localhost:8000`.

### Content sanitisation
Summary content is written to the DOM via `textContent` (never `innerHTML`) in both the popup and the sidebar — preventing any XSS from a malicious Gemini response.

Highlight injection uses `document.createTextNode` and `document.createElement` — no `innerHTML` path.

### Message validation
All `chrome.runtime` messages are validated by type string before any handler runs. Unknown message types are silently dropped. The background SW validates that `content` is at least 50 chars before calling the server.

### No secrets in source
`.env` is in `.gitignore`. The committed `.env.example` contains only placeholder values. Server logs never print the API key.

---

## Trade-offs

| Decision | Choice | Rationale | Trade-off |
|----------|--------|-----------|-----------|
| Content extraction | Custom heuristic (no external lib bundle) | No build step, small footprint | May miss unusual page structures that Mozilla Readability handles |
| AI provider | Gemini 2.0 Flash | Fast, free tier, strong JSON mode | Requires Google account; OpenAI/Claude could be swapped in by changing `main.py` |
| Cache store | `chrome.storage.local` | Zero infrastructure, works offline | Cleared when user wipes extension data; no cross-device sync for summaries |
| Rate limiting | In-memory dict in FastAPI | Simple, no Redis dependency | Resets on server restart; not suitable for multi-instance Render deployment without Redis |
| Highlight matching | Regex over text nodes | Accurate phrase matching | Complex DOM structures (React SPAs with fragmented text nodes) may get partial matches |
| Server deployment | localhost → Render | Simple dev setup | HTTPS required for Render; extension `manifest.json` and `host_permissions` must be updated with the production URL |

### Swapping to production (Render)

1. Deploy the `server/` folder to Render as a Python web service
2. Set `GEMINI_API_KEY` and `ALLOWED_ORIGINS` as Render environment variables
3. In `manifest.json`, replace `http://localhost:8000/*` in `host_permissions` with `https://your-app.onrender.com/*`
4. In `background/service-worker.js`, update `SERVER_URL`
5. In Settings, update the server URL in the extension

---

## Development Guide

### Run the server with auto-reload

```bash
cd server
source .venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Test the API directly

```bash
curl -X POST http://localhost:8000/summarize \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Artificial intelligence is transforming...",
    "title": "Test Article",
    "url": "https://example.com",
    "summary_length": "standard"
  }'
```

### Reload the extension after code changes

Go to `chrome://extensions` → click the **↺ refresh** icon on the PageLens card.  
For popup/content script changes, just reload the page and reopen the popup.

### View service worker logs

`chrome://extensions` → PageLens → **Service Worker** link → opens DevTools console for the background context.

### View content script logs

Open DevTools on any page (F12) → Console — content script logs appear here prefixed with `[PageLens]`.

---

## License

MIT
