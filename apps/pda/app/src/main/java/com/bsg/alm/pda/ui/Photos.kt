package com.bsg.alm.pda.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.util.UUID

/** 실사 사진: 카메라 원본 → 긴 변 1,600px JPEG(서버 한도 5 MB, 06 pdaPresignPhoto) */
object Photos {
    const val MAX_SIDE = 1600

    fun newCaptureUri(ctx: Context, dir: File): Pair<Uri, File> {
        val f = File(dir, "raw-${UUID.randomUUID()}.jpg")
        return FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f) to f
    }

    /** 원본을 줄이고 회전을 바로잡아 새 파일로. 원본은 지운다 */
    fun shrink(raw: File, dir: File): File {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(raw.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
        val bmp = BitmapFactory.decodeFile(raw.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: error("Photo could not be read")
        val rotation = when (ExifInterface(raw.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f; ExifInterface.ORIENTATION_ROTATE_180 -> 180f; ExifInterface.ORIENTATION_ROTATE_270 -> 270f; else -> 0f
        }
        val scale = minOf(1f, MAX_SIDE.toFloat() / maxOf(bmp.width, bmp.height))
        val m = Matrix().apply { postScale(scale, scale); postRotate(rotation) }
        val out = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        val f = File(dir, "photo-${UUID.randomUUID()}.jpg")
        f.outputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        if (out !== bmp) out.recycle()
        bmp.recycle()
        raw.delete()
        return f
    }
}
