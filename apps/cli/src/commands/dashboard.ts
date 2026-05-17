import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireString, type ParsedArgs } from "../argv.js";
import { CliUsageError, EXIT_OK } from "../errors.js";
import { emit, type OutputOptions } from "../output.js";

const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
const DEFAULT_DASHBOARD_PORT = 4299;
const DEFAULT_FRICK_ENDPOINT = "http://127.0.0.1:4099";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
} as const;

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

export async function dashboardCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const host = requireString(parsed.flags, "host") ?? DEFAULT_DASHBOARD_HOST;
  const port = parsePortFlag(requireString(parsed.flags, "port"));
  const endpoint =
    requireString(parsed.flags, "endpoint") ??
    process.env.FRICK_DASHBOARD_ENDPOINT ??
    DEFAULT_FRICK_ENDPOINT;
  validateEndpoint(endpoint);

  const root = await resolveDashboardRoot(dirname(fileURLToPath(import.meta.url)));
  const server = createDashboardServer(root);
  await listen(server, port, host);

  const actualPort = boundPort(server);
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = new URL(`http://${displayHost}:${actualPort}/`);
  url.searchParams.set("endpoint", endpoint);

  emit(
    {
      ok: true,
      command: "dashboard",
      url: url.toString(),
      host,
      port: actualPort,
      endpoint,
    },
    out,
  );

  await waitForever();
  return EXIT_OK;
}

async function resolveDashboardRoot(here: string): Promise<string> {
  const candidates = [
    resolve(here, "../dev-dashboard"),
    resolve(here, "../../dev-dashboard"),
    resolve(here, "../../../dev-dashboard"),
  ];

  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, "index.html"));
      return candidate;
    } catch {
      // Try the next layout: packaged dist first, monorepo source/dist last.
    }
  }

  throw new CliUsageError("dashboard assets were not found; rebuild @frick/cli before running `frick dashboard`");
}

function createDashboardServer(root: string): Server {
  return createServer(async (req, res) => {
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
        "content-type": mime[extname(file) as keyof typeof mime] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
    } catch {
      send(res, req, 500, "internal server error", {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
    }
  });
}

function send(
  res: ServerResponse,
  req: IncomingMessage,
  status: number,
  body: string | Buffer,
  headers: Record<string, string>,
): void {
  res.writeHead(status, {
    ...securityHeaders,
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function parsePortFlag(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DASHBOARD_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliUsageError(`--port must be an integer in [0, 65535], got ${JSON.stringify(raw)}`);
  }
  return port;
}

function validateEndpoint(endpoint: string): void {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
  } catch {
    throw new CliUsageError(`--endpoint must be an HTTP(S) URL, got ${JSON.stringify(endpoint)}`);
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address && typeof address === "object") return address.port;
  return DEFAULT_DASHBOARD_PORT;
}

function waitForever(): Promise<never> {
  return new Promise(() => {
    // Keep the CLI process alive until the user sends SIGINT/SIGTERM.
  });
}
