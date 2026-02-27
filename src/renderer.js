/**
 * renderer.js — Renderer Process UI Logic
 *
 * This runs in the browser window (Chromium). It has NO access to Node.js or
 * the filesystem — it can only talk to the main process through window.electronAPI,
 * which was set up by preload.js.
 *
 * Responsibilities:
 * - Panel navigation (Chat ↔ Settings)
 * - Settings form: load, edit, save
 * - Auth: service account JSON file picker, browser OAuth flow
 * - Connection test: display tables, update status badge
 * - Chat: send queries, render thinking state, render results as tables + SQL
 */

'use strict';

/* ── DOM refs ─────────────────────────────────────────────────────────────── */
const $  = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// Nav
const navBtns    = $$('.nav-btn');
const panels     = { chat: $('panel-chat'), settings: $('panel-settings') };

// Settings form
const inputProject     = $('input-project');
const inputDataset     = $('input-dataset');
const inputGemini      = $('input-gemini');
const inputOauthId     = $('input-oauth-id');
const inputOauthSecret = $('input-oauth-secret');
const inputOauthCode   = $('input-oauth-code');
const btnSave          = $('btn-save');
const saveFeedback     = $('save-feedback');
const btnPickJson      = $('btn-pick-json');
const jsonStatus       = $('json-status');
const btnBrowserLogin  = $('btn-browser-login');
const oauthCodeRow     = $('oauth-code-row');
const btnSubmitCode    = $('btn-submit-code');
const authTabs         = $$('.auth-tab');
const authPanes        = $$('.auth-pane');

// Connection
const connStatus = $('conn-status');
const connTables = $('conn-tables');
const btnTest    = $('btn-test');

// Chat
const chatFeed    = $('chat-feed');
const queryInput  = $('query-input');
const btnSend     = $('btn-send');
const exampleChips = $$('.example-chip');

// ── Panel navigation ──────────────────────────────────────────────────────────

function showPanel(name) {
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  Object.entries(panels).forEach(([k, el]) => el.classList.toggle('active', k === name));
}

navBtns.forEach(btn => btn.addEventListener('click', () => showPanel(btn.dataset.panel)));

// ── Load saved config into the form ──────────────────────────────────────────

async function loadConfig() {
  const cfg = await window.electronAPI.loadConfig();
  if (cfg.projectId) inputProject.value = cfg.projectId;
  if (cfg.datasetId) inputDataset.value = cfg.datasetId;
  if (cfg.geminiKey) inputGemini.value  = cfg.geminiKey;

  if (cfg.hasJsonKey) {
    jsonStatus.textContent = '✓ Key file loaded';
    jsonStatus.className = 'file-status loaded';
  }

  // Activate the right auth tab
  activateAuthTab(cfg.authMethod || 'serviceAccount');
}

// ── Auth method tabs ──────────────────────────────────────────────────────────

function activateAuthTab(method) {
  authTabs.forEach(t => t.classList.toggle('active', t.dataset.auth === method));
  authPanes.forEach(p => p.classList.toggle('active', p.id === `auth-pane-${method}`));
}

authTabs.forEach(tab => {
  tab.addEventListener('click', () => activateAuthTab(tab.dataset.auth));
});

// ── Service account JSON upload ───────────────────────────────────────────────

btnPickJson.addEventListener('click', async () => {
  const result = await window.electronAPI.pickJsonFile();
  if (!result.ok) {
    showToast(result.error || 'Could not load key file', 'error');
    return;
  }
  // result.email is the service account's email address from the JSON
  jsonStatus.textContent = `✓ ${result.email}`;
  jsonStatus.className = 'file-status loaded';
  showToast('Service account key loaded', 'success');
});

// ── Browser OAuth flow ────────────────────────────────────────────────────────

btnBrowserLogin.addEventListener('click', async () => {
  // Save the OAuth credentials to store first
  await window.electronAPI.saveConfig({
    oauthClientId:     inputOauthId.value,
    oauthClientSecret: inputOauthSecret.value,
  });

  const result = await window.electronAPI.browserLogin();
  if (!result.ok) {
    showToast(result.error, 'error');
    return;
  }
  // Show the code paste field — the browser will open and the user pastes back the code
  oauthCodeRow.classList.remove('hidden');
  showToast('Browser opened — sign in and paste the code below', 'success');
});

btnSubmitCode.addEventListener('click', async () => {
  const code = inputOauthCode.value.trim();
  if (!code) { showToast('Please paste the authorization code', 'error'); return; }
  const result = await window.electronAPI.submitOauthCode(code);
  if (!result.ok) {
    showToast(result.error, 'error');
  } else {
    oauthCodeRow.classList.add('hidden');
    inputOauthCode.value = '';
    showToast('Signed in successfully', 'success');
  }
});

// ── Save config ───────────────────────────────────────────────────────────────

btnSave.addEventListener('click', async () => {
  // Which auth method is currently shown?
  const activeAuthTab = document.querySelector('.auth-tab.active');
  const authMethod = activeAuthTab?.dataset.auth || 'serviceAccount';

  await window.electronAPI.saveConfig({
    projectId:  inputProject.value,
    datasetId:  inputDataset.value,
    geminiKey:  inputGemini.value,
    authMethod,
    // OAuth creds saved separately (in browser login handler above)
  });

  saveFeedback.textContent = '✓ Saved';
  setTimeout(() => { saveFeedback.textContent = ''; }, 2500);
});

// ── Connection test ───────────────────────────────────────────────────────────

async function testConnection() {
  connStatus.className = 'conn-badge testing';
  connStatus.textContent = 'Testing…';
  connTables.textContent = '';
  btnTest.disabled = true;

  const result = await window.electronAPI.testConnection();

  if (result.ok) {
    connStatus.className = 'conn-badge connected';
    connStatus.textContent = 'Connected';
    if (result.tables.length > 0) {
      connTables.className = 'conn-tables has-tables';
      connTables.textContent = result.tables.join('\n');
    } else {
      connTables.textContent = 'No tables found yet\n(export may be pending)';
    }
    btnSend.disabled = false;
    // Once connected, clear the empty feed state
    const emptyState = chatFeed.querySelector('.feed-empty');
    if (emptyState) emptyState.remove();
  } else {
    connStatus.className = 'conn-badge error';
    connStatus.textContent = 'Error';
    connTables.textContent = result.error;
    btnSend.disabled = true;
    showToast(`Connection failed: ${result.error}`, 'error');
  }

  btnTest.disabled = false;
}

btnTest.addEventListener('click', testConnection);

// ── Chat: input auto-resize and send on Enter ─────────────────────────────────

queryInput.addEventListener('input', () => {
  // Auto-grow the textarea up to its max-height (set in CSS)
  queryInput.style.height = 'auto';
  queryInput.style.height = queryInput.scrollHeight + 'px';
});

queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendQuery();
  }
});

btnSend.addEventListener('click', sendQuery);

// Example chips pre-fill the input and send immediately
exampleChips.forEach(chip => {
  chip.addEventListener('click', () => {
    queryInput.value = chip.dataset.q;
    queryInput.style.height = 'auto';
    sendQuery();
  });
});

// ── Chat: query flow ──────────────────────────────────────────────────────────

let isQuerying = false;

async function sendQuery() {
  const text = queryInput.value.trim();
  if (!text || isQuerying) return;

  isQuerying = true;
  btnSend.disabled = true;
  queryInput.value = '';
  queryInput.style.height = 'auto';

  // 1. Render the user's question
  appendQuestion(text);

  // 2. Show the thinking indicator while we wait
  const thinkingEl = appendThinking();

  // 3. Send to main process (Gemini → BigQuery)
  const result = await window.electronAPI.query(text);

  // 4. Remove thinking indicator and render the result
  thinkingEl.remove();
  appendAnswer(result);

  isQuerying = false;
  btnSend.disabled = false;
  queryInput.focus();
}

// ── Chat: DOM rendering helpers ───────────────────────────────────────────────

function appendQuestion(text) {
  const el = document.createElement('div');
  el.className = 'message';
  el.innerHTML = `<div class="msg-question">${escapeHtml(text)}</div>`;
  chatFeed.appendChild(el);
  chatFeed.scrollTop = chatFeed.scrollHeight;
  return el;
}

function appendThinking() {
  const el = document.createElement('div');
  el.className = 'message';
  el.innerHTML = `
    <div class="msg-answer">
      <div class="msg-answer-header">
        <div class="answer-icon">
          <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        </div>
        <span class="answer-label">Thinking</span>
      </div>
      <div class="thinking"><span></span><span></span><span></span></div>
    </div>`;
  chatFeed.appendChild(el);
  chatFeed.scrollTop = chatFeed.scrollHeight;
  return el;
}

function appendAnswer(result) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message';

  // Build the answer container
  const answer = document.createElement('div');
  answer.className = 'msg-answer';

  // Header row
  answer.innerHTML = `
    <div class="msg-answer-header">
      <div class="answer-icon">
        <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </div>
      <span class="answer-label">Agent</span>
    </div>`;

  if (!result.ok) {
    // Error from main process
    const err = document.createElement('div');
    err.className = 'msg-text msg-error';
    err.textContent = result.error;
    answer.appendChild(err);

  } else if (result.message) {
    // "CANNOT_ANSWER" or info message from the agent
    const msg = document.createElement('div');
    msg.className = 'msg-text';
    msg.textContent = result.message;
    answer.appendChild(msg);

  } else {
    // We have real results

    // SQL disclosure (collapsed by default — keeps the UI clean)
    if (result.sql) {
      const details = document.createElement('details');
      details.className = 'sql-disclosure';
      details.innerHTML = `<summary>SQL Query</summary><pre class="sql-block">${escapeHtml(result.sql)}</pre>`;
      answer.appendChild(details);
    }

    // Results table or empty message
    if (result.rows && result.rows.length > 0) {
      answer.appendChild(buildResultsTable(result.columns, result.rows));
    } else {
      const empty = document.createElement('div');
      empty.className = 'msg-text';
      empty.textContent = 'Query ran successfully but returned no rows.';
      answer.appendChild(empty);
    }
  }

  wrapper.appendChild(answer);
  chatFeed.appendChild(wrapper);
  chatFeed.scrollTop = chatFeed.scrollHeight;
  return wrapper;
}

function buildResultsTable(columns, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'results-wrap';

  // Row count metadata strip
  const meta = document.createElement('div');
  meta.className = 'results-meta';
  meta.textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''} · ${columns.length} column${columns.length !== 1 ? 's' : ''}`;
  wrap.appendChild(meta);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'results-table-wrap';

  const table = document.createElement('table');
  table.className = 'results-table';

  // Header
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>${columns.map(c => `<th title="${escapeHtml(c)}">${escapeHtml(c)}</th>`).join('')}</tr>`;
  table.appendChild(thead);

  // Body — limit visual rows to 200 for performance (BigQuery already limits the query)
  const tbody = document.createElement('tbody');
  rows.slice(0, 200).forEach(row => {
    const tr = document.createElement('tr');
    columns.forEach(col => {
      const td = document.createElement('td');
      const val = row[col];
      const display = val === null || val === undefined ? '—' : String(val);
      td.textContent = display;
      td.title = display; // tooltip on hover for truncated values
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
  return wrap;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('toast-container').appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.4s';
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

// ── Footer links (open in system browser, not Electron window) ─────────────────

document.querySelectorAll('[data-url]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal(el.dataset.url);
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadConfig();
