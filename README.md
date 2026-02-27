# 3CX Query Agent — Desktop App

A desktop app that lets you ask natural-language questions about your 3CX call data stored in BigQuery. Powered by Gemini AI.

---

## Prerequisites

- **Node.js 18 or later** — download from https://nodejs.org (choose LTS)
- **npm** — included with Node.js
- Internet access for the initial `npm install`

---

## Setup (one time)

1. Open a terminal (PowerShell on Windows, Terminal on Mac/Linux) in this folder.

2. Install dependencies:
   ```
   npm install
   ```
   This will take 1–3 minutes the first time — it's downloading Electron, the BigQuery SDK, and the Gemini SDK.

3. Launch the app:
   ```
   npm start
   ```

---

## Using the App

**First time:**

1. Click **Settings** in the sidebar.
2. Enter your **Google Cloud Project ID** and **BigQuery Dataset Name**.
3. Under **BigQuery Authentication**, click **Upload JSON Key…** and select your service account JSON file.
4. Enter your **Gemini API Key** (starts with `AIza...`).
5. Click **Save Configuration**.
6. Back in the sidebar, click **Test Connection**. If successful, the badge turns green and lists your BigQuery tables.

**Asking questions:**

Switch to the **Chat** panel and type any natural-language question about your call data. For example:
- "How many inbound calls did we get this week?"
- "Which extension had the most calls last month?"
- "Show me all calls longer than 10 minutes from yesterday"

The generated SQL is shown in a collapsible section under each answer so you can verify or learn from it.

---

## Building a distributable installer

```
npm run build        # auto-detects your platform
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS DMG
npm run build:linux  # Linux AppImage
```

Output will be in the `dist/` folder.

---

## Credentials & Security

## where creds live

stored in electron's OS app-data dir with basic obfuscation... not plaintext but not cryptographically secure either

- windows: `%APPDATA%\3cx-bigquery-agent`
- mac: `~/Library/Application Support/3cx-bigquery-agent`

fine for personal use on a trusted machine, not suitable for shared or multi-user environments

---

## known limitations (mvp)

- cred encryption is obfuscation only... hardcoded key in source
- no input sanitization before queries hit gemini
- oauth client secret persisted in store
- whole service account json stored locally

tracked, not forgotten. if this becomes a shared tool these get addressed first.


---

## Troubleshooting

**`npm install` fails** — Make sure Node.js 18+ is installed: `node --version`

**"No Google Cloud Project ID configured"** — Go to Settings and fill in both fields, then Save.

**"No service account JSON uploaded"** — Click Upload JSON Key in Settings and select your downloaded key file.

**Connection test fails with auth error** — Double-check that the service account has the `BigQuery Data Editor` and `BigQuery Job User` roles on the project.

**Tables listed as empty after connecting** — The first 3CX export to BigQuery can take up to 24 hours. The connection is working; data just hasn't arrived yet.
