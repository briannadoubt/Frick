import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function loadServiceWorkerSanitizer(): (value: unknown) => string | undefined {
  const source = readFileSync(new URL("../public/frick-sw.js", import.meta.url), "utf8");
  const factory = new Function(
    "self",
    `${source}
return { sanitizeNotificationDeepLink };`,
  ) as (scope: unknown) => { sanitizeNotificationDeepLink(value: unknown): string | undefined };
  return factory({
    location: new URL("https://app.example.test/frick-sw.js"),
    addEventListener: () => undefined,
    skipWaiting: () => undefined,
    clients: {
      claim: () => Promise.resolve(),
    },
  }).sanitizeNotificationDeepLink;
}

describe("service worker notification deep links", () => {
  test("normalizes allowed same-origin app routes", () => {
    const sanitize = loadServiceWorkerSanitizer();

    expect(sanitize("https://app.example.test/conversations/conversation-1?focus=latest#message-2")).toBe(
      "/conversations/conversation-1?focus=latest#message-2",
    );
    expect(sanitize("/chat/general")).toBe("/chat/general");
  });

  test.each([
    "https://evil.example/collect",
    "//evil.example/collect",
    "//app.example.test/chat/general",
    "javascript:alert(1)",
    "data:text/html,<h1>x</h1>",
    "/admin",
  ])("rejects unsafe notification click target %s", (target) => {
    const sanitize = loadServiceWorkerSanitizer();

    expect(sanitize(target)).toBeUndefined();
  });
});
