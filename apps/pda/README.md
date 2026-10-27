# ALM Count — PDA 실사 앱

Android 네이티브(Kotlin, Jetpack Compose) 앱. 01 기능정의서 PDA-01~08, 06 API 명세서(PDA), 09 권한·보안 설계서 6.5를 따른다.

| 화면 | 내용 |
| --- | --- |
| PDA-01 | 로그인(회사 SSO, AppAuth PKCE) · 기기 등록 · 작업목록 내려받기 |
| PDA-02 | 내 실사 작업(캠페인별 진행률) |
| PDA-03 | 룸 선택(룸 라벨 스캔 또는 목록) |
| PDA-04 | 스캔 · 판정(확인·위치 불일치·범위 밖·미등록·중복·폐기) |
| PDA-05 | 자산 확인(상태·라벨 재출력·메모·사진) |
| PDA-06 | 미등록 자산 보고(사진 필수) |
| PDA-07 | 룸 현황 · 완료(미확인이 남으면 확인 후 강제 완료) |
| PDA-08 | 전송 대기열(오프라인 저장 → 통신될 때 자동 전송) |
| 설정 | 스캐너 연동 방식·시험, API 주소, 기기 시리얼 |

## 구조

- `net/` API 호출(Bearer + `X-Device-Id`), `auth/` AppAuth·토큰(Keystore 암호화 저장)
- `data/` Room + SQLCipher 오프라인 DB, 판정(`Judge`), 동기화·대기열(`Repository`)
- `scan/` 하드웨어 스캐너(방송 인텐트·키보드 입력), 카메라 스캔(ZXing)
- `sync/` WorkManager 전송(15분 + 통신 복구 시)
- `ui/` 화면, 앱 잠금(15분 미사용·1분 넘게 나갔다 오면 PIN·생체 확인)

## 빌드

```
cd apps/pda
./gradlew testDevDebugUnitTest assembleDevPilot     # app/build/outputs/apk/dev/pilot/app-dev-pilot.apk (R8 축소, 디버그 키 서명)
```

환경(flavor): `dev`(alm-dev.pasapps.com) · `qa` · `prd`. CI(`ci.yml`의 PDA 작업)가 DEV 시험용(pilot) APK를 아티팩트로 올린다. 운영 배포는 release + 배포 키 서명.

## 스캐너 설정 (Farset G47 · Scan Tool 등)

앱의 **Device settings → Scanner**에서 방식을 고른다.

1. **Broadcast(권장)**: Scan Tool에서 출력 방식을 '방송(Broadcast/Intent)'으로 바꾸고
   - 액션: `com.bsg.alm.SCAN`, 데이터 키: `barcode` (앱 기본값)
   - 또는 Scan Tool의 기본 액션·키를 그대로 두고, 설정 화면의 **Scanner test**에 표시되는 `action=`·키 이름을 앱에 넣는다
   - 흔한 액션(Urovo·iData·Newland 등)은 따로 넣지 않아도 받는다
2. **Keyboard**: Scan Tool 출력을 '키보드 입력 + Enter'로. 스캔 화면의 입력칸으로 들어온다
3. **Camera**: 스캔 화면의 카메라 버튼

## 기기 시리얼(X-Device-Id)

MDM 관리형 구성 `deviceSerial`이 있으면 그 값, 없으면 설정 화면 값, 그것도 없으면 `모델명-ANDROID_ID` 앞 12자리(파일럿 기본).
