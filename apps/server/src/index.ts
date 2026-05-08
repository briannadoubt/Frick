import { createFrickServer } from "./server.js";

const app = createFrickServer();
await app.listen();

console.log(`Frick sync server listening on http://127.0.0.1:${app.port}`);
console.log(`WebSocket sync endpoint ws://127.0.0.1:${app.port}/_frick/sync`);
