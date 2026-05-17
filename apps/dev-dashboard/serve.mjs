import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..");
const port = Number(process.env.PORT ?? 4299);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const allowedFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/dashboard.css", "dashboard.css"],
  ["/dashboard.js", "dashboard.js"],
]);

const securityHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'none'",
    "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
    "frame-src http://127.0.0.1:* http://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

function send(res, req, status, body, headers = {}) {
  res.writeHead(status, {
    ...securityHeaders,
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, req, 405, "method not allowed", {
        allow: "GET, HEAD",
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const fileName = allowedFiles.get(url.pathname);
    if (!fileName) {
      send(res, req, 404, "not found", {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      return;
    }

    const file = resolve(root, fileName);
    const body = await readFile(file);
    send(res, req, 200, body, {
      "content-type": mime[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
  } catch {
    send(res, req, 500, "internal server error", {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dev-dashboard listening on http://127.0.0.1:${port}`);
});
