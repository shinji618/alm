// ALM PDA 실사 앱(WBS 5.x, 01 기능정의서 PDA-01~08). Android 네이티브(Kotlin) + Compose + Room(SQLCipher) + AppAuth
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
    // KSP 플러그인 마커가 플러그인 포털에만 있어(포털 접근이 막힌 환경 대비) Maven Central의 본체로 바로 연결
    resolutionStrategy {
        eachPlugin {
            if (requested.id.id == "com.google.devtools.ksp") useModule("com.google.devtools.ksp:symbol-processing-gradle-plugin:${requested.version}")
        }
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "alm-pda"
include(":app")
