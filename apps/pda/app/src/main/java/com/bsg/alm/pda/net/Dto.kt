package com.bsg.alm.pda.net

import kotlinx.serialization.Serializable

// openapi PDA 스키마(06 API 명세서 PDA). 이름·필드는 서버와 같게 둔다

@Serializable data class PdaAuthConfig(
    val authorizationEndpoint: String, val tokenEndpoint: String, val revocationEndpoint: String, val endSessionEndpoint: String,
    val clientId: String, val redirectUri: String, val identityProvider: String, val scopes: List<String>,
)

@Serializable data class PdaMe(
    val userId: String, val displayName: String, val email: String, val locale: String? = null, val roles: List<String> = emptyList(),
    val tenantCode: String, val serverTime: String, val minAppVersion: String = "1.0.0", val offlineHours: Int = 24,
)

@Serializable data class DeviceRegister(val deviceSerial: String, val model: String? = null, val appVersion: String)
@Serializable data class DeviceOut(val deviceId: String, val lastSyncAt: String? = null)

@Serializable data class PdaTask(
    val taskId: String, val campaignId: String, val campaignCode: String, val campaignName: String, val keyDate: String, val dueDate: String,
    val roomId: String, val roomCode: String, val roomName: String, val siteCode: String, val status: String,
    val expectedCount: Int, val foundCount: Int, val pendingCount: Int, val updatedAt: String,
)
@Serializable data class PdaTaskList(val items: List<PdaTask>)

@Serializable data class WorklistItem(
    val countItemId: String, val assetId: String, val assetTag: String, val description: String, val categoryName: String,
    val model: String? = null, val serialNo: String? = null, val assetStatus: String, val expectedRoomId: String, val expectedRoomCode: String,
    val assignedUserName: String? = null, val result: String, val countedAt: String? = null, val updatedAt: String,
)
@Serializable data class WorklistPage(
    val campaignId: String, val items: List<WorklistItem>, val removed: List<String> = emptyList(), val nextCursor: String? = null, val syncToken: String,
)

@Serializable data class TagIndexItem(val assetTag: String, val assetStatus: String, val siteCode: String? = null)
@Serializable data class TagIndexPage(val items: List<TagIndexItem>, val nextCursor: String? = null, val syncToken: String)

@Serializable data class PdaRoom(val roomId: String, val roomCode: String, val name: String, val floor: String? = null, val siteCode: String, val barcode: String)
@Serializable data class PdaRoomList(val items: List<PdaRoom>)

@Serializable data class CodeItem(val id: String, val label: String)
@Serializable data class PdaCodes(val categories: List<CodeItem>, val conditions: List<CodeItem>)

@Serializable data class TaskUpdate(val action: String, val at: String, val force: Boolean? = null)

@Serializable data class ScanIn(
    val clientScanId: String, val campaignId: String, val taskId: String, val roomId: String, val barcode: String, val inputMethod: String,
    val deviceResult: String, val condition: String? = null, val isUserConfirmed: Boolean? = null, val needsRelabel: Boolean? = null,
    val note: String? = null, val attachmentIds: List<String>? = null, val scannedAt: String,
)
@Serializable data class ScanBatch(val deviceId: String, val scans: List<ScanIn>)
@Serializable data class ScanResultItem(
    val clientScanId: String, val status: String, val serverResult: String? = null, val countItemId: String? = null, val assetId: String? = null,
    val code: String? = null, val message: String? = null,
)
@Serializable data class TaskProgress(val taskId: String, val foundCount: Int, val pendingCount: Int)
@Serializable data class ScanBatchResult(val results: List<ScanResultItem>, val tasks: List<TaskProgress> = emptyList())

@Serializable data class UnregisteredIn(
    val clientScanId: String, val campaignId: String, val roomId: String, val provisionalNo: String, val categoryId: String? = null,
    val description: String, val serialNo: String? = null, val scannedBarcode: String? = null, val attachmentIds: List<String>, val reportedAt: String,
)
@Serializable data class UnregisteredBatch(val deviceId: String, val items: List<UnregisteredIn>)
@Serializable data class UnregisteredResultItem(val clientScanId: String, val status: String, val tempNo: String? = null, val code: String? = null, val message: String? = null)
@Serializable data class UnregisteredBatchResult(val results: List<UnregisteredResultItem>)

@Serializable data class PresignRequest(
    val ownerType: String, val fileName: String, val contentType: String, val sizeBytes: Long, val sha256: String, val kind: String = "PHOTO",
)
@Serializable data class PresignResponse(val attachmentId: String, val uploadUrl: String, val headers: Map<String, String>, val expiresAt: String)

@Serializable data class Problem(val code: String? = null, val detail: String? = null, val message: String? = null, val title: String? = null)
