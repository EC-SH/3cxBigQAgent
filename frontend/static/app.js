/**
 * BigQuery Agent — Chat UI logic
 * Vanilla JS. No framework, no build step.
 */

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("message-input");
const sendBtn = document.getElementById("send-button");
const statusDot = document.querySelector(".status-dot");
const statusText = document.getElementById("status-text");

let sessionId = null;
let isProcessing = false;

// ── Auto-resize textarea ──────────────────────────────────────

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
});

// ── Send on Enter (Shift+Enter for newline) ───────────────────

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

// ── Core send logic ───────────────────────────────────────────

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || isProcessing) return;

  isProcessing = true;
  sendBtn.disabled = true;
  setStatus("thinking", "Thinking...");

  // Render user message
  appendMessage("user", text);
  inputEl.value = "";
  inputEl.style.height = "auto";

  // Show typing indicator
  const typingEl = showTypingIndicator();

  const startTime = performance.now();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, session_id: sessionId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `Request failed with status ${res.status}`);
    }

    const data = await res.json();
    sessionId = data.session_id;

    const duration = ((performance.now() - startTime) / 1000).toFixed(1);
    removeTypingIndicator(typingEl);
    appendMessage("bot", data.response, duration);
    setStatus("ready", "Ready");
  } catch (err) {
    removeTypingIndicator(typingEl);
    appendMessage("bot", `**Error:** ${err.message}`);
    setStatus("error", "Error");
    // Reset to ready after 3s so the dot isn't stuck red
    setTimeout(() => setStatus("ready", "Ready"), 3000);
  } finally {
    isProcessing = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ── Message rendering ─────────────────────────────────────────

function appendMessage(role, text, duration) {
  const msg = document.createElement("div");
  msg.className = `message ${role}-message`;

  const avatarSvg =
    role === "bot"
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const durationBadge = duration
    ? `<span class="duration-badge">${duration}s</span>`
    : "";

  msg.innerHTML = `
    <div class="message-avatar">${avatarSvg}</div>
    <div class="message-content">
      <div class="message-bubble">${renderMarkdown(text)}</div>
      ${durationBadge}
    </div>
  `;

  messagesEl.appendChild(msg);
  scrollToBottom();
}

// ── Typing indicator ──────────────────────────────────────────

function showTypingIndicator() {
  const msg = document.createElement("div");
  msg.className = "message bot-message";
  msg.innerHTML = `
    <div class="message-avatar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="message-content">
      <div class="message-bubble typing-indicator">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
    </div>
  `;
  messagesEl.appendChild(msg);
  scrollToBottom();
  return msg;
}

function removeTypingIndicator(el) {
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// ── Status updates ────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className = "status-dot";
  if (state === "thinking") statusDot.classList.add("thinking");
  if (state === "error") statusDot.classList.add("error");
  statusText.textContent = text;
}

// ── Scroll ────────────────────────────────────────────────────

function scrollToBottom() {
  const chatArea = document.getElementById("chat-area");
  // Small delay to let the DOM render the new message
  requestAnimationFrame(() => {
    chatArea.scrollTop = chatArea.scrollHeight;
  });
}

// ── Simple markdown rendering ─────────────────────────────────
// Handles: bold, inline code, code blocks, lists, paragraphs.
// No library — just enough to make agent output readable.

function renderMarkdown(text) {
  if (!text) return "";

  // Escape HTML first
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold (**...**)
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic (*...*)
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Unordered list items (- item or * item)
  html = html.replace(/^[\-\*]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/gs, "<ul>$&</ul>");

  // Ordered list items (1. item)
  html = html.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");

  // Paragraphs — split by double newlines
  html = html
    .split(/\n{2,}/)
    .map((block) => {
      block = block.trim();
      if (!block) return "";
      // Don't wrap blocks that are already wrapped in HTML tags
      if (/^<(pre|ul|ol|li|table|h[1-6])/.test(block)) return block;
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");

  return html;
}
