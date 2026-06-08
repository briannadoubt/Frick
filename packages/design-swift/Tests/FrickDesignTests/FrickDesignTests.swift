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

    // MARK: - FR-87 workspace shell composition

    func testAppShellIsWorkspaceShellParityAlias() {
        // FrickAppShell is the cross-platform parity name for the Apple
        // TabView + .sidebarAdaptable + .inspector workspace shell.
        let shell = FrickAppShell(
            destinations: [
                FrickWorkspaceDestination(id: "chat", title: "Chat", icon: .chatMessage)
            ],
            selection: .constant("chat"),
            inspectorPresented: .constant(false)
        ) { destination in
            Text(destination.title)
        } inspector: {
            Text("Inspector")
        }

        XCTAssertEqual(shell.destinations.map(\.id), ["chat"])
        XCTAssertFalse(shell.inspectorPresented.wrappedValue)
    }

    func testWorkspaceShellPreservesDisabledDestinationContract() {
        let destinations = [
            FrickWorkspaceDestination(id: "chat", title: "Chat", icon: .chatMessage),
            FrickWorkspaceDestination(id: "calls", title: "Calls", icon: .callVideo, isEnabled: false),
        ]
        let shell = FrickWorkspaceShell(
            destinations: destinations,
            selection: .constant("chat")
        ) { destination in
            Text(destination.title)
        } inspector: {
            EmptyView()
        }

        XCTAssertEqual(shell.destinations.filter { !$0.isEnabled }.map(\.id), ["calls"])
    }

    // MARK: - FR-91 parity components

    func testStatusChipStoresToneAndText() {
        let chip = FrickStatusChip("Live", tone: .success)
        XCTAssertEqual(chip.text, "Live")
        XCTAssertEqual(chip.tone, .success)
    }

    func testProgressRingClampsAndExposesValue() {
        let ring = FrickProgressRing(value: 0.42)
        XCTAssertEqual(ring.value, 0.42)
        let indeterminate = FrickProgressRing()
        XCTAssertNil(indeterminate.value)
    }

    func testReactionRowKeepsReactionsInOrder() {
        let row = FrickReactionRow(reactions: [
            .init(value: "👍", count: 3),
            .init(value: "🎉", count: 1),
        ])
        XCTAssertEqual(row.reactions.map(\.value), ["👍", "🎉"])
        XCTAssertEqual(row.reactions.first?.count, 3)
    }

    func testSignalPanelStoresStrengthAndDetail() {
        let panel = FrickSignalPanel(title: "Relay", strength: 0.8, detail: "Stable")
        XCTAssertEqual(panel.strength, 0.8)
        XCTAssertEqual(panel.detail, "Stable")
    }

    func testCallButtonStoresIconAndTone() {
        let button = FrickCallButton(icon: .call, label: "Answer", tone: .success) {}
        XCTAssertEqual(button.icon, .call)
        XCTAssertEqual(button.tone, .success)
        XCTAssertEqual(button.label, "Answer")
    }

    func testCallControlBarStoresPresenceState() {
        var toggled: [String] = []
        let bar = FrickCallControlBar(
            micEnabled: true,
            cameraEnabled: false,
            screenSharing: true,
            onToggleMic: { toggled.append("mic") },
            onToggleCamera: { toggled.append("camera") },
            onToggleScreenShare: { toggled.append("screen") },
            onLeave: { toggled.append("leave") }
        )
        XCTAssertTrue(bar.micEnabled)
        XCTAssertFalse(bar.cameraEnabled)
        XCTAssertTrue(bar.screenSharing)
    }

    func testCallControlToggleReflectsActiveStateAndIcon() {
        let toggle = FrickCallControlToggle(icon: .microphone, isActive: true, label: "Mute microphone") {}
        XCTAssertEqual(toggle.icon, .microphone)
        XCTAssertTrue(toggle.isActive)
        XCTAssertEqual(toggle.label, "Mute microphone")
    }

    func testDateTimePickerStoresTitle() {
        let picker = FrickDateTimePicker("When", selection: .constant(Date(timeIntervalSince1970: 0)))
        XCTAssertEqual(picker.title, "When")
    }

    func testColumnAndDataTableExposeSemanticColumns() {
        struct Person: Identifiable { let id: String; let name: String }
        let people = [Person(id: "1", name: "Ada"), Person(id: "2", name: "Grace")]
        let columns: [FrickColumn<Person>] = [
            FrickColumn("Name") { Text($0.name) },
            FrickColumn("ID", width: 60, alignment: .trailing) { Text($0.id) },
        ]
        let table = FrickDataTable(people, columns: columns)

        XCTAssertEqual(table.columns.map(\.title), ["Name", "ID"])
        XCTAssertEqual(table.columns.last?.width, 60)
        XCTAssertEqual(table.data.count, 2)
    }

    // MARK: - FR-91 charts

    func testChartPaletteRotatesAcrossSeries() {
        XCTAssertEqual(FrickChartPalette.color(at: 0), FrickPalette.accent)
        XCTAssertEqual(FrickChartPalette.color(at: FrickChartPalette.series.count), FrickPalette.accent)
    }

    func testPieChartComputesTotalFromPoints() {
        let chart = FrickPieChart(points: [
            FrickChartPoint(label: "A", value: 3),
            FrickChartPoint(label: "B", value: 1),
        ])
        XCTAssertEqual(chart.total, 4)
    }

    func testChartSurfaceStoresEmptyAndErrorState() {
        let surface = FrickChartSurface(title: "Usage", isEmpty: true) { EmptyView() }
        XCTAssertTrue(surface.isEmpty)
        XCTAssertEqual(surface.title, "Usage")
    }

    func testLineChartKeepsPointsInOrder() {
        let chart = FrickLineChart(points: [
            FrickChartPoint(label: "Mon", value: 1),
            FrickChartPoint(label: "Tue", value: 5),
        ])
        XCTAssertEqual(chart.points.map(\.label), ["Mon", "Tue"])
    }

    // MARK: - FR-102 Dynamic Type / text scaling

    /// The typography roles must be built from *relative* text styles so they
    /// scale with the user's Dynamic Type setting, not from fixed point sizes.
    /// A fixed-size system font compares unequal to its text-style counterpart,
    /// so these assertions pin the roles to the scaling fonts.
    func testTypographyRolesUseDynamicTypeScalingStyles() {
        XCTAssertEqual(FrickTypography.heading, Font.system(.title, design: .rounded, weight: .bold))
        XCTAssertEqual(FrickTypography.body, Font.system(.callout, design: .default, weight: .regular))
        XCTAssertEqual(FrickTypography.label, Font.system(.footnote, design: .default, weight: .semibold))
        XCTAssertEqual(FrickTypography.mono, Font.system(.footnote, design: .monospaced, weight: .regular))
    }

    /// The scaling roles must differ from the fixed-point-size generated tokens;
    /// if they were identical the text would not respond to Dynamic Type.
    func testTypographyScalingRolesDifferFromFixedTokens() {
        XCTAssertNotEqual(FrickTypography.heading, FrickTypography.Fixed.heading)
        XCTAssertNotEqual(FrickTypography.body, FrickTypography.Fixed.body)
        XCTAssertNotEqual(FrickTypography.label, FrickTypography.Fixed.label)
        XCTAssertNotEqual(FrickTypography.mono, FrickTypography.Fixed.mono)
    }

    /// The fixed reference fonts still expose the unchanged generated token values.
    func testTypographyFixedRolesMirrorGeneratedTokens() {
        XCTAssertEqual(FrickTypography.Fixed.heading, FrickTokens.Typography.heading)
        XCTAssertEqual(FrickTypography.Fixed.body, FrickTokens.Typography.body)
        XCTAssertEqual(FrickTypography.Fixed.label, FrickTokens.Typography.label)
        XCTAssertEqual(FrickTypography.Fixed.mono, FrickTokens.Typography.mono)
    }
}
