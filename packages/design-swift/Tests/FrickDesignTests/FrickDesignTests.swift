import XCTest
import SwiftUI
@testable import FrickDesign

@MainActor
final class FrickDesignTests: XCTestCase {
    func testDesignContextExposesGeneratedDefaults() {
        let context = FrickDesignContext()

        XCTAssertEqual(context.brand, .frick)
        XCTAssertEqual(context.color(.accent), FrickPalette.accent)
        XCTAssertEqual(context.spacing(.md), FrickTokens.Spacing.medium)
        XCTAssertEqual(context.radius(.lg), FrickTokens.Radius.surface)
    }

    func testIconUsesExpectedGeneratedNameContract() {
        let icon = FrickIcon(.send)

        XCTAssertEqual(icon.name, .send)
    }

    func testWorkspaceDestinationStoresNavigationContract() {
        let destination = FrickWorkspaceDestination(
            id: "chat",
            title: "Chat",
            icon: .chatMessage,
            isEnabled: true,
            badge: "2"
        )

        XCTAssertEqual(destination.id, "chat")
        XCTAssertEqual(destination.title, "Chat")
        XCTAssertEqual(destination.icon, .chatMessage)
        XCTAssertTrue(destination.isEnabled)
        XCTAssertEqual(destination.badge, "2")
    }

    func testWorkspaceShellStoresDestinationsAndSelection() {
        let destinations = [
            FrickWorkspaceDestination(id: "chat", title: "Chat", icon: .chatMessage),
            FrickWorkspaceDestination(id: "calls", title: "Calls", icon: .callVideo),
        ]

        let shell = FrickWorkspaceShell(
            destinations: destinations,
            selection: .constant("chat"),
            inspectorPresented: .constant(true)
        ) { destination in
            Text(destination.title)
        } inspector: {
            Text("Inspector")
        }

        XCTAssertEqual(shell.destinations.map(\.id), ["chat", "calls"])
        XCTAssertEqual(shell.selection.wrappedValue, "chat")
        XCTAssertTrue(shell.inspectorPresented.wrappedValue)
    }

    func testListDetailShellStoresNativeNavigationBindings() {
        let shell = FrickListDetailShell(
            preferredCompactColumn: .constant(.detail),
            columnVisibility: .constant(.all),
            sidebarTitle: "Threads"
        ) {
            Text("List")
        } detail: {
            Text("Detail")
        }

        XCTAssertEqual(shell.preferredCompactColumn.wrappedValue, .detail)
        XCTAssertEqual(shell.columnVisibility.wrappedValue, .all)
        XCTAssertEqual(shell.sidebarIdealWidth, 320)
    }

    func testWorkspaceListItemStoresSidebarRowContract() {
        let item = FrickWorkspaceListItem(
            title: "Foundation General",
            subtitle: "Latest synced message",
            meta: "Read #4 / Last #5",
            isSelected: true
        )

        XCTAssertEqual(item.title, "Foundation General")
        XCTAssertEqual(item.subtitle, "Latest synced message")
        XCTAssertEqual(item.meta, "Read #4 / Last #5")
        XCTAssertTrue(item.isSelected)
    }

    func testButtonStoresVariantAndSize() {
        let button = FrickButton("Send", icon: .send, variant: .primary, size: .sm) {}

        XCTAssertEqual(button.title, "Send")
        XCTAssertEqual(button.icon, .send)
        XCTAssertEqual(button.variant, .primary)
        XCTAssertEqual(button.size, .sm)
    }

    func testMessageListKeepsMessagesInInputOrder() {
        let messages = [
            FrickMessage(id: "1", author: "Ada", body: "Hello", timestamp: "9:00 AM", isCurrentUser: false),
            FrickMessage(id: "2", author: "Grace", body: "Hi", timestamp: "9:01 AM", isCurrentUser: true),
        ]

        let list = FrickMessageList(messages: messages)

        XCTAssertEqual(list.messages.map(\.id), ["1", "2"])
    }

    func testSparklineNormalizesConstantSeries() {
        let sparkline = FrickSparkline(values: [7, 7, 7])

        XCTAssertEqual(sparkline.normalizedValues, [0.5, 0.5, 0.5])
    }
}
