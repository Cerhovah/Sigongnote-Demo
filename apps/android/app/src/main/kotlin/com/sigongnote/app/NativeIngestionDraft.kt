package com.sigongnote.app

import java.util.UUID

/** Native capture cannot prepare a device upload without a bound source generation. */
data class NativeIngestionDraft(
    val sourceId: String,
    val sourceGeneration: Int,
    val clientCaptureId: String,
    val sha256: String,
    val byteLength: Long,
    val declaredMime: String,
) {
    init {
        require(UUID.fromString(sourceId).toString() == sourceId)
        require(sourceGeneration > 0)
        require(UUID.fromString(clientCaptureId).toString() == clientCaptureId)
        require(Regex("^[0-9a-f]{64}$").matches(sha256))
        require(byteLength in 1..10_485_760)
        require(Regex("^[a-z0-9.+-]+/[a-z0-9.+-]+$").matches(declaredMime))
    }
}
