"use strict";

const MSG = {
  GET_SETTINGS: "PAGELENS_GET_SETTINGS",
  SAVE_SETTINGS: "PAGELENS_SAVE_SETTINGS",
};

const DEFAULT_SETTINGS = {
  highlight_mode: "inject",
  summary_length: "standard",
  theme: "auto",
  auto_highlight: false,
  server_url: "http://localhost:8000",
};

let currentSettings = { ...DEFAULT_SETTINGS };
let dirty = false;

const saveBtn = document.getElementById("saveBtn");
const saveMsg = document.getElementById("saveMsg");
const serverUrlInput = document.getElementById("serverUrl");
const testServerBtn = document.getElementById("testServerBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const autoHighToggle = document.getElementById("autoHighlightToggle");
const clearCacheBtn = document.getElementById("clearCacheBtn");

function applyTheme(theme) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = theme === "auto" ? (prefersDark ? "dark" : "light") : theme;
  root.setAttribute("data-theme", resolved);
}

async function loadSettings() {
  const resp = await sendToBackground({ type: MSG.GET_SETTINGS });
  currentSettings = { ...DEFAULT_SETTINGS, ...(resp?.settings || {}) };
  applyToUI(currentSettings);
  applyTheme(currentSettings.theme || "auto");
}

function applyToUI(s) {
  setRadio("summary_length", s.summary_length);
  setRadio("theme", s.theme);
  setRadio("sidebar_position", s.sidebar_position || "right");
  autoHighToggle.setAttribute(
    "aria-checked",
    s.auto_highlight ? "true" : "false",
  );
  serverUrlInput.value = s.server_url || "http://localhost:8000";
}

function setRadio(name, value) {
  const input = document.querySelector(
    `input[name="${name}"][value="${value}"]`,
  );
  if (input) input.checked = true;
}

function readFromUI() {
  return {
    summary_length: getRadio("summary_length") || "standard",
    theme: getRadio("theme") || "auto",
    sidebar_position: getRadio("sidebar_position") || "right",
    auto_highlight: autoHighToggle.getAttribute("aria-checked") === "true",
    server_url: serverUrlInput.value.trim() || "http://localhost:8000",
  };
}

function getRadio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

async function saveSettings() {
  const updated = readFromUI();
  const resp = await sendToBackground({
    type: MSG.SAVE_SETTINGS,
    settings: updated,
  });
  if (resp?.ok) {
    currentSettings = updated;
    dirty = false;
    saveMsg.textContent = "Settings saved ✓";
    setTimeout(() => {
      saveMsg.textContent = "";
    }, 2500);
  } else {
    saveMsg.textContent = "Save failed — try again";
    saveMsg.style.color = "var(--rasp-400)";
    setTimeout(() => {
      saveMsg.textContent = "";
      saveMsg.style.color = "";
    }, 3000);
  }
}

async function testServer() {
  const url = serverUrlInput.value.trim() || "http://localhost:8000";
  statusDot.className = "status-dot";
  statusText.textContent = "Checking…";
  testServerBtn.disabled = true;

  try {
    const resp = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (resp.ok && data.status === "ok") {
      statusDot.className = "status-dot ok";
      const keySet = data.api_key_set ? "API key set ✓" : "⚠ API key not set";
      statusText.textContent = `Connected · ${data.model} · ${keySet}`;
    } else {
      throw new Error(`Status ${resp.status}`);
    }
  } catch (err) {
    statusDot.className = "status-dot err";
    if (err.name === "TimeoutError") {
      statusText.textContent = "Connection timed out";
    } else if (
      err.message.includes("Failed to fetch") ||
      err.message.includes("NetworkError")
    ) {
      statusText.textContent = "Cannot reach server — is it running?";
    } else {
      statusText.textContent = `Error: ${err.message}`;
    }
  } finally {
    testServerBtn.disabled = false;
  }
}

async function clearAllCache() {
  if (!confirm("Clear all cached summaries? This cannot be undone.")) return;

  const allData = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(allData).filter((k) => k.startsWith("cache:"));
  if (cacheKeys.length === 0) {
    saveMsg.textContent = "No cached summaries to clear.";
  } else {
    await chrome.storage.local.remove(cacheKeys);
    saveMsg.textContent = `Cleared ${cacheKeys.length} cached summary${cacheKeys.length !== 1 ? "s" : ""} ✓`;
  }
  setTimeout(() => {
    saveMsg.textContent = "";
  }, 3000);
}

document.querySelectorAll("input[type='radio']").forEach((el) => {
  el.addEventListener("change", () => {
    dirty = true;
  });
});

serverUrlInput.addEventListener("input", () => {
  dirty = true;
});

autoHighToggle.addEventListener("click", () => {
  const checked = autoHighToggle.getAttribute("aria-checked") === "true";
  autoHighToggle.setAttribute("aria-checked", checked ? "false" : "true");
  dirty = true;
});

saveBtn.addEventListener("click", saveSettings);
testServerBtn.addEventListener("click", testServer);
clearCacheBtn.addEventListener("click", clearAllCache);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveSettings();
  }
});

document.querySelectorAll('input[name="theme"]').forEach((el) => {
  el.addEventListener("change", () => applyTheme(el.value));
});

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

loadSettings().catch(console.error);
