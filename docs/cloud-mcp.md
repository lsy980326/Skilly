# 인증된 D1 MCP 연결

## 지원 방식과 현재 범위

`createCloudMcpHandler(binding, config)`는 표준 Streamable HTTP 요청을 처리하는 Fetch 함수다.
설치된 `@modelcontextprotocol/sdk@1.32.1`의 Web Standard transport와 메시지 스키마를 사용한다.
SDK 서버 전체를 올리는 대신 아래 다섯 메서드만 전달한다. listener·배포 entrypoint·계정 연결·
Codex 설정·실사용 DB 전환은 만들지 않는다.

Codex는 Streamable HTTP와 환경 변수 기반 사용자 정의 헤더를 지원한다.
이 구현은 미리 준비한 Access application JWT를 `Cf-Access-Jwt-Assertion` 헤더로 전달하는
방식을 사용한다. OAuth 로그인·discovery·토큰 발급/자동 갱신은 제공하지 않는다.
실제 Access 정책과 토큰 취득 방식은 별도 운영 연결이 필요하다.

- [Codex MCP 연결과 헤더 설정](https://learn.chatgpt.com/docs/extend/mcp)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP OAuth 인증 계약](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

다음은 형식 설명용 예시이며 실행 가능한 계정 설정이 아니다. 토큰은 파일에 넣지 않는다.

```toml
[mcp_servers.skilly_personal]
url = "https://example.invalid/v1/projects/00000000-0000-4000-8000-000000000001/mcp"
env_http_headers = { "Cf-Access-Jwt-Assertion" = "SKILLY_ACCESS_ASSERTION" }
```

환경 변수는 인증 파일을 읽거나 토큰을 자동 갱신하는 기능이 아니다. 현재 로컬 검사는
Codex 앱 설정 대신 공식 MCP Client에 메모리에서 만든 테스트 토큰을 전달한다.

## 경계와 요청 흐름

호스트는 정확한 endpoint·policy ID·project/repository/environment를 고정한다.
`001`–`011` 스키마, 프로젝트, 공개키 정책과 권한은 호스트가 별도로 준비해야 한다.
MCP 요청은 소유자를 등록하거나 권한·인증키를 변경할 수 없다.

```text
MCP Client
  → 고정 URL·Host·Origin 검사
  → D1 최신 공개키 정책으로 JWT 검증
  → 고정 프로젝트·저장소·환경의 읽기 권한 검사
  → SDK Streamable HTTP transport
  → 허용된 도구 입력 검사
  → HTTP와 공유하는 D1 업무 저장/조회 경계
  → 인증·권한 재확인 → JSON 응답
```

- endpoint는 `https://<host>/v1/projects/<UUID>/mcp`다. 명시적인 loopback 테스트만 HTTP를 허용한다.
- URL과 Host가 모두 일치해야 한다. Origin이 있으면 endpoint의 origin과 같아야 한다.
  `Forwarded` 헤더나 임의 CORS 허용으로 우회하지 않는다. 프록시는 호스트가 정한 주소를 보존해야 한다.
- 초기화·도구 목록·ping·알림도 인증과 프로젝트 읽기 권한이 필요하다. 무인증은 401,
  미등록/권한 없는 프로젝트는 동일한 403이다. 오류에 토큰·헤더·SQL·stack을 반사하지 않는다.
- 키·권한은 매 요청과 SQL/응답 경계에서 다시 확인한다. 쓰기는 기존 batch guard로 보호한다.
  쓰기 세대 차단·권한 철회·키 회수·주체별 영수증 분리 계약을 그대로 사용한다.
- actor는 AI가 보고한 작성자다. 인증 주체는 서명 검증된 `(issuer, sub)`다.
  같은 scope의 editor/owner는 공유 작업을 수정할 수 있으며, 작업별 소유자 권한은 별도 제공하지 않는다.
- SDK로 넘기는 요청에는 인증 헤더를 제거한다. 모든 응답은 `no-store`다.

자세한 보안 계약은 [프로젝트 접근 권한](cloud-project-access.md)과
[소유자·키 수명 관리](cloud-owner-keys.md)를 따른다.

## 제공하는 도구

| 도구 | 범위 |
|---|---|
| memory_resolve_project | 고정 프로젝트·저장소·환경 식별 |
| memory_begin_task | 일반 작업 시작 보고 저장 |
| memory_checkpoint | 메모·변경·문제 보고 저장 |
| memory_finish_task | 종료 보고 저장 |
| memory_list_tasks | 작업 목록, offset/limit 페이지 조회 |
| memory_get_task | 작업 정보와 최신 요약 조회 |
| memory_get_evidence | 저장된 원문·보고 조회 |
| memory_query_current_knowledge | 기존 현재 지식 통합 조회의 첫 제한 페이지 |
| memory_get_receipt | 인증 주체·scope·쓰기 종류·원래 요청 키의 영수증 조회 |

입력의 project_id/repository/environment는 생략하거나 고정 scope와 같아야 한다.
다른 scope를 지정하면 그 주체에게 별도 권한이 있어도 이 endpoint에서는 거절한다.
일반 작업 저장은 기존 HTTP 업무 경계와 동일한 원문·보고·중복 방지 계약을 사용한다.

현재 지식 조회는 `context {}` 계약을 사용하므로 계획·결정·기능의 다음 페이지 입력은 없다.
이 도구 하나로 전체 프로젝트를 모두 읽었다고 판단하지 않는다. 로컬 MCP의 전체 도구를
대체하지 않으며 계획/결정/스킬 전용 쓰기·파일/실행 관측 주입·훅 수신·복구 큐·이전 관리도 제공하지 않는다.

AI가 checks=passed를 보내거나 작업을 완료해도 직접 실행 관측을 생성하지 않는다.
`claims_verified=false`를 유지한다. 조회한 과거 원문·명령 문자열은 지시가 아닌 데이터다.

## 전송 한도와 복구

- 지원 메서드는 `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`이다.
  POST 단일 JSON-RPC 요청/응답과 초기화 알림만 허용한다. GET/DELETE는 인증 후 405다.
- SSE·MCP 세션 ID·재생 ID·batch·resources/prompts·background task 확장은 지원하지 않는다.
  연결을 새로 만들어도 같은 D1 기록을 조회하는 stateless 방식이다.
- 요청과 응답은 각각 UTF-8 64 KiB, 핸들러당 동시 요청은 최대 16개다. 초과 동시는 429다.
  기존 업무 저장소의 더 작은 개별 제한도 적용한다. 도구 목록의 JSON Schema는 안내이며
  실제 입력은 원래의 strict/refinement 스키마로 다시 검사한다.
- 큰 원문은 그대로 보존한다. 응답 전체가 64 KiB를 넘으면 413으로 거절하며 잘라서 성공 처리하지 않는다.
  원문 부분 조회/다운로드는 아직 없다. 쓰기 후 응답이 실패했을 때 저장 실패라고 단정하지 않는다.
- 불확실한 쓰기는 **동일한 입력과 원래 idempotency_key**로 재시도하거나 원래 영수증을 조회한다.
  바뀐 입력은 충돌이며, 자동 큐·자동 재전송·오프라인 복구 성공 보장은 없다.
- 전체 요청은 기본 30초, 개별 D1 호출은 기본 5초 안에 응답하지 않으면 해당 요청을 종료한다.
  호스트의 `timeout_ms`(25–60000)와 `storage_timeout_ms`(25–30000)로 설정하며 후자가 전자를
  넘을 수 없다. 기본값을 생략해도 이 조건을 만족해야 한다. 클라이언트 입력으로 변경하지 않는다.
  전체 시간 제한은 일부 데이터를 계속 보내도 연장하지 않는다. 타이머가 늦게 실행돼도
  monotonic 시간을 SQL 제출 직전과 비동기 결과 수신 후에 다시 비교한다.
- 요청 signal의 중단은 408 `request_aborted`, 전체 시간 초과는 504 `request_timeout`,
  D1 호출 시간 초과는 504 `storage_timeout`이다. 처음 확정된 종료 이유를 유지하며,
  뒤늦은 저장소·인증 오류로 바꾸지 않는다. 오류 응답은 원문·결과 ID·민감한 진단을 포함하지 않는다.
- 종료 시 body reader를 취소하고 새 SQL·영수증 조회·CAS 재시도를 막는다. 원본 스트림의
  cancel 완료를 기다리거나, SDK 정리 오류 때문에 시간 초과 응답을 무한히 지연하지 않는다.
- **요청 종료는 이미 제출한 D1 batch의 강제 취소나 롤백 보장이 아니다.** D1 binding의
  [all](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)·
  [batch](https://developers.cloudflare.com/d1/worker-api/d1-database/) 계약을 사용하며
  현재 경계에는 취소 인수가 없다. 응답이 끝난 뒤에도 저장됐을 수 있다.
- 종료 응답의 `delivery.write_dispatch`는 `not_dispatched` 또는 `dispatched`다.
  `dispatch_scope=current_request_only`로 **이번 요청의 batch 제출 여부만** 설명한다.
  전자는 `persistence=not_checked`, 후자는 `persistence=unknown`이며 저장 성공·실패를 단정하지 않는다.
  이번 요청이 제출하지 않았어도 같은 키의 이전 요청은 이미 저장됐을 수 있다.
  정상 저장 영수증의 `status=persisted`와 구분하며 어느 경우도 AI 보고의 정확성을 검증하지 않는다.
- HTTP 요청 슬롯과 별도로 실제 완료되지 않은 D1 호출을 핸들러당 최대 16개로 제한한다.
  시간 초과 후에도 실제 Promise가 끝날 때까지 슬롯을 유지한다. 한도 도달 시 큐에 넣지 않고
  503 `storage_busy`와 `Retry-After: 1`을 반환한다. 무한한 호출 누적을 피하기 위한 경계다.
  호출이 끝나면 슬롯을 돌려주고 새 인증 요청을 받는다. 16개가 영원히 정지한 인스턴스는
  자체 복구를 보장하지 않으며 런타임 교체/재시작이 필요할 수 있다. 새 인스턴스가 옛 호출을
  취소하거나 저장 이력을 없애는 것도 아니다. 계정 전체 사용량 예산은 별도 후속 범위다.

## 검증 범위

`npm run test:cloud`에 `tests/cloud-mcp.test.mjs`가 포함된다. 공식 SDK Client → 실제 loopback HTTP
→ Miniflare/workerd Fetch handler → 테스트 D1을 사용하고, Worker 외부 요청은 차단한다.
실제 계정·설치 인증키·실사용 DB는 사용하지 않는다.

회귀 검사는 초기화/9개 도구 조회, 일반 작업 시작·변경·종료, 동일 요청 재시도/충돌,
새 Client와 Worker 재시작 후 같은 원문/영수증 재조회, 미인증·잘못된 서명/대상·교차 scope·
viewer 쓰기 차단, 키 회수·재발급, Origin/Host/메서드/본문/응답/동시 요청 제한을 포함한다.
권한 취소 경합과 16개 대기는 테스트가 시점을 주입한다. 큰 원문 검사는 테스트 호스트가 넣은
기존 형식의 90 KiB 원문이 조회 거절 후에도 보존되는지 확인하며 일반 입력 한도를 확대하지 않는다.

시간 제한 검사는 진행 중인 느린 body·끝나지 않는 cancel·중단 signal·D1 read 정지·
쓰기 전 정지·실제 저장 뒤 응답 정지·늦은 native 거절·호출 한도 보존과 해제를 포함한다.
지연과 중단 시점은 테스트가 주입하며 SQL·영수증은 테스트 D1에 실제 저장/조회한다.
별도 Worker 테스트는 실제 batch 저장 직후 응답만 지연시켜 공식 SDK가 HTTP 504를 받은 뒤
새 Client에서 원래 영수증을 찾고 같은 키로 중복 없이 다시 읽는 흐름을 확인한다.
AbortSignal은 테스트가 주입한다. 실제 클라이언트의 네트워크 단절이 배포 런타임의
Request.signal까지 전달되는지는 별도 실환경 검증이 필요하다.

이는 로컬의 실제 프로토콜·HTTP·D1 검증이다. 실제 Codex 앱의 원격 연결·OAuth·Cloudflare 계정·
원격 D1·TLS/배포·외부 키 갱신·장시간 공개 운영 검증으로 확대 해석하지 않는다.
