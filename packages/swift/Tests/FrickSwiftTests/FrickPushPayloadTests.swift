import XCTest
@testable import FrickSwift

final class FrickPushPayloadTests: XCTestCase {
    func testDecodesFromAPNsUserInfo() {
        let userInfo: [AnyHashable: Any] = [
            "aps": [
                "alert": ["title": "New message", "body": "Hello there"],
                "thread-id": "convo-1",
                "sound": "default",
            ],
            "intent": "message.new",
            "deepLink": "frick://conversation/convo-1",
            "messageId": "msg-7",
            "unread": NSNumber(value: 3),
        ]
        let payload = FrickPushPayload.from(userInfo: userInfo)
        XCTAssertNotNil(payload)
        XCTAssertEqual(payload?.intent, "message.new")
        XCTAssertEqual(payload?.title, "New message")
        XCTAssertEqual(payload?.body, "Hello there")
        XCTAssertEqual(payload?.threadId, "convo-1")
        XCTAssertEqual(payload?.deepLink, "frick://conversation/convo-1")
        XCTAssertEqual(payload?.data["messageId"], "msg-7")
        XCTAssertEqual(payload?.data["unread"], "3")
    }

    func testReturnsNilForThirdPartyPushes() {
        let userInfo: [AnyHashable: Any] = ["aps": ["alert": "raw"]]
        XCTAssertNil(FrickPushPayload.from(userInfo: userInfo))
    }

    func testRouterResolvesIntentSpecificRoutes() {
        enum Route: Equatable, Sendable { case conversation(String); case call(String); case unknown }
        let router = FrickDeepLinkRouter<Route>()
            .on(intent: "message.new") { payload in
                .conversation(payload.threadId ?? "general")
            }
            .on(intent: "call.ringing") { payload in
                .call(payload.data["callId"] ?? "")
            }
            .fallback { _ in .unknown }

        let messagePayload = FrickPushPayload(intent: "message.new", threadId: "c1")
        XCTAssertEqual(router.resolve(messagePayload), .conversation("c1"))

        let callPayload = FrickPushPayload(intent: "call.ringing", data: ["callId": "call-7"])
        XCTAssertEqual(router.resolve(callPayload), .call("call-7"))

        let strangePayload = FrickPushPayload(intent: "unrelated.intent")
        XCTAssertEqual(router.resolve(strangePayload), .unknown)
    }
}
