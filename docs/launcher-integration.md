# 런처 계약 및 후속 연동

2026-10-01 `samlab-launcher/src/shared/types.ts`, `src/main/services/targetSource.ts`,
`githubReleaseSource.ts`, `src/main/adapters/letmeupKiosk.ts`를 확인했다. 참고 저장소는 수정하지 않았다.

## 목표 API

`GET /api/target?programId=letmeup-kiosk-v2`는 실제 `TargetState` 계약을 반환한다.

```json
{
  "programId": "letmeup-kiosk-v2",
  "targetVersion": "2.10.109",
  "artifact": {
    "version": "2.10.109",
    "url": "https://github.com/Samlab-Corp/letmeup-kiosk-v2-release/releases/download/v2.10.109/LetMeUp-StudyCafe-V2-Setup-2.10.109.exe",
    "sha512": "REPLACE_WITH_RELEASE_SHA512_BASE64_OR_HEX",
    "sizeBytes": 125528005,
    "fileName": "LetMeUp-StudyCafe-V2-Setup-2.10.109.exe"
  },
  "detectedAt": "2026-10-01T00:00:00.000Z"
}
```

예시 해시는 placeholder이며 운영 목표가 아니다.

`Authorization: Bearer <device token>`과 `x-device-id`가 필요하다. 토큰은
`base64url(JSON claims).base64url(HMAC-SHA256(payload, DEVICE_SIGNING_KEY))` 형식이다.
claims는 `{deviceId, service, channel, exp}`, exp는 Unix 초 단위 만료 시각이다.
등록·신원 확인된 단말에만 관리 측 비밀 보관 경로에서 `signDevice()`로 발급·배포한다.
자동 등록 API는 없다. 토큰은 단말·서비스·채널에 한정된다. 짧은 유효기간과 갱신 운영이
필요하며 키 교체는 모든 토큰을 만료시킨다. ID 헤더만으로 인증할 수 없다.

지정 및 파일 검증을 마친 목표만 제공한다. 지정 없음 404, 인증 실패 401, 다른 스코프 403,
클라이언트 연동 미구현 서비스 409. 단말 지정이 전체 기본 목표보다 우선한다.
안정화 버전은 자동 목표가 아니다. `detectedAt`은 목표 지정의 저장 시각이다.

`Cache-Control: private, no-cache`, `Vary: Authorization, x-device-id`를 사용한다.
ETag는 단말 범위와 실제 목표 JSON으로 생성하여 시각이나 다른 서비스 변경으로 바뀌지 않는다.
인증 후 `If-None-Match`를 평가해 304를 반환한다. 공유 캐시 저장과 nginx 캐시는 금지한다.
요청마다 GitHub를 호출하거나 파일 전체를 읽지 않는다.

## 후속 연동

현재 `HttpTargetSource`는 ID 헤더만 보내고 Bearer 인증·ETag 저장이 없다. 304를 오류로
처리하며 `detectedAt`을 현재 시각으로 덮어쓴다. 주소 설정만으로는 중앙 연동이 동작하지 않는다.
렛미업 Windows 어댑터 외 클래스업 앱·Android·런처 자체 중앙 목표 설치 연동도 미구현이다.
이번 작업은 해당 카탈로그와 관리 목표를 저장하며 미구현 서비스 단말 목표 API는 409로 거부한다.

별도 후속 작업:

1. 인증된 단말 등록, 토큰 배포·보관·갱신·개별 단말 차단 운영.
2. 5분 조회, ±1분 시간 분산. 실패 시 지수 백오프와 지터, 재연결 즉시 조회.
   여러 단말의 동시 재연결도 부하 검증한다.
3. 검증한 200 JSON과 ETag 저장, 다음 조회에 `If-None-Match` 전송.
   304는 저장된 JSON 재사용, 캐시가 없으면 무조건 재조회.
   인증·단말·서비스·채널이 바뀌면 캐시를 폐기한다.
4. programId·버전·URL·크기·해시 검증, 서버 detectedAt 유지, 인증 오류 구분.
5. 결과·다운로드 실패·실제 설치 버전·APP_READY 인증 보고.
   오프라인 결과 재전송과 오래된 보고의 순서 역전 처리.

## 복구

다운로드 실패 시 정상 앱 유지·재시도. 실패만으로 자동 하향 설치하지 않는다.
서버 안정화 버전은 운영자가 검증한 전체 후보이며 단말의 `lastKnownGoodInstallerVersion`과
별개다. 단말 정상 버전을 확정하려면 정상 설치 파일 로컬 보관, 설치 검증, 재실행 후
APP_READY 확인이 필요하다. 보고 연동이 없어 화면은 미보고다. 실제 설치 완료·정상 실행·
복구 가능한 로컬 파일 존재를 추정하지 않는다.
