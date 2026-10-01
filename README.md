# 셋업 앱 중앙 버전 관리 (LETMEUP-1221)

셋업 렛미업·셋업 클래스업의 서비스별 릴리스 카탈로그, stable/beta 목표, 단말별 지정,
운영 검증 안정화 버전과 변경 이력을 관리하는 **Next.js 한 프로젝트**다.
웹·API·수집기가 같은 Node 프로세스에서 동작한다. 중앙 서버는 메타데이터를 제공하고
설치 파일은 GitHub CDN에서 받는다. 이 저장소의 기존 공개 설치 릴리스는 수정하지 않는다.

## 서비스 및 확인 근거

|서비스|Samlab-Corp 배포 저장소|중앙 설치 연동|
|---|---|---|
|렛미업 Windows 키오스크|letmeup-kiosk-v2-release|런처 인증/304 후속 작업 필요|
|렛미업 Android 태블릿|letmeup-kiosk-app-releases|미구현|
|클래스업 Android 태블릿|classup-kiosk-app-releases|미구현|
|클래스업 데스크톱|classup-desktop-app-releases|미구현|
|클래스업 키오스크|classup-kiosk-client-releases|미구현|
|클래스업 배리어프리 키오스크|classup-kiosk-barrier-free-releases|미구현|
|런처 자체, 별도 카탈로그|samlab-launcher-release|자체 업데이트 미구현|

2026-10-01 `setup-samlab-click/app.py`(GitHub), 로컬 `setup-classup-io/index.js`, 런처
`types.ts`·`targetSource.ts`·`githubReleaseSource.ts`·`letmeupKiosk.ts`를 읽고 매핑을 확인했다.
해당 저장소는 수정하지 않았다. 주 대상은 셋업 페이지들의 앱 버전 관리다.
카탈로그·관리 목표 저장과 실제 설치 연동은 구분한다. [런처 계약 및 후속 작업](docs/launcher-integration.md).

## 실행

Node >=20.9, pnpm 10.32.1. `pnpm install --frozen-lockfile` 이후:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
# 외부 자격증명 파일에서 필요한 환경변수를 로드한 동일 셸에서:
pnpm start
```

개발은 `pnpm dev`. **`next start`를 직접 실행하지 않는다.** `server.ts`가 API·인증·저장소
잠금·시작 및 20분 주기 수집을 소유한다. 요청이 없어도 수집기가 유지된다.
서버는 127.0.0.1:3022에 바인딩한다. Next 앱만 시작하면 중앙 API/접근 제어가 연결되지 않는다.
공식 [커스텀 서버](https://nextjs.org/docs/app/guides/custom-server)와
[자체 호스팅](https://nextjs.org/docs/app/guides/self-hosting) 안내를 확인했다.
커스텀 서버와 standalone 배포를 혼용하지 않는다.

환경 예시는 [.env.example](.env.example). 비밀은 환경변수 `ADMIN_PASSWORD`, `DEVICE_SIGNING_KEY`,
`GITHUB_WEBHOOK_SECRET`, 선택적인 읽기 전용 `GITHUB_TOKEN`으로 받는다. 실제 비밀은
`~/.samlab-central/credentials.local`, `.dev`, `.prod` 중 명시적으로 선택한 파일 한 곳에
보관한다. 디렉터리 700/파일 600, 환경 간 fallback 없음. 신뢰한 파일을 `source`한 동일 셸에서
앱을 실행한다. 코드가 읽는 것은 프로세스 환경뿐이다. 비밀을 로그·명령 인자·Git에 넣지 않는다.
미설정/placeholder/32자 미만 필수 비밀은 시작을 거부한다.

`DATA_DIR`은 프로젝트 밖 절대 경로(`/var/lib/samlab-central` 등), `APP_ORIGIN`은 외부 HTTPS
origin이어야 한다. 로컬은 localhost/127.0.0.1 HTTP를 허용한다. `.env.example`은 placeholder
그대로 유지한다. 자격증명 파일은 이 작업에서 생성하거나 기존 값을 교체하지 않았다.

## 관리 흐름

관리 화면과 읽기/쓰기 API는 HTTPS Basic 인증을 사용한다. 공유 브라우저의 인증 캐시에 유의한다.
쓰기에는 정확한 Origin·JSON Content-Type·`x-csrf-protection: 1`이 필요하다.

1. 서비스와 채널을 선택한다. GitHub prerelease 플래그로 stable/beta를 분리하고 draft는 제외한다.
   모든 페이지를 수집하며 안전 한도 초과 시 카탈로그를 교체하지 않는다.
2. `설치 파일 크기·해시 검증`으로 실제 스트림을 확인한다. 서버 디스크에 설치 파일을 보관하지 않는다.
3. 검증한 버전만 전체 기본 목표 또는 단말 목표로 지정한다. 단말 지정이 우선이며 해제하면 기본으로 돌아간다.
4. 운영 환경에서 별도 검증한 뒤 `운영 검증 완료 · 안정화 지정`을 실행한다.
   파일 무결성과 운영 안정성은 별개이며 최신 버전을 자동 안정화 버전으로 취급하지 않는다.
5. 실제 설치는 보고 연동이 없어 **미보고**다. 실패 시 정상 앱 유지·재시도 및 안정화 후보를 안내한다.
   다운로드 실패만으로 서버가 임의 하향 설치를 지시하지 않는다.

electron-builder latest.yml/beta.yml의 버전·파일명·SHA-512·크기를 실제 자산과 대조한다.
beta.yml을 우선하며 없는 경우 latest.yml을 사용한다. 외부 URL/경로 입력은 받지 않으며
허용 저장소의 특정 태그 URL과 안전한 파일명만 받는다. CDN redirect도 HTTPS GitHub 허용
호스트에 제한하고 토큰을 전송하지 않는다. APK는 단일 APK 자산·정상 버전 태그·GitHub
SHA-256 digest가 있어야 후보가 된다. 실제 스트림의 SHA-256 확인 후 SHA-512를 산출한다.
예전 릴리스에 정상 해시/메타데이터가 없으면 목록은 보여도 목표 지정은 거부한다.
자산 변경/삭제/채널 이동은 검증 및 유효하지 않은 목표를 해제하고 대조 이력을 남긴다.
통신 장애에는 마지막 정상 카탈로그와 목표를 유지하고 오류를 표시한다.

## JSON 저장과 복구

`central.snapshot.json`에 revision·카탈로그·목표·검증·delivery·이력을 함께 저장한다.
쓰기 큐로 직렬화하며 관리자 수정에는 revision 일치가 필수다. 경쟁 변경은 409.
임시 파일 fsync → atomic rename, Linux 디렉터리 fsync를 사용한다. 직전 검증된 스냅샷은
`.bak`에 남긴다. 메모리는 저장 성공 후 교체하고 이후 읽기 전용이다. 참조와 이력도 검증한다.

손상을 빈 초기값으로 덮어쓰지 않는다. 기본 파일 없이 백업이 있으면 시작을 거부한다.
실행 중 외부 수정/손상도 쓰기를 거부하고 정상 백업을 보호한다. 복구 절차는 앱 정지 →
손상본 별도 보존 → 검증한 백업을 기본 파일로 복원 → 재시작. 자동 복원/초기화는 없다.
실제 데이터·백업·비밀은 Git에 넣지 않는다.

배타적 `central.lock`이 중복 프로세스를 차단하며 정상 종료는 요청·수집 완료 후 제거한다.
비정상 종료 시 **기록된 PID 및 다른 인스턴스가 없는 것을 운영자가 확인한 뒤** 잠금을
제거하고 재시작한다. 강제 종료 후 자동 잠금 회수는 없다. history/delivery는 중복 판정과
감사를 위해 보존하므로 장기 운영에서는 크기 감시 및 정지 상태의 명시적 보관 정책이 필요하다.

## Webhook·누락 복구

대상 저장소의 release 이벤트를 `/api/webhook`에 연결한다. raw body HMAC-SHA256,
서명·delivery ID·허용 repo를 검증한다. webhook 최대 256KB, 관리자 입력 64KB.
서명 없는 이벤트는 거부하며 ping은 서명 확인 후 응답한다.

delivery를 pending으로 영구 저장한 뒤 GitHub의 현재 전체 릴리스 목록을 조회한다.
완료 저장 후에만 200. 실패는 failed·시도 횟수를 저장하고 503. 같은 ID의 done은 중복
처리하지 않으며 failed는 재처리한다. GitHub 자동 재전송은 가정하지 않으며 수동 redelivery
또는 별도 재전송 운영이 필요하다. 시작 및 20분 주기 대조가 누락·역순·중단을 복구한다.
기존 수집 도중 도착한 webhook은 이전 수집 종료 후 다시 조회한다.

## 단일 앱 배포

[PM2](deploy/ecosystem.config.cjs)·[nginx](deploy/nginx.conf) 예시 제공. 소스·빌드·node_modules와
별개의 영구 data 디렉터리와 외부 비밀을 준비한다. 선택한 `.prod` 환경을 로드하고 PM2 fork
**instances: 1**로 실행한다. cluster/여러 replica/무중단 reload는 금지한다. 새 프로세스는
기존 잠금과 충돌하므로 stop 후 start하는 유지보수 창이 필요하다. serverless/임시 파일
시스템/Next standalone은 이 저장 설계의 배포 대상이 아니다. nginx TLS·요청 제한·캐시 비활성화를 적용한다.
마지막 수집·failed delivery·프로세스·디스크·백업 복구를 감시한다. 대규모 운영은 DB와
인증된 단말 등록/보고 체계로 확장하고 실제 환경에서 용량을 측정한다.

## 검증

`pnpm test`: 재시작 유지·revision 경쟁·손상 보호·잠금·인증·CSRF·채널 분리·웹훅 중복/재처리/
현재 소스 대조·304/단말 캐시 범위·안전한 다운로드/해시 테스트.
`pnpm verify:releases`: 실제 공개 카탈로그 및 최신 사용 가능한 설치 파일 읽기 전용 검증.
`pnpm smoke`: 임시 환경에서 실제 프로덕션 서버 시작·화면/API 인증 검증.
`pnpm benchmark`: 32 동시 연결, 10,000건 로컬 HTTP 읽기 측정.
[검증 기록](docs/validation.md). 수치를 운영 용량으로 단정하지 않는다.
