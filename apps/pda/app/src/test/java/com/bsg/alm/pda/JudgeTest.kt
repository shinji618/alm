package com.bsg.alm.pda

import com.bsg.alm.pda.data.Judge
import com.bsg.alm.pda.data.Judge.Input
import org.junit.Assert.assertEquals
import org.junit.Test

/** 기기 판정이 서버(pdaPostScans) 규칙과 같은지 */
class JudgeTest {
    private val r1 = "room-1"; private val r2 = "room-2"

    @Test fun unknownTagIsUnregistered() = assertEquals(Judge.UNREGISTERED, Judge.judge(Input(r1)))
    @Test fun retiredInIndex() = assertEquals(Judge.RETIRED_ASSET, Judge.judge(Input(r1, tagAssetStatus = "RETIRED")))
    @Test fun disposedOnWorklist() = assertEquals(Judge.RETIRED_ASSET, Judge.judge(Input(r1, "DISPOSED", r1)))
    @Test fun indexOnlyIsOutOfScope() = assertEquals(Judge.OUT_OF_SCOPE, Judge.judge(Input(r1, tagAssetStatus = "IN_USE")))
    @Test fun sameRoomFound() = assertEquals(Judge.FOUND, Judge.judge(Input(r1, "IN_USE", r1)))
    @Test fun otherRoomMisplaced() = assertEquals(Judge.MISPLACED, Judge.judge(Input(r2, "IN_USE", r1)))
    @Test fun missingAssetFoundIsCounted() = assertEquals(Judge.FOUND, Judge.judge(Input(r1, "MISSING", r1)))
    @Test fun rescanSameRoomDuplicate() = assertEquals(Judge.DUPLICATE, Judge.judge(Input(r1, "IN_USE", r1, itemCountedRoomId = r1)))
    @Test fun rescanOtherRoomMoves() = assertEquals(Judge.MISPLACED, Judge.judge(Input(r2, "IN_USE", r1, itemCountedRoomId = r1)))
    @Test fun countsItem() {
        assertEquals(true, Judge.countsItem(Judge.FOUND)); assertEquals(true, Judge.countsItem(Judge.MISPLACED))
        assertEquals(false, Judge.countsItem(Judge.DUPLICATE)); assertEquals(false, Judge.countsItem(Judge.OUT_OF_SCOPE))
    }
}
