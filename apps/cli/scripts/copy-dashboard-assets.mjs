import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "../dev-dashboard");
const targetRoot = resolve(packageRoot, "dist/dev-dashboard");
const staticFiles = ["index.html", "dashboard.css", "dashboard.js"];

await rm(targetRoot, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });

await Promise.all(
  staticFiles.map((file) => copyFile(resolve(sourceRoot, file), resolve(targetRoot, file))),
);
