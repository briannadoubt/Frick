/**
 * `frick backup [--tenant-id <id>|all] [--output <path>] [--db-path <path>]`
 *
 * Streams the framework database as NDJSON. Defaults to the `_default`
 * tenant; pass `--tenant-id all` for whole-database. Output goes to stdout
 * unless `--output <path>` is given, in which case stdout receives a final
 * one-line summary record (rowCount, path) so callers always get a stable
 * JSON record back.
 */
import { createWriteStream } from "node:fs";
import { dumpFrickDatabase } from "@fricken/server";
import type { ParsedArgs } from "../argv.js";
import { requireString } from "../argv.js";
import { contextFlagsFrom, loadConfig, openStore } from "../context.js";
import { emit, type OutputOptions } from "../output.js";

export async function backupCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const tenantFlag = requireString(parsed.flags, "tenant-id");
  const outputPath = requireString(parsed.flags, "output");
  const tenantId = tenantFlag && tenantFlag.length > 0 ? tenantFlag : "_default";

  const store = openStore(config);
  let writeLine: (line: string) => void;
  let close: () => Promise<void>;
  if (outputPath) {
    const stream = createWriteStream(outputPath);
    writeLine = (line) => {
      stream.write(`${line}\n`);
    };
    close = () =>
      new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
  } else {
    writeLine = (line) => {
      out.stdout.write(`${line}\n`);
    };
    close = async () => {
      // stdout: nothing to close.
    };
  }

  let rowCount = 0;
  try {
    for await (const line of dumpFrickDatabase(store, { tenantId })) {
      writeLine(line);
      rowCount += 1;
    }
    await close();
  } finally {
    store.close();
  }

  if (outputPath) {
    emit(
      {
        ok: true,
        dbPath: config.dbPath,
        tenantId,
        output: outputPath,
        rows: rowCount,
      },
      out,
    );
  } else {
    // When NDJSON has gone to stdout we report the summary to stderr so the
    // primary stream stays a clean newline-delimited dump.
    out.stderr.write(
      `${JSON.stringify({ ok: true, dbPath: config.dbPath, tenantId, rows: rowCount })}\n`,
    );
  }
  return 0;
}
