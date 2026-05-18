import Foundation

public enum FrickClientTelemetryAttributeValue: Equatable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
}

public typealias FrickClientTelemetryAttributes = [String: FrickClientTelemetryAttributeValue]

public enum FrickClientTelemetrySpanKind: Equatable, Sendable {
    case client
    case internalOperation
}

public struct FrickClientTelemetrySpanStart: Equatable, Sendable {
    public let name: String
    public let kind: FrickClientTelemetrySpanKind
    public let attributes: FrickClientTelemetryAttributes

    public init(
        name: String,
        kind: FrickClientTelemetrySpanKind = .client,
        attributes: FrickClientTelemetryAttributes = [:]
    ) {
        self.name = name
        self.kind = kind
        self.attributes = attributes
    }
}

public enum FrickClientTelemetrySpanStatus: Equatable, Sendable {
    case ok
    case error
}

public struct FrickClientTelemetrySpanResult: Equatable, Sendable {
    public let status: FrickClientTelemetrySpanStatus?
    public let attributes: FrickClientTelemetryAttributes
    public let errorDescription: String?

    public init(
        status: FrickClientTelemetrySpanStatus? = nil,
        attributes: FrickClientTelemetryAttributes = [:],
        errorDescription: String? = nil
    ) {
        self.status = status
        self.attributes = attributes
        self.errorDescription = errorDescription
    }
}

public protocol FrickClientTelemetrySpan: Sendable {
    var traceId: String? { get }
    func injectHeaders(_ headers: inout [String: String]) throws
    func setAttributes(_ attributes: FrickClientTelemetryAttributes) throws
    func end(_ result: FrickClientTelemetrySpanResult?) throws
}

public extension FrickClientTelemetrySpan {
    var traceId: String? { nil }

    func injectHeaders(_ headers: inout [String: String]) throws {}

    func setAttributes(_ attributes: FrickClientTelemetryAttributes) throws {}

    func end(_ result: FrickClientTelemetrySpanResult?) throws {}
}

public protocol FrickClientTelemetryRuntime: Sendable {
    func startSpan(_ input: FrickClientTelemetrySpanStart) throws -> any FrickClientTelemetrySpan
    func recordCounter(name: String, value: Double, attributes: FrickClientTelemetryAttributes) throws
    func recordHistogram(name: String, value: Double, attributes: FrickClientTelemetryAttributes) throws
}

public extension FrickClientTelemetryRuntime {
    func recordCounter(name: String, value: Double, attributes: FrickClientTelemetryAttributes) throws {}

    func recordHistogram(name: String, value: Double, attributes: FrickClientTelemetryAttributes) throws {}
}

public struct FrickNoopClientTelemetryRuntime: FrickClientTelemetryRuntime {
    public init() {}

    public func startSpan(_ input: FrickClientTelemetrySpanStart) throws -> any FrickClientTelemetrySpan {
        FrickNoopClientTelemetrySpan()
    }
}

private struct FrickNoopClientTelemetrySpan: FrickClientTelemetrySpan {}

func startFrickClientTelemetrySpan(
    _ telemetry: any FrickClientTelemetryRuntime,
    _ input: FrickClientTelemetrySpanStart
) -> any FrickClientTelemetrySpan {
    do {
        return try telemetry.startSpan(input)
    } catch {
        return FrickNoopClientTelemetrySpan()
    }
}

func injectFrickClientTelemetryHeaders(
    _ span: any FrickClientTelemetrySpan,
    into headers: inout [String: String]
) {
    do {
        try span.injectHeaders(&headers)
    } catch {
        // Telemetry must never affect framework requests.
    }
}

func finishFrickClientTelemetrySpan(
    _ span: any FrickClientTelemetrySpan,
    _ result: FrickClientTelemetrySpanResult?
) {
    do {
        try span.end(result)
    } catch {
        // Telemetry must never affect framework behavior.
    }
}

func recordFrickClientTelemetryCounter(
    _ telemetry: any FrickClientTelemetryRuntime,
    name: String,
    value: Double,
    attributes: FrickClientTelemetryAttributes
) {
    do {
        try telemetry.recordCounter(name: name, value: value, attributes: attributes)
    } catch {
        // Telemetry must never affect framework behavior.
    }
}

func recordFrickClientTelemetryHistogram(
    _ telemetry: any FrickClientTelemetryRuntime,
    name: String,
    value: Double,
    attributes: FrickClientTelemetryAttributes
) {
    do {
        try telemetry.recordHistogram(name: name, value: value, attributes: attributes)
    } catch {
        // Telemetry must never affect framework behavior.
    }
}
