"use strict";

const MSG = {
  EXTRACT_CONTENT: "PAGELENS_EXTRACT_CONTENT",
  CONTENT_RESULT: "PAGELENS_CONTENT_RESULT",
  APPLY_HIGHLIGHTS: "PAGELENS_APPLY_HIGHLIGHTS",
  CLEAR_HIGHLIGHTS: "PAGELENS_CLEAR_HIGHLIGHTS",
  SHOW_SIDEBAR: "PAGELENS_SHOW_SIDEBAR",
  HIDE_SIDEBAR: "PAGELENS_HIDE_SIDEBAR",
  PING: "PAGELENS_PING",
};

const HIGHLIGHT_CLASS = "pagelens-hl";
const SIDEBAR_ID = "pagelens-sidebar";

let sidebarFrame = null;
let highlightsApplied = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case MSG.PING:
      sendResponse({ ok: true });
      return false;

    case MSG.EXTRACT_CONTENT:
      handleExtract(sendResponse);
      return true;

    case MSG.APPLY_HIGHLIGHTS:
      handleHighlights(
        msg.phrases || [],
        msg.mode || "inject",
        msg.summary,
        sendResponse,
      );
      return true;

    case MSG.CLEAR_HIGHLIGHTS:
      clearHighlights();
      hideSidebar();
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

// ── Extract ────────────────────────────────────────────────────────────────────
async function handleExtract(sendResponse) {
  try {
    let content = PageLensReadability.extractContent(document);
    const title = PageLensReadability.extractTitle(document);
    const url = location.href;

    if (!content || content.length < 50) {
      await new Promise((r) => setTimeout(r, 1200));
      content = PageLensReadability.extractContent(document);
    }

    if (!content || content.length < 50) {
      const tag = document.body?.tagName;
      const bodyLen = (document.body?.textContent || "").trim().length;

      if (bodyLen < 50) {
        sendResponse({
          ok: false,
          error: "This page has no readable text content.",
        });
      } else if (location.protocol === "file:") {
        sendResponse({
          ok: false,
          error: "Local file pages are not supported.",
        });
      } else {
        sendResponse({
          ok: false,
          error:
            "Could not extract enough content. The page may be a dashboard, login wall, or heavily JavaScript-rendered app.",
        });
      }
      return;
    }

    sendResponse({ ok: true, content, title, url });
  } catch (err) {
    sendResponse({ ok: false, error: `Extraction failed: ${err.message}` });
  }
}

function handleHighlights(phrases, mode, summary, sendResponse) {
  clearHighlights();

  if (mode === "off" || !phrases.length) {
    sendResponse({ ok: true, applied: false });
    return;
  }

  if (mode === "sidebar") {
    showSidebar(summary, phrases);
    sendResponse({ ok: true, applied: true, mode: "sidebar" });
    return;
  }

  try {
    const count = injectHighlights(phrases);
    sendResponse({ ok: true, applied: count > 0, mode: "inject", count });
  } catch (err) {
    console.warn("[PageLens] Highlight injection error:", err.message);
    sendResponse({ ok: true, applied: false, mode: "inject", count: 0 });
  }
}

function injectHighlights(phrases) {
  if (!phrases.length) return 0;

  const escaped = phrases
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);

  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  let count = 0;

  const contentRoot =
    document.querySelector("article, main, [role='main']") || document.body;

  const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();

      if (
        ["script", "style", "noscript", "textarea", "input", "select"].includes(
          tag,
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.closest(`#${SIDEBAR_ID}`)) return NodeFilter.FILTER_REJECT;
      if (parent.classList.contains(HIGHLIGHT_CLASS))
        return NodeFilter.FILTER_REJECT;

      const inBlock = parent.closest(
        "p, h1, h2, h3, h4, h5, h6, li, blockquote, td, pre, div, section, article",
      );
      if (!inBlock) return NodeFilter.FILTER_SKIP;

      if ((node.textContent || "").trim().length < 4)
        return NodeFilter.FILTER_SKIP;

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  for (const textNode of textNodes) {
    const text = textNode.textContent;
    if (!pattern.test(text)) {
      pattern.lastIndex = 0;
      continue;
    }
    pattern.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0,
      match;
    let localCount = 0;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) {
        frag.appendChild(
          document.createTextNode(text.slice(last, match.index)),
        );
      }
      const mark = document.createElement("mark");
      mark.className = HIGHLIGHT_CLASS;
      mark.setAttribute("data-pagelens", "1");
      mark.textContent = match[0];
      frag.appendChild(mark);
      localCount++;
      last = pattern.lastIndex;
    }

    if (localCount > 0) {
      if (last < text.length)
        frag.appendChild(document.createTextNode(text.slice(last)));
      try {
        textNode.parentNode.replaceChild(frag, textNode);
        count += localCount;
      } catch (_) {
        // node may have moved
      }
    }
    pattern.lastIndex = 0;
  }

  return count;
}

function clearHighlights() {
  document.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`).forEach((mark) => {
    const text = document.createTextNode(mark.textContent);
    mark.parentNode?.replaceChild(text, mark);
  });
  highlightsApplied = false;
}

function showSidebar(summary, phrases) {
  hideSidebar();

  const sidebar = document.createElement("div");
  sidebar.id = SIDEBAR_ID;
  sidebar.setAttribute("role", "complementary");
  sidebar.setAttribute("aria-label", "PageLens Summary");

  const bulletList = (summary?.summary || [])
    .map((b) => {
      const li = document.createElement("li");
      li.textContent = b;
      return li.outerHTML;
    })
    .join("");
  const insightList = (summary?.key_insights || [])
    .map((i) => {
      const li = document.createElement("li");
      li.textContent = i;
      return li.outerHTML;
    })
    .join("");
  const rt = summary?.reading_time_minutes ?? "?";

  sidebar.innerHTML = `
    <div class="pl-sidebar-inner">
      <div class="pl-sidebar-header">
        <span class="pl-logo">PageLens</span>
        <span class="pl-reading-time">${rt} min read</span>
        <button class="pl-close" aria-label="Close sidebar" id="pl-close-btn">✕</button>
      </div>
      <div class="pl-sidebar-body">
        <p class="pl-section-label">Summary</p>
        <ul class="pl-summary-list">${bulletList}</ul>
        ${insightList ? `<p class="pl-section-label">Key Insights</p><ul class="pl-insights-list">${insightList}</ul>` : ""}
        ${
          phrases.length
            ? `
          <p class="pl-section-label">Highlights</p>
          <button class="pl-highlight-btn" id="pl-hl-btn">
            <svg viewBox="0 0 16 16" fill="none"><path d="M3 13l2-5 6-6 3 3-6 6-5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 4l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            Highlight page
          </button>
          <div class="pl-highlight-fail" id="pl-hl-fail" hidden>No matching phrases found on this page.</div>
        `
            : ""
        }
      </div>
    </div>
  `;

  document.body.appendChild(sidebar);

  chrome.storage.sync.get("pagelens_settings", (data) => {
    const s = data?.pagelens_settings || {};
    const theme = s.theme || "auto";
    const position = s.sidebar_position || "right";
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const resolved =
      theme === "auto" ? (prefersDark ? "dark" : "light") : theme;
    sidebar.setAttribute("data-theme", resolved);
    sidebar.setAttribute("data-position", position);
  });

  document
    .getElementById("pl-close-btn")
    ?.addEventListener("click", hideSidebar);

  let sidebarHlActive = false;
  const hlBtn = document.getElementById("pl-hl-btn");
  const hlFail = document.getElementById("pl-hl-fail");

  if (hlBtn) {
    hlBtn.addEventListener("click", () => {
      if (sidebarHlActive) {
        clearHighlights();
        sidebarHlActive = false;
        hlBtn.classList.remove("active");
        hlBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none"><path d="M3 13l2-5 6-6 3 3-6 6-5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 4l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Highlight page`;
        if (hlFail) hlFail.hidden = true;
      } else {
        const count = injectHighlights(phrases);
        if (count === 0) {
          if (hlFail) hlFail.hidden = false;
        } else {
          sidebarHlActive = true;
          hlBtn.classList.add("active");
          hlBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none"><path d="M3 13l2-5 6-6 3 3-6 6-5 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 4l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> Clear highlights`;
          if (hlFail) hlFail.hidden = true;
        }
      }
    });
  }

  requestAnimationFrame(() => sidebar.classList.add("pl-visible"));
  sidebarFrame = sidebar;
}

function hideSidebar() {
  if (sidebarFrame) {
    sidebarFrame.classList.remove("pl-visible");
    setTimeout(() => {
      sidebarFrame?.remove();
      sidebarFrame = null;
    }, 300);
  }
}
