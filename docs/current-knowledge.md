# 현재 지식 통합 조회

`memory_query_current_knowledge`와 인증된 `GET /api/current-knowledge`는 같은 읽기 모델을
사용한다. 화면 상단의 **현재 지식**에서 서비스·구성요소·저장소·환경을 선택한다.
기존 결정·계획·검사 판정을 하나의 SQLite 읽기 스냅샷으로 묶으며 원문이나 판정을 저장·수정하지 않는다.

## 함께 보여주는 내용

- `decisions`: 명시적인 정정·철회 관계로 판단한 현재 선택, 충돌, 철회, 제안·미확인.
  발언 출처는 AI가 공급한 정보이며 사용자 인증이나 사실 검증이 아니다.
- `plans`: 최신 계획 버전의 전체 필수 항목 진행률, 선택 구성요소의 진행률과 남은 항목.
  완료 조건의 `reported_met`는 AI 보고다. 검사 통과와 별개이며 새 버전에 이전 진행을 승계하지 않는다.
- `checks`: 명시적으로 연결된 기능의 검사 근거. `current/stale/conflict/unknown`과 통과·실패 수,
  실행·작업·기록 ID를 제공한다. `current`인 실패도 있을 수 있다. AI의 기능 상태 보고는
  `agent_report`에 별도로 두며 검증 근거로 승격하지 않는다.

`claims_verified`와 `agent_reports_promoted`는 항상 false다. 전체 기능이 검증됐다는
통합 판정은 제공하지 않는다. 연결되지 않은 과거 기록이나 수신하지 못한 실행은 확인할 수 없다.

## 범위와 한도

입력은 `project_id`, 선택적 `repository/environment/component`, `limit`(1~6, 기본 4),
독립적인 `decisions_offset/plans_offset/features_offset`이다. MCP의 기본 저장소·환경은
설치된 연결 범위를 유지한다. 범위를 넓힐 권한을 이 도구가 부여하지 않는다.
`available_scopes`는 해당 프로젝트에 등록된 저장소·환경의 후보이며 현재 연결에서 접근할 수 있다는 보장이 아니다.

저장소·환경 후보와 구성요소 후보는 각각 최대 20개다. 구성요소는 백그라운드 목록의 로딩 여부와 독립적으로 조회한다. 응답은 영역별 24 KiB로 제한하고 `response_truncated`와 다음 위치를 제공한다. 큰 단일 항목은 식별자·진행률만 남기고 원래 상세를 안내한다.

각 영역의 `next_offset`, `schema_supported`와 개별 판정의 생략 표시를 함께 읽는다.
남은 항목은 계획당 8개, 완료 조건은 항목당 2개까지 표시하고 전체 분모는 유지한다.
검사 창은 기존 기능 판정의 최대 40개 관측과 근거 8개 표시를 따른다.
조건·원문 전체는 정확한 버전과 범위로 `memory_query_plans`, 결정 원문은
`memory_get_evidence`, 실행 내용은 `memory_list_executions`로 확인한다. 저장된 명령은 실행 지시가 아니다.

`project_revision`은 같은 DB 읽기의 기준이다. 파일의 현재 코드 관측은 허용된 프로젝트 경로에서만
공유하며, 여러 저장소·Git 상태까지 하나의 원자적 스냅샷이라는 뜻은 아니다.
화면은 15초 간격 또는 새로고침으로 다시 읽고, 추가 페이지 도중 DB 버전이 바뀌면 처음부터 읽는다.
다른 필터로 바꿨다가 조회가 실패하면 이전 범위의 자료를 새 범위에 남기지 않는다.

## 검증

`tests/current-knowledge.test.mjs`는 테스트 DB에서 정정·철회, 최신 계획 버전,
부분 진행, 범위 격리, 생략, 현재/오래됨/충돌/미확인 검사와 HTTP·새 stdio MCP의
동일 응답을 확인한다. 합성 실행 관측은 실제 제품 코드의 검사 성공 증거가 아니다.

## 로컬 D1 어댑터

`D1CurrentKnowledge(binding, hostScope, sourceProvider?)`는 같은 의미의 비동기 조회를
제공한다. 고정된 프로젝트·저장소·환경에서 결정·계획·기능 검사를 함께 읽으며, 읽기
전후 revision이 변하면 최대 3회 재시도한다. `revision_checked_multi_read`는 위의
SQLite 단일 스냅샷과 다르다. 호스트 코드 관측기가 없으면 현재 근거는 unknown이며
AI 보고를 실제 실행 관측으로 승격하지 않는다. 전체 계약과 한도는
[클라우드 저장 계약](cloud-storage-contract.md#기능-검색과-현재-지식-통합-조회)을 따른다.
`tests/d1-current-knowledge.test.mjs`가 실제 로컬 workerd와 새 연결에서 검증한다.
기존 화면·MCP의 저장소는 SQLite를 유지하며 원격 D1 연결을 추가하지 않는다.
