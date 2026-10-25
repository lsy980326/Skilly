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
- 비동기 transport callback 오류는 해당 요청의 오류 경로로 전달하고 transport를 닫는다.
  다만 느린 body 읽기나 멈춘 D1 호출의 전체 시간 제한/강제 취소는 아직 없다.
  16개가 정지하면 새 요청도 차단될 수 있다. 공개 배포 전 시간 제한과 사용량 예산 검증이 필요하다.

## 검증 범위

`npm run test:cloud`에 `tests/cloud-mcp.test.mjs`가 포함된다. 공식 SDK Client → 실제 loopback HTTP
→ Miniflare/workerd Fetch handler → 테스트 D1을 사용하고, Worker 외부 요청은 차단한다.
실제 계정·설치 인증키·실사용 DB는 사용하지 않는다.

회귀 검사는 초기화/9개 도구 조회, 일반 작업 시작·변경·종료, 동일 요청 재시도/충돌,
새 Client와 Worker 재시작 후 같은 원문/영수증 재조회, 미인증·잘못된 서명/대상·교차 scope·
viewer 쓰기 차단, 키 회수·재발급, Origin/Host/메서드/본문/응답/동시 요청 제한을 포함한다.
권한 취소 경합과 16개 대기는 테스트가 시점을 주입한다. 큰 원문 검사는 테스트 호스트가 넣은
기존 형식의 90 KiB 원문이 조회 거절 후에도 보존되는지 확인하며 일반 입력 한도를 확대하지 않는다.

이는 로컬의 실제 프로토콜·HTTP·D1 검증이다. 실제 Codex 앱의 원격 연결·OAuth·Cloudflare 계정·
원격 D1·TLS/배포·외부 키 갱신·장시간 공개 운영 검증으로 확대 해석하지 않는다.
