/**
 * main.js — Electron Main Process
 *
 * This is the "backend" of the Electron app. It runs in Node.js, which means
 * it has access to the filesystem, can call Google APIs, and manages the app
 * lifecycle. The browser window (renderer) can't do any of this directly for
 * security reasons — instead it sends IPC messages here and we do the work.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { BigQuery } = require('@google-cloud/bigquery');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const Store = require('electron-store');

// electron-store persists config between sessions in the OS userData directory
// (e.g. %APPDATA%/3cx-bigquery-agent on Windows, ~/Library/Application Support/... on Mac)
const store = new Store({
  encryptionKey: 'engage-3cx-agent-v1', // basic obfuscation for stored credentials
});

let mainWindow;
let bigqueryClient = null;
let geminiClient = null;
let tableSchemaCache = {}; // cache discovered BigQuery table schemas

// ── Window creation ──────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f0f10',
    webPreferences: {
      // preload.js is the ONLY bridge between renderer and main.
      // It explicitly exposes only the functions we choose — nothing else.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,  // renderer can't access Node.js globals
      nodeIntegration: false,  // belt and suspenders
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: Config management ───────────────────────────────────────────────────

// Load whatever config is currently saved so the renderer can pre-fill the UI
ipcMain.handle('config:load', () => {
  return {
    projectId:   store.get('projectId', ''),
    datasetId:   store.get('datasetId', ''),
    geminiKey:   store.get('geminiKey', ''),
    authMethod:  store.get('authMethod', 'serviceAccount'), // 'serviceAccount' | 'apiKey' | 'browser'
    hasJsonKey:  !!store.get('serviceAccountJson'),
  };
});

// Save config from the renderer's settings form
ipcMain.handle('config:save', (event, config) => {
  if (config.projectId)  store.set('projectId',  config.projectId.trim());
  if (config.datasetId)  store.set('datasetId',   config.datasetId.trim());
  if (config.geminiKey)  store.set('geminiKey',   config.geminiKey.trim());
  if (config.authMethod) store.set('authMethod',  config.authMethod);
  // Reset clients so they're re-initialized with new credentials on next query
  bigqueryClient = null;
  geminiClient   = null;
  tableSchemaCache = {};
  return { ok: true };
});

// ── IPC: Service account JSON upload ────────────────────────────────────────

// Opens a native file picker dialog and reads the chosen JSON key file
ipcMain.handle('auth:pickJsonFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Service Account JSON Key',
    filters: [{ name: 'JSON Key', extensions: ['json'] }],
    properties: ['openFile'],
  });

  if (result.canceled || !result.filePaths.length) return { ok: false };

  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    const parsed = JSON.parse(raw);

    // Basic validation — Google service account files always have these fields
    if (!parsed.type || parsed.type !== 'service_account') {
      return { ok: false, error: 'Not a valid service account JSON file. Make sure you downloaded the right key.' };
    }

    store.set('serviceAccountJson', raw);
    store.set('authMethod', 'serviceAccount');
    bigqueryClient = null; // force re-init
    return { ok: true, email: parsed.client_email };
  } catch (e) {
    return { ok: false, error: `Could not read file: ${e.message}` };
  }
});

// ── IPC: Browser OAuth flow ──────────────────────────────────────────────────

// Triggers Google's OAuth2 device/browser flow for users who don't have a key file.
// This is the "Sign in with Google" path.
ipcMain.handle('auth:browserLogin', async () => {
  const clientId     = store.get('oauthClientId', '');
  const clientSecret = store.get('oauthClientSecret', '');

  if (!clientId || !clientSecret) {
    return {
      ok: false,
      error: 'OAuth client credentials not configured. Add your OAuth2 Client ID and Secret in settings, or use a service account JSON instead.',
    };
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob' // "out of band" — shows the auth code in the browser for manual paste
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/bigquery.readonly',
      'https://www.googleapis.com/auth/cloud-platform.read-only',
    ],
  });

  // Opens the URL in the user's default browser (not inside Electron)
  shell.openExternal(authUrl);
  store.set('authMethod', 'browser');
  store.set('pendingOauthClient', JSON.stringify({ clientId, clientSecret }));

  return { ok: true, authUrl };
});

// Called after the user pastes their auth code back into the app
ipcMain.handle('auth:submitOauthCode', async (event, code) => {
  try {
    const pending = JSON.parse(store.get('pendingOauthClient', '{}'));
    const oauth2Client = new google.auth.OAuth2(pending.clientId, pending.clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
    const { tokens } = await oauth2Client.getToken(code.trim());
    store.set('oauthTokens', JSON.stringify(tokens));
    store.set('authMethod', 'browser');
    bigqueryClient = null;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Token exchange failed: ${e.message}` };
  }
});

// ── BigQuery client factory ──────────────────────────────────────────────────

function getBigQueryClient() {
  if (bigqueryClient) return bigqueryClient;

  const projectId = store.get('projectId');
  const authMethod = store.get('authMethod', 'serviceAccount');

  if (!projectId) throw new Error('No Google Cloud Project ID configured. Go to Settings.');

  if (authMethod === 'serviceAccount') {
    const jsonRaw = store.get('serviceAccountJson');
    if (!jsonRaw) throw new Error('No service account JSON uploaded. Go to Settings and upload your key file.');
    const credentials = JSON.parse(jsonRaw);
    bigqueryClient = new BigQuery({ projectId, credentials });

  } else if (authMethod === 'browser') {
    const tokensRaw = store.get('oauthTokens');
    if (!tokensRaw) throw new Error('Browser auth not completed. Go to Settings and sign in.');
    // googleapis handles token refresh automatically
    const pending = JSON.parse(store.get('pendingOauthClient', '{}'));
    const oauth2Client = new google.auth.OAuth2(pending.clientId, pending.clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
    oauth2Client.setCredentials(JSON.parse(tokensRaw));
    bigqueryClient = new BigQuery({ projectId, authClient: oauth2Client });

  } else {
    // API key only — BigQuery requires OAuth, so we try Application Default Credentials
    // This works if gcloud CLI is installed and configured on the machine
    bigqueryClient = new BigQuery({ projectId });
  }

  return bigqueryClient;
}

// ── Gemini client factory ─────────────────────────────────────────────────────

function getGeminiClient() {
  if (geminiClient) return geminiClient;
  const key = store.get('geminiKey');
  if (!key) throw new Error('No Gemini API key configured. Go to Settings and add your key.');
  geminiClient = new GoogleGenerativeAI(key);
  return geminiClient;
}

// ── IPC: Connection test ──────────────────────────────────────────────────────

ipcMain.handle('agent:testConnection', async () => {
  try {
    const bq = getBigQueryClient();
    const datasetId = store.get('datasetId');
    if (!datasetId) return { ok: false, error: 'No BigQuery dataset configured. Go to Settings.' };

    // List tables as a lightweight connectivity check
    const [tables] = await bq.dataset(datasetId).getTables();
    const tableNames = tables.map(t => t.id);

    // Also prime the schema cache while we're here
    for (const table of tables) {
      const [meta] = await table.getMetadata();
      tableSchemaCache[table.id] = meta.schema?.fields || [];
    }

    return { ok: true, tables: tableNames };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── IPC: Natural language query (the main event) ─────────────────────────────

ipcMain.handle('agent:query', async (event, userQuestion) => {
  try {
    const bq        = getBigQueryClient();
    const ai        = getGeminiClient();
    const datasetId = store.get('datasetId');
    const projectId = store.get('projectId');

    if (!datasetId) throw new Error('No BigQuery dataset configured.');

    // ── Step 1: Discover schema if not cached ───────────────────────────────
    if (Object.keys(tableSchemaCache).length === 0) {
      const [tables] = await bq.dataset(datasetId).getTables();
      for (const table of tables) {
        const [meta] = await table.getMetadata();
        tableSchemaCache[table.id] = meta.schema?.fields || [];
      }
    }

    // Build a compact schema description to include in the Gemini prompt.
    // We only send field names and types — not actual data — to keep the prompt small.
    const schemaText = Object.entries(tableSchemaCache)
      .map(([tableName, fields]) => {
        const cols = fields.map(f => `  ${f.name} (${f.type})`).join('\n');
        return `Table: \`${projectId}.${datasetId}.${tableName}\`\n${cols}`;
      })
      .join('\n\n');

    // ── Step 2: Ask Gemini to generate SQL ──────────────────────────────────
    const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const systemPrompt = `You are a BigQuery SQL expert for a 3CX phone system analytics database.
Given the following table schemas, write a valid BigQuery SQL query that answers the user's question.

SCHEMA:
${schemaText}

RULES:
- Return ONLY the SQL query, nothing else — no markdown, no explanation, no backticks.
- Use fully-qualified table names: \`${projectId}.${datasetId}.TableName\`
- Use STANDARD SQL (BigQuery default). DATE functions: CURRENT_DATE(), DATE_SUB(), FORMAT_DATE().
- TIMESTAMP columns: use TIMESTAMP_TRUNC() for grouping by day/hour.
- Limit results to 200 rows maximum unless the question asks for all data.
- If the question cannot be answered from the schema, respond with exactly: CANNOT_ANSWER

USER QUESTION: ${userQuestion}`;

    const geminiResult = await model.generateContent(systemPrompt);
    const sql = geminiResult.response.text().trim();

    if (sql === 'CANNOT_ANSWER') {
      return {
        ok: true,
        sql: null,
        rows: [],
        columns: [],
        message: "I couldn't find a way to answer that from the available 3CX data. Try rephrasing, or ask about calls, queues, extensions, or call durations.",
      };
    }

    // ── Step 3: Execute the generated SQL against BigQuery ──────────────────
    const [rows] = await bq.query({ query: sql, useLegacySql: false });

    // Extract column names from the first row's keys
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    // BigQuery returns some values as BigQuery-specific objects (e.g. BigInt, Date).
    // Serialize them to plain JS values for JSON transfer to the renderer.
    const serialized = rows.map(row =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, serializeValue(v)])
      )
    );

    return { ok: true, sql, rows: serialized, columns, message: null };

  } catch (e) {
    return { ok: false, error: e.message, sql: null };
  }
});

// Converts BigQuery response values to plain JSON-serializable types
function serializeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && v.value !== undefined) return v.value; // BigQuery date/time wrapper
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

// ── IPC: Open external links safely ─────────────────────────────────────────

ipcMain.handle('shell:openExternal', (event, url) => {
  // Only allow https:// links to prevent shell injection
  if (url.startsWith('https://')) shell.openExternal(url);
});
