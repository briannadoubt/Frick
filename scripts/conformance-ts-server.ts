// Boots the TypeScript Frick server with the `productTestSchema` on a fixed
// port so the language-neutral conformance suite (crates/frick-conformance)
// can run against it for the cross-implementation parity check:
//
//   pnpm tsx scripts/conformance-ts-server.ts &        # starts on :4099
//   FRICK_CONFORMANCE_URL=http://127.0.0.1:4099 \
//     cargo test -p frick-conformance
//
// The same suite runs against the in-process Rust server by default (no env
// var). Port comes from PORT (default 4099); the DB is in-memory and the env
// is development so demo/dev-login auth is on — matching the Rust default.
import { productTestSchema } from "../packages/protocol/src/index.js";
import { createFrickServer } from "../apps/server/src/server.js";

const port = Number(process.env.PORT ?? 4099);

const server = createFrickServer({
  port,
  dbPath: ":memory:",
  config: { env: "development" as const },
  schema: productTestSchema,
});

await server.listen();
process.stdout.write(
  `${JSON.stringify({ ok: true, server: "ts", schemaId: productTestSchema.schemaId, httpUrl: server.httpUrl })}\n`,
);

// Stay up until terminated; shut down cleanly on signal.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
