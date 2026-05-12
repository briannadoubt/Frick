import XCTest
@testable import FrickSwift

final class FrickDraftStoreTests: XCTestCase {
    func testDraftIdMatchesCrossSDKConvention() {
        // The React `useDraft({ sync: true })` and Kotlin
        // `FrickDraftStore` both key MessageDraft rows by
        // `"${userId}:${conversationId}"` — keep parity so a draft
        // typed on web shows up under the same id on iOS and Android.
        XCTAssertEqual(
            FrickDraftStore.draftId(userId: "user-ada", conversationId: "convo-1"),
            "user-ada:convo-1"
        )
        // No collapsing of separators in odd user ids.
        XCTAssertEqual(
            FrickDraftStore.draftId(userId: "a:b", conversationId: "c"),
            "a:b:c"
        )
    }
}
