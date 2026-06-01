/**
 * `frick restore --input <path> [--tenant-id <id>] [--overwrite]
 *                 [--force-schema-drift] [--confirm yes] [--db-path <path>]`
 *
 * Reads NDJSON from a file and replays it into the framework database.
 * Refuses without `--confirm yes`. Refuses against a production-mode
 * config unless `FRICK_RESTORE_ALLOW_PROD=1` is set in the environment.
 */
import { createReadStream } from "node:fs";
import { FrickRestoreRefusedError, restoreFrickDatabase } from "@frick/server";
import type { ParsedArgs } from "../argv.js";
import { requireString } from "../argv.js";
import { CliFailureError, CliRefusedError, CliUsageError } from "../errors.js";
import { contextFlagsFrom, loadConfig, openStore } from "../context.js";
import { emit, type OutputOptions } from "../output.js";

export async function restoreCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const inputPath = requireString(parsed.flags, "input");
  if (!inputPath) {
    throw new CliUsageError("`frick restore` requires --input <path>");
  }
  const confirm = requireString(parsed.flags, "confirm");
  if (confirm !== "yes") {
    throw new CliRefusedError("`frick restore` requires --confirm yes", {
      reason: "missingConfirmation",
    });
  }

  const config = loadConfig(contextFlagsFrom(parsed.flags));
  if (config.env === "production" && process.env.FRICK_RESTORE_ALLOW_PROD !== "1") {
    throw new CliRefusedError(
      "Refusing to restore against a production-mode config without FRICK_RESTORE_ALLOW_PROD=1",
      { env: config.env, dbPath: config.dbPath },
    );
  }

  const overwrite = parsed.flags.overwrite === true;
  const forceSchemaDrift = parsed.flags["force-schema-drift"] === true;

  const stream = createReadStream(inputPath, { encoding: "utf8" });
  async function* asChunks(): AsyncIterable<string> {
    for await (const chunk of stream) {
      yield chunk as string;
    }
  }

  const store = openStore(config);
  try {
    const report = await restoreFrickDatabase({
      target: store,
      source: asChunks(),
      confirm: "yes",
      overwrite,
      forceSchemaDrift,
    });
    emit(report, out);
    return 0;
  } catch (error) {
    if (error instanceof FrickRestoreRefusedError) {
      throw new CliFailureError(
        `cli.restore.${error.reason}`,
        error.message,
        error.details ?? undefined,
      );
    }
    throw error;
  } finally {
    store.close();
  }
}
