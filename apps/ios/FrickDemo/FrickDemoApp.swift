import SwiftUI
import FrickSwift

@main
struct FrickDemoApp: App {
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Register the background-refresh handler before SwiftUI builds
        // the scene — iOS requires the registration during launch.
        FrickBackgroundSync.register {
            FrickClient()
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .background {
                FrickBackgroundSync.scheduleFlush()
            }
        }
    }
}
