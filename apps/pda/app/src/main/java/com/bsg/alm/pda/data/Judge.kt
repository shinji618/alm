package com.bsg.alm.pda.data

/**
 * 기기 판정(오프라인). 서버(pdaPostScans)와 같은 규칙이고, 전송 뒤에는 서버 판정이 기준이다.
 *  1) 작업목록에도 범위 밖 색인에도 없는 태그 → UNREGISTERED(서버가 다시 확인: 다른 담당 룸의 대상일 수 있음)
 *  2) 폐기·처분 자산 → RETIRED_ASSET
 *  3) 색인에만 있음 → OUT_OF_SCOPE
 *  4) 이미 같은 룸에서 확인 → DUPLICATE
 *  5) 등록 룸 = 현재 룸 → FOUND, 아니면 MISPLACED
 */
object Judge {
    const val FOUND = "FOUND"; const val MISPLACED = "MISPLACED"; const val OUT_OF_SCOPE = "OUT_OF_SCOPE"
    const val UNREGISTERED = "UNREGISTERED"; const val DUPLICATE = "DUPLICATE"; const val RETIRED_ASSET = "RETIRED_ASSET"
    private val RETIRED = setOf("RETIRED", "DISPOSED")

    data class Input(
        val roomId: String,
        val itemAssetStatus: String? = null, val itemExpectedRoomId: String? = null,
        /** 이미 실사된 룸(기기 결과 우선, 없으면 서버 결과가 PENDING이 아닐 때의 룸은 알 수 없어 null) */
        val itemCountedRoomId: String? = null,
        val tagAssetStatus: String? = null,
    ) { val inWorklist get() = itemExpectedRoomId != null; val inIndex get() = tagAssetStatus != null }

    fun judge(i: Input): String = when {
        !i.inWorklist && !i.inIndex -> UNREGISTERED
        (i.itemAssetStatus ?: i.tagAssetStatus) in RETIRED -> RETIRED_ASSET
        !i.inWorklist -> OUT_OF_SCOPE
        i.itemCountedRoomId == i.roomId -> DUPLICATE
        i.itemExpectedRoomId == i.roomId -> FOUND
        else -> MISPLACED
    }

    /** 판정이 대상의 결과(FOUND·MISPLACED)를 바꾸는지 */
    fun countsItem(result: String) = result == FOUND || result == MISPLACED
}
