import { createFrickServer } from "@frick/server";
import { schema } from "./schema.js";

const port = Number(process.env.PORT ?? 4099);

const app = createFrickServer({ schema, port });

await app.listen();
