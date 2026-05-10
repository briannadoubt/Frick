import { execFileSync } from "node:child_process";

const generatedPaths = [
  "packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift",
  "apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt",
  "packages/protocol/fixtures",
];

execFileSync("pnpm", ["schema:generate"], { stdio: "inherit" });
execFileSync("pnpm", ["fixtures:generate"], { stdio: "inherit" });

try {
  execFileSync("git", ["diff", "--exit-code", "--", ...generatedPaths], { stdio: "inherit" });
} catch {
  console.error("Generated artifacts are out of date. Run pnpm schema:generate and pnpm fixtures:generate.");
  process.exit(1);
}
