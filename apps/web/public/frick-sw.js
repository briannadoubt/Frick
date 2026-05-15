// Frick Service Worker — handles background sync triggers + web push
// receive. Registered by `apps/web/src/main.tsx` via the helper exported
// from `@frick/core/push-web` (Phase 5d, follow-up commit).
//
// Background Sync: when the browser fires a `sync` event tagged
// `frick-pending-appends`, the worker posts a `frick:flush` message to
// every active client tab so the `FrickClient` in-page can drain its
// IndexedDB-backed pending-append queue against the live socket.
//
// Push receive: on a `push` event, the worker fetches the latest
// devtools event feed (the framework's existing inspect surface) to
// resolve the actual notification body, then shows a system
// notification. Apps that want a richer payload — and don't want a
// roundtrip — can override this handler in their own SW.
//
// Vendored verbatim into `apps/web/public/` so Vite serves it from the
// site root and the registration path stays `/frick-sw.js`.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("sync", (event) => {
  if (event.tag !== "frick-pending-appends") return;
  event.waitUntil(notifyClients({ type: "frick:flush" }));
});

self.addEventListener("push", (event) => {
  const data = event.data ? safeParse(event.data.text()) : {};
  const title = data?.title ?? "New message";
  const deepLink = sanitizeNotificationDeepLink(data?.deepLink);
  const options = {
    body: data?.body ?? "Tap to open",
    tag: data?.tag,
    data: deepLink ? { deepLink } : undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = sanitizeNotificationDeepLink(event.notification.data?.deepLink);
  if (!target) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: "frick:navigate", url: target });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    }),
  );
});

async function notifyClients(message) {
  const list = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of list) {
    try {
      client.postMessage(message);
    } catch {
      // best-effort
    }
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const allowedAppRoutePrefixes = ["/chat", "/conversation", "/conversations"];

function sanitizeNotificationDeepLink(value) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.startsWith("//")) {
    return undefined;
  }
  let url;
  try {
    url = new URL(value, self.location.origin);
  } catch {
    return undefined;
  }
  if (url.origin !== self.location.origin || !isAllowedAppRoute(url.pathname)) {
    return undefined;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function isAllowedAppRoute(pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    return true;
  }
  return allowedAppRoutePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
