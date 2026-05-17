import { access, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const allowedFiles = new Map<string, string>([
  ["", "index.html"],
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/dashboard.css", "dashboard.css"],
  ["/dashboard.js", "dashboard.js"],
]);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

let assetRootPromise: Promise<string> | undefined;

export async function resolveDashboardAssetRoot(
  here = dirname(fileURLToPath(import.meta.url)),
): Promise<string> {
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
      // Try the next packaged/source layout.
    }
  }

  throw new Error("dashboard assets were not found");
}

export async function sendDashboardAsset(input: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly assetRoot?: string;
  readonly path: string;
  readonly headers: Record<string, string>;
}): Promise<boolean> {
  const fileName = allowedFiles.get(input.path);
  if (!fileName) return false;

  const assetRoot = input.assetRoot ?? await defaultDashboardAssetRoot();
  const body = await readFile(resolve(assetRoot, fileName));
  input.response.writeHead(200, {
    ...input.headers,
    "content-type": contentTypes[extname(fileName)] ?? "application/octet-stream",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
  });
  input.response.end(input.request.method === "HEAD" ? undefined : body);
  return true;
}

function defaultDashboardAssetRoot(): Promise<string> {
  assetRootPromise ??= resolveDashboardAssetRoot();
  return assetRootPromise;
}
