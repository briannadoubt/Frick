import SwiftUI

// MARK: - Charts
//
// Phase-1 scoped charts: simple series, labels, empty/error states, tokenized
// palette, native SwiftUI rendering with Path/Shape (no external deps, no BI).

/// A labeled numeric data point shared across the chart family.
public struct FrickChartPoint: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let value: Double

    public init(label: String, value: Double) {
        self.id = label
        self.label = label
        self.value = value
    }
}

/// Tokenized rotating palette used to color chart series/slices.
public enum FrickChartPalette {
    public static let series: [Color] = [
        FrickPalette.accent,
        FrickPalette.info,
        FrickPalette.success,
        FrickPalette.warning,
        FrickPalette.danger,
    ]

    public static func color(at index: Int) -> Color {
        series[index % series.count]
    }
}

/// Card surface wrapping a chart with a title and empty/error handling.
/// Parity with web/Android `FrickChartSurface`.
public struct FrickChartSurface<Content: View>: View {
    public let title: String
    public let isEmpty: Bool
    public let errorMessage: String?
    private let content: Content

    public init(
        title: String,
        isEmpty: Bool = false,
        errorMessage: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.isEmpty = isEmpty
        self.errorMessage = errorMessage
        self.content = content()
    }

    public var body: some View {
        FrickSurface(padding: .md) {
            FrickStack(spacing: .sm) {
                Text(title)
                    .font(FrickTypography.label)
                    .foregroundStyle(FrickPalette.textMuted)
                if let errorMessage {
                    FrickErrorState(title: "Couldn’t load", message: errorMessage)
                } else if isEmpty {
                    FrickEmptyState(title: "No data", message: "There’s nothing to chart yet.")
                } else {
                    content
                        .frame(minHeight: 120)
                }
            }
        }
    }
}

private func normalized(_ points: [FrickChartPoint]) -> [Double] {
    let values = points.map(\.value)
    guard let min = values.min(), let max = values.max(), min != max else {
        return values.map { _ in 0.5 }
    }
    return values.map { ($0 - min) / (max - min) }
}

/// Simple line chart. Parity with web/Android `FrickLineChart`.
public struct FrickLineChart: View, Sendable {
    public let points: [FrickChartPoint]

    public init(points: [FrickChartPoint]) {
        self.points = points
    }

    public var body: some View {
        GeometryReader { proxy in
            let norm = normalized(points)
            Path { path in
                guard let first = norm.first else { return }
                let step = norm.count > 1 ? proxy.size.width / CGFloat(norm.count - 1) : 0
                path.move(to: CGPoint(x: 0, y: proxy.size.height * (1 - first)))
                for index in norm.indices.dropFirst() {
                    path.addLine(to: CGPoint(x: CGFloat(index) * step, y: proxy.size.height * (1 - norm[index])))
                }
            }
            .stroke(FrickPalette.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }
        .accessibilityLabel("Line chart")
    }
}

/// Simple filled area chart. Parity with web/Android `FrickAreaChart`.
public struct FrickAreaChart: View, Sendable {
    public let points: [FrickChartPoint]

    public init(points: [FrickChartPoint]) {
        self.points = points
    }

    public var body: some View {
        GeometryReader { proxy in
            let norm = normalized(points)
            let step = norm.count > 1 ? proxy.size.width / CGFloat(norm.count - 1) : 0
            Path { path in
                guard let first = norm.first else { return }
                path.move(to: CGPoint(x: 0, y: proxy.size.height))
                path.addLine(to: CGPoint(x: 0, y: proxy.size.height * (1 - first)))
                for index in norm.indices.dropFirst() {
                    path.addLine(to: CGPoint(x: CGFloat(index) * step, y: proxy.size.height * (1 - norm[index])))
                }
                path.addLine(to: CGPoint(x: CGFloat(max(norm.count - 1, 0)) * step, y: proxy.size.height))
                path.closeSubpath()
            }
            .fill(FrickPalette.accent.opacity(0.22))
        }
        .accessibilityLabel("Area chart")
    }
}

/// Simple vertical bar chart. Parity with web/Android `FrickBarChart`.
public struct FrickBarChart: View, Sendable {
    public let points: [FrickChartPoint]

    public init(points: [FrickChartPoint]) {
        self.points = points
    }

    public var body: some View {
        GeometryReader { proxy in
            let norm = normalized(points)
            let count = max(norm.count, 1)
            let gap = FrickTokens.Spacing.xs
            let barWidth = max((proxy.size.width - gap * CGFloat(count - 1)) / CGFloat(count), 1)
            HStack(alignment: .bottom, spacing: gap) {
                ForEach(Array(norm.enumerated()), id: \.offset) { index, value in
                    RoundedRectangle(cornerRadius: FrickTokens.Radius.control, style: .continuous)
                        .fill(FrickChartPalette.color(at: index))
                        .frame(width: barWidth, height: max(proxy.size.height * CGFloat(value), 1))
                }
            }
            .frame(height: proxy.size.height, alignment: .bottom)
        }
        .accessibilityLabel("Bar chart")
    }
}

/// Simple pie chart. Parity with web/Android `FrickPieChart`.
public struct FrickPieChart: View, Sendable {
    public let points: [FrickChartPoint]

    public init(points: [FrickChartPoint]) {
        self.points = points
    }

    public var total: Double {
        points.map(\.value).reduce(0, +)
    }

    public var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            let center = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
            let radius = side / 2
            ZStack {
                ForEach(Array(slices.enumerated()), id: \.offset) { index, slice in
                    Path { path in
                        path.move(to: center)
                        path.addArc(
                            center: center,
                            radius: radius,
                            startAngle: .degrees(slice.start),
                            endAngle: .degrees(slice.end),
                            clockwise: false
                        )
                        path.closeSubpath()
                    }
                    .fill(FrickChartPalette.color(at: index))
                }
            }
        }
        .accessibilityLabel("Pie chart")
    }

    private var slices: [(start: Double, end: Double)] {
        guard total > 0 else { return [] }
        var cursor = -90.0
        return points.map { point in
            let sweep = (point.value / total) * 360
            let start = cursor
            cursor += sweep
            return (start, cursor)
        }
    }
}
