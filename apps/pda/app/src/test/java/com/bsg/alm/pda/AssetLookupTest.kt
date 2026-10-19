package com.bsg.alm.pda

import com.bsg.alm.pda.net.PdaAssetDetail
import com.bsg.alm.pda.net.json
import com.bsg.alm.pda.ui.eventLabel
import com.bsg.alm.pda.ui.statusLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** PDA-09 자산 조회 응답(openapi PdaAssetDetail)을 앱이 읽는지 */
class AssetLookupTest {
    @Test fun limitedAssetHasOnlyTagStatusSite() {
        val a = json.decodeFromString(PdaAssetDetail.serializer(), """{"assetTag":"AT-000006","status":"IN_STOCK","siteCode":"NYC","limited":true}""")
        assertTrue(a.limited); assertEquals("NYC", a.siteCode); assertNull(a.description); assertTrue(a.events.isEmpty())
    }

    @Test fun fullAssetWithCountAndHistory() {
        val a = json.decodeFromString(PdaAssetDetail.serializer(), """{"assetTag":"AT-000001","status":"IN_USE","limited":false,"stage":"OPERATE",
            "description":"Laptop","serialNo":"SN-1","sapAssetNo":"1000001","netBookValue":700.5,"unknownField":1,
            "count":{"campaignCode":"PI26Q4","expectedRoomCode":"ATL-101","result":"PENDING"},
            "events":[{"eventType":"ASSIGNED","occurredAt":"2026-10-19T12:00:00Z","channel":"UI","actorName":"Asset Mgr"}]}""")
        assertEquals("PI26Q4", a.count?.campaignCode); assertEquals(700.5, a.netBookValue!!, 0.001); assertEquals("Asset Mgr", a.events[0].actorName)
    }

    @Test fun labels() {
        assertEquals("In use", statusLabel("IN_USE")); assertEquals("Checked out", eventLabel("ASSIGNED")); assertEquals("X_NEW", eventLabel("X_NEW"))
    }
}
