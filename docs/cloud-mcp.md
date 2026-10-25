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
| memory_checkpoint(kind=decision) | 명시적 결정·정정·철회·제안 원문과 구조화 이력 저장 |
| memory_finish_task | 종료 보고 저장 |
| memory_list_tasks | 작업 목록, offset/limit 페이지 조회 |
| memory_get_task | 작업 정보와 최신 요약 조회 |
| memory_get_evidence | 저장된 원문·보고 조회 |
| memory_query_current_knowledge | 유효한 결정·계획 진행률/남은 항목·검사 근거의 구역별 페이지 조회 |
| memory_query_decisions | 정확한 subject·구성요소·기능 범위의 결정 이력, history_offset 페이지 조회 |
| memory_save_plan | 선택한 MD/대화 계획을 불변 버전으로 저장 |
| memory_update_plan_item | 정확한 계획 버전·작업·보고·완료 조건에 연결해 진행 상태 보고 |
| memory_query_plans | 계획 카탈로그 페이지 또는 정확한 버전의 원문·진행률·남은 항목 조회 |
| memory_list_executions | 저장된 호스트 실행 결과·통과/실패 상세·코드 버전의 작업별 페이지 조회 |
| memory_list_task_events | 호스트가 고정한 현재 세션의 수신 이벤트 목록 |
| memory_link_task_events | 현재 호스트 기준 이벤트와 자신의 활성 작업을 명시적으로 연결 |
| memory_get_status | task_recording의 현재 마지막 저장 지점과 중단 당시 저장 지점 조회 |
| memory_register_skill | 공급한 스킬 전문·불변 버전·보조 파일·설치 안내 등록 |
| memory_assign_skill | 예상 assignment ID를 확인한 설치 지정 메타데이터 저장; 파일 설치 아님 |
| memory_checkpoint_skill_usage | 별도 작업 종류로 스킬 버전/목적의 AI 사용 보고 및 기존 파일 관측 ID 연결 |
| memory_list_skills | 프로젝트 공유 카탈로그 페이지, 호스트별 설치 수 |
| memory_get_skill | 전문·버전 목록·설치 안내와 호스트별 설치/마지막 관측 페이지 |
| memory_get_skill_package | 정확한 버전의 이동 가능한 패키지; 다운로드/실행 없음 |
| memory_list_skill_history | 호스트별 설치 지정/저장된 파일 관측 이력 페이지 |
| memory_list_task_skills | 작업별 AI 사용 보고와 연결된 과거 파일 관측 구분 |
| memory_list_features | 별칭·코드 경로 검색과 매칭 이유·현재 검사 근거 조회 |
| memory_get_receipt | 인증 주체·scope·쓰기 종류·원래 요청 키의 영수증 조회 |
| memory_get_write_context | 명시적 호스트 보관함용 인증 주체·DB·쓰기 세대·호스트 문맥 고정표 조회 |

입력의 project_id/repository/environment는 생략하거나 고정 scope와 같아야 한다.
다른 scope를 지정하면 그 주체에게 별도 권한이 있어도 이 endpoint에서는 거절한다.
일반 작업 저장은 기존 HTTP 업무 경계와 동일한 원문·보고·중복 방지 계약을 사용한다.

현재 지식 조회는 `component`, `limit`, `decisions_offset`, `plans_offset`, `features_offset`를 받는다.
각 구역의 `next_offset`을 해당 입력에 전달한다. 페이지는 요청마다 revision을 확인하지만
여러 요청을 묶은 불변 스냅샷은 아니며 다른 작업이 저장되면 목록이 달라질 수 있다.
제한된 구역/항목 수와 잘림 표시는 그대로 유지한다. 결정·계획의 긴 원문과 개별 이력은
`memory_query_decisions`·`memory_query_plans`에서 선택·페이지 조회한다.
로컬 MCP 전체를 대체하지 않으며 파일/실행/이벤트 관측 주입·훅 설치·복구 큐·이전 관리는 제공하지 않는다.

AI가 checks=passed를 보내거나 작업을 완료해도 직접 실행 관측을 생성하지 않는다.
`claims_verified=false`를 유지한다. 조회한 과거 원문·명령 문자열은 지시가 아닌 데이터다.

### 스킬·기능 검색과 호스트 경계

`createCloudMcpHandler`의 다섯 번째 인자인 `CloudSkillContextProvider`는 인증 주체와 고정 scope에
해당하는 `root_hash`를 호스트에서 선택한다. 이벤트 훅의 세션과 독립적이다. 등록되지 않은 root는
`unsupported_capability`이며 일반 작업 연결의 장애로 판단하지 않는다. 클라이언트는 root나
로컬 절대 경로를 선택할 수 없다. 운영 매핑은 issuer와 subject 및 정확한 scope를 모두 확인해야 한다.

스킬 카탈로그 전문·버전은 프로젝트 공유다. 설치 지정·파일 관측은 repository/environment/root별이다.
`memory_register_skill`은 resolve로 받은 `project_id`가 필수다. 나머지 공통 scope는 생략하거나
endpoint와 같아야 한다. 등록 전문·출처 URL·보조 스크립트·설치 안내는 신뢰되지 않은 데이터이고,
이 경계는 URL을 가져오거나 파일을 설치/덮어쓰거나 명령을 실행하지 않는다. 설치 지정은
`expected_assignment_id`가 일치할 때만 추가되며 버전 변경 후 관측은 다시 `not_checked`다.

`CloudSkillInspector`는 MCP 도구가 아닌 별도 호스트 경계다. 명시적으로 고정된 observer/root에서
등록된 패키지 파일만 읽고, 작업마다 새 인증·최신 ACL을 검사한다. 실제 파일 I/O 어댑터는 호스트가
제공한다. 관측은 그 시점의 파일 상태이며 모델 로딩·실제 사용·작업 정확성의 증명이 아니다.
MCP 읽기는 저장된 관측을 보여줄 뿐 파일을 다시 읽지 않는다. 다른 root의 작업 사용 보고에서는
파일 관측을 숨기고 `outside_host_root`로 구분한다.

AI 사용 보고는 `memory_checkpoint_skill_usage`로 전문과 별개인 note/change/issue를 저장한다.
원래 `memory_checkpoint`의 키/영수증 계약을 바꾸지 않고, 같은 키 문자열이라도 별도 operation이다.
구조화 결정은 이 도구로 저장하지 않는다. 선택적 `observation_id`는 같은 스킬 버전·범위의
기존 관측만 연결할 수 있다. `skill-register/skill-assign/skill-checkpoint/skill-inspect` 영수증은
인증 주체·프로젝트·repository·environment·root·operation·키별이며 응답 유실 후 원래 입력으로만 재시도한다.
파일 관측·설치 이력·사용 보고는 페이지 cursor를 따라야 한다. 전문/패키지는 64KiB 전송 한도를
넘으면 명시적으로 거절하고 원문을 자르거나 한도를 늘리지 않는다.

기능 검색은 이미 저장한 별칭과 repository 상대 코드 경로 **메타데이터**를 사용한다.
`match_reasons`로 별칭/코드 경로/이름 등의 일치 이유를 반환하고 `memory_list_tasks`도 같은 메타데이터로
관련 작업을 찾는다. 경로 파일을 열거나 과거 미분류 기록을 추정으로 연결하지 않는다.
AI 상태 보고, 저장된 실행 관측, 현재 코드와의 비교 가능 여부는 계속 별개다.

### 결정·계획의 저장과 재조회

현재 도구는 27개다. 구조화 결정은 기존 `memory_checkpoint`의 `kind=decision`과 `decision`
메타데이터를 함께 보낸다. 다른 kind에 결정 메타데이터를 넣거나 결정 원문만 보내면 거절한다.
`subject`와 선택적 `component_key/feature_key`를 정확히 지정하고, 조회에서 받은 완전한
`active_record_ids`를 `expected_current_ids`로 유지한다. 정정/철회는 명시한 대상 ID를 사용하고
오래된 예상 값은 충돌로 거절한다. 소급 원문은 현재 결정을 정정·철회할 수 없다.
원문을 덮어쓰지 않고 이전/현재/철회 이력을 별도로 계산한다. `source.kind=user_statement`도
AI가 제공한 출처 선언이며 인증된 사용자의 실제 발언 관측이나 사실 검증으로 승격하지 않는다.

계획은 선택한 `source_body` 원문을 전달한다. `source_ref` 파일을 열지 않으며 원본 MD와
기존 로컬 설정을 바꾸지 않는다. MD의 체크 표시는 출처 정보로만 보존하고 새 항목은 pending이다.
대화 계획은 명시적인 항목·완료 조건을 요구한다. 새 버전은 `expected_version`을 검사하며
기존 원문과 버전은 유지하고 진행률을 자동 이월하지 않는다.

항목 갱신은 같은 scope의 활성 `run_id`, 그 작업에 저장된 `record_id`, 정확한 최신 버전과
`expected_update_id`를 요구한다. completed 보고에는 모든 완료 조건의 결과가 필요하다.
다른 작업의 원문·실행 ID, 정정된/소급 원문, 이전 계획 버전으로 완료 보고를 만들지 않는다.
완료율은 **보고된 조건 충족 비율**이다. 실행 ID를 연결해도 AI의 설명 자체를 검증하지 않는다.
실행 결과는 이미 저장된 관측만 참조할 수 있고 이 endpoint는 관측을 생성하지 않는다.
호스트가 `createCloudMcpHandler(binding, config, sourceProvider)`의 세 번째 인자로
현재 소스 관측기를 명시적으로 주입할 수 있다. 요청 본문에는 이 입력이 없고 기본값은 없으므로
현재 코드 비교는 확인 불가다. 관측기는 호스트가 허용한 고정 루트만 매핑해야 하며,
저장된 root_hash·경로·명령을 실행하거나 임의 폴더를 열지 않는다.

`memory_query_plans`는 카탈로그의 offset/limit 또는 plan_key와 선택적 version/remaining_only를
받는다. 결정 상세는 history_next_offset, 계획 카탈로그는 next_offset을 따라간다.
원래 D1의 행·바이트·이력 상한과 MCP 응답 64 KiB 제한을 유지하며 큰 원문을 잘라 성공 처리하지 않는다.

`memory_get_receipt.write_operation`은 기존 begin/checkpoint/finish와 새 save-plan/update-plan을
구분한다. 인증 주체·project/repository/environment·작업 종류·원래 요청 키를 해시해 저장하므로
다른 사용자나 저장소에서 같은 키를 사용해도 이전 결과를 돌려주지 않는다. 조회 시 영수증의
저장 scope도 다시 검사한다. 기존 host 전용 D1Plans의 입력 키 계약은 바꾸지 않으며 새 계획
저장 결과에는 scope가 추가된다. 옛 영수증을 다시 작성하거나 소급해서 필드를 넣지 않는다.
계획도 자동 전송 큐에 넣지 않는다. 응답이 불확실하면 새 인증 연결에서 원래 종류/키의 영수증을
조회하고, 재시도는 같은 입력·키를 유지한다. 충돌 시 예상 버전이나 ID를 자동 변경하지 않는다.

### 호스트의 실행 수집과 원격 조회

실행 사실을 쓰는 MCP 도구는 없다. `memory_checkpoint`의 `checks=passed`는 AI 보고다.
`memory_resolve_project.capture=agent_reports_only`는 이 도구들의 업무 쓰기 경계이며,
별도의 `execution_capture=explicit_host_collector_only`가 호스트 수집 지원을 설명한다.
서버가 일반 명령·대화·파일을 자동 수집한다는 뜻이 아니다.

승인된 호스트는 내부 `CloudExecutionCollector(binding, scope, authenticate, requestKey)`를
기존 `observeCommand`의 sink로 연결한다. Workers 안에서 명령을 실행하는 API나 원격 명령
실행 도구가 아니다. 로컬/호스트 실행기가 실제 자식 프로세스에서 받은 결과만 전달한다.
`authenticate()`는 각 시작·종료 저장·영수증 조회·종료 재시도마다 새 인증을 제공해야 한다.
이미 종료된 MCP 요청의 수명이나 credential을 고정 재사용하지 않는다.
같은 issuer/sub를 유지하고 프로젝트·저장소·환경의 최신 권한과 쓰기 배치 guard를 적용한다.
다른 주체로 바뀌면 거절한다. viewer는 조회만 가능하다.

수집기는 한 명령 전용이다. `D1Executions.startForProcess`는 이번에 만든 실행 ID가
저장된 시작 영수증의 ID와 같은 경우에만 실행 허가를 반환한다. 같은 키의 다른 수집기나
동시 시작이 기존 영수증을 받으면 명령 실행을 거절한다. 시작 저장 직후 실제 실행 전에
중단될 수 있어 unconfirmed는 미실행/미확인이고, 정확히 한 번 실행 보장은 아니다.
기존 host 전용 `start()`의 영수증 재조회 계약은 유지한다.

종료 저장이 실패하면 프로세스를 다시 실행하지 않는다. 같은 수집기의 `retryFinish()`는
메모리에 보존한 원래 종료 입력·키만 재시도한다. 이 입력은 프로세스당 한 건이며 영속 큐가
아니다. 호스트 종료 후 자동 복구·전송 대기열이 있다고 표시하지 않는다.
`memory_get_receipt`의 `execution-start`/`execution-finish`로 새 인증 연결에서 저장 여부를
확인한다. 키는 주체·scope·종류별로 분리하며 반환 전 저장 scope를 다시 검사한다.
새 실행 영수증에는 scope가 추가되며 과거 영수증은 소급 변경하지 않는다.

`memory_list_executions({run_id, offset?})`는 같은 scope의 작업만 조회한다. 통과/실패 개수,
bounded 실패 항목, 원래 실행 ID·before/after 코드 버전·현재 비교를 읽는다. 다음 위치와
잘림을 따라가며, 미수집 결과를 0개/성공으로 해석하지 않는다. 현재 소스 관측기가 없으면
저장된 코드 버전은 보이되 현재 비교는 unknown이다. 호스트 주입 관측기만 비교에 쓰인다.

계획 항목의 `execution_ids`는 같은 작업에서 이미 저장된 실행만 참조한다. AI 보고의 진행률,
실제 검사 성공/실패와 코드 비교는 별개다. 보고 완료율 50%라도 실패 근거나 오래된 검사가
연결될 수 있다. `source/provenance=local_runner`, `authenticity=local_observation_not_attestation`,
`claims_verified=false`를 유지한다. 인증된 업로더나 저장 영수증은 결과의 진실성을 증명하지 않는다.

### 이벤트·작업 연결과 중단 저장 지점

원격 MCP는 이벤트를 받는 쓰기 도구를 제공하지 않는다. 허용된 호스트는 내부
`CloudEventReceiver(binding, eventScope, authenticate)`에 정규화한 최소 이벤트를 전달한다.
eventScope는 호스트가 고정한 project/repository/environment/root_hash/session_hash다.
입력에는 원문 프롬프트·명령·절대 경로·도구 출력·임의 세션 ID를 받지 않는다.
수신마다 새 인증·같은 issuer/sub·최신 쓰기 권한·배치 guard를 확인한다.
이는 훅 설치·신뢰 승인·실제 Codex 앱 중단의 관측을 대신하지 않는다.

호스트는 `createCloudMcpHandler(binding, config, sourceProvider?, eventContextProvider?)`의
네 번째 인자로 **인증 주체와 고정 scope에 맞는 현재 세션**을 선택한다.
이 함수는 요청 본문·임의 헤더·저장된 prose에서 세션을 고르지 않으며 자격증명을 받지 않는다.
수신 영수증을 확인한 뒤 현재 기준 관측 ID를 공개하고, 중단·세션 변경 때 현재성을 관리해야 한다.
같은 프로젝트를 쓰는 다른 사용자/채팅의 세션을 조용히 재사용하지 않는다.
운영 매핑은 scope와 `(issuer, sub)` 전체를 사용한다. 테스트 Worker의 subject 기반 매핑은
한 issuer로 고정된 로컬 시험용이며 운영 계정 매핑의 예제가 아니다.

`memory_resolve_project.lifecycle_context`는 `host_bound`와 현재 `current_observation_id`,
또는 `not_configured`를 반환한다. 이 ID는 **이 원격 호스트**의 ID다. 로컬 Codex 훅 안내의
관측 ID를 원격 DB에 있다고 추측하지 않는다. 공급자가 없으면 이벤트 도구는
`unsupported_capability`를 반환하며, 일반 작업/계획/검사 조회 연결까지 끊겼다는 뜻이 아니다.

작업 시작 영수증을 받은 뒤 `memory_link_task_events`에 run_id·현재 관측 ID·요청 키를 보낸다.
클라이언트는 root/session을 지정할 수 없다. 새 연결 쓰기는 호스트의 현재 관측과 일치해야 하며
DB에서도 같은 범위·루트·세션과 활성 작업, 경계 이벤트·다른 활성 작업 연결을 확인한다.
연결 이전 이벤트는 소급 연결하지 않는다. 이미 저장된 **원래 입력·키** 재생은 당시 연결
영수증을 반환하므로 현재 연결이 유효하다거나 새 작업이 연결됐다는 증거로 쓰지 않는다.

이벤트 영수증의 `work_record_saved=false`는 이벤트 메타데이터 저장과 작업 기록 저장이
다르다는 뜻이다. Interrupt/Stop으로 작업을 자동 종료하거나 검사가 성공했다고 표시하지 않는다.
`completeness=unknown`, `missing_record_count=null`, `live_execution=unknown`,
`authenticity=not_attested`, `claims_verified=false`를 유지한다. 서버가 받지 못한 이벤트나
작업 요청의 누락 개수는 알 수 없다. 수신 실패는 자동 복구 대기로 표시하지 않는다.

조회 범위는 다음처럼 다르다.

| 조회 | 범위와 의미 |
|---|---|
| memory_list_task_events | 현재 호스트 루트·세션의 수신 목록, live offset 페이지 |
| memory_get_status.task_recording | 같은 루트에서 그 작업에 명시적으로 연결된 여러 세션의 이력 |
| last_saved | 조회 당시 DB에 보이는 마지막 작업 기록·영수증 여부 |
| interruption.saved_during_event | 중단 이벤트 수신 트랜잭션 당시 저장 지점. 이후 쓰기로 바뀌지 않음 |
| current_session_binding | 현재 호스트 세션이 이 작업에 연결돼 있는지. 실제 실행 여부는 아님 |

한 D1 트랜잭션의 수신 순서이며 사용자가 실제 중지 버튼을 누른 시각의 원자적 경계가 아니다.
새 세션은 같은 루트의 중단 이력을 읽되, 새 이벤트를 연결하려면 자신의 현재 관측으로 다시
명시적으로 연결한다. 폴더/루트가 달라지면 과거 루트를 자동 선택하지 않는다.

`memory_get_receipt.write_operation`의 `event-receive`/`event-link`는 인증 주체·고정 scope·
root_hash·session_hash·종류·원래 키로 분리한다. 반환 시 전체 저장 scope를 검사한다.
세션이 바뀌면 현재 세션의 키 공간에서 조회하므로 과거 세션의 영수증을 대신 반환하지 않는다.
새 이벤트 영수증에는 scope가 추가되며 옛 원문·영수증·이벤트는 소급 변경하지 않는다.

로컬 검사는 정규화한 **테스트용 호스트 이벤트를 명시적으로 주입**한다. 실제 D1 저장과
SDK/HTTP 새 연결·Worker 재시작 재조회, 권한 취소·위조 입력·응답 유실을 검사하지만
실제 Codex 앱의 버튼/훅 전달·계정·배포 검증으로 확대하지 않는다.

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
  바뀐 입력은 충돌이다. 서버 자체에 자동 큐는 없다. 명시적으로 연결한 호스트만
  [원격 요청 보관함](remote-recovery.md)에 원문을 먼저 보관하고 제한된 복구를 실행할 수 있다.
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

회귀 검사는 초기화/27개 도구 조회, 일반 작업 시작·변경·종료, 동일 요청 재시도/충돌,
새 Client와 Worker 재시작 후 같은 원문/영수증 재조회, 미인증·잘못된 서명/대상·교차 scope·
viewer 쓰기 차단, 스킬 등록/지정/사용 보고·실제 로컬 파일 관측의 별도 수집과 새 연결 재조회,
별칭/코드 경로 매칭 이유·통합 조회 세 구역 페이지, 키 회수·재발급, Origin/Host/메서드/본문/응답/동시 요청 제한을 포함한다.
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
