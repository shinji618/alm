# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class com.bsg.alm.pda.** { *** Companion; }
-keepclasseswithmembers class com.bsg.alm.pda.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.bsg.alm.pda.**$$serializer { *; }
# SQLCipher
-keep class net.zetetic.database.** { *; }
-keep class net.zetetic.database.sqlcipher.** { *; }

# R8가 찾는 컴파일 전용 주석(Tink·ZXing 등이 참조)
-dontwarn com.google.errorprone.annotations.CanIgnoreReturnValue
-dontwarn com.google.errorprone.annotations.CheckReturnValue
-dontwarn com.google.errorprone.annotations.Immutable
-dontwarn com.google.errorprone.annotations.RestrictedApi
