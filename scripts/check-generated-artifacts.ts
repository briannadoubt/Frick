import { execFileSync } from "node:child_process";

const generatedPaths = [
  "packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift",
  "apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt",
  "packages/protocol/fixtures",
];

execFileSync("pnpm", ["schema:generate"], { stdio: "inherit" });
execFileSync("pnpm", ["fixtures:generate"], { stdio: "inherit" });

try {
  const status = execFileSync("git", ["status", "--porcelain", "--", ...generatedPaths], { encoding: "utf8" });
  if (status.length > 0) {
    process.stderr.write(status);
    throw new Error("Generated artifacts changed");
  }
} catch {
  console.error("Generated artifacts are out of date. Run pnpm schema:generate and pnpm fixtures:generate.");
  process.exit(1);
}
