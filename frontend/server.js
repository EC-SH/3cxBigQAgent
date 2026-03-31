const express = require("express");
const { GoogleAuth } = require("google-auth-library");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 8080;
const BACKEND_URL = process.env.BACKEND_URL;

// --- Fail loud and early ---
if (!BACKEND_URL) {
  console.error(
    JSON.stringify({
      severity: "CRITICAL",
      message: "BACKEND_URL is not set. Refusing to start.",
      timestamp: Date.now(),
    })
  );
  process.exit(1);
}

function log(level, msg, ctx = {}) {
  console.log(
    JSON.stringify({
      severity: level,
      message: msg,
      timestamp: Date.now(),
      ...ctx,
    })
  );
}

const auth = new GoogleAuth();
const app = express();

// Health check — deploy script smoke test hits this
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Proxy /api/* to the backend with OIDC identity token injection
// Backend requires identity token, not access token — access tokens won't pass
// the IAM invoker check on internal-only Cloud Run services
app.use(
  "/api",
  async (req, _res, next) => {
    const requestId = randomUUID().slice(0, 8);
    req.headers["x-request-id"] = requestId;

    try {
      const client = await auth.getIdTokenClient(BACKEND_URL);
      const headers = await client.getRequestHeaders();
      req.headers["authorization"] = headers.Authorization;
      log("INFO", "proxy_request", {
        requestId,
        method: req.method,
        path: req.originalUrl,
      });
    } catch (err) {
      log("ERROR", "oidc_token_fetch_failed", {
        requestId,
        error: err.message,
      });
      // Don't block the request — let the backend reject it with 403
      // so the error is visible in backend logs too
    }

    next();
  },
  createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    pathRewrite: { "^/api": "" },
    on: {
      proxyRes: (proxyRes, req) => {
        log("INFO", "proxy_response", {
          requestId: req.headers["x-request-id"],
          status: proxyRes.statusCode,
        });
      },
      error: (err, req) => {
        log("ERROR", "proxy_error", {
          requestId: req.headers["x-request-id"],
          error: err.message,
        });
      },
    },
  })
);

// Serve static files (the chat UI)
app.use(express.static("static"));

app.listen(PORT, () => {
  log("INFO", "server_started", { port: PORT, backend: BACKEND_URL });
});
