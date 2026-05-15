import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..");
const port = Number(process.env.PORT ?? 4299);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    let requestPath = decodeURIComponent(url.pathname);
    if (requestPath === "/" || requestPath === "") requestPath = "/index.html";
    const file = resolve(root, `.${requestPath}`);
    const relativePath = relative(root, file);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": mime[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      res.writeHead(404).end("not found");
    } else {
      res.writeHead(500).end(String(err));
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dev-dashboard listening on http://127.0.0.1:${port}`);
});
