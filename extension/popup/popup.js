// pop up scrupt
"use strict";

const MSG = {
  SUMMARIZE_PAGE:   "PAGELENS_SUMMARIZE_PAGE",
  GET_CACHED:       "PAGELENS_GET_CACHED",
  CLEAR_CACHE_URL:  "PAGELENS_CLEAR_CACHE_URL",
  GET_SETTINGS:     "PAGELENS_GET_SETTINGS",
  APPLY_HIGHLIGHTS: "PAGELENS_APPLY_HIGHLIGHTS",
  CLEAR_HIGHLIGHTS: "PAGELENS_CLEAR_HIGHLIGHTS",
};

const $ = id => document.getElementById(id);

const stateIdle     = $("stateIdle");
const stateLoading  = $("stateLoading");
const stateError    = $("stateError");
const stateSummary  = $("stateSummary");

const pageTitle     = $("pageTitle");
const cacheBadge    = $("cacheBadge");
const loadingLabel  = $("loadingLabel");
const errorMessage  = $("errorMessage");

const summaryList   = $("summaryList");
const insightList   = $("insightList");
const insightsSection = $("insightsSection");
const highlightActionRow = $("highlightActionRow");
const highlightFailMsg   = $("highlightFailMsg");
const sidebarBtn         = $("sidebarBtn");

const statReadTime  = $("statReadTime");
const statWordCount = $("statWordCount");
const statBullets   = $("statBullets");

const summarizeBtn  = $("summarizeBtn");
const summarizeBtnLabel = $("summarizeBtnLabel");
const retryBtn      = $("retryBtn");
const copyBtn       = $("copyBtn");
const clearBtn      = $("clearBtn");
const highlightBtn  = $("highlightBtn");
const settingsBtn   = $("settingsBtn");

// state
let currentSummary   = null;
let currentUrl       = "";
let highlightsActive = false;
let settings         = {};

function applyTheme(theme) {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  if (theme === "light" || theme === "dark") {
    root.setAttribute("data-theme", theme);
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", prefersDark ? "dark" : "light");
  }
}

async function init() {
  const settingsResp = await sendToBackground({ type: MSG.GET_SETTINGS });
  settings = settingsResp?.settings || {};
  applyTheme(settings.theme || "auto");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = tab?.url || "";
  const title = tab?.title || "Unknown page";
  pageTitle.textContent = title.length > 80 ? title.slice(0, 80) + "…" : title;

  if (currentUrl) {
    const cached = await sendToBackground({ type: MSG.GET_CACHED, url: currentUrl });
    if (cached?.summary) {
      renderSummary(cached.summary, true);
      return;
    }
  }

  showState("idle");
}

function showState(name) {
  stateIdle.hidden    = name !== "idle";
  stateLoading.hidden = name !== "loading";
  stateError.hidden   = name !== "error";
  stateSummary.hidden = name !== "summary";

  copyBtn.hidden  = name !== "summary";
  clearBtn.hidden = name !== "summary";

  if (name === "loading") {
    summarizeBtn.classList.add("loading");
    summarizeBtnLabel.textContent = "Summarizing…";
    summarizeBtn.setAttribute("aria-disabled", "true");
  } else {
    summarizeBtn.classList.remove("loading");
    summarizeBtnLabel.textContent = name === "summary" ? "Re-summarize" : "Summarize Page";
    summarizeBtn.removeAttribute("aria-disabled");
  }
}

async function summarize() {
  showState("loading");
  setLoadingMessage("Reading page…");

  const messages = [
    "Reading page…",
    "Extracting content…",
    "Asking Gemini…",
    "Building summary…",
  ];
  let msgIdx = 0;
  const msgInterval = setInterval(() => {
    msgIdx = (msgIdx + 1) % messages.length;
    setLoadingMessage(messages[msgIdx]);
  }, 1200);

  try {
    const resp = await sendToBackground({ type: MSG.SUMMARIZE_PAGE });
    clearInterval(msgInterval);

    if (!resp?.ok) {
      showError(resp?.error || "Something went wrong. Please try again.");
      return;
    }

    currentSummary = resp.summary;
    renderSummary(resp.summary, resp.fromCache || false);
  } catch (err) {
    clearInterval(msgInterval);
    showError(err.message || "Unexpected error.");
  }
}

function setLoadingMessage(msg) {
  loadingLabel.textContent = msg;
}

function showError(msg) {
  errorMessage.textContent = msg;
  showState("error");
}

// Normalise summary fields — guards against Gemini returning strings not arrays
function normaliseSummary(summary) {
  const toArray = v => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return v.split(/\n|;/).map(s => s.replace(/^[\s•\-–]+/, "").trim()).filter(Boolean);
    return [String(v)];
  };
  return {
    ...summary,
    summary:           toArray(summary.summary),
    key_insights:      toArray(summary.key_insights),
    highlight_phrases: toArray(summary.highlight_phrases),
    reading_time_minutes: Number(summary.reading_time_minutes) || 0,
    word_count:           Number(summary.word_count) || 0,
  };
}

function renderSummary(rawSummary, fromCache) {
  const summary = normaliseSummary(rawSummary);
  currentSummary = summary;

  statReadTime.textContent  = summary.reading_time_minutes || "—";
  statWordCount.textContent = summary.word_count ? formatNumber(summary.word_count) : "—";
  statBullets.textContent   = summary.summary.length;

  cacheBadge.hidden = !fromCache;

  summaryList.innerHTML = "";
  summary.summary.forEach((bullet, i) => {
    const li = document.createElement("li");
    li.textContent = bullet;
    li.style.animationDelay = `${i * 60}ms`;
    summaryList.appendChild(li);
  });

  insightList.innerHTML = "";
  const insights = summary.key_insights;
  insightsSection.hidden = insights.length === 0;
  insights.forEach((insight, i) => {
    const li = document.createElement("li");
    li.textContent = insight;
    li.style.animationDelay = `${(i + summary.summary.length) * 60}ms`;
    insightList.appendChild(li);
  });

  const phrases = summary.highlight_phrases;
  highlightActionRow.hidden = phrases.length === 0;
  highlightFailMsg.hidden   = true;
  highlightBtn.classList.remove("active");
  highlightBtn.textContent  = "";
  highlightBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13l2-5 6-6 3 3-6 6-5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 4l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Highlight`;

  showState("summary");
}

async function toggleHighlights() {
  if (!currentSummary) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (highlightsActive) {
    chrome.tabs.sendMessage(tab.id, { type: MSG.CLEAR_HIGHLIGHTS });
    highlightsActive = false;
    highlightBtn.classList.remove("active");
    highlightBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13l2-5 6-6 3 3-6 6-5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 4l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Highlight`;
    highlightFailMsg.hidden = true;
    return;
  }

  const phrases = currentSummary.highlight_phrases || [];
  const resp = await new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, {
      type: MSG.APPLY_HIGHLIGHTS,
      phrases,
      mode: "inject",
      summary: currentSummary,
    }, resolve);
  });

  if (!resp?.count || resp.count === 0) {
    highlightFailMsg.hidden = false;
  } else {
    highlightsActive = true;
    highlightFailMsg.hidden = true;
    highlightBtn.classList.add("active");
    highlightBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13l2-5 6-6 3 3-6 6-5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 4l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Clear`;
  }
}

async function openSidebar() {
  if (!currentSummary) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type:    MSG.APPLY_HIGHLIGHTS,
    phrases: currentSummary.highlight_phrases || [],
    mode:    "sidebar",
    summary: currentSummary,
  });
  window.close();
}

async function copySummary() {
  if (!currentSummary) return;

  const lines = [
    "PageLens Summary",
    "─────────────────",
    "",
    "📝 Summary",
    ...(currentSummary.summary || []).map(b => `• ${b}`),
    "",
    "💡 Key Insights",
    ...(currentSummary.key_insights || []).map(i => `→ ${i}`),
    "",
    `⏱ Reading time: ${currentSummary.reading_time_minutes ?? "?"} min`,
    `📖 Word count: ${currentSummary.word_count ?? "?"}`,
  ];

  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    copyBtn.style.color = "var(--moss-300)";
    setTimeout(() => {
      copyBtn.innerHTML = `
        <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
          <path d="M2 10V2h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Copy`;
      copyBtn.style.color = "";
    }, 1800);
  } catch (_) {
    copyBtn.textContent = "Failed";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  }
}

async function clearSummary() {
  if (currentUrl) {
    await sendToBackground({ type: MSG.CLEAR_CACHE_URL, url: currentUrl });
  }

  if (highlightsActive) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.CLEAR_HIGHLIGHTS }).catch(() => {});
    }
    highlightsActive = false;
  }

  currentSummary = null;
  cacheBadge.hidden = true;
  highlightBtn.classList.remove("active");
  showState("idle");
}

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, resp => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

function formatNumber(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

summarizeBtn.addEventListener("click", () => {
  if (!summarizeBtn.classList.contains("loading")) summarize();
});

retryBtn.addEventListener("click", summarize);

highlightBtn.addEventListener("click", toggleHighlights);
sidebarBtn.addEventListener("click", openSidebar);

copyBtn.addEventListener("click", copySummary);

clearBtn.addEventListener("click", clearSummary);

settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
    const state = stateSummary.hidden ? (stateLoading.hidden ? "idle" : "loading") : "summary";
    if (state === "idle") summarize();
  }
});

init().catch(err => {
  console.error("[PageLens] Init error:", err);
  showError("Failed to initialise. Try reopening the popup.");
});
