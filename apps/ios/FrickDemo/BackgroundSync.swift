@preconcurrency import BackgroundTasks
import Foundation
import FrickSwift

/// iOS background sync wiring for the FrickDemo app.
///
/// Registers a `BGAppRefreshTaskRequest` against the
/// `dev.frick.demo.flush-pending-appends` identifier. When iOS fires it,
/// we open a fresh `FrickClient`, call `flushPendingAppends()` (which
/// drains the SQLite-backed queue against the live socket), and reschedule.
///
/// The matching tag must also be added to `apps/ios/FrickDemo.xcodeproj`'s
/// Info.plist under `BGTaskSchedulerPermittedIdentifiers`. The xcodegen
/// spec at `apps/ios/project.yml` (or equivalent) is the canonical place
/// to declare it; this file is the runtime half.
///
/// Triggered manually from the app's `applicationDidEnterBackground`
/// hook via `FrickBackgroundSync.scheduleFlush()` and the system itself
/// when it decides the conditions are right.
public enum FrickBackgroundSync {
    public static let flushTaskIdentifier = "dev.frick.demo.flush-pending-appends"

    /// Earliest moment iOS may fire the task. The system commonly waits
    /// 15 minutes or longer; this is a hint, not a deadline.
    public static let earliestBeginDelay: TimeInterval = 60

    /// Register the BGTaskScheduler handler. Call from
    /// `FrickDemoApp.init()` *before* the SwiftUI scene is built — iOS
    /// requires the registration to land during launch.
    public static func register(makeClient: @escaping @Sendable () -> FrickClient) {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: flushTaskIdentifier,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else { return }
            handleFlush(task: refreshTask, makeClient: makeClient)
        }
    }

    /// Ask iOS to fire the task soon-ish. Call when the app is about to
    /// background — typically from `ScenePhase.background` in SwiftUI.
    public static func scheduleFlush() {
        let request = BGAppRefreshTaskRequest(identifier: flushTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: earliestBeginDelay)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // BGTaskScheduler refuses submissions on a simulator and
            // when the entitlement isn't present — those are dev-time
            // conditions, not user-facing failures.
        }
    }

    public static func cancelFlush() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: flushTaskIdentifier)
    }

    private static func handleFlush(
        task: BGAppRefreshTask,
        makeClient: @escaping @Sendable () -> FrickClient
    ) {
        // Reschedule first so a crash mid-flush doesn't drop the next
        // run; system docs explicitly recommend this ordering.
        scheduleFlush()

        let drain = Task { @Sendable in
            let client = makeClient()
            do {
                try await client.flushPendingAppends()
                return true
            } catch is FrickAuthenticationRequiredError {
                return true
            } catch {
                return false
            }
        }

        task.expirationHandler = {
            drain.cancel()
            task.setTaskCompleted(success: false)
        }

        Task { @Sendable in
            let success = await drain.value
            task.setTaskCompleted(success: success)
        }
    }
}
