# 개인 클라우드 저장 기반

## 현재 범위

개인 클라우드의 첫 구현은 **원자적 저장 계약**이다. `AtomicCommitStore`의
`commit(mutation)`과 `getReceipt(scope, key)`를 SQLite와 D1이 공유하고,
`commitWithReceipt`가 같은 요청의 재시도·해시 충돌·최대 3회 재평가를 담당한다.
기존 로컬 `MemoryService`도 이 재시도 모듈을 사용한다.

| 대상 | 구현 범위 | 실행 연결 |
|---|---|---|
| SQLite | 기존 전체 MemoryStore와 업무 확장, 새 공통 저장 계약 | 기존 로컬 MCP/CLI 유지 |
| D1 | 작업·원문·보고·분류, 결정·계획·검사 근거, 이벤트·중단 지점, 스킬 버전·설치 이력·파일 관측·작업 사용 보고, 별칭·경로 검색과 현재 지식 통합 조회 | 주입된 Workers binding을 받는 모듈만 구현 |
| 클라우드 HTTP·MCP | JWT 검증·프로젝트 권한을 갖춘 제한된 fetch 함수 | 로컬 테스트만, 실제 로그인·배포·원격 MCP·실사용 DB 연결 없음 |

D1 모듈은 전체 `MemoryStore` 구현이 아니다.
역사 자료 가져오기와 이전 권한은 [D1 독립 이전](d1-project-transfer.md)의 별도 008 계약으로 처리한다.
일반 업무 mutation으로 가져오기 권한을 부여하지 않는다.
이 필드와 알 수 없는 최상위 입력을 `unsupported_capability`로 **SQL 제출 전에 거절**한다.
기본 `kind=decision` 원문 보관과 구조화 결정 이력 지원은 서로 다르다.
일반 mutation에 `superseded_by`를 미리 채운 역사 자료는 거절한다. 전용 이전 모듈만 전체 관계를 검증해 가져온다.
빈 목록이나 성공 영수증으로 미지원 기능을 숨기지 않는다.

`migrations/d1/001-atomic-memory.sql`은 별도의 신규 테스트/향후 프로비저닝 DB용이다.
로컬 v15 DB에 적용하거나 완전한 Skilly 백업·가져오기 DB로 사용하지 않는다.
자동 실행·마이그레이션·초기화 경로에는 등록하지 않았다.

## 업무 확장의 의존 순서

| 순서 | 범위 | 먼저 필요한 자료 | 상태 |
|---|---|---|---|
| 1 | 작업 분류·제목·보고, 작업 목록·기록 원문 조회 | 프로젝트·작업·원문·영수증 | 구현 |
| 2 | 결정·정정·철회, 계획 버전·항목·완료 조건·진행 보고 | 작업 ID·기능·구성요소·원문 보고 | 구현 |
| 3 | 검사 실행 관측·통과/실패 상세·코드 버전 | 작업·원문 ID와 출처 | 구현. 004 스키마에서 계획의 검사 근거 연결 지원 |
| 4 | 훅 이벤트·작업 연결·중단 당시 마지막 저장 지점 | 저장된 작업·원문·실행 ID | 구현. 명시적 호스트 수신·연결만 지원 |
| 5 | 스킬 전문·불변 패키지·설치 관측·작업별 사용 버전 | 프로젝트 범위·작업·원문·관측 연결 | 구현. 006 스키마와 비동기 호스트 모듈, 명시적 관측기 주입 |
| 6 | 별칭·경로 검색, 현재 지식 통합 조회 | 위 자료의 범위·버전·연결 계약 | 구현. 007 메타데이터와 revision 확인 방식의 비동기 조회 |
| 7 | D1 독립 이전·쓰기 세대·실패 복귀 | 26개 업무 테이블과 전용 교환 포맷 | 구현. 008 제어 스키마, 빈 D1 대상과 새 복귀 사본 |

개인 인증·원격 HTTP/MCP·전송 큐·사용량 예산은 별도의 운영 경계다.
로컬 D1 업무 모듈의 구현이 원격 운영이나 기존 MCP/화면의 D1 지원을 뜻하지 않는다.

### 첫 묶음: 작업 저장과 비동기 조회

새 D1에 `001-atomic-memory.sql` 다음 **`002-work.sql`**을 명시적으로 적용한다.
002는 sidecar 테이블·조회 색인만 추가한다. 기존 원문·ID·영수증을 고치지 않고,
로컬 v15 마이그레이션 목록이나 자동 초기화에는 등록하지 않는다.

`Mutation.work`와 `reports`는 구성요소·기능, 제목·브랜치, 원문 ID에 붙은 보고를
같은 CAS/원문/영수증 배치에서 저장한다. 보고의 `technical`, `import_source`,
`feature_updates`도 보존한다. 작업 연결 없이 카탈로그만 등록하는 입력은 허용한다.
작업 메타데이터는 해당 mutation의 작업만, 보고는 **동일 작업의 새 원문**만 가리킬 수 있다.
기존 원문에 보고를 덧붙이거나 기존 보고·최초 제목/브랜치를 덮어쓰지 않는다.
구성요소/기능의 같은 key에 다른 정의, 연결되지 않은 기능 상태 보고는 배치 안에서
충돌로 판정하여 전체를 되돌린다. 배치 바깥의 사전 조회로 경합을 판단하지 않는다.

001–006만 적용한 DB는 기능의 별칭·코드 경로 메타데이터 입력을
`unsupported_capability`로 거절한다. 명시적으로 007을 적용한 DB에서만 아래의
추가 저장 계약을 지원하며, 역사 자료 가져오기는 계속 거절한다.
메타데이터가 늘어도 요청 64 KiB/40문장 상한은 유지한다. 작은 분류·보고는 함께 저장할 수
있지만 12개 분류를 한꺼번에 넣는 등 문장 예산을 넘는 조합은 **분할 자동 저장 없이 거절**한다.

`D1TaskReader(binding, {project_id, repository, environment})`는 좁은 비동기 조회다.
동기 `WorkReader`를 구현한다고 가장하거나 미지원 조회를 빈 성공으로 반환하지 않는다.

| 메서드 | 반환 범위 |
|---|---|
| `getTask(runId)` | 작업·작성자 보고·최초 제목/브랜치·구성요소/기능·최신 당시 요약 |
| `getRecord(recordId)` | 원문·보고·소급 여부, 명시적 미검증 상태 |
| `listTasks({query?, component?, feature?, state?, offset?, limit?})` | 고정 범위의 최근 활동순 목록, 다음 offset |

constructor의 범위는 호스트가 결정하며 요청 본문으로 덮어쓰지 않는다. 이 고정은 자료 혼합
방지이며 사용자 인증이 아니다. 상태는 저장된 `active/completed/interrupted`이며 프로세스
생존을 추정하지 않는다. 목록은 `updated_at DESC,id DESC`, 요약은 대체되지 않은
`contemporaneous` 원문의 `observed_at DESC,seq DESC` 순서다. 소급 보고도 원문 조회에서
그대로 읽지만 최신 당시 활동으로 승격하지 않는다. 보고된 검사 성공은 실행 관측이 아니다.

작업·분류·보고 본문은 새 `first-primary` 세션의 **단일 SQL**로 읽는다.
검색 지원 여부와 매칭 이유의 보충 조회는 별도 SQL이며 단일 스냅샷을 보장하지 않는다.
목록은 최대 10개/24 KiB, 상세는 128 KiB다. 분류는 각 12개와 전체 수·잘림 표시를 제공한다.
목록이 너무 크면 일부 항목 또는 최소 ID 투영으로 반환하고 원문은 상세에서 조회한다.
`pagination: live_offset`은 고정 스냅샷이 아니다. 페이지 사이 새 작업/활동으로 순서가
바뀔 수 있으므로 고정된 내보내기·이전 스냅샷으로 사용하지 않는다. 필터 변경 시 offset을
0으로 되돌린다. offset 100000을 넘는 후속 위치는 반환하지 않고 `pagination_truncated`
및 `pagination_reason: offset_limit`로 표시한다. 조회는 과거 미분류를 추정하거나 DB·설정을 수정하지 않는다.

반환의 `claims_verified=false`, `capture=agent_reports_only`,
작업/원문 조회의 `execution_observations=unsupported`는 이 조회가 실행 근거를
포함하지 않는다는 뜻이다. 실행 관측은 별도의 `D1ExecutionReader`에서 읽는다.
최신 요약·저장 성공·작업 종료로 검증 완료를 판정하지 않는다.

### 두 번째 묶음: 결정 이력과 계획

`003-decisions-plans.sql`은 001·002 다음 테스트/신규 D1에만 적용하는 추가 스키마다.
기존 SQLite v15 마이그레이션·설정·MCP·화면에는 등록하지 않는다. 원격 배포나
전체 `MemoryStore` 구현이 아니며 팀 인증·자동 전송은 추가하지 않는다.

**결정**은 기존 `Mutation.decision`과 새 `record(kind=decision)`를 같이 저장한다.
`D1Decisions(binding, scope).query({subject, component_key?, feature_key?, history_offset?})`로
정확한 주제와 명시적 구성요소/기능 범위를 조회한다. 구성요소/기능 생략은 공통 범위이며
다른 범위 전체를 합치는 뜻이 아니다. 주제 이름을 모르는 카탈로그 검색은 이 조회의 범위 밖이다.
원문 전체는 기존 `D1TaskReader.getRecord`에서 읽는다.

- 공통 `assessDecisions/validateDecision` 규칙으로 decide·replace·withdraw·propose를 구분한다.
- 이력과 프로젝트 revision을 한 SQL에서 읽고 그 revision으로 최종 CAS를 수행한다.
  다른 요청의 쓰기가 끼면 전부 거절한다. 원래 `expected_current_ids`나 targets를 자동 교체하지 않는다.
- 활성 작업에 미리 연결한 구성요소·기능만 선언할 수 있다. 다른 주제의 대상과 소급 정정·철회는 거절한다.
- 새 결정과 같은 배치의 추가 원문이 그 결정을 generic supersedes하는 경우도 사전에 거절한다.
  배치 안에서도 최종 원문의 종류·연결·미정정 상태를 확인한다.
- 결정 원문·sidecar의 UPDATE/DELETE는 DB 트리거로 막아 이전 writer의 generic correction도 거절한다.
  정정·철회는 새 이벤트일 뿐 원문을 바꾸거나 이전 조상을 부활시키지 않는다.
- 최대 200건의 완전한 이력만 현재 ID의 기준이다. 200건에서 새 쓰기는 거절하며, 초과 이력은
  unknown·불완전한 active IDs로 표시한다. 메타데이터 합계 100000바이트를 넘는 snapshot은
  명시적 resource_limit이며 현재 상태를 반환하지 않는다. 상세 응답은 최대 128 KiB,
  최근 이력은 20개씩과 다음 위치를 반환한다. 원문 투영은 1200자로 제한한다.
- 현재/충돌/철회는 명시된 선택 관계이며 사실 검증이나 사용자 인증이 아니다.

**계획**은 `D1Plans(binding, scope).save(input)`, `.update(input)`, `.query(options)`를 제공한다.
호스트 scope의 project/repository/environment를 input으로 덮어쓰지 못한다. `save`와 `update`
필드는 기존 계획 계약과 같으며, 작업 ID·요청 키는 필수이고 project/scope는 constructor에서 고정한다.
입력은 런타임 스키마로 검사하고, SHA-256은 Worker의 Web Crypto로 계산한다.

| 처리 | 보존/판정 규칙 |
|---|---|
| save | 선택 원문·source_ref·SHA-256·항목·조건을 불변 버전으로 추가. expected_version과 최신 MAX를 대조 |
| update | 활성 작업의 같은 범위 원문에 연결. 최신 계획 버전·항목·expected_update_id·완료 조건·작업 분류 확인 |
| 완료 보고 | 모든 조건의 충족 보고와 contemporaneous·미정정 원문 필요. 직접 검사 통과나 작업 종료를 대신하지 않음 |
| 새 버전 | 과거 원문/진행 보존, 새 항목은 모두 pending. MD의 체크도 source_checked일 뿐 진행 승계 없음 |
| 후속 원문 정정 | 완료 보고의 연결 원문이 정정되면 needs_review로 파생, 진행률에서 제외하고 남은 항목으로 반환 |
| 재시도 | 정규화한 원래 명령·키의 영수증 재생. 다른 내용은 충돌, 응답 유실은 영수증 확인 또는 persistence_unknown |

계획 확장은 D1 전용 `D1Mutation.plan`이며 기존 공통 Mutation이나 SQLite API를 바꾸지 않는다.
원문 작업/보고와는 별도의 plan command다. revision·버전/진행·영수증은 같은 배치로 확정한다.
계획 snapshot을 읽고 **더 최신 revision으로 갈아끼우지 않으며**, 배치 안에서도 최신 버전·갱신 ID·
활성 작업·정확한 원문 범위·완료 자격·분류 연결을 재확인한다. 이전 버전이나 이력 행은 UPDATE/DELETE하지 않는다.

query는 최신 목록 또는 `{plan_key, version?, remaining_only?}` 상세를 단일 SQL snapshot으로 읽는다.
진행률 분모는 전체 필수 항목이며 remaining_only는 표시 항목만 줄인다. 상세는 원문·진행 조건·
버전 목록·명시 연결 작업 ID를 포함한다. 버전 목록과 연결 작업은 최근 20개 및 잘림 표시,
이전 버전은 번호로 직접 조회한다. 상세 128 KiB, 목록 최대 10개/32 KiB와 live_offset 상한을 적용한다.
큰 상세는 성공으로 잘라 숨기지 않고 resource_limit로 거절한다. 작업 제목은 200자와 잘림 표시를 제공한다.
입력 원문/조건의 개별 상한과 별도로 전체 mutation 64 KiB/40문장 상한을 유지하므로 가장 큰 값들을
한번에 조합한 요청은 저장 전에 거절할 수 있다. source_ref는 출처 문자열이며 파일을 열거나 실행하지 않는다.

003까지만 적용한 DB는 `execution_ids`가 있는 진행 요청을 unsupported_capability로 거절한다.
004 적용 후에는 아래의 근거 연결을 제공한다. 완료는 여전히 completed_reported·claims_verified=false이며
계획 쓰기는 별도 전송 큐에 자동 보관하지 않는다.

### 세 번째 묶음: 실행 관측과 계획 근거 연결

`004-execution-evidence.sql`은 001–003 다음 **선택한 신규/테스트 D1**에 명시적으로 적용한다.
기존 SQLite v15 마이그레이션과 실사용 DB, MCP, 화면은 전환하지 않는다.

`D1Executions(binding, scope, sourceProvider?)`는 내부 호스트용 비동기 저장·조회 모듈이다.
`start({idempotency_key,run_id,record_id?,executable,command_hash,source_observation?})`는
미확정 관측 ID를, `finish({idempotency_key,execution_id,result,details?,source_after?})`는
마감 영수증을 반환한다. `list(run_id,offset?)`로 새 연결에서도 관측을 읽는다.

- 실제 명령 실행은 Node의 `observeCommand`가 담당한다. 기존 SQLite CLI와 동일한 수집 코드를
  재사용하고 저장 sink만 await한다. Node 테스트 이벤트와 지원 Vitest 수집기의 결과를 사용하며
  stdout 문자열이나 AI의 통과 보고를 검사 개수로 바꾸지 않는다.
- D1은 프로세스를 실행하지 않는다. 이 쓰기는 호스트 내부 경계이며 AI MCP 도구나 공개 HTTP
  입력으로 노출하지 않는다. `source=local_runner`는 로컬 출처 표시이고 원격 인증·서명·증명이 아니다.
- 시작은 정확한 범위의 활성 작업과 같은 작업의 선택 원문을 요구한다. 마감은 이미 시작한 관측만
  한 번 허용하며, 작업이 먼저 종료돼도 그 관측의 결과 마감은 가능하다. ID·명령 해시·시작 시각·
  before 소스는 불변이고, 마감 후 덮어쓰기·삭제도 DB 트리거로 막는다.
- 시작/마감의 관측·상세·소스·프로젝트 revision·영수증은 같은 CAS 배치에서 확정한다.
  응답 유실은 **원래 입력/키의 영수증만** 재조회한다. 시작 영수증 재생은 실행 허가나 프로세스
  재개가 아니다. 저장 실패를 해결하려고 명령을 다시 실행하지 않는다. 자동 큐는 없다.
- 계획 진행의 `execution_ids`는 최대 4개의 같은 프로젝트·작업·범위 관측만 연결한다.
  링크는 진행 보고·기대 갱신 ID·완료 조건·영수증과 같은 원자 배치로 저장한다. 미확정·실패 관측도
  그대로 연결해 표시하며, 검사가 보고된 진행률을 자동 변경하지 않는다.
- 계획 상세는 한 업무 SQL snapshot에서 연결 관측·검사 상세·before/after를 함께 읽는다.
  항목별 `evidence`에는 current/stale/conflict/unknown과 집계·실행 ID·결과 요약이 포함된다.
  상세의 공통 `execution_details.items`에서 ID로 중복 제거한 검사 상세·실패 항목·코드 비교를 읽는다.
  이 공통 투영은 32 KiB를 넘으면 omitted_execution_ids·truncated를 명시하고, 전문은 실행 목록에서
  조회한다. 같은 실행을 여러 항목에 연결해도 실패 이름·소스 전체를 항목마다 복제하지 않는다.
  SQL 중간 집계도 항목에는 ID만 넣고 실행은 중복 제거한다. 저장된 검사 상세가 4 KiB를 넘으면
  계획 투영에서는 개수·결과를 유지하고 실패 이름을 생략해 detail_projection_truncated와
  failures_truncated로 표시한다. 실행 목록의 원래 상세는 보존하므로 해당 ID를 다시 조회할 수 있다.
  기존 `assessFeatureKnowledge`·`compareExecutionSource`를 재사용한다. 통과 판정에는 종료 코드뿐 아니라
  온전한 테스트 요약·통과/실패·취소 여부가 필요하다. 모든 응답의 claims_verified는 false다.
- 현재 코드의 관측은 **조회 요청이 아니라 호스트가 주입한 sourceProvider**에서만 받는다.
  D1 모듈은 Git을 실행하거나 저장된 경로를 열지 않는다. 공급자가 없는 Worker/새 연결은 unknown이며
  저장된 after를 현재 코드로 복사하지 않는다. dirty 코드는 수집된 공개 소스 지문으로 비교하고,
  누락·제외·불안정한 지문은 비교 불가로 남긴다. 같음은 코드 호환성일 뿐 제품 정확성은 아니다.
- 실행 목록은 최대 10개/64 KiB와 live_offset 상한을 사용한다. 응답 한도로 생략한 투영은
  projection_truncated 및 다음 위치로 표시한다. 상세 전체는 기존 128 KiB를 유지하며 초과 시
  resource_limit이다. 테스트 상세는 최대 20개 실패 이름/각 200자와 명시적 잘림 표시를 보존한다.
- 명령 인자·출력 전문·환경변수·실제 경로는 저장하지 않는다. 출력 해시는 스트림당 최대 1 MiB이며
  hashed_bytes와 전체 bytes가 다를 수 있다. output_complete는 스트림 마감 여부이지 전체 해시 보장이 아니다.

검증은 합성 DTO로 경계/장애를 주입하는 검사와, **실제 로컬 자식 프로세스 수집 → 로컬 D1 →
계획 연결 → 새 바인딩/workerd 재실행 후 조회**를 구분한다. 원격 D1·계정 인증·네트워크 장애·
Codex 새 MCP의 D1 실행기 연결은 검증 범위가 아니다. 기존 003만 있는 계획은 계속 읽을 수 있고,
실행 스키마가 없으면 근거 상태를 미지원으로 반환한다.

### 네 번째 묶음: 수신 이벤트·작업·중단 저장 지점

`005-task-events.sql`은 001–004 다음 선택한 신규/테스트 D1에만 명시적으로 적용한다.
기존 SQLite v15·로컬 훅·신뢰·연결 설정과 실사용 DB는 바꾸지 않는다.

`D1TaskEvents(binding, {project_id,repository,environment,root_hash,session_hash})`는
호스트가 고정한 프로젝트·저장소·환경·작업 폴더 해시·세션 해시를 사용한다.
요청으로 범위를 덮어쓰지 못하며, 저장된 경로나 가장 최근 이벤트에서 현재 세션을 추측하지 않는다.
실제 파일 경로, 프롬프트, 명령, 입출력, 도구 입력을 받거나 저장하지 않는다.

| API | 입력/의미 |
|---|---|
| receive(input) | idempotency_key·observation_id·event·observed_at·선택 turn_hash/source/tool_group의 정규화된 호스트 이벤트 |
| link(input) | idempotency_key·활성 run_id·현재 호스트 세션의 명시적 observation_id |
| observations(offset?) | 현재 호스트 세션/폴더의 실제 저장된 이벤트와 연결 상태를 최대20개/64KiB로 조회 |
| status(run_id) | 같은 프로젝트/저장소/환경/폴더 작업의 현재 저장 지점·최근 연결 이벤트·마지막 중단 snapshot |

- 허용 이벤트는 기존 수집기의 SessionStart/PostToolUse/PreCompact/Stop/Interrupt/SessionEnd이다.
  이 모듈의 허용 목록은 Codex의 실제 훅 설치·신뢰·자동 실행 검증이 아니다. 출처는
  local_hook_input·authenticity=not_attested·claims_verified=false로 유지한다.
- 이벤트 저장 영수증의 delivery_status=saved와 work_record_saved=false는 **이벤트만 저장**했다는 뜻이다.
  작업 시작/변경/마감 영수증을 대체하지 않는다. 작업 상태나 프로세스 종료도 자동 변경하지 않는다.
- 동일 키/정규 입력은 원래 영수증을 재생한다. 같은 observation_id/동일 원문을 다른 키로 다시
  보내도 기존 이벤트를 소급 연결하거나 snapshot을 새로 만들지 않는다. 다른 원문은 event_conflict다.
- 연결 anchor는 정확한 범위의 기존 SessionStart/PostToolUse/PreCompact여야 한다. 중간의
  PostToolUse·PreCompact·불투명 turn_hash 변경은 허용한다. 같은 세션의 Stop/Interrupt/SessionEnd/
  새 SessionStart 경계는 이전 미연결 anchor를 무효화한다. 다른 세션의 경계는 영향을 주지 않는다.
- 다른 활성 작업의 세션 연결을 빼앗지 않는다. 동일 작업의 기존 연결 재조회는 원래 링크와
  watermark를 보존한다. 새 링크는 확정 배치의 마지막 이벤트 seq+1부터만 연결하며, anchor와
  연결 전에 수신한 이벤트는 소급 연결하지 않는다. 새 세션/fork는 기존 링크를 상속하지 않는다.
- 정규화 이벤트·연결·저장 지점·프로젝트 revision·영수증은 같은 CAS 배치에서 확정한다.
  새 수신 시 링크가 없거나 작업이 이미 닫혔으면 이벤트는 각각 not_linked/run_closed로 보존하고
  연결 snapshot은 만들지 않는다. linked로 저장됐으면 snapshot도 함께 존재해야 한다.
- snapshot은 **서버 수신·저장 처리 시점에 보이던 기록**이다. 원래 생산자 시각 observed_at과
  서버 저장 시각 received_at을 구분하며, 네트워크 도착 전 실제 중지 버튼 시각을 뜻하지 않는다.
  last_saved는 최신 원문 ID/seq와 실제 영수증의 단일 record_id 또는 다중 record_ids 연결을 확인한다.
  시작 영수증만 있는 start, 원문이 보이지만 영수증 확인이 없는 record, unknown을 구분한다.
- 중단 뒤 새 원문이나 지연된 쓰기가 저장되면 현재 last_saved만 변한다. 기존 interruption의
  saved_during_event는 불변이다. 최근20개 밖의 마지막 Interrupt도 별도로 조회한다. 한 status의
  작업·현재 저장 지점·이벤트·중단 snapshot은 같은 업무 SQL snapshot에서 읽는다.
- 이미 커밋된 응답을 잃으면 원래 입력/키로 원래 영수증과 snapshot을 확인한다. 롤백된 요청을
  나중에 처음 저장했다면 그때의 서버 시각/저장 지점이며 실패 당시 snapshot으로 주장하지 않는다.
  자동 재전송 큐·원문 복구·미수신 이벤트 추정은 없다.
- 프로젝트별 이벤트와 링크는 각각10000개 상한이다. 초과 시 보존/큐 성공을 반환하거나 기존
  이력을 지우지 않는다. 조회는 live_offset과 잘림 표시를 사용한다. 빈 목록이어도 completeness=unknown,
  missing_record_count=null, live_execution=unknown이며 미수신 이벤트/작업 요청은 not_observable이다.
- 아직 004까지만 적용한 DB는 unsupported/schema_supported=false로 반환하며 자동 마이그레이션하지 않는다.
  역사 이벤트 가져오기·이전 세대·외부 호스트 인증·원격 D1 전송은 별도 후속 계약이다.

`tests/d1-task-events.test.mjs`는 합성 중단/경계/장애 입력과 실제 로컬 훅 수집기→정규 DTO→
로컬 D1→새 바인딩/workerd 재실행을 구분한다. 테스트의 Interrupt는 실제 사용자 중지 버튼
검증이 아니며, 실사용 훅 설정·MCP·화면의 D1 연결도 변경하거나 검증하지 않는다.

### 다섯 번째 묶음: 스킬·설치 이력·작업별 사용 보고

`006-skills.sql`은 001–005 다음 **선택한 테스트/신규 D1에만 명시적으로 적용**한다.
기존 SQLite v15·스킬 파일·설치 지정·MCP·인증·설정은 바꾸지 않는다.
전체 MemoryStore나 원격 API 구현은 아니다. 실사용 화면/MCP는 계속 SQLite를 사용한다.

`D1Skills(binding, {project_id,repository,environment,root_hash}, observer?)`는
고정된 호스트 범위를 사용한다. 절대 경로·임의 파일 접근·설치 스크립트·네트워크 요청은 받거나 실행하지 않는다.
카탈로그는 프로젝트 단위로 공유하고, 설치 지정·관측은 같은 저장소/환경/폴더 해시로 제한한다.
이 범위 제한은 인증이 아니며 외부 호스트 신원이나 파일 관측의 진위를 증명하지 않는다.

| API | 동작과 경계 |
|---|---|
| register(input) | 기존 registerSkillSchema의 전문·파일·출처·설치 안내·버전을 보존. 입력 project_id도 고정 호스트와 일치해야 함 |
| assign(input) | 키·정확한 버전·codex/cursor·folder와 expected_assignment_id(null은 최초 지정)를 받아 설치 **지정 이력** 추가. 파일 쓰기 없음 |
| inspect(input) | 설치 ID·요청 키만 수신. 호스트가 주입한 관측기가 있을 때에만 등록 manifest를 비교해 해시·크기·상태 저장 |
| checkpoint(input) | 새 원문·읽기 쉬운 report·skill_usage 최대8개를 작업/정확한 버전/선택 observation_id에 같은 배치로 연결 |
| list(query?,offset?) / detail(key,version?,offset?) | 전문 없는 카탈로그 목록 / 선택한 전문·버전·현재 지정 및 그 지정의 마지막 관측 조회 |
| package(key,version) | 기존 skilly-skill v1 공유 형식 반환. 프로젝트·설치 위치·관측·작업 이력 제외, 자동 파일 작성/전송 없음 |
| history(installation_id,assignments/observations,offset?) | 고정 호스트 범위의 불변 지정/관측 이력 조회 |
| taskSkills(run_id,offset?) | AI 보고의 원문 ID·출처·소급/이전 상태와 명시한 파일 관측을 구분해 조회 |

Node 전용 `model.ts`의 기존 공개 export와 해시는 유지하고, 검증·패키지 해시 직렬화만
`core/skills/schema.ts`로 분리한다. Workers는 Node 암호화/파일 API나 설치 모듈을 import하지 않는다.
기존 문자열·개행·UTF-8·파일 정렬과 `{content,path}` 해시 표현을 보존하며 공유 패키지 왕복을 검사한다.

- 같은 프로젝트/키는 출처를 유지하고, 같은 버전의 전문·파일·설치 안내·표시 메타데이터는 불변이다.
  수정은 새 버전이다. 버전을 생략한 상세는 등록 seq가 가장 큰 버전이며 의미상 버전 크기나 설치 버전을 추측하지 않는다.
- 설치 슬롯 ID는 프로젝트/키/저장소/환경/root_hash/도구/폴더로 고정한다. 지정 변경은 원본을
  덮지 않고 새 assignment ID/seq를 추가한다. expected_assignment_id가 최신 지정과 다르면 assignment_conflict다.
  새 지정에는 not_checked를 표시하며 이전 지정의 관측을 새 버전 확인으로 사용하지 않는다.
- 파일 관측은 주입된 `D1SkillObserver`만 수집한다. 이 객체의 root_hash도 호스트와 일치해야 한다.
  테스트는 기존 LocalSkillObserver를 명시적 테스트 루트에 연결해 실제 파일 비교를 수행한다.
  원문은 수집하지 않으며 SKILL.md와 등록 보조 파일을 정확히 한 번씩 모두 포함해야 한다.
  상태/해시/크기 일관성을 서버에서 검사하고, 확인 불가→없음→변경→일치 순으로 합산한다.
- 관측기는 DB 트랜잭션 밖에서 실행된다. 파일 수집 동안 지정이 변경되면 전체 저장을 거절한다.
  같은 호출의 CAS 재시도는 이미 수집한 snapshot을 재사용하며 다른 파일 상태로 자동 재관측하지 않는다.
  이미 저장된 요청 키의 재시도는 **관측기 호출 전에** 기존 영수증을 반환한다. 보관된 영수증 없는
  별도 호출의 관측이 실패 당시 파일 상태를 재구성했다고 주장하지 않는다. 자동 복구 큐는 없다.
- 사용 보고는 자신의 활성 작업과 이번 새 원문에만 연결한다. 서버가 정확한 등록 버전 해시를 고정하고,
  observation_id를 명시했을 때만 같은 프로젝트/루트/저장소/환경/키/관측 버전/해시를 검사한다.
  최신 관측을 자동으로 붙이지 않는다. 파일이 나중에 변경되거나 설치 지정이 바뀌어도 과거 보고는 그대로다.
  원문을 정정하면 원문과 연결은 남고 조회의 report_state가 superseded가 된다. 소급 보고도 출처를 보존한다.
- taskSkills는 같은 프로젝트/저장소/환경 작업의 보고를 읽되, 다른 root의 파일 관측은 숨기고
  file_observation_status=outside_host_root를 반환한다. 보고만 있으면 not_collected이며 무사용의 증거가 아니다.
  원래 root에서는 기존 관측을 계속 읽을 수 있고 어떤 조회도 파일을 다시 읽지 않는다.
- 파일 관측은 `host_files_at_observation_time`, 사용 보고는 `agent_report`다. 일치한 파일도
  AI 로딩·실행·실제 사용의 증명이 아니다. claims_verified=false, loading_status=unknown,
  current_machine_verified=false, authenticity=not_attested를 유지한다.
- 버전/지정/관측/사용 연결에 UPDATE/DELETE 방지 트리거를 둔다. 프로젝트 revision을 **먼저** 읽고
  사전 검증을 거친 뒤 같은 CAS 배치에 변경·새 원문/색인·영수증을 함께 확정한다.
  중복·출처/버전/지정 충돌·닫힌 작업·SQL 경계별 실패·응답 유실도 기존 공통 계약을 따른다.
- 기존 공통 스킬 입력의 100KiB보다 D1은 **전체 mutation 64KiB/40문장** 제한이 더 엄격하다.
  한 번에 넣을 수 없는 패키지/본문은 SQL 전에 resource_limit으로 거절하며 쪼개거나 성공으로 표시하지 않는다.
  프로젝트당 등록 버전10000개 제한으로 기존 이력을 삭제하지 않는다. 전송·설치·파일 감시는 자동 수행하지 않는다.
- 카탈로그/이력은10개, 작업별 보고는8개/64KiB, 상세 설치는6개/128KiB다. 버전 목록은 최근100개와
  versions_truncated를 제공하며 이전 버전은 이름을 지정해 읽는다. live_offset 최대100000과 잘림/다음 위치를 표시한다.
  005까지만 있는 DB는 unsupported를 명시하고 자동 마이그레이션하지 않는다.

`tests/d1-skills.test.mjs`는 실제 로컬 Miniflare/workerd의 Worker import, 패키지 해시 호환,
테스트 파일 관측→D1 저장→작업 보고→지정 변경→workerd 재시작/새 연결 재조회를 검사한다.
이 검사는 원격 D1·실제 AI 로딩·실사용 MCP/화면·자동 설치·외부 전송의 검증이 아니다.

## 공통 저장 규칙

1. 신규 프로젝트는 revision 0, 기존 프로젝트는 기대 revision을 정확히 1 증가시킨다.
2. 프로젝트 identity와 작업·원문의 프로젝트/저장소/환경을 일치시킨다.
   같은 작업 ID가 다른 프로젝트/저장소/환경에 있으면 덮어쓰지 않는다.
3. revision·작업 상태·원문·정정 연결·검색 색인·영수증은 함께 확정하거나 함께 되돌린다.
   `conflict`는 이 요청이 아무것도 확정하지 않았다는 뜻이다.
4. 요청 키는 프로젝트 안에서 사용한다. 기존 로컬 프로젝트 등록의 `registration`
   범위만 예외이며 D1의 프로젝트별 저장 binding에서는 이 전역 범위를 허용하지 않는다.
   클라우드 프로젝트 생성·소유자 부여는 인증된 별도 프로비저닝 흐름이 필요하다.
5. 같은 키·같은 입력 해시는 원래 결과를 반환한다. 같은 키·다른 입력은
   `idempotency_conflict`다. 재시도는 원래 입력/키/관측 시각을 유지한다.
6. 응답 유실은 미저장·저장 대기와 다르다. 영수증을 재조회하여 저장 확인하거나
   `persistence_unknown`을 반환한다. D1의 영수증에는 배치별 고유 시도 ID를 따로 저장한다.
   응답 유실 후 그 ID까지 일치해야 이번 배치의 저장을 확인한다. 입력 해시/결과만 같은
   과거 영수증은 이번 쓰기의 증거가 아니다. 저장 여부 미확인을 큐 성공으로 표시하지 않는다.
7. 원문과 AI 보고는 검증된 사실로 승격하지 않는다. 같은 코드 지문·저장 성공·작업 종료는
   검사의 정확성 증명이 아니다. `claims_verified=false` 등 도메인 판정을 그대로 보존한다.

이 저장 계약 자체에는 전송 큐가 없다. 별도 명시적 호스트의
[원격 요청 보관함](remote-recovery.md)은 원문·키·문맥 고정표를 로컬 SQLite에 먼저 보관한다.
원격 영수증 조회 후 같은 입력을 다시 제출하여 해시까지 일치해야 저장 확인으로 전환한다.
호스트 실행 수집기의 종료 결과와 미수신 이벤트는 이 업무 요청 보관함의 대상이 아니다.

## D1 배치의 CAS 처리

D1 `batch()`는 준비된 문장을 순서대로 실행하며 SQL 실패 시 배치 전체를 되돌린다.
그러나 `UPDATE ... WHERE revision=?`가 **0행**을 바꾸는 것은 SQL 오류가 아니다.
배치가 끝난 뒤 수정 수만 확인하면 이미 후속 원문/영수증이 저장됐을 수 있다.

```text
revision 조건부 생성/수정
  → changes()=1을 CHECK 제약으로 검증
  → 작업 저장 + 동일한 행 수 검증
  → 원문 INSERT + FTS 트리거
  → 정정 대상 수정 + 동일한 행 수 검증
  → 영수증 INSERT
  → 배치 COMMIT
```

고정된 `skilly_atomic_change` CHECK 제약이 0행을 실제 SQL 오류로 만든다.
검사 행은 같은 배치 안에서 제거하며 실패하면 함께 롤백된다. 다음 revision 값만
재검사하는 방식은 다른 요청이 이미 그 값을 만든 경우를 구분하지 못하므로 사용하지 않는다.
마지막 영수증 UNIQUE 경합도 배치 전체를 되돌리고, 저장된 원래 영수증으로 재평가한다.

각 커밋과 영수증 조회는 새 `first-primary` 세션을 사용한다. 오래된 replica에서
영수증이 없다는 결과를 받아 중복 확정하는 일을 피하기 위한 선택이다.
이미 조회한 값을 응답 캐시로 재사용하지 않는다. 원격의 응답/제약 오류를 확정할 수
없으면 같은 키 재조회가 필요한 상태로 남긴다.

공식 계약: [D1 batch와 Sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[실행 결과의 changes](https://developers.cloudflare.com/d1/worker-api/return-object/).

## 인증·오프라인 복구·사용량 제한을 붙일 경계

### 인증과 쓰기 권한

현재 D1 생성자의 프로젝트 ID 제한은 **자료 혼합 방지**이며 인증이 아니다.
별도 [인증·프로젝트 권한 경계](cloud-project-access.md)는 Cloudflare Access app JWT를
주입한 공개키로 검증하고, 명시적 010 권한 스키마의 주체·프로젝트·저장소·환경을 확인한다.
제한된 fetch 함수의 일반 보고와 조회에만 연결하며 실제 로그인·계정·원격 MCP는 연결하지 않는다.
관리형 경로의 최초 소유자 등록·공개키 갱신/회수는 [별도 수명 관리](cloud-owner-keys.md)를 따른다.
이는 호스트 사전 지정과 테스트 D1 기반이며 실제 계정의 최초 연결이나 외부 키 다운로드가 아니다.
요청 본문의 사용자 이름/역할이나 `authenticated` 표식을 권한 근거로 사용하지 않는다.
읽기/영수증 조회에도 같은 검사를 적용하며 D1 관리 키는 클라이언트나 AI에 주지 않는다.
008의 프로젝트 이전 세대·쓰기 봉인은 명시적 호스트 제어 계약이다. 원격 이전 대상으로
공개하기 전에는 이 제어 경로에도 인증·권한 검사를 연결해야 한다. 기존 SQLite의 봉인과 권한 경로는 유지한다.

### 오프라인과 복구

향후 전송 큐는 로컬 정상 저장소 및 현재의 로컬 요청 보관소와 별도 모듈이다.
대상·사용자·프로젝트·요청 키·정규 입력 해시·원래 입력·관측 시각을 함께 보관한다.
디스크에 보관한 영수증이 있어야 `recovery_pending`으로 표시하며, D1 응답이 없다는
사실만으로 보관 완료를 주장하지 않는다. 목적지 변경은 명시적 매핑을 필요로 한다.

- 응답 유실: 원래 목적지의 영수증을 먼저 조회한다.
- 인증 만료/권한 거부/지원하지 않는 기능: 재연결 또는 사용자 조치 전까지 차단한다.
- 버전 충돌: 최신 상태를 읽고 도메인 규칙을 재평가한다. 오래된 자료로 최신 원문을 덮지 않는다.
- 사용량 제한/일시 장애: 서버의 재시도 시각과 제한된 백오프를 따른다.
- 연결 복귀 시 한 주기 최대 3회, 큐 건수·바이트 상한, 기록 중단 요청 후 전송 중지.

이번 구현에는 전송 큐나 자동 네트워크 재시도가 없다. 커밋 호출 자체가 실패하면
`commitWithReceipt`는 무한 반복하지 않고 오류를 전달한다.

### 사용량

D1 어댑터의 현재 보수적 상한은 **요청 64 KiB, 영수증 16 KiB, 원문 8개, 문장 40개**다.
문자 수 대신 UTF-8 바이트를 센다. 초과하면 배치 호출 전에 거절한다.
이것은 공급자 계정의 무료 한도나 요금을 보장하지 않는다.

인증된 원격 MCP는 호스트가 `usage_protection: true`를 명시했을 때
DB 전체·사용자별 원자적 예산 예약/정산을 사용한다. 기존 연결을 자동 변경하거나
실사용 DB에 스키마·정책을 설치하지 않는다. 설정하지 않은 기존 MCP, 관리용 HTTP,
직접 D1 접근은 이 제한의 범위 밖이다. 자세한 계약과 한계는
[사용량 예산](cloud-usage.md)을 따른다.

관측한 D1 `rows_read`/`rows_written`과 예약 잔액을 구분한다. 요청 단위 제한만으로
동시 요청의 합계 비용을 막을 수 없으므로 예약은 공유 DB의 같은 트랜잭션으로 처리한다.
제한 초과 시 자동 유료 전환이나 다른 정본으로의 자동 쓰기 전환은 하지 않는다.
한도는 배포 시 공식 [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)와
계정 정책을 다시 확인한다.

## 기능 검색과 현재 지식 통합 조회

`007-feature-discovery.sql`은 001–006 다음 **테스트/신규 D1에 명시적으로 적용**한다.
기존 SQLite v15·실사용 DB·자동 마이그레이션·설정에는 적용하지 않는다.
`Mutation.work.features`의 `aliases`·`code_paths`는 해당 입력의 활성 `run_id`가 필요하고,
그 작업의 실제 저장소·환경과 출처 작업 ID를 함께 보존한다. 같은 CAS/원문/보고/영수증
배치에서 저장하며 중복은 기존 최초 선언을 유지한다. UPDATE/DELETE로 덮어쓰지 않는다.
항목은 요청당 각각 8개, 기능·저장소·환경별 누적 각각 64개다. 누적 초과는
`resource_limit`이며 자동 삭제·분할·재분류하지 않는다. 배치의 한도 검사도 유지한다.

별칭은 NFKC와 소문자 정규화, 코드 경로는 상대 경로·구분자 정리와 유니코드 소문자
검색 키를 사용한다. 절대 경로·상위 디렉터리·비공개 파일 경로는 기존 공통 검증으로
거절한다. 코드 경로는 디렉터리 경계로 비교하고 파일명 일부만으로 추정하지 않는다.
007이 없어도 이름·ID·설명 검색은 가능하며 `discovery_schema_supported=false`로 구분한다.

- `D1FeatureReader(binding, hostScope, sourceProvider?).list({query?, component?, feature?, offset?, limit?})`
  는 명시적으로 연결된 범위의 기능 후보·별칭·경로와 `match_reasons`를 반환한다.
  이름/ID/설명/별칭/경로 중 어떤 값이 맞았는지, 등록된 별칭·경로의 출처 작업·범위를 제공한다.
  같은 별칭의 후보를 모두 유지한다. 등록된 경로를 실제 파일로 열지 않는다.
- `D1TaskReader.listTasks({query, ...})`는 작업 제목/목표와 명시적으로 연결된 기능을 검색한다.
  원본 텍스트 매치는 `task_text_match`, 기능 이유는 `match_reasons`로 구분한다.
  잘린 목록 텍스트로 매칭을 재추정하지 않는다. 과거 미분류 작업에 기능을 자동 연결하지 않는다.
- `D1CurrentKnowledge(binding, hostScope, sourceProvider?).query({component?, limit?, decisions_offset?, plans_offset?, features_offset?})`
  는 `decisions/plans/checks`를 묶는다. 프로젝트·저장소·환경은 호스트 고정 범위이고 요청으로
  덮어쓸 수 없다. 결정의 정정/철회·충돌과 활성 원문 ID, 최신 계획 버전의 전체/선택 구성요소
  진행률, 남은 항목·조건, 완료 항목까지 포함한 검사 근거를 따로 제공한다.

통합 조회는 `first-primary` 읽기 전후의 단조 증가 프로젝트 revision을 비교하고, 변하면
최대 3회 다시 읽는다. 계속 변하면 `conflict`로 끝나며 불완전한 성공을 반환하지 않는다.
`snapshot=revision_checked_multi_read`이며 SQLite의 단일 읽기 스냅샷과 다르다.
모든 공식 쓰기가 프로젝트 revision을 올린다는 계약이 전제다. 별칭·기능 단독 조회는
여러 읽기이므로 통합 조회의 revision 검사를 보장하지 않는다. 현재 코드 관측은 호스트가
명시적으로 주입하며 같은 호출의 재시도까지 루트별 한 번 공유한다. DB와 파일 상태가
동시에 고정된다는 의미는 아니다. 관측기가 없으면 현재 코드 비교는 `unknown`이다.

각 영역은 기본 4개/최대 6개·24 KiB이며 독립 다음 offset과 잘림 표시를 제공한다.
남은 항목과 항목별 근거는 각각 8개, 조건은 항목당 2개다. 전체 진행률의 분모는 유지한다.
큰 단일 항목은 식별자·진행률만 남기고 상세 조회가 필요함을 표시하여 다음 페이지 진행을 유지한다.
검사 판정은 최신 최대 40개 실행을 평가하고 근거 8개를 표시하며 생략을 명시한다.

`agent_report`, AI 조건 충족 보고, 직접 실행 관측과 코드 비교 판정은 서로 독립적이다.
`current`는 현재 코드와 연결 가능한 검사라는 뜻으로 실패 검사도 포함한다.
`claims_verified=false`, `agent_reports_promoted=false`를 유지한다. AI의 완료 보고,
계획 100%, 저장 영수증으로 검증 완료를 만들지 않는다. 수신되지 않거나 연결되지 않은
과거 작업·실행의 누락은 판단하지 못한다. 조회는 DB·파일·설정을 변경하지 않는다.
기존 로컬 화면·MCP는 SQLite이며, 이 D1 모듈은 원격 API·인증·MCP 배포가 아니다.

## 검증 범위

`tests/storage-contract.test.mjs`는 기존 SQLite 어댑터와 **SQLite 기반 D1 API 모양의
로컬 harness**에 같은 저장 계약 검사를 적용한다. 실제 SQL을 실행하여 CAS 0행,
영수증 경합, 정정 경합, 프로젝트 격리, 오류 위치별 롤백, 응답 유실을 검증한다.
고정 응답을 반환하는 모의 저장소가 아니다.

이 harness의 배치 트랜잭션은 Node SQLite로 직접 구현했다. 실제 D1 런타임의
호환성 근거는 별도의 `tests/d1-runtime.test.mjs`, `tests/d1-work.test.mjs`,
`tests/d1-decisions-plans.test.mjs`, `tests/d1-executions.test.mjs`,
`tests/d1-task-events.test.mjs`, `tests/d1-skills.test.mjs`,
`tests/d1-current-knowledge.test.mjs`, `tests/d1-transfer.test.mjs`에서 구분한다.

### 실제 로컬 D1 런타임

개발 의존성을 **Miniflare 4.20260730.0 / workerd 1.20260730.1**로 고정하고,
compatibility date `2026-07-30`에서 실제 로컬 D1 바인딩을 실행한다.
설치된 workerd 바이너리 버전도 검사한다. 로컬 모듈에 배포 설정이나 계정 연결을 추가하지 않는다.

```sh
npm ci --ignore-scripts
npm run test:d1
```

Miniflare는 테스트에만 로딩한다. 평소 MCP·로컬 화면의 상주 의존성은 아니다.
workerd 네이티브 바이너리와 loopback/프로세스 실행 권한이 필요하며, 실행할 수 없는 환경을
자동으로 건너뛰어 성공으로 처리하지 않는다. 자료는 새 임시 폴더의 테스트용 D1에만 저장한다.
Worker의 외부 fetch는 차단하고 원격 D1·Cloudflare 자격증명·기존 DB를 연결하지 않는다.
테스트 모듈 목록은 기존 설치된 Zod의 ESM 그래프를 명시적으로 제공한다. Miniflare를
패키지 번들러로 가정하지 않으며 제품 파일을 바꾸거나 검사 중 패키지를 다운로드하지 않는다.

| 검사 경로 | 확인하는 범위 |
|---|---|
| 실제 Worker 내부 | 제품 dist ESM을 import하고 `env.DB`로 시작·변경·종료·영수증 조회 실행. CAS와 영수증 UNIQUE 충돌의 오류 분류도 실행 |
| Node → Miniflare D1 바인딩 → workerd | 중복·동시 요청·정정 경합·프로젝트/작업 범위·실제 SQL 오류 위치별 배치 롤백 |
| 실제 SQL 위 장애 주입 | 배치 확정 뒤 응답만 버린 경우의 token 확인, 영수증 조회까지 차단한 경우의 `persistence_unknown`, 잘못된 응답 이후 재조회 |
| 런타임 재실행 | dispose 후 같은 테스트 저장 경로를 새 workerd 프로세스에서 열어 원문·ID·영수증 재조회 |

체크인된 D1 스키마의 STRICT·외래키·named CHECK·FTS5·트리거를 실제 바인딩으로 생성한다.
실패 전후 프로젝트·작업·원문·영수증·작성자와 **FTS MATCH 결과**를 대조한다.
미지원 입력과 바이트 초과는 저장 호출 카운터가 증가하지 않는지 확인한다.

스키마 적용은 이 고정 스키마의 CREATE 문장 사이만 나눠 준비된 문장으로 실행하며
트리거 내부 세미콜론은 보존한다. 사용자 SQL을 받는 범용 마이그레이션 파서가 아니다.
D1 `exec()`에 여러 줄 DDL을 그대로 넣는 것과 이 검사를 혼동하지 않는다.

이는 **실제 로컬 D1 런타임 검증**이며 Cloudflare 원격 운영 검증은 아니다.
원격 replica 라우팅·복제 지연·실제 네트워크 장애·인증/프로젝트 권한·계정별 요금/한도는
확인하지 않았다. 응답 유실은 실제 네트워크를 끊은 결과가 아니라 실제 저장 후 주입한 장애다.
기존 MCP·화면·설정·실사용 DB는 계속 로컬 SQLite를 사용한다.

검색·통합 조회 검사는 로컬 Worker와 새 workerd 연결에서 별칭/경로·범위 격리·매칭 이유,
메타데이터 배치의 오류 위치별 롤백·CAS 경합·누적 한도, 결정 정정/철회·최신 계획과 남은
항목·revision 변경 재시도를 확인한다. 합성 코드 관측/충돌 자료와 실제 자식 Node 검사
프로세스를 구분한다. 자식 실행을 관측기로 D1에 저장하여 새 연결에서 근거 ID와 계획
상태를 읽지만, 테스트 자료의 성공은 실사용 제품 작업의 검증 완료를 뜻하지 않는다.

D1 독립 이전의 빈 대상·행/바이트 한도·쓰기 세대·단계별 복귀 및 실제 로컬 시험 경계는
[D1 독립 이전](d1-project-transfer.md)을 따른다. SQLite 왕복 변환은 [로컬 연결 모듈](sqlite-d1-project-transfer.md)을 사용한다. 원격 인증·전송은 별도 후속이다.
