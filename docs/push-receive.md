# Push receive

The framework's push **send** side ships APNs / FCM / Web Push adapters out of the box ([`docs/push-adapters.md`](./push-adapters.md)). This page documents the **receive** side — how to wire a real iOS Notification Service Extension and Android FirebaseMessagingService against the framework's typed payload + deep-link router.

Both pieces depend on credentials the framework can't ship by default (APNs key, FCM service account); the wiring below is the minimum your app needs once those are in hand.

## What the framework gives you

Both native SDKs expose a typed `FrickPushPayload` plus a generic `FrickDeepLinkRouter<Route>`. The payload matches the wire shape the server-side adapters produce:

- **APNs (Swift):** [`packages/swift/Sources/FrickSwift/Push/FrickPushPayload.swift`](../packages/swift/Sources/FrickSwift/Push/FrickPushPayload.swift) decodes from the `userInfo` dictionary `UNUserNotificationCenter` hands the app.
- **FCM (Kotlin):** [`apps/android/frick/src/main/java/dev/frick/client/FrickPushReceiver.kt`](../apps/android/frick/src/main/java/dev/frick/client/FrickPushReceiver.kt) decodes from the `notification` + `data` maps `FirebaseMessagingService.onMessageReceived` exposes.

Both files include a `from(...)` factory and a fluent router (`router.on("message.new", { … })`) that resolves a payload to your app's own typed route enum.

## iOS — Notification Service Extension

1. **Add the target** (one-time): in Xcode → File → New → Target → Notification Service Extension. Name it `FrickNotificationService`.
2. **Adopt the Frick payload:**

```swift
import UserNotifications
import FrickSwift

class FrickNotificationService: UNNotificationServiceExtension {
    private let router = FrickDeepLinkRouter<AppRoute>()
        .on(intent: "message.new") { payload in
            .conversation(id: payload.threadId ?? "general")
        }
        .on(intent: "call.ringing") { payload in
            .call(id: payload.data["callId"] ?? "")
        }

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        let mutable = request.content.mutableCopy() as! UNMutableNotificationContent
        if let payload = FrickPushPayload.from(userInfo: request.content.userInfo),
           let route = router.resolve(payload) {
            mutable.userInfo["frickRoute"] = String(describing: route)
        }
        contentHandler(mutable)
    }
}
```

3. **On tap**, the main app's `UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:)` reads `frickRoute` from `userInfo` and navigates.

You'll also need to enable the **Push Notifications** capability + an `aps-environment` entitlement, plus an APNs key uploaded server-side via `frick tenants set-push --platform apns …` (see [`docs/push-adapters.md`](./push-adapters.md)).

## Android — FirebaseMessagingService

1. **Add Firebase**: drop `google-services.json` into `apps/android/app/`, apply the Google services Gradle plugin in your app build file, add the `firebase-messaging-ktx` dependency.
2. **Add a service class:**

```kotlin
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.frick.client.FrickDeepLinkRouter
import dev.frick.client.FrickPushPayload

class FrickFirebaseMessagingService : FirebaseMessagingService() {
    private val router = FrickDeepLinkRouter<AppRoute>()
        .on("message.new") { payload -> AppRoute.Conversation(payload.threadId ?: "general") }
        .on("call.ringing") { payload -> AppRoute.Call(payload.data["callId"].orEmpty()) }

    override fun onMessageReceived(message: RemoteMessage) {
        val payload = FrickPushPayload.from(
            notification = mapOf(
                "title" to message.notification?.title,
                "body" to message.notification?.body,
            ),
            data = message.data,
        ) ?: return
        val route = router.resolve(payload) ?: return
        // Build a system notification with a PendingIntent that opens the
        // route. Implementation is app-specific — see Android's Notifications
        // guide; the typed `route` is what your NotificationCompat.Builder
        // needs to deep-link into.
    }

    override fun onNewToken(token: String) {
        // POST to `/push/registrations` with `platform = "fcm"`, `token`,
        // and the device's deviceId — same call the existing demo makes
        // for the test platform.
    }
}
```

3. **Register the service** in `AndroidManifest.xml`:

```xml
<service
    android:name=".FrickFirebaseMessagingService"
    android:exported="false">
  <intent-filter>
    <action android:name="com.google.firebase.MESSAGING_EVENT" />
  </intent-filter>
</service>
```

Server-side: `frick tenants set-push --platform fcm --service-account google-svc-account.json`.

## Web — Service Worker

The web push pipeline is already wired by [`apps/web/public/frick-sw.js`](../apps/web/public/frick-sw.js) plus the `registerFrickBackgroundSync(...)` helper in `@frick/core`. The worker's `notificationclick` handler only accepts same-origin app routes, normalizes them to path/search/hash, then posts a `frick:navigate` message back to the active tab — your React app reads `data.url` and routes.

## Threat-model notes

- The deep-link target lands in user-visible UI; treat it as untrusted input. Never paste it raw into HTML.
- Don't include sensitive data in the push payload — APNs and FCM both have the payload visible to platform infrastructure (lock-screen previews, intermediary servers). Use the payload to point at IDs the user fetches authenticated.
- On Android, the push receiver runs in a brand-new process for cold deliveries; don't assume your app's in-memory state exists yet.
