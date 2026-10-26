# 로컬 첫 구현

Codex 프로젝트 식별·스킬 설치·실제 연결 점검은 [Codex 연동 안내](codex-integration.md)를 참고한다.
기록·서비스 현황·복구와 확장 도구를 제공하며, 실제 목록은 해당 연결의 `tools/list`로 확인한다. 프로젝트 연결 모드는
등록·목록 대신 `memory_resolve_project`를 제공하며, SQLite 스키마는 동일하다.

이 문서는 로컬 MVP 0.1.0의 실행 가능한 범위와 후속 범위를 구분한다.
기록 연결은 한 로컬 사용자에게 노출하는 STDIO MCP다. 별도로 실행하는 로컬
조회 화면은 loopback HTTP만 사용하며 팀 서버·팀 권한 시스템은 없다.

## 구현한 흐름

```text
Codex·Cursor 등의 작업 AI
  → use-skilly 안내에 따라 MCP 도구 호출
  → 공통 입력 검증·요청량 제한
  → MemoryService의 기록·이력·범위 규칙
  → SQLite의 조건부 트랜잭션 + 영수증 + FTS 색인
  → JSON 결과를 작업 AI에 반환
```

CLI도 같은 도구 계약을 사용한다. 프로젝트를 등록하고 작업을 시작한 뒤 기록·정정·마감·검색할 수 있다. 프로세스를 다시 열어도 기록은 유지된다. 같은 DB를 여러 MCP 프로세스에서 사용할 수 있지만 각 프로세스의 메모리는 별도로 든다.

로컬 화면은 `ui/` → `transport/viewer`의 조회 API → `SqliteViewer` 읽기 모델로
연결된다. 조회 경로는 쓰기용 `MemoryService`를 생성하지 않으며 DB 생성·마이그레이션·복구
재전송을 하지 않는다. 별도 프레임워크 없이 Node HTTP와 브라우저 기본 기능을 쓴다.
Host·Origin·일회성 실행 토큰으로 접근을 제한하고 조회 DB는 읽기 전용으로 연다.
사용자가 명시적으로 누르는 완료 확인은 별도 쓰기 경로로 처리하며 원래 작업과 기록을 수정하지 않는다.
화면은 서버 조회로 확인된 실행 토큰만 출처별 브라우저 저장소에 최대 7일 보관해
페이지·브라우저 재실행 후 복원한다. 쿠키나 서버의 인증 예외는 추가하지 않으며,
  401 응답에서 실제 사용한 저장 연결만 무효화한다. 관리 명령의 `restart`·`restart-code`는
주소·인증을 유지하며, 종료 후 새로 시작하거나 출처가 바뀌면 전체 연결 주소로 다시 연결한다.
본문은 HTML로 해석하지 않는다. 실행과 상태 의미는 [사용 안내](user-guide.md#로컬-화면으로-보기)를 따른다.

도구 입력에는 프로젝트 ID를 명시적으로 전달한다. Codex 연결 모드는 `skilly.project.json`을 읽어 ID를 반환한다. 임의 폴더·worktree 추론은 후속 기능이다. 명시적 [기능 별칭·코드 경로 검색](feature-discovery.md)을 지원한다. `topic`은 프로젝트 안의 일관된 기능 이름으로 사용한다. 검색은 프로젝트·저장소·환경·선택한 주제 범위를 고정하고 FTS 토큰 접두 검색과 범위 안의 부분 문자열 검색을 함께 사용한다. 짧은 한글도 찾을 수 있지만 부분 검색은 해당 범위의 행을 읽을 수 있으므로 매우 큰 프로젝트에서는 추가 최적화가 필요하다.

`memory_query_context.current_knowledge`는 호환성을 위해 빈 배열로 남긴다. 결정·계획·검사 근거의 통합 조회는 `memory_query_current_knowledge`를 사용한다([현재 지식 안내](current-knowledge.md)). 기본 기록 조회는 명시적으로 대체된 기록과 요청한 소스 지문이 다른 기록을 제외하지만, 나머지 기록을 검증된 현재 사실로 승격하지 않는다. 같은 주제의 기록이 여럿이라는 이유로 자동 병합·대체하지 않는다.

## 실행

지원 대상은 Node.js 24 이상이며 이 작업에서 검증한 런타임은 **25.2.1**이다. `node:sqlite`의 실험 기능 경고가 stderr에 나올 수 있다. 최소 Node 24 버전의 별도 실행 검증은 아직 하지 않았다.

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run demo
```

`demo`는 합성 자료와 임시 DB만 사용한다. 데모가 끝나면 자신이 만든 임시 폴더를 제거한다.

```sh
node dist/runtime/local/main.js --help
node dist/runtime/local/main.js serve --db /absolute/path/memory.sqlite
```

`serve`는 클라이언트가 생성하는 STDIO 프로세스다. stdout은 MCP 메시지 전용이므로 터미널에서 시작하면 일반적인 안내 화면 없이 입력을 기다린다. 기본 DB는 `~/.skilly/memory.sqlite`다. SQLite 파일을 여러 컴퓨터의 네트워크 공유 폴더에 두지 않는다.

MCP를 등록할 때 사용할 **서버 항목** 예시는 다음과 같다. 상위 설정 형식과 등록 위치는 클라이언트마다 다르다. Codex용 프로젝트 설정 생성과 실제 확인 결과는 [연동 안내](codex-integration.md)에 별도로 기록한다.

```json
{
  "command": "node",
  "args": [
    "/absolute/path/Skilly/dist/runtime/local/main.js",
    "serve",
    "--db",
    "/absolute/path/skilly-data/memory.sqlite"
  ]
}
```

스킬 배포 원본은 [use-skilly](../integrations/skills/use-skilly/SKILL.md)다. `npm run setup:codex`가 프로젝트의 Codex 탐색 경로에 설치한다. 스킬 파일이 있다고 모든 요청의 자동 호출이 보장되지는 않는다.

CLI로 호출할 때는 `call <도구 이름>`에 JSON 하나를 stdin으로 전달한다.

```sh
node dist/runtime/local/main.js call memory_register_project --db /absolute/path/memory.sqlite <<'JSON'
{"key":"example","name":"예제 프로젝트","idempotency_key":"setup:example"}
JSON
```

이후 입력의 `project_id`·`run_id`·`record_id`에는 실제 반환된 UUID를 사용한다. 비밀 파일이나 전체 개발 로그를 JSON 입력으로 전달하지 않는다.

## 실제 도구 계약

| 도구 | 주요 입력 | 결과 |
|---|---|---|
| `memory_register_project` | `key`, `name`, `idempotency_key` | 프로젝트 UUID. 같은 키·이름으로 다시 등록할 수 있음 |
| `memory_list_projects` | 선택적 `cursor`, `limit` | 프로젝트 목록과 다음 커서 |
| `memory_begin_task` | `project_id`, `goal`, `mode`, `idempotency_key`, 선택적 `environment`, `repository`, `actor` | 활성 작업 UUID. 컨텍스트는 다음 조회에서 받음 |
| `memory_checkpoint` | `project_id`, `run_id`, `topic`, `kind`, `body`, `idempotency_key` | 미확인 기록 ID와 저장 상태 |
| `memory_finish_task` | `project_id`, `run_id`, `summary`, `outcome`, `idempotency_key` | 마감 상태와 미확인 요약 기록 |
| `memory_query_context` | `project_id`, 선택적 `query`, `topic`, `environment`, `repository`, `source_fingerprint`, `history`, `limit`, `cursor` | 짧은 발췌·출처·상태·다음 커서 |
| `memory_query_overview` | `project_id`, 선택적 `view`, `coverage`, `component`, `feature`, `repository`, `environment`, `offset`, `limit` | 구성요소·기능·작업과 공통 요약. 서비스 범위는 명시적으로 선택, 미검증 보고 |
| `memory_get_evidence` | `project_id`, `record_id` | 원문과 이력 연결. 이름과 무관하게 현재 반환 자료는 `verified: false` |
| `memory_get_status` | `project_id`, `run_id` | 작업 상태와 수집 제한 |

- `mode`: `answer`, `diagnose`, `review`, `change`.
- `kind`: `note`, `decision`, `change`, `issue`, `summary`.
- `outcome`: `completed`, `interrupted`. 완료는 작업 마감이며 내용의 진실성 판정이 아니다.
- `environment` 기본값은 `development`, `repository` 기본값은 `default`다. 서로 다른 저장소·운영 환경은 명시적으로 구분한다.
- `actor`는 선택적 1–80자 작성 주체 선언이다. 인증 정보가 아니며 생략한 과거 입력에
  기본값을 삽입하지 않는다. 작성 주체는 시작 때 확정하고 재시도·진행·종료에서 덮어쓰지 않는다.
  v3 마이그레이션은 `run_actors`를 별도 테이블로 추가해 기존 작업 행과 영수증을 유지한다.
- `memory_checkpoint`는 선택적으로 `source_fingerprint`, ISO 8601 `observed_at`, `supersedes`를 받는다. 관측 시각은 UTC로 정규화하며 미래 시각은 거부한다.
- `memory_checkpoint`와 `memory_finish_task`는 선택적으로 `report_origin`을 받는다.
  생략 시 `unspecified`, 작업 중 작성 선언은 `contemporaneous`, 소급은 `retrospective`다.
  저장 여부와 내용의 검증 상태는 별개다.
- `memory_recovery_status`는 프로젝트·저장소·환경, 선택적 요청 ID·limit·offset으로
  미완료 작업과 복구 보관 요청을 조회한다. `memory_retry_write`는 같은 범위와 요청 ID로
  한 건을 그대로 재시도한다. [복구 계약과 한계](recovery.md)를 참고한다.
- 정정은 같은 프로젝트·주제·종류·저장소·환경의 아직 대체되지 않은 기록만 대상으로 한다. 더 오래된 관측으로 더 새로운 기록을 대체하지 않는다.
- 쓰기 재전송은 같은 키와 같은 입력을 사용한다. 다른 내용으로 같은 키를 쓰면 `idempotency_conflict`다. 프로젝트 등록 키는 DB 전체 범위이므로 `setup:<project-key>`처럼 프로젝트마다 구분한다.
- 조회 커서는 필터와 프로젝트 개정 번호에 묶인다. 페이지 사이 기록이 바뀌면 `invalid_cursor`로 알리므로 다시 조회한다.

예제 요청은 전체 시나리오가 실행되는 [demo.mjs](../scripts/demo.mjs)를 참고한다. 스키마의 실제 기준은 [tools.ts](../src/transport/tools.ts)다.

## 저장과 자원 제한

- 실제 DB 파일은 최초 생성 시 소유자만 읽고 쓸 수 있도록 만든다. 기존 파일의 권한은 임의로 바꾸지 않는다.
- 프로젝트·작업·기록·대체 연결·수신 영수증·FTS 갱신을 원자적으로 확정한다. 프로젝트 개정 번호가 달라지면 최대 3회 재평가하고 충돌을 반환한다.
- 내용은 삭제·수정하지 않고 새 기록과 `supersedes`/`superseded_by` 관계로 정정한다. `observed_at`과 `recorded_at`을 분리한다.
- 일반 도구 입력은 128 KiB, MCP 수신 버퍼는 160 KiB다. 본문은 최대 16,000 UTF-16 코드 단위다.
- 컨텍스트 결과는 최대 32 KiB, 기본 10건·최대 50건이다. 본문은 최대 400 Unicode 코드 포인트의 발췌이며 원문 조회로 보완한다.
- MCP는 응답 전송이 끝날 때까지 최대 32개 요청·합계 1 MiB를 추적한다. 초과 입력·출력 적체에는 연결을 닫아 버퍼가 계속 커지지 않도록 한다. 연결이 닫혀 응답을 못 받은 쓰기는 재연결 후 같은 키로 재확인한다.
- SQLite 잠금 대기는 최대 1초다. 잠금을 얻지 못하면 `busy`이며 저장 완료가 아니다.
  새 런타임은 검증된 작업 요청을 별도 로컬 저널에 먼저 보관한다. 실패 응답의
  `recovery.pending_retained`가 true인 경우에만 원래 요청의 보관이 확인된다.
  대기는 100건/1 MiB로 제한되며 자동 재시도 루프는 없다.
- MCP에는 폴더 감시, 주기적 조회, AI 호출, 별도 유지보수 워커가 없다. 연결 종료 시 진행 중 저장을 정리하고 프로세스를 종료한다.
- 별도로 실행한 조회 화면만 보이는 탭에서 15초마다 조회한다. 조회는 페이지당 40건,
  DB 잠금 대기 250ms, 연결당 캐시 2 MiB로 제한하며 숨겨진 탭과 과거 페이지를 읽을 때는
  자동 갱신을 멈춘다. 작업 상세는 `seq` 커서를 사용해 새 기록이 생겨도 중복 페이지를 피한다.

프로젝트 ID 필터는 자료 혼합 방지용이다. 연결을 가진 로컬 사용자는 DB의 모든 프로젝트를 열 수 있다. 따라서 이 STDIO 서버를 그대로 팀용 네트워크 서비스로 노출하는 방식은 지원하지 않는다.

## 검증

```sh
npm run typecheck
npm test
npm run demo
npm run bench
```

테스트는 임시 DB에서 작업 사이클, 프로젝트·환경·저장소 격리, 중복/변경된 입력, 두 연결의 경합, 정정 이력, 검증 상태의 오인 방지, 짧은 한글 검색, 페이지·크기 제한, 트랜잭션 실패, 실제 MCP 호출과 종료를 확인한다.

`bench`는 20개 프로젝트·10,000개 약 2 KiB 합성 기록을 만든 뒤 실제 MCP 연결로 조회·저장 각각 100회를 측정한다. 마지막에 60초 동안 대기 CPU와 RSS를 관찰한다. `ps`를 사용하는 macOS/Linux용 측정이며 실제 데이터·서버에 접근하지 않는다. 결과는 장비·런타임과 함께 출력한다. 장시간 누수, 여러 클라이언트의 합산 RSS, 실제 다른 프로젝트의 빌드/테스트 지연 측정은 별도다.

### 2026-10-20 실행 결과

| 검증 | 결과 |
|---|---|
| `npm run typecheck` | 통과 |
| `npm test` 및 마지막 변경 후 `node --test tests/*.test.mjs` | 17개 모두 통과 |
| `npm run demo` | 임시 DB의 정정·마감·재연결·검색 성공 |
| 스킬 `quick_validate.py` | 통과 |
| 독립 읽기 전용 검토 | 출력 적체·멱등 경합 문제 수정 후 추가 지적 없음 |
| 문서 검사 | Markdown 7개, 로컬 링크·앵커 34개, JSON 예제 6개 통과 |

`npm run bench` 측정 환경은 Apple M2, macOS/Darwin 27.0.0 arm64, Node.js 25.2.1이다. 합성 본문은 기록당 2,042바이트이며, 기록 10,000개를 만든 다음 단일 MCP 프로세스에 100회씩 요청했다.

| 항목 | 이번 측정값 |
|---|---|
| MCP 조회 p95 | 11.86 ms |
| 본문 8 KiB 저장 p95 | 6.69 ms |
| 작업 후 60초 대기 RSS | 37.31 MiB |
| 60.04초 대기의 CPU 증가 | `ps` 시간 측정 해상도에서 0, 한 코어 기준 측정치 0% |
| SQLite 주파일 크기 | 50,040,832바이트, 약 47.72 MiB. 이력·영수증·색인 포함, WAL·SHM 제외 |

이는 한 장비의 초기 확인값이며 CPU를 전혀 사용하지 않거나 다른 환경에서 같은 성능을 보장한다는 뜻은 아니다. DB는 검색·이력·영수증을 함께 보관하므로 원문 텍스트의 총량보다 커졌다. 측정 과정에서 제한된 실행 환경의 `ps` 호출이 차단되어, 같은 합성 자료 벤치마크를 해당 자식 프로세스의 정보 조회가 허용된 환경에서 다시 실행했다.

서비스 현황 v4는 구성요소·기능·작업 연결과 구조화 보고를 원문과 함께 저장한다.
`memory_query_overview`의 기본 카탈로그·작업·최근 보고는 저장소/환경 범위를 따른다.
`coverage: service`는 같은 프로젝트 내 저장소를 함께 읽지만 원문·쓰기 권한을
넓히지 않는다. 다른 저장소의 보고 ID는 해당 저장소 연결로 원문을 읽는다.
목록 연결은 종류별 12개와 총수/잘림 표시를 제공하고 상세 분류 검색은 전체 연결을
사용한다. 극단적으로 긴 JSON 입력도 작은 목록 표현으로 줄여 페이지가 진행된다.

## 로컬 백업·프로젝트 교환

CLI `backup`, `restore`, `export`, `import`는 원본을 읽기 전용으로 열고 새 폴더에만 결과를 만든다.
`import --db`도 기존 DB의 새 사본에 합친다. 복구 저널을 함께 보존하고 자동 재시도·정본 전환은 하지 않는다.
지원 버전·상한·실패 완료 표시·명령은 [로컬 백업·이동 안내](local-transfer.md)를 따른다.

## 스킬 라이브러리

프로젝트별 전문·버전·설치 안내·지정 버전과 명시적 파일 관측을 제공한다.
원문은 실행하지 않으며 파일 일치와 AI 로딩/실행 여부를 구분한다.
MCP·CLI 계약과 화면 사용법은 [스킬 라이브러리](skill-library.md)를 따른다.

## 기능별 현재 근거

기능 조회와 화면은 [현재 근거 판정](feature-knowledge.md)의 current/stale/conflict/unknown을 표시한다.
이는 직접 수집한 검사의 Git 버전 적합성으로, AI 보고나 기능 전체를 검증 완료로 승격하지 않는다.

## 후속 범위

선택적 실행 훅·명시적 실행기 관측·코드 버전 비교·현재 지식 조회는 구현되어 있다.
각 기능의 관측 범위를 벗어난 명령이나 서버에 도착하지 않은 작업까지 수집하지 않으며,
AI 보고만으로 현재 검증 상태를 만들지 않는다. 설치·폴더 이동 후보의 생성도 실제
호스트의 신뢰·연결·자동 실행 확인과 다르다.

로컬 백업·프로젝트 사본 교환과 별도의 [명시적 쓰기 전환·복귀](project-write-transfer.md)를
지원한다. 로컬 설치·실행 환경 검증을 클라우드 실운영·팀 공유·선택적 음성 연동의
완료로 확대하지 않는다. 연동 스킬 지침과 스킬 라이브러리 제품 기능도 구분한다.

## 최초 로컬 MVP 작업의 계약

아래는 Codex 연동 이전 첫 구현의 계약이다. 후속 연동 변경은 [별도 계약](codex-integration.md#이번-변경의-계약)을 따른다.

```yaml
mode: change
risk: medium
goal: 로컬 SQLite에 여러 프로젝트의 작업 기록을 저장하고 CLI·MCP로 재조회하는 첫 실행 흐름 구현
non_goals: [클라우드 배포, 팀 인증, 실제 클라이언트 설정 변경, 자동 실행 관측 훅, 스킬 설치, 커밋, push]
affected_repositories: [Skilly]
constraints:
  - 기존 미커밋 설계 문서와 사용자 작업 보존
  - Skilly 자체 AI 호출·모델·폴더 감시·상주 데몬 없음
  - 실제 사용자 자료·자격증명을 읽지 않고 임시 합성 자료로 검증
  - AI가 제출한 설명은 독립된 검증 증거가 아님
acceptance_criteria:
  - 프로젝트 등록·작업 시작·기록·마감·재조회가 프로세스 재시작 후에도 동작
  - 프로젝트 범위 격리·멱등성·수정 이력·동시 변경 충돌 검증
  - 한글 기본 검색과 조회 결과 크기·입력 크기 제한
  - 실제 MCP 클라이언트로 도구 탐색·호출·오류·종료 검증
  - use-skilly 배포 스킬과 재현 가능한 로컬 사용법 제공
verification: [TypeScript 타입 검사, 빌드, 임시 SQLite 계약 테스트, MCP 통합 테스트, 독립 읽기 전용 검토]
required_user_decisions: []
```

첫 버전의 모든 기록은 `agent_report`이며, 현재 지식으로 자동 승격하지 않는다. 실제 도구 결과 수집·인증된 근거 연결은 후속 구현이다. 따라서 “최신 활성 기록”과 “현재 검증된 사실”은 다르며, `current_knowledge`는 비어 있고 상태는 `unknown`, `stale`, `superseded` 중 하나다.

추가하는 런타임 의존성은 MCP 프로토콜을 처리하는 공식 TypeScript SDK와 입력 검증용 Zod다. DB는 Node의 내장 `node:sqlite`를 사용해 별도 DB 서버·네이티브 설치 스크립트를 줄인다. 내장 SQLite의 API 안정성은 Node 버전에 영향을 받으므로 지원 런타임과 검증 런타임을 구분한다. Hono와 클라우드용 의존성은 해당 경로를 구현할 때 도입한다.

참고: [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x), [STDIO와 도구 등록](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md), [Node SQLite](https://nodejs.org/api/sqlite.html).

## 간단히 보기와 완료 확인

간단히 보기는 저장된 작업 상태를 조립 라인으로 표현한다. 실제 프로세스 실행을 감지하는 화면이 아니다. 새로 관측한 진행중 → 완료 전환만 보관함 이동으로 표시하며, 처음 읽은 과거 완료 작업은 이동을 재생하지 않는다.

완료 보관함에는 미확인 완료 작업만 표시한다. 사용자가 **확인 완료**를 눌렀을 때 DB에 읽음 상태를 저장한다. 상세 열기·애니메이션 종료로 자동 확인하지 않는다. 원래 작업과 기록은 상세보기에서 계속 조회할 수 있다.

확인은 현재 개인용 로컬 DB 전체에 적용되며 내용 검증이나 사람별 신원 인증이 아니다. DB v9의 별도 `run_acknowledgements` 행에 확인한 작업 버전을 보존한다. 백업·복원과 프로젝트 사본에도 포함된다. v9 DB를 여는 MCP·설치 진단·뷰어에는 v9를 지원하는 실행 파일을 사용해야 한다.
