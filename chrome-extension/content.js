const BASE_URL = "http://localhost:8000";
console.log("Extension injected...");

let debounceTimer;
let lastScoredPrompt = "";
let promptHistory = [];
let scoreHistory = [];
const MAX_HISTORY = 5;
let activeView         = "llm";   
let viewBeforeSettings = "llm";   
let currentTextbox = null;
let isUIActive = false;
let contextSummary = "";  // Store the summary of the last 5 prompts.


// Global flags for detection settings and prompt type
let scoreDetectionEnabled = true;
let piiDetectionEnabled = true;
let promptType = "short";  // "short" or "descriptive"


function findActiveTextbox() {
  const host = window.location.hostname;
  let box = null;

  if (host.includes("chat.openai.com")) {
    // ChatGPT
    box = document.querySelector("#prompt-textarea.ProseMirror");
  }
  else if (host.includes("deepseek.ai")) {
    // DeepSeek
    box = document.querySelector("textarea#chat-input");
  }
  else if (host.includes("perplexity.ai")) {
    // (example) Perplexity — adjust to the real selector
    box = document.querySelector("textarea.query-input");
  }

  // Fallback: first visible <textarea> or [contenteditable="true"]
  if (!box) {
    const candidates = [
      ...document.querySelectorAll("textarea"),
      ...document.querySelectorAll("[contenteditable='true']")
    ];
    box = candidates.find(el => el.offsetParent !== null) || null;
  }

  return (box && box.offsetParent !== null) ? box : null;
}
/* ------------------ Horizontal Pipe Score Meter Popup (Top, attached to icon) ------------------ */

/**
 * Compute & apply top/left on #score-pipe-popup
 * so it always sits just above the fixed icon.
 */
function repositionScorePipePopup() {
  const popup = document.getElementById("score-pipe-popup");
  if (!popup) return;

  const icon = document.getElementById("smart-suggest-img");
  if (!icon) {
    // fallback if icon not found
    popup.style.position = "fixed";
    popup.style.bottom   = "70px";
    popup.style.right    = "40px";
    return;
  }

  const iconRect   = icon.getBoundingClientRect();
  const gap        = 10;
  const { width: pw, height: ph } = popup.getBoundingClientRect();

  let left = iconRect.left;
  let top  = iconRect.top - ph - gap;

  // clamp horizontally
  if (left + pw > window.innerWidth - 10) {
    left = window.innerWidth - pw - 10;
  } else if (left < 10) {
    left = 10;
  }

  popup.style.position = "fixed";
  popup.style.left     = left + "px";
  popup.style.top      = top  + "px";
}

function showScorePipePopup(score) {
  removeScorePipePopup(); // Remove old popup

  const popup = document.createElement("div");
  popup.id = "score-pipe-popup";
  popup.className = "score-pipe-popup";
  popup.innerHTML = `
    <div class="pipe-popup-title">Score Meter</div>
    <div class="pipe-popup-meter">
      <div class="pipe-segment"></div>
      <div class="pipe-segment"></div>
      <div class="pipe-segment"></div>
      <div class="pipe-segment"></div>
      <div class="pipe-segment"></div>
    </div>
    <div class="pipe-popup-legend">Low / Medium / High</div>
  `;
  document.body.appendChild(popup);

  // Decide how many segments to fill
  let fillCount = 0;
  let fillColor = "#ccc";
  if (score === "low") {
    fillCount = 2; fillColor = "red";
  } else if (score === "medium") {
    fillCount = 3; fillColor = "orange";
  } else if (score === "high") {
    fillCount = 5; fillColor = "green";
  }
  popup.querySelectorAll(".pipe-segment").forEach((seg, i) => {
    seg.style.backgroundColor = (i < fillCount) ? fillColor : "#ddd";
  });

  // Position once now, then keep it anchored on resize
  repositionScorePipePopup();
  window.addEventListener("resize", repositionScorePipePopup);
}

function removeScorePipePopup() {
  const old = document.getElementById("score-pipe-popup");
  if (old) old.remove();
  window.removeEventListener("resize", repositionScorePipePopup);
}



/* ------------------ PII Detection Functions ------------------ */
function showPIIPopup() {
  const imgBtn = document.getElementById("smart-suggest-img");
  if (!imgBtn) return;
  imgBtn.style.position = "relative";
  // Change the logo to the red version
  imgBtn.src = chrome.runtime.getURL("icons/logo_red.png");
  // Add an animation class for a pulse effect
  imgBtn.classList.add("logo-red-animate");
}



function removePIIPopup() {
  const imgBtn = document.getElementById("smart-suggest-img");
  if (!imgBtn) return;
  // Revert to the default logo
  imgBtn.src = chrome.runtime.getURL("icons/logo-128.png");
  // Remove the animation class
  imgBtn.classList.remove("logo-red-animate");
}


function detectPII(prompt) {
  if (!piiDetectionEnabled) {
    removePIIPopup();
    return;
  }
  fetch(`${BASE_URL}/detect-pii`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: prompt })
  })
    .then(res => res.json())
    .then(data => {
      if (data.pii === true) {
        showPIIPopup();
      } else {
        removePIIPopup();
      }
    })
    .catch(err => {
      console.error("Error in detect-pii:", err);
    });
}

/* ------------------ Score Prompt Function ------------------ */

function scorePrompt(prompt) {
  if (!scoreDetectionEnabled) {
    removeScorePipePopup();
    return;
  }
  if (!prompt || prompt.trim() === "") {
    removeScorePipePopup();
    return;
  }
  const cleaned = prompt.trim();
  if (cleaned === lastScoredPrompt) return;
  lastScoredPrompt = cleaned;

  fetch(`${BASE_URL}/prompt-score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: cleaned })
  })
    .then(res => res.json())
    .then(data => {
      const scoreObj = data.score || {}; 
      const score = scoreObj.score || "unknown";
      const displayedPrompt = scoreObj.masked_prompt || cleaned;
      
      if (["low", "medium", "high"].includes(score)) {
        scoreHistory.unshift({ prompt: displayedPrompt, score });
        if (scoreHistory.length > MAX_HISTORY) scoreHistory.pop();
        updateScoreHistoryUI();
        showScorePipePopup(score);
      } else {
        removeScorePipePopup();
      }
    })
    .catch(err => {
      console.error("Scoring error:", err);
    });
}

/* ------------------ LLM Suggestion Function ------------------ */
function checkAndUpdateLLMSuggestion() {
  if (promptHistory.length === 0) return;
  fetch(`${BASE_URL}/prompt_classifier`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompts: promptHistory })
  })
    .then(res => res.json())
    .then(data => {
      const llmContainer = document.getElementById("llm-suggestion-line");
      if (llmContainer) {
        if (data.suggested_llm && data.suggested_llm !== "Unknown") {
          llmContainer.innerHTML = `
            <strong>Suggested LLM:</strong> ${data.suggested_llm}
            <br><small>${data.reason || "No additional details"}</small>
          `;
        } else {
          llmContainer.innerHTML = `
            <strong>Suggested LLM:</strong> <em>No strong signal</em>
          `;
        }
      }
    })
    .catch(err => {
      console.error("Failed to get LLM suggestion:", err);
    });
}

/* ------------------ Observer Function ------------------ */

function observeInputBox() {
  const box = findActiveTextbox();
  if (!box) {
    console.log("❌ No input box found.");
    return;
  }
  currentTextbox = box;
  const isTextarea = box.tagName === "TEXTAREA";
  const getText    = () => isTextarea ? box.value : box.innerText;


  const handleChange = () => {
    // If the UI is toggled off, do nothing.
    if (!isUIActive) return;
    
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // Re-check before executing
      if (!isUIActive) return;
      const current = getText().trim();
      if (!current) {
        removeScorePipePopup();
        removePIIPopup();
        return;
      }
      scorePrompt(current);
      detectPII(current);
    }, 750);
  };
  
  // Listen for edits
  if (isTextarea) {
    box.addEventListener("input", handleChange);
  } else {
    const observer = new MutationObserver(handleChange);
    observer.observe(box, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

// On Enter: hide popups and record history & trigger LLM suggestion
  box.addEventListener("keydown", (event) => {
    // If UI is off, do nothing.
    if (!isUIActive) return;
    
    const isEnter = event.key === "Enter";
    const plainEnter = isEnter && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (!plainEnter) return;

    // Hide the popups immediately
    removeScorePipePopup();
    removePIIPopup();

    // Then record to history & trigger LLM suggestion and summary generation
    setTimeout(() => {
      const submitted = lastScoredPrompt;
      if (!submitted) return;
      if (!promptHistory.length || promptHistory[0] !== submitted) {
        promptHistory.unshift(submitted);
        if (promptHistory.length > MAX_HISTORY) promptHistory.pop();
        
        // Existing call to prompt_classifier
        checkAndUpdateLLMSuggestion();

        // New: Call the summary endpoint with the last 5 prompts
        fetch(`${BASE_URL}/summary-gen`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompts: promptHistory.slice(0, MAX_HISTORY) })
        })
          .then(res => res.json())
          .then(data => {
            contextSummary = data.summary || "";
            console.log("Updated context summary:", contextSummary);
          })
          .catch(err => console.error("Summary generation error:", err));
      }
    }, 300);
  });


  console.log("👁️ Observer & Enter key capture initialized");
}

function checkForNewTextbox() {
  const newBox = findActiveTextbox();
  if (newBox && newBox !== currentTextbox) {

    // Reset the summary when the chat screen changes.
    contextSummary = "";
    promptHistory = [];  // Clear old history
    // Clear popups from the previous screen
    removeScorePipePopup();
    removePIIPopup();

    // Optionally, if you stored any MutationObserver from the previous box,
    // disconnect it here (not shown in the original code).

    // Update the global variable
    currentTextbox = newBox;
    
    // Reattach the observer on the new active textbox
    observeInputBox();
  }
}

/* ------------------ Update Score History UI with Mini Pipe Meter & Copy Icon ------------------ */
function updateScoreHistoryUI() {
  const historyList = document.getElementById("score-history-list");
  if (!historyList) return;
  historyList.innerHTML = "";
  scoreHistory.forEach((item) => {
    let fillCount = 0;
    let fillColor = "#ccc";
    if (item.score === "low") {
      fillCount = 2;
      fillColor = "red";
    } else if (item.score === "medium") {
      fillCount = 3;
      fillColor = "orange";
    } else if (item.score === "high") {
      fillCount = 5;
      fillColor = "green";
    }
    const li = document.createElement("li");
    li.style.marginBottom = "8px";
    li.style.display = "flex";
    li.style.alignItems = "center";
    li.style.justifyContent = "space-between";
    let meterHTML = "";
    for (let i = 0; i < 5; i++) {
      const color = i < fillCount ? fillColor : "#ddd";
      meterHTML += `<div class="mini-segment" style="background-color:${color};"></div>`;
    }
    
    // Use the masked prompt if it exists; otherwise, use the raw prompt.
    const displayPrompt = item.masked_prompt ? item.masked_prompt : item.prompt;
    
    li.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="prompt-text" style="font-size:13px;">${truncatePrompt(displayPrompt, 40)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="score-dot" style="background:${fillColor};"></span>
        <span class="copy-icon" title="Copy prompt" style="cursor:pointer;font-size:16px;">📋</span>
      </div>
    `;

    li.querySelector(".copy-icon").addEventListener("click", () => {
      navigator.clipboard.writeText(displayPrompt)
        .then(() => { alert("Prompt copied!"); })
        .catch((err) => { console.error("Copy failed:", err); });
    });
    historyList.appendChild(li);
  });
}

function truncatePrompt(prompt, maxLength) {
  if (prompt.length <= maxLength) return prompt;
  return prompt.slice(0, maxLength) + "...";
}


/* ------------------ Create Prompt Buddy Playground Panel (Tabbed Layout) ------------------ */
function createDropdownPanel() {
  if (document.getElementById("buddy-panel")) return;
  const panel = document.createElement("div");
  panel.id = "buddy-panel";
  panel.classList.add("buddy-panel");
  panel.style.display = "none"; // hidden by default
  panel.innerHTML = `
    <div class="buddy-header">
      <div class="buddy-title">Prompt Buddy Playground</div>
      <div class="header-icons">
      <button id="buddy-gear-btn" class="buddy-gear-btn" title="Settings">
        <svg viewBox="0 0 24 24" fill="currentColor" style="overflow:visible">
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7.4-3.5
                   a5.9 5.9 0 0 1-.2 1.5l2.1 1.6-1.5 2.6-2.5-1
                   a6.2 6.2 0 0 1-1.3.8l-.4 2.7h-3l-.4-2.7
                   a6.2 6.2 0 0 1-1.3-.8l-2.5 1-1.5-2.6
                   2.1-1.6a5.9 5.9 0 0 1-.2-1.5 5.9 5.9 0 0 1
                   .2-1.5L4.8 8.9l1.5-2.6 2.5 1c.4-.3.9-.5
                   1.3-.8l.4-2.7h3l.4 2.7c.4.2.9.5 1.3.8l2.5-1
                   1.5 2.6-2.1 1.6c.1.5.2 1 .2 1.5z"/>
        </svg>
      </button>
      <button id="buddy-close-btn" class="buddy-close-btn" title="Close">
        <svg viewBox="0 0 24 24" fill="currentColor" style="overflow:visible">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
      </div>
    
    </div>
    <div class="buddy-tabs">
      <button class="buddy-tab active-tab" id="tab-llm">Suggested LLM</button>
      <button class="buddy-tab" id="tab-history">Score History</button>
    </div>
    <div class="buddy-content" id="buddy-content">
      <div id="content-llm">
        <div id="llm-suggestion-line">
          <strong>Suggested LLM:</strong> <em>Waiting...</em>
        </div>
      </div>
      <div id="content-history" style="display: none;">
        <ul id="score-history-list" class="buddy-section-list"></ul>
      </div>
    </div>
    <div class="buddy-section" id="section-settings" style="display:none;">
    <h4 class="settings-heading">Features</h4>
  
    <div class="setting-row">
      <span class="setting-label">Score detection</span>
      <label class="switch">
        <input type="checkbox" id="toggle-score-detection" checked>
        <span class="slider"></span>
      </label>
    </div>
  
    <div class="setting-row">
      <span class="setting-label">PII detection</span>
      <label class="switch">
        <input type="checkbox" id="toggle-pii-detection" checked>
        <span class="slider"></span>
      </label>
    </div>
  
    <h4 class="settings-heading">Prompt Style</h4>
  
    <div class="setting-row">
      <span class="setting-label">Type</span>
      <div class="radio‑group">
        <label><input type="radio" name="promptType" value="short" checked> Short </label>
        <label><input type="radio" name="promptType" value="descriptive"> Descriptive </label>
      </div>
    </div>
  
    <h4 class="settings-heading">Theme</h4>
  
    <div class="setting-row">
      <span class="setting-label">Colour Scheme</span>
      <div class="radio‑group">
        <label><input type="radio" name="themeChoice" value="theme-default" checked> Blue</label>
        <label><input type="radio" name="themeChoice" value="theme-purple"> Purple</label>
        <label><input type="radio" name="themeChoice" value="theme-charcoal"> Charcoal</label>
      </div>
    </div>
  </div>
  
  `;
  document.body.appendChild(panel);
  document.getElementById("buddy-close-btn").addEventListener("click", () => {
    panel.style.display = "none";
  });

  document.getElementById("buddy-gear-btn").addEventListener("click", () => {
    const settings       = document.getElementById("section-settings");
    const contentLLM     = document.getElementById("content-llm");
    const contentHistory = document.getElementById("content-history");
    const tabLLM         = document.getElementById("tab-llm");
    const tabHistory     = document.getElementById("tab-history");
  
    if (activeView === "settings") {
      /* Close settings → restore previous tab */
      settings.style.display = "none";
      document.getElementById("buddy-content").style.display = "block";
      document.querySelector(".buddy-tabs").style.display     = "flex";
  
      if (viewBeforeSettings === "history") {
        contentHistory.style.display = "block";
        tabHistory.classList.add("active-tab");
        contentLLM.style.display = "none";
        tabLLM.classList.remove("active-tab");
        activeView = "history";
      } else {                              // default back to LLM
        contentLLM.style.display = "block";
        tabLLM.classList.add("active-tab");
        contentHistory.style.display = "none";
        tabHistory.classList.remove("active-tab");
        activeView = "llm";
      }
    } else {
      /* Open settings → hide whichever tab was showing */
      viewBeforeSettings     = activeView;
      activeView             = "settings";
  
      settings.style.display       = "block";
      contentLLM.style.display     = "none";
      contentHistory.style.display = "none";
      document.getElementById("buddy-content").style.display = "none";  // hide gap
      document.querySelector(".buddy-tabs").style.display     = "none"; // hide tabs


      tabLLM.classList.remove("active-tab");
      tabHistory.classList.remove("active-tab");
    }
  });
  
    // --- Suggested LLM tab ---
  document.getElementById("tab-llm").addEventListener("click", () => {
    document.getElementById("buddy-content").style.display = "block";
    document.querySelector(".buddy-tabs").style.display     = "flex";

    document.getElementById("content-llm").style.display      = "block";
    document.getElementById("content-history").style.display  = "none";
    document.getElementById("section-settings").style.display = "none";

    document.getElementById("tab-llm").classList.add("active-tab");
    document.getElementById("tab-history").classList.remove("active-tab");

    activeView = "llm";
  });

  // --- Score History tab ---
  document.getElementById("tab-history").addEventListener("click", () => {
    document.getElementById("buddy-content").style.display = "block";
    document.querySelector(".buddy-tabs").style.display     = "flex";

    document.getElementById("content-history").style.display  = "block";
    document.getElementById("content-llm").style.display      = "none";
    document.getElementById("section-settings").style.display = "none";

    document.getElementById("tab-history").classList.add("active-tab");
    document.getElementById("tab-llm").classList.remove("active-tab");

    activeView = "history";
  });


  document.getElementById("toggle-score-detection").addEventListener("change", function(){
    scoreDetectionEnabled = this.checked;
    if (!scoreDetectionEnabled) {
      removeScorePipePopup();
      
    }
  });
  document.getElementById("toggle-pii-detection").addEventListener("change", function(){
    piiDetectionEnabled = this.checked;
    if (!piiDetectionEnabled) {
      removePIIPopup();
    }
  });
  document.querySelectorAll('input[name="promptType"]').forEach((elem) => {
    elem.addEventListener("change", function() {
      promptType = this.value;
    });
  });

  /* theme radios – add this */
  document.querySelectorAll('input[name="themeChoice"]').forEach(r =>
    r.addEventListener("change", e => {
      document.documentElement.classList.remove("theme-default",
                                                "theme-purple",
                                                "theme-charcoal");
      document.documentElement.classList.add(e.target.value);
    })
  );

  /* give the document its initial class */
  document.documentElement.classList.add("theme-default");
  
}

function toggleDropdownPanel() {
  const panel = document.getElementById("buddy-panel");
  if (!panel) return;

  // Toggle display
  const isHidden = (panel.style.display === "none" || !panel.style.display);
  panel.style.display = isHidden ? "block" : "none";

  if (isHidden) {
    // Wait one tick so the panel has a size, then position it
    // and start listening for zoom/resize events
    setTimeout(() => {
      repositionBuddyPanel();
      window.addEventListener("resize", repositionBuddyPanel);
    }, 0);
  } else {
    // Panel is being hidden – stop listening to window resize events
    window.removeEventListener("resize", repositionBuddyPanel);
  }
}

/* ---------- keep Buddy‑panel glued to the icon on resize / zoom ---------- */
function repositionBuddyPanel() {
  const panel = document.getElementById("buddy-panel");
  const icon  = document.getElementById("smart-suggest-img");
  if (!panel || !icon || panel.style.display === "none") return;   // nothing to do

  const gap         = 10;
  const iconRect    = icon.getBoundingClientRect();
  const panelWidth  = panel.offsetWidth;
  const panelHeight = panel.offsetHeight;

  // default: below the icon
  let left = iconRect.left;
  let top  = iconRect.bottom + gap;

  // clamp so it never leaves the screen
  if (left + panelWidth > window.innerWidth - 10) {
    left = window.innerWidth - panelWidth - 10;
  }
  if (top + panelHeight > window.innerHeight - 10) {
    top = iconRect.top - panelHeight - gap;   // put it above instead
  }

  panel.style.position = "fixed";
  panel.style.left  = `${left}px`;
  panel.style.top   = `${top}px`;
}


/* ------------------ Floating Button & Draggable Icon ------------------ */

function createFloatingButton() {
  if (document.getElementById("prompt-buddy-container")) return;
  
  const container = document.createElement("div");
  container.id = "prompt-buddy-container";
  container.style.width = "56px";
  container.style.height = "56px";
  container.style.position = "fixed";
  container.style.bottom = "20px";
  container.style.right = "0px"; // Sticks to right edge
  container.style.top = "200px"; // Fixed vertical position (adjust as needed)
  container.style.overflow = "hidden";
  container.style.borderRadius = "8px";
  container.style.transition = "width 0.3s ease";
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.zIndex = "99999";
  // Remove draggable event listeners (previous mousedown events are removed)
  
  const imgBtn = document.createElement("img");
  imgBtn.id = "smart-suggest-img";
  imgBtn.src = chrome.runtime.getURL("icons/logo-128.png");
  imgBtn.alt = "Prompt Buddy";
  imgBtn.style.width = "56px";
  imgBtn.style.height = "56px";
  imgBtn.style.borderRadius = "8px";
  imgBtn.style.flexShrink = "0";
  imgBtn.style.cursor = "pointer";
  
  const kebabContainer = document.createElement("div");
  kebabContainer.id = "kebab-container";
  kebabContainer.style.width = "24px";
  kebabContainer.style.height = "56px";
  kebabContainer.style.display = "flex";
  kebabContainer.style.alignItems = "center";
  kebabContainer.style.justifyContent = "center";
  kebabContainer.style.background = "linear-gradient(180deg, #333 0%, #111 100%)";
  kebabContainer.style.opacity = "0";
  kebabContainer.style.transition = "opacity 0.3s ease";
  kebabContainer.style.flexShrink = "0";
  
  const kebabBtn = document.createElement("button");
  kebabBtn.id = "kebab-menu-btn";
  kebabBtn.innerText = "⋮";
  kebabBtn.style.width = "100%";
  kebabBtn.style.height = "100%";
  kebabBtn.style.border = "none";
  kebabBtn.style.background = "transparent";
  kebabBtn.style.color = "#fff";
  kebabBtn.style.fontSize = "18px";
  kebabBtn.style.cursor = "pointer";
  kebabBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDropdownPanel();
  });
  kebabContainer.appendChild(kebabBtn);
  
  container.appendChild(imgBtn);
  container.appendChild(kebabContainer);
  
  container.addEventListener("mouseenter", () => {
    container.style.width = "80px";
    kebabContainer.style.opacity = "1";
  });
  container.addEventListener("mouseleave", () => {
    container.style.width = "56px";
    kebabContainer.style.opacity = "0";
  });
  
  
  imgBtn.addEventListener("click", () => {
    const inputBox = findActiveTextbox();
    if (!inputBox) {
      alert("Couldn't find textbox.");
      return;
    }
  
    const tag = inputBox.tagName;
    const isInputLike = tag === "INPUT" || tag === "TEXTAREA";
    const isEditable  = inputBox.isContentEditable;
    const original = isInputLike ? inputBox.value.trim() : inputBox.innerText.trim();
  
    if (!original) {
      alert("⚠️ Please type something into the box first.");
      return;
    }

    // Show the animated loading dots and hide the logo
    showLoadingDots();

    // Choose endpoint based on prompt type
    const endpoint = promptType === "descriptive"
      ? `${BASE_URL}/suggest-templates-descriptive`
      : `${BASE_URL}/suggest-templates`;
  
    // Build the payload. For descriptive prompts, include the summary if available.
    const payload = { prompt: original };
    if (promptType === "descriptive" && contextSummary) {
      payload.summary = contextSummary;
    }
  
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(data => {

      // Hide the loading dots and show the logo again
      hideLoadingDots();
        const templates = data.templates || [];
        if (!templates.length) return;
        const newPrompt = Array.isArray(templates)
          ? templates.join("\n\n")
          : templates;
  
        if (isInputLike) {
          // Use the native setter for INPUT or TEXTAREA
          const proto = tag === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(inputBox, newPrompt);
          // Dispatch events for frameworks like React
          inputBox.dispatchEvent(new Event("input", { bubbles: true }));
          inputBox.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (isEditable) {
          inputBox.innerText = newPrompt;
          inputBox.dispatchEvent(new InputEvent("input", { bubbles: true }));
        } else {
          console.warn("Unknown box type, can't set value:", inputBox);
        }
  
        inputBox.focus();
        removeScorePipePopup();
        scorePrompt(newPrompt);
      })
      .catch(err => console.error("Error fetching prompt suggestion:", err));
  });
  
  
  document.body.appendChild(container);
}
// ------------------ Loading Dots Helper Functions ------------------

function showLoadingDots() {
  // Hide the main logo during loading.
  const imgBtn = document.getElementById("smart-suggest-img");
  if (imgBtn) {
    imgBtn.style.display = "none";
  }
  
  // Create or show the loading dots overlay.
  let loader = document.getElementById("loading-dots");
  if (!loader) {
    loader = document.createElement("div");
    loader.id = "loading-dots";
    loader.className = "loading-dots";
    loader.innerHTML = "<span></span><span></span><span></span>";
    // Append this overlay to the prompt buddy container.
    const container = document.getElementById("prompt-buddy-container");
    if (container) {
      container.appendChild(loader);
    }
  } else {
    loader.style.display = "inline-flex";
  }
}

function hideLoadingDots() {
  // Show the main logo once loading is complete.
  const imgBtn = document.getElementById("smart-suggest-img");
  if (imgBtn) {
    imgBtn.style.display = "block";
  }
  
  // Hide the loading dots overlay.
  const loader = document.getElementById("loading-dots");
  if (loader) {
    loader.style.display = "none";
  }
}


// ------------------ UI Toggle Helper Functions ------------------

// Call this function to create/inject all UI elements.
function createBuddyUI() {
  createFloatingButton();
  createDropdownPanel();
  observeInputBox();
  updateScoreHistoryUI();
  // You can add any additional initialization here if needed.
}

// Call this function to remove all UI elements.
function removeBuddyUI() {
  // Remove the floating button container.
  const container = document.getElementById("prompt-buddy-container");
  if (container) container.remove();

  // Remove the dropdown panel.
  const panel = document.getElementById("buddy-panel");
  if (panel) panel.remove();

  // Also remove any active popups.
  removeScorePipePopup();
  removePIIPopup();

  // (Optional) Disconnect any observers if you stored them.
}





/* ------------------ On Load ------------------ */
window.addEventListener("load", () => {
  setTimeout(() => {
    const box = findActiveTextbox();
    if (box) {
      createBuddyUI();    // Create the UI elements
      isUIActive = true;    // Mark UI as active
    } else {
      console.log("No input box found.");
    }
  }, 3000);
  // Start checking for a new active textbox every 1 second
  setInterval(checkForNewTextbox, 1000);
});


/* ------------------ Inject CSS ------------------ */
const style = document.createElement("style");
style.innerHTML = `

/* BEGIN BUDDY CSS ------------------------------------------------------- */

/* ---------- Floating button ---------- */
#prompt-buddy-container{position:fixed;bottom:20px;right:0;width:56px;height:56px;overflow:hidden;border-radius:8px;display:flex;align-items:center;transition:width .3s ease;z-index:99999}
#prompt-buddy-container:hover{box-shadow:0 6px 16px rgba(0,0,0,.1)}
#smart-suggest-img{width:56px;height:56px;border-radius:8px;cursor:pointer}
#kebab-container{width:24px;height:56px;display:flex;align-items:center;justify-content:center;background:#f0f0f0;opacity:0;transition:opacity .3s}
#prompt-buddy-container:hover #kebab-container{opacity:1}
#kebab-menu-btn{width:100%;height:100%;background:transparent;border:none;cursor:pointer;color:#555;font-size:18px}

/* ---------- Panel shell ---------- */
.buddy-panel{position:fixed;bottom:100px;right:20px;width:380px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.1);font-family:'Roboto',sans-serif;font-size:14px;color:#333;z-index:99999;overflow:visible}

/* ---------- Header bar ---------- */
.buddy-header{display:flex;align-items:center;justify-content:space-between;background:var(--header-gradient,linear-gradient(90deg,#4c6ef5,#15aabf));padding:12px 32px 12px 16px;border-top-left-radius:12px;border-top-right-radius:12px}
.buddy-title{font-size:16px;font-weight:600;color:#fff}        /* always white */
.header-icons{display:flex;align-items:center;gap:8px}
.header-icons button{display:flex;align-items:center;justify-content:center;padding:6px;background:transparent;border:none;cursor:pointer;color:rgba(255,255,255,.8);transition:color .2s;overflow:visible}
.header-icons button:hover{color:#fff}
.buddy-gear-btn svg,.buddy-close-btn svg{width:16px;height:16px;pointer-events:none;transition:fill .2s,stroke .2s}
.buddy-gear-btn svg{fill:currentColor}
.buddy-close-btn svg{fill:none;stroke:currentColor;stroke-width:2}

/* ---------- Tabs ---------- */
.buddy-tabs{display:flex;background:#f1f3f5;border-bottom:1px solid #e2e8f0}
.buddy-tab{flex:1;padding:10px;background:transparent;border:none;color:#555;font-weight:500;cursor:pointer;transition:color .2s}
.buddy-tab:hover{color:var(--accent,#4c6ef5)}
.active-tab{color:var(--accent,#4c6ef5);border-bottom:3px solid var(--accent,#4c6ef5)}

/* ---------- Main content area ---------- */
.buddy-content{padding:16px 20px;background:#fff;max-height:300px;overflow-y:auto}
.buddy-content>div{display:none}
.buddy-content>.visible{display:block}

/* ---------- Settings section ---------- */
.buddy-section{padding:16px 20px}
.settings-heading{margin:16px 0 8px;font-size:14px;font-weight:600;color:#4c6ef5}
.setting-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f3f5;font-size:13px}
.setting-row:last-of-type{border-bottom:none}
.setting-label{color:#333}

/* Toggle switch */
.switch{position:relative;width:36px;height:20px}
.switch input{display:none}
.slider{position:absolute;inset:0;background:#ced4da;border-radius:999px;transition:.25s}
.slider:before{content:"";position:absolute;left:2px;top:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:.25s}
.switch input:checked+.slider{background:var(--accent,#4c6ef5)}
.switch input:checked+.slider:before{transform:translateX(16px)}

/* Inline radio group */
.radio-group label{margin-left:12px;font-size:12px;white-space:nowrap}

/* ---------- Theme variables ---------- */
:root{
  --accent:#4c6ef5;
  --header-gradient:linear-gradient(90deg,#4c6ef5,#15aabf);
}
.theme-purple{
  --accent:#845ef7;
  --header-gradient:linear-gradient(90deg,#845ef7,#b197fc);
}
.theme-charcoal{
  --accent:#adb5bd;
  --header-gradient:linear-gradient(90deg,#495057,#343a40);
}

/* ---------- Misc (score popup, history list, etc.) ---------- */
#score-pipe-popup{position:fixed;width:240px;padding:12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 4px 8px rgba(0,0,0,.1);font-family:'Roboto',sans-serif;color:#333;z-index:99999;opacity:0;transform:translateY(10px);animation:pipePopupFadeIn .3s forwards}
@keyframes pipePopupFadeIn{to{opacity:1;transform:translateY(0)}}
.pipe-popup-title{font-size:14px;font-weight:bold;margin-bottom:8px;text-align:center}
.pipe-popup-meter{display:flex;justify-content:center;margin-bottom:8px}
.pipe-segment{width:12px;height:20px;border-radius:4px;background:#e2e8f0;margin:0 2px;transition:background-color .3s}
.pipe-popup-legend{font-size:12px;color:#666;text-align:center}
#score-history-list{list-style:none;margin:0;padding:0}
#score-history-list li{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #e2e8f0}
.prompt-text{font-size:13px;color:#555;flex:1;margin-right:8px}
.copy-icon{width:20px;height:20px;fill:var(--accent,#4c6ef5);cursor:pointer;transition:fill .2s}
.copy-icon:hover{fill:#15aabf}

.score-dot{
  display:inline-block;
  width:10px;
  height:10px;
  border-radius:50%;
  margin-left:8px;          
}


#smart-suggest-img {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

#smart-suggest-img:hover {
  transform: scale(1.1);
}

/* Define the pulse animation */
@keyframes logoRedPulse {
  0% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.1);
    opacity: 0.8;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

/* Apply the pulse animation when PII is detected */
.logo-red-animate {
  animation: logoRedPulse 0.5s ease-in-out;
}

/* Loading Dots on Black Overlay Animation */
@keyframes blink {
  0% { opacity: 0.2; }
  20% { opacity: 1; }
  100% { opacity: 0.2; }
}

.loading-dots {
  display: inline-flex;
  gap: 4px;
  position: absolute;
  top: 0;
  left: 0;
  width: 56px;   /* match your container dimensions */
  height: 56px;
  align-items: center;
  justify-content: center;
  z-index: 100001; /* above the logo */
  background: black;  /* black overlay */
  border-radius: 8px;
}

.loading-dots span {
  display: block;
  width: 6px;
  height: 6px;
  background: white;  /* white dots */
  border-radius: 50%;
  opacity: 0.2;
  animation: blink 1.4s infinite;
}

.loading-dots span:nth-child(1) {
  animation-delay: 0s;
}
.loading-dots span:nth-child(2) {
  animation-delay: 0.2s;
}
.loading-dots span:nth-child(3) {
  animation-delay: 0.4s;
}


/* END BUDDY CSS --------------------------------------------------------- */

`;

// ------------------ Message Listener for UI Toggle ------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "toggleUI") {
    if (isUIActive) {
      removeBuddyUI();
      isUIActive = false;
    } else {
      createBuddyUI();
      isUIActive = true;
    }
  }
});

document.head.appendChild(style);
