import { execFileSync } from "node:child_process";

/**
 * Snapshot the set of tracked files that currently differ from HEAD.
 *
 * `--untracked-files=no` keeps untracked scratch output a generator might drop
 * (logs, caches) from tripping the gate; we only care about modifications to
 * files that are actually committed.
 */
function dirtyTrackedFiles(): Set<string> {
  const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  });
  return new Set(
    out
      .split("\n")
      .map((line) => line.slice(3).trim()) // strip the "XY " status prefix
      .filter((path) => path.length > 0),
  );
}

// Capture pre-existing local modifications so unrelated in-progress edits don't
// produce false failures; the gate only flags drift *introduced* by the
// generators below.
const before = dirtyTrackedFiles();

execFileSync("pnpm", ["schema:generate"], { stdio: "inherit" });
execFileSync("pnpm", ["fixtures:generate"], { stdio: "inherit" });
execFileSync("pnpm", ["design:generate"], { stdio: "inherit" });

// Check the WHOLE tracked tree, not a hardcoded allowlist. The previous version
// only inspected a fixed set of generated code/token paths, so any generated
// output landing outside that list — docs, READMEs, agent-kit surfaces, etc. —
// silently evaded the gate (FR-108). Comparing the full tracked diff against the
// pre-run snapshot catches generated drift wherever it lands.
const after = dirtyTrackedFiles();
const introduced = [...after].filter((path) => !before.has(path));

if (introduced.length > 0) {
  process.stderr.write(`${introduced.map((path) => `  ${path}`).join("\n")}\n`);
  console.error(
    "Generated artifacts are out of date. Run `pnpm schema:generate`, " +
      "`pnpm fixtures:generate`, and `pnpm design:generate`, then commit the result.",
  );
  process.exit(1);
}
