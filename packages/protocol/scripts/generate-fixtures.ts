import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  errorEnvelopeFixture,
  foundationSchemaFixture,
  helloFrameFixture,
} from "../src/fixtures.js";

const fixturesDir = join(process.cwd(), "packages/protocol/fixtures");

rmSync(fixturesDir, { recursive: true, force: true });
mkdirSync(fixturesDir, { recursive: true });
writeJson("foundation-schema.json", foundationSchemaFixture());
writeJson("error-envelope.json", errorEnvelopeFixture());
writeJson("hello-frame.json", helloFrameFixture());

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(fixturesDir, name), `${JSON.stringify(value, null, 2)}\n`);
}
