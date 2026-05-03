"use strict";

const SERVER_URL = "http://localhost:8000";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const MSG = {
  SUMMARIZE_PAGE: "PAGELENS_SUMMARIZE_PAGE",
  GET_CACHED: "PAGELENS_GET_CACHED",
  CLEAR_CACHE_URL: "PAGELENS_CLEAR_CACHE_URL",
  GET_SETTINGS: "PAGELENS_GET_SETTINGS",
  SAVE_SETTINGS: "PAGELENS_SAVE_SETTINGS",

  EXTRACT_CONTENT: "PAGELENS_EXTRACT_CONTENT",
  APPLY_HIGHLIGHTS: "PAGELENS_APPLY_HIGHLIGHTS",
  CLEAR_HIGHLIGHTS: "PAGELENS_CLEAR_HIGHLIGHTS",
  PING: "PAGELENS_PING",
};

const DEFAULT_SETTINGS = {
  highlight_mode: "inject",
  summary_length: "standard",
  theme: "auto",
  auto_highlight: false,
  server_url: SERVER_URL,
  sidebar_position: "right",
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return false;

  switch (msg.type) {
    case MSG.SUMMARIZE_PAGE:
      handleSummarizePage(sendResponse);
      return true;

    case MSG.GET_CACHED:
      handleGetCached(msg.url, sendResponse);
      return true;

    case MSG.CLEAR_CACHE_URL:
      handleClearCacheUrl(msg.url, sendResponse);
      return true;

    case MSG.GET_SETTINGS:
      handleGetSettings(sendResponse);
      return true;

    case MSG.SAVE_SETTINGS:
      handleSaveSettings(msg.settings, sendResponse);
      return true;

    default:
      return false;
  }
});

async function handleSummarizePage(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) {
      return sendResponse({ ok: false, error: "No active tab found." });
    }

    const url = tab.url || "";

    if (!url || url === "about:blank") {
      return sendResponse({
        ok: false,
        error: "Nothing to summarize on a blank page.",
      });
    }
    if (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("edge://") ||
      url.startsWith("about:")
    ) {
      return sendResponse({
        ok: false,
        error: "PageLens can't summarize browser system pages.",
      });
    }
    if (
      url.endsWith(".pdf") ||
      url.includes("/pdf/") ||
      tab.title?.toLowerCase().includes(".pdf")
    ) {
      return sendResponse({
        ok: false,
        error:
          "PDF summarization isn't supported yet. Try copying the text manually.",
      });
    }
    if (url.startsWith("file://")) {
      return sendResponse({
        ok: false,
        error:
          "Local file pages aren't supported. Host the file on a server or use a URL.",
      });
    }

    const cached = await getCachedSummary(url);
    if (cached) {
      console.log("[PageLens] Cache hit for", url);
      return sendResponse({ ok: true, summary: cached, fromCache: true });
    }

    const alive = await pingContentScript(tab.id);
    if (!alive) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/readability.min.js", "content/content-script.js"],
        });
        await sleep(150);
      } catch (err) {
        return sendResponse({
          ok: false,
          error: "Could not inject content script. Try refreshing the page.",
        });
      }
    }

    const extraction = await sendToContentScript(tab.id, {
      type: MSG.EXTRACT_CONTENT,
    });
    if (!extraction?.ok) {
      return sendResponse({
        ok: false,
        error: extraction?.error || "Could not extract page content.",
      });
    }

    const settings = await loadSettings();

    const summary = await callServer(
      extraction.content,
      extraction.title,
      extraction.url,
      settings.summary_length,
      settings.server_url,
    );

    await cacheSummary(url, summary);

    if (settings.auto_highlight && settings.highlight_mode !== "off") {
      await sendToContentScript(tab.id, {
        type: MSG.APPLY_HIGHLIGHTS,
        phrases: summary.highlight_phrases || [],
        mode: settings.highlight_mode,
        summary,
      });
    }

    sendResponse({ ok: true, summary, fromCache: false });
  } catch (err) {
    console.error("[PageLens] Summarize error:", err);
    sendResponse({
      ok: false,
      error: err.message || "An unexpected error occurred.",
    });
  }
}

async function callServer(content, title, url, summary_length, serverUrl) {
  const endpoint = `${serverUrl || SERVER_URL}/summarize`;

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, title, url, summary_length }),
    });
  } catch (err) {
    if (
      err.message.includes("Failed to fetch") ||
      err.message.includes("NetworkError")
    ) {
      throw new Error(
        "Cannot reach the PageLens server. Is it running on localhost:8000?",
      );
    }
    throw err;
  }

  if (resp.status === 429) {
    const retryAfter = resp.headers.get("Retry-After") || "60";
    throw new Error(`Rate limit hit. Please wait ${retryAfter} seconds.`);
  }

  if (!resp.ok) {
    let detail = `Server error (${resp.status})`;
    try {
      detail = (await resp.json()).detail || detail;
    } catch (_) {}
    throw new Error(detail);
  }

  return await resp.json();
}

function cacheKey(url) {
  return `cache:${url}`;
}

async function getCachedSummary(url) {
  try {
    const key = cacheKey(url);
    const data = await chrome.storage.local.get(key);
    const entry = data[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      await chrome.storage.local.remove(key);
      return null;
    }
    return entry.summary;
  } catch (_) {
    return null;
  }
}

async function cacheSummary(url, summary) {
  try {
    const key = cacheKey(url);
    await chrome.storage.local.set({ [key]: { summary, ts: Date.now() } });
  } catch (_) {
    // storage errors are non-fatal
  }
}

async function handleGetCached(url, sendResponse) {
  const cached = await getCachedSummary(url);
  sendResponse({ ok: true, summary: cached });
}

async function handleClearCacheUrl(url, sendResponse) {
  try {
    await chrome.storage.local.remove(cacheKey(url));
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

async function loadSettings() {
  try {
    const data = await chrome.storage.sync.get("pagelens_settings");
    return { ...DEFAULT_SETTINGS, ...(data.pagelens_settings || {}) };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

async function handleGetSettings(sendResponse) {
  sendResponse({ ok: true, settings: await loadSettings() });
}

async function handleSaveSettings(partial, sendResponse) {
  try {
    const current = await loadSettings();
    const updated = { ...current, ...partial };
    await chrome.storage.sync.set({ pagelens_settings: updated });
    sendResponse({ ok: true, settings: updated });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

function pingContentScript(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: MSG.PING }, (resp) => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(resp?.ok === true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    await chrome.storage.sync.set({ pagelens_settings: DEFAULT_SETTINGS });
    console.log("[PageLens] Installed. Default settings applied.");
  }
});
