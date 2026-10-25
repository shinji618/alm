package com.bsg.alm.pda.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

// 오프라인 DB(09 6.5): Room + SQLCipher. 사용자별로 데이터를 나눠(userId) 다른 사용자의 대기열을 보내지 않는다

@Entity(tableName = "task", indices = [Index("userId")])
data class TaskEntity(
    @PrimaryKey val taskId: String, val userId: String, val campaignId: String, val campaignCode: String, val campaignName: String,
    val keyDate: String, val dueDate: String, val roomId: String, val roomCode: String, val roomName: String, val siteCode: String,
    val status: String, val expectedCount: Int, val foundCount: Int, val pendingCount: Int,
)

@Entity(tableName = "campaign_sync", primaryKeys = ["userId", "campaignId"])
data class CampaignSync(val userId: String, val campaignId: String, val worklistToken: String?, val tagToken: String?, val syncedAt: Long)

/** 작업목록 1건 + 이 기기에서 실사한 결과(local*) */
@Entity(tableName = "work_item", indices = [Index(value = ["campaignId", "assetTag"]), Index("userId")])
data class WorkItem(
    @PrimaryKey val countItemId: String, val userId: String, val campaignId: String, val assetId: String, val assetTag: String,
    val description: String, val categoryName: String, val model: String?, val serialNo: String?, val assetStatus: String,
    val expectedRoomId: String, val expectedRoomCode: String, val assignedUserName: String?, val result: String, val countedAt: String?,
    val localResult: String? = null, val localRoomId: String? = null, val localCountedAt: Long? = null, val localCondition: String? = null,
)

@Entity(tableName = "tag_index", primaryKeys = ["campaignId", "assetTag"])
data class TagEntity(val campaignId: String, val assetTag: String, val assetStatus: String, val siteCode: String?)

@Entity(tableName = "room", primaryKeys = ["campaignId", "roomId"], indices = [Index("barcode")])
data class RoomEntity(val campaignId: String, val roomId: String, val roomCode: String, val name: String, val floor: String?, val siteCode: String, val barcode: String)

@Entity(tableName = "code", primaryKeys = ["kind", "id"])
data class CodeEntity(val kind: String, val id: String, val label: String)

/** 보낼 일(대기열). type: SCAN / UNREG / TASK. payload = 요청 본문(JSON). photos = 로컬 사진 경로(JSON 배열) */
@Entity(tableName = "queue", indices = [Index("userId"), Index("state")])
data class QueueItem(
    @PrimaryKey(autoGenerate = true) val id: Long = 0, val userId: String, val type: String, val campaignId: String, val roomId: String?,
    /** TASK: count_task id */
    val refId: String? = null,
    val label: String, val detail: String, val payload: String, val photos: String = "[]",
    val state: String = PENDING, val attempts: Int = 0, val error: String? = null, val localResult: String? = null,
    val serverResult: String? = null, val createdAt: Long = System.currentTimeMillis(), val sentAt: Long? = null,
) {
    companion object { const val PENDING = "PENDING"; const val SENT = "SENT"; const val REJECTED = "REJECTED" }
}

@Dao
interface CountDao {
    // 작업
    @Query("SELECT * FROM task WHERE userId = :userId ORDER BY dueDate, campaignCode, roomCode") fun tasks(userId: String): Flow<List<TaskEntity>>
    @Query("SELECT * FROM task WHERE userId = :userId AND campaignId = :campaignId ORDER BY roomCode") fun tasksOf(userId: String, campaignId: String): Flow<List<TaskEntity>>
    @Query("SELECT * FROM task WHERE taskId = :taskId") suspend fun task(taskId: String): TaskEntity?
    @Query("SELECT * FROM task WHERE userId = :userId AND campaignId = :campaignId ORDER BY roomCode") suspend fun tasksOfNow(userId: String, campaignId: String): List<TaskEntity>
    @Query("SELECT * FROM task WHERE userId = :userId AND campaignId = :campaignId AND roomId = :roomId") suspend fun taskForRoom(userId: String, campaignId: String, roomId: String): TaskEntity?
    @Query("DELETE FROM task WHERE userId = :userId") suspend fun clearTasks(userId: String)
    @Upsert suspend fun upsertTasks(t: List<TaskEntity>)
    @Query("UPDATE task SET status = :status WHERE taskId = :taskId") suspend fun setTaskStatus(taskId: String, status: String)
    @Query("UPDATE task SET foundCount = :found, pendingCount = :pending WHERE taskId = :taskId") suspend fun setTaskProgress(taskId: String, found: Int, pending: Int)

    // 동기화 토큰
    @Query("SELECT * FROM campaign_sync WHERE userId = :userId AND campaignId = :campaignId") suspend fun sync(userId: String, campaignId: String): CampaignSync?
    @Upsert suspend fun upsertSync(s: CampaignSync)

    // 작업목록
    @Upsert suspend fun upsertItems(items: List<WorkItem>)
    @Query("DELETE FROM work_item WHERE countItemId IN (:ids)") suspend fun deleteItems(ids: List<String>)
    @Query("DELETE FROM work_item WHERE userId = :userId AND campaignId = :campaignId") suspend fun clearItems(userId: String, campaignId: String)
    @Query("SELECT * FROM work_item WHERE countItemId IN (:ids)") suspend fun itemsById(ids: List<String>): List<WorkItem>
    @Query("SELECT * FROM work_item WHERE userId = :userId AND campaignId = :campaignId AND upper(assetTag) = upper(:tag) LIMIT 1")
    suspend fun itemByTag(userId: String, campaignId: String, tag: String): WorkItem?
    /** 자산 조회(PDA-09) 오프라인 대체: 내려받은 작업목록에서 태그로 */
    @Query("SELECT * FROM work_item WHERE userId = :userId AND upper(assetTag) = upper(:tag) LIMIT 1")
    suspend fun itemByTagAny(userId: String, tag: String): WorkItem?
    @Query("SELECT * FROM work_item WHERE userId = :userId AND campaignId = :campaignId AND expectedRoomId = :roomId ORDER BY assetTag")
    fun itemsInRoom(userId: String, campaignId: String, roomId: String): Flow<List<WorkItem>>
    @Query("SELECT count(*) FROM work_item WHERE userId = :userId") suspend fun itemCount(userId: String): Int
    @Query("UPDATE work_item SET localResult = :result, localRoomId = :roomId, localCountedAt = :at, localCondition = coalesce(:condition, localCondition) WHERE countItemId = :id")
    suspend fun markCounted(id: String, result: String, roomId: String, at: Long, condition: String?)

    // 범위 밖 태그 색인
    @Upsert suspend fun upsertTags(t: List<TagEntity>)
    @Query("SELECT * FROM tag_index WHERE campaignId = :campaignId AND upper(assetTag) = upper(:tag) LIMIT 1") suspend fun tag(campaignId: String, tag: String): TagEntity?
    @Query("DELETE FROM tag_index WHERE campaignId = :campaignId") suspend fun clearTags(campaignId: String)

    // 룸·코드
    @Query("DELETE FROM room WHERE campaignId = :campaignId") suspend fun clearRooms(campaignId: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertRooms(r: List<RoomEntity>)
    @Query("SELECT * FROM room WHERE campaignId = :campaignId ORDER BY siteCode, roomCode") fun rooms(campaignId: String): Flow<List<RoomEntity>>
    @Query("SELECT * FROM room WHERE campaignId = :campaignId AND (upper(barcode) = upper(:code) OR upper(roomCode) = upper(:code)) LIMIT 1")
    suspend fun roomByCode(campaignId: String, code: String): RoomEntity?
    @Query("SELECT * FROM room WHERE campaignId = :campaignId AND roomId = :roomId") suspend fun room(campaignId: String, roomId: String): RoomEntity?
    @Query("DELETE FROM code") suspend fun clearCodes()
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertCodes(c: List<CodeEntity>)
    @Query("SELECT * FROM code WHERE kind = :kind ORDER BY label") suspend fun codes(kind: String): List<CodeEntity>

    @Transaction
    suspend fun replaceCodes(c: List<CodeEntity>) { clearCodes(); insertCodes(c) }
    @Transaction
    suspend fun replaceRooms(campaignId: String, r: List<RoomEntity>) { clearRooms(campaignId); insertRooms(r) }

    // 대기열
    @Insert suspend fun enqueue(q: QueueItem): Long
    @Query("SELECT * FROM queue WHERE userId = :userId AND state = 'PENDING' ORDER BY id") suspend fun pending(userId: String): List<QueueItem>
    @Query("SELECT count(*) FROM queue WHERE userId = :userId AND state = 'PENDING'") fun pendingCount(userId: String): Flow<Int>
    @Query("SELECT count(*) FROM queue WHERE userId = :userId AND state = 'PENDING'") suspend fun pendingNow(userId: String): Int
    @Query("SELECT * FROM queue WHERE userId = :userId ORDER BY id DESC LIMIT 300") fun queue(userId: String): Flow<List<QueueItem>>
    // 같은 자산을 여러 번 스캔·확인해도 최근 스캔 목록에는 자산당 마지막 1건만 보인다
    @Query("SELECT * FROM queue WHERE id IN (SELECT max(id) FROM queue WHERE userId = :userId AND type = 'SCAN' AND campaignId = :campaignId AND roomId = :roomId GROUP BY upper(label)) ORDER BY id DESC LIMIT 50")
    fun recentScans(userId: String, campaignId: String, roomId: String): Flow<List<QueueItem>>
    @Query("SELECT count(*) FROM queue WHERE userId = :userId AND type = 'UNREG' AND campaignId = :campaignId") suspend fun unregCount(userId: String, campaignId: String): Int
    @Query("UPDATE queue SET state = :state, attempts = attempts + 1, error = :error, serverResult = coalesce(:serverResult, serverResult), sentAt = :sentAt WHERE id = :id")
    suspend fun setQueueState(id: Long, state: String, error: String?, serverResult: String?, sentAt: Long?)
    @Query("UPDATE queue SET attempts = attempts + 1, error = :error WHERE id = :id") suspend fun queueFailed(id: Long, error: String)
    @Query("UPDATE queue SET photos = :photos WHERE id = :id") suspend fun setPhotos(id: Long, photos: String)
    @Query("SELECT count(*) FROM queue WHERE userId = :userId AND type = 'SCAN' AND state = 'PENDING' AND campaignId = :campaignId AND upper(label) = upper(:tag)")
    suspend fun pendingScansFor(userId: String, campaignId: String, tag: String): Int
    @Query("UPDATE queue SET state = 'PENDING', error = NULL WHERE id = :id") suspend fun retry(id: Long)
    @Query("SELECT * FROM queue WHERE id IN (:ids) AND state <> 'SENT'") suspend fun unsentByIds(ids: List<Long>): List<QueueItem>
    @Query("SELECT id FROM queue WHERE userId = :userId AND state <> 'SENT'") suspend fun unsentIds(userId: String): List<Long>
    @Query("DELETE FROM queue WHERE id = :id AND state <> 'SENT'") suspend fun deleteUnsent(id: Long)
    @Query("UPDATE work_item SET localResult = NULL, localRoomId = NULL, localCountedAt = NULL, localCondition = NULL WHERE userId = :userId AND campaignId = :campaignId AND upper(assetTag) = upper(:tag)")
    suspend fun clearLocal(userId: String, campaignId: String, tag: String)
    @Query("DELETE FROM queue WHERE state <> 'PENDING' AND createdAt < :before") suspend fun purgeSent(before: Long)

    /** 로그아웃·전송 완료 후 정리: 보낸 업무 데이터는 지운다(미전송 대기열은 남김) */
    @Transaction
    suspend fun clearUser(userId: String) {
        clearTasks(userId)
        clearAllItems(userId)
        clearSentQueue(userId)
    }
    @Query("DELETE FROM work_item WHERE userId = :userId") suspend fun clearAllItems(userId: String)
    @Query("DELETE FROM queue WHERE userId = :userId AND state <> 'PENDING'") suspend fun clearSentQueue(userId: String)
}

@Database(entities = [TaskEntity::class, CampaignSync::class, WorkItem::class, TagEntity::class, RoomEntity::class, CodeEntity::class, QueueItem::class],
    version = 1, exportSchema = true)
abstract class AlmDb : RoomDatabase() {
    abstract fun dao(): CountDao

    companion object {
        fun open(ctx: Context, passphrase: ByteArray): AlmDb {
            System.loadLibrary("sqlcipher")
            return Room.databaseBuilder(ctx, AlmDb::class.java, "alm-count.db")
                .openHelperFactory(SupportOpenHelperFactory(passphrase))
                .build()
        }
    }
}
