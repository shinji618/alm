plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.bsg.alm.pda"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.bsg.alm"
        minSdk = 26
        targetSdk = 35
        versionCode = 4
        versionName = "1.0.3"
        // AppAuth 리디렉트(Cognito alm-pda 콜백 com.bsg.alm://auth)
        manifestPlaceholders["appAuthRedirectScheme"] = "com.bsg.alm"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // 환경별 API 주소. 앱 설정(MDM 관리형 구성)으로 바꿀 수 있다
    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            buildConfigField("String", "API_BASE", "\"https://alm-dev.bsgapps.com/api/v1\"")
            resValue("string", "app_name", "ALM Count DEV")
        }
        create("qa") {
            dimension = "env"
            applicationIdSuffix = ".qa"
            versionNameSuffix = "-qa"
            buildConfigField("String", "API_BASE", "\"https://alm-qa.bsgapps.com/api/v1\"")
            resValue("string", "app_name", "ALM Count QA")
        }
        create("prd") {
            dimension = "env"
            buildConfigField("String", "API_BASE", "\"https://alm.bsgapps.com/api/v1\"")
            resValue("string", "app_name", "ALM Count")
        }
    }

    // 시험용 서명 키를 저장소에 둔다(CI·PC 어디서 빌드해도 같은 서명 → 덮어 설치 가능). 운영 배포 키는 따로 보관
    signingConfigs {
        getByName("debug") { storeFile = file("debug.keystore"); storePassword = "android"; keyAlias = "androiddebugkey"; keyPassword = "android" }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        // 현장 시험용: release와 같은 축소(R8)·크기, 디버그 키 서명(배포 키 없이 설치)
        create("pilot") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
        }
    }
    // 산업용 PDA는 ARM. x86 라이브러리(에뮬레이터용)는 디버그에만
    defaultConfig.ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    testOptions { unitTests.isReturnDefaultValues = true }
}

ksp { arg("room.schemaLocation", "$projectDir/schemas") }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.exifinterface:exifinterface:1.3.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.15.0")

    // 로그인(PKCE)·토큰 보관·앱 잠금(09 6.5)
    implementation("net.openid:appauth:0.11.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.biometric:biometric:1.1.0")

    // 오프라인 DB(Room + SQLCipher)
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("net.zetetic:sqlcipher-android:4.6.1@aar")
    implementation("androidx.sqlite:sqlite-ktx:2.4.0")

    // 통신·동기화
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")

    // 카메라 스캔(스캐너가 없을 때)
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
