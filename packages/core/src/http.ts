/**
 * Translate a WebSocket sync endpoint (e.g. `ws://127.0.0.1:4099`) into the
 * matching HTTP origin (`http://127.0.0.1:4099`). Used by
 * {@link FrickClient.loadOlder} and by the `@frick/react` provider to
 * derive a default `httpEndpoint` when the consumer doesn't pass one.
 *
 * Strips path, search, and hash so the result is a clean origin suitable
 * for relative-URL composition.
 */
export function resolveHttpEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
    url.pathname = "";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
    url.pathname = "";
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
