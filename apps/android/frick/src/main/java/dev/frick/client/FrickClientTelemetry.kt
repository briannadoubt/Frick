package dev.frick.client

import kotlinx.serialization.json.JsonPrimitive

enum class FrickClientTelemetrySpanKind {
    CLIENT,
    INTERNAL,
}

enum class FrickClientTelemetrySpanStatus {
    OK,
    ERROR,
}

data class FrickClientTelemetrySpanStart(
    val name: String,
    val kind: FrickClientTelemetrySpanKind = FrickClientTelemetrySpanKind.CLIENT,
    val attributes: Map<String, JsonPrimitive> = emptyMap(),
)

data class FrickClientTelemetrySpanResult(
    val status: FrickClientTelemetrySpanStatus? = null,
    val attributes: Map<String, JsonPrimitive> = emptyMap(),
    val error: Throwable? = null,
)

interface FrickClientTelemetrySpan {
    val traceId: String?
        get() = null

    fun injectHeaders(headers: MutableMap<String, String>) = Unit

    fun setAttributes(attributes: Map<String, JsonPrimitive>) = Unit

    fun end(result: FrickClientTelemetrySpanResult? = null) = Unit
}

interface FrickClientTelemetryRuntime {
    fun startSpan(input: FrickClientTelemetrySpanStart): FrickClientTelemetrySpan

    fun recordCounter(name: String, value: Double, attributes: Map<String, JsonPrimitive> = emptyMap()) = Unit

    fun recordHistogram(name: String, value: Double, attributes: Map<String, JsonPrimitive> = emptyMap()) = Unit
}

object NoopFrickClientTelemetryRuntime : FrickClientTelemetryRuntime {
    override fun startSpan(input: FrickClientTelemetrySpanStart): FrickClientTelemetrySpan =
        NoopFrickClientTelemetrySpan
}

private object NoopFrickClientTelemetrySpan : FrickClientTelemetrySpan

internal fun startFrickClientTelemetrySpan(
    telemetry: FrickClientTelemetryRuntime,
    input: FrickClientTelemetrySpanStart,
): FrickClientTelemetrySpan =
    runCatching { telemetry.startSpan(input) }.getOrDefault(NoopFrickClientTelemetrySpan)

internal fun injectFrickClientTelemetryHeaders(
    span: FrickClientTelemetrySpan,
    headers: MutableMap<String, String>,
) {
    runCatching { span.injectHeaders(headers) }
}

internal fun getFrickClientTelemetryTraceId(span: FrickClientTelemetrySpan): String? =
    runCatching { span.traceId }.getOrNull()

internal fun finishFrickClientTelemetrySpan(
    span: FrickClientTelemetrySpan,
    result: FrickClientTelemetrySpanResult? = null,
) {
    runCatching { span.end(result) }
}

internal fun recordFrickClientTelemetryCounter(
    telemetry: FrickClientTelemetryRuntime,
    name: String,
    value: Double,
    attributes: Map<String, JsonPrimitive>,
) {
    runCatching { telemetry.recordCounter(name = name, value = value, attributes = attributes) }
}

internal fun recordFrickClientTelemetryHistogram(
    telemetry: FrickClientTelemetryRuntime,
    name: String,
    value: Double,
    attributes: Map<String, JsonPrimitive>,
) {
    runCatching { telemetry.recordHistogram(name = name, value = value, attributes = attributes) }
}
