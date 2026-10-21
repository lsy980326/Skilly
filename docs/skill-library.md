# 프로젝트별 스킬 라이브러리

스킬 전문과 보조 파일, 버전, 출처, 설치 안내를 DB에 보관한다. 프로젝트마다 사용할
버전과 설치 위치를 지정하고, 요청한 때에만 실제 로컬 파일을 비교한다.
별도 AI·파일 감시기·다운로드·자동 설치·스크립트 실행은 없다.

## 저장과 관측의 구분

- `memory_register_skill`: `skill_key`, `source`, `version`, `name`, `description`, `body`,
  `files`, `install_instructions`를 보관한다. `body`는 SKILL.md 전문이고 `files`는 명시한 보조 파일이다.
  같은 프로젝트·키·버전은 불변이다. 수정은 새 버전으로 남긴다. 출처가 다른 동명 스킬은 다른 키를 사용한다.
- `memory_assign_skill`: 보관 버전을 이 프로젝트 연결의 `repository`·`environment`와
  `tool`(`codex`/`cursor`)·`folder`에 지정한다. 파일을 만들지 않는다.
- `memory_check_skill_installation`: 지정한 설치 ID를 현재 실행 프로젝트 루트에서 명시적으로 점검한다.
  원문을 수집하지 않고 파일별 해시·크기·관측 시각만 저장한다.
- `memory_list_skills`: 프로젝트 전체 카탈로그와 마지막 설치 관측 요약. 전문은 제외한다.
- `memory_get_skill`: 특정 버전의 전문·보조 파일·설치 안내와 마지막 설치 관측을 읽는다.
  버전을 생략하면 마지막 등록 시각과 저장 순서로 선택한다. 버전 문자열의 의미상 최신을 추측하지 않는다.

등록과 조회에는 실제 `project_id`가 필요하다. 연결된 프로젝트는 기존처럼
`memory_resolve_project`로 식별한다. 지정·관측은 `--project`로 실행한 연결에서만 가능하다.
개인 홈 전체나 다른 프로젝트의 설치 폴더를 재귀 검색하지 않는다.

## 상태의 의미

| 화면 | 의미 |
|---|---|
| 미확인 | 설치 지정만 했거나 지정 버전을 바꾼 뒤 아직 점검하지 않음 |
| 파일 일치 | 관측 당시 등록한 파일들의 내용이 해당 버전과 같았음 |
| 내용 변경 | 읽을 수 있는 파일 내용이 등록 버전과 달랐음 |
| 파일 없음 | 유효한 프로젝트 루트 아래 기대한 파일이 없었음 |
| 확인 불가 | 링크·권한·크기 제한·읽기 중 변경 등으로 비교할 수 없었음 |

여러 파일이 섞이면 확인 불가 → 파일 없음 → 내용 변경 → 일치 순서로 표시한다.
관측은 이력으로 누적하고 같은 시각에는 저장 순서로 마지막 관측을 선택한다.
지정 버전 변경 전 관측은 보존하지만 새 버전의 설치 확인으로 재사용하지 않는다.

모든 화면 상태는 **마지막 관측 당시 파일 기준**이다. 화면을 열거나 새로고침한다고
파일을 다시 읽지 않는다. 파일 일치는 AI가 스킬을 로딩·사용·실행했다는 증명이 아니다.
`loading_status`는 `unknown`, `current_machine_verified`는 `false`로 표시한다.
다른 컴퓨터로 가져온 절대 경로도 역사 데이터일 뿐 새 파일 접근 권한이 아니다.
현재 실행 루트와 다르면 점검을 거부하며, 새 루트에서 다시 지정해야 한다.

## 사용 예시

AI에는 다음처럼 요청할 수 있다.

> 이 프로젝트의 스킬 목록과 지정 버전을 조회해줘. 필요한 스킬의 전문·설치 방법과
> 마지막 파일 관측을 구분해서 알려줘. 파일을 자동 설치하거나 명령을 실행하지 마.

등록 예시 입력(실제 프로젝트 ID로 교체):

```json
{
  "project_id": "PROJECT_UUID",
  "skill_key": "review-guide",
  "version": "1.0.0",
  "name": "리뷰 안내",
  "source": "local:review-guide",
  "body": "# Review guide\n등록할 실제 스킬 전문",
  "files": [{"path": "references/checklist.md", "content": "실제 참고 내용"}],
  "install_instructions": "프로젝트 .agents/skills/review-guide에 파일 배치 후 새 세션에서 확인",
  "idempotency_key": "register-review-guide-1"
}
```

`skilly call memory_register_skill --project /absolute/project --db /absolute/memory.sqlite`
의 표준 입력이나 같은 MCP 도구 입력으로 사용한다. 설치 지정에는 등록된 키·버전,
`tool: "codex"`, `folder: "review-guide"`, 새 `idempotency_key`를 전달한다.
반환된 `installation_id`로 명시적 파일 점검을 요청한다.
관측을 다시 하고 싶을 때는 새 키를 쓰고, 실패한 동일 요청 재시도에는 원래 키를 유지한다.

모든 쓰기는 영수증으로 중복을 막는다. 이 스킬 쓰기 도구는 일반 작업 보고용 복구 큐에
자동 보관되지 않는다. 실패한 쓰기를 저장됐거나 대기 중이라고 간주하지 않는다.
현재 실행 중인 오래된 MCP 프로세스에는 새 도구가 자동 추가되지 않는다. 새 빌드로 시작한
연결에서 도구 목록을 확인해야 하며, 기존 보고 도구가 작동하는 상태를 연결 장애라고 판단하지 않는다.

## 화면과 안전 경계

프로젝트를 선택하고 **스킬** 탭을 누른다. 목록에서 보존 버전 수와 설치 상태를 보고,
상세에서 버전 선택·설치 안내·설치 위치·관측 시각·파일별 비교·전문을 확인한다.
설치 위치는 6개씩, 카탈로그는 기본 12개씩 읽는다. 상세의 이전/다음 설치 위치 버튼으로
전체를 볼 수 있다. 버전 목록은 최근 100개이며 이전 버전도 이름을 지정해 조회할 수 있다.
원문은 HTML로 실행하지 않고 텍스트로 표시한다. 기존 화면의 GET-only·인증·읽기전용 DB 계약은 유지한다.

전문은 최대 32,000자, 보조 파일은 최대 16개·각 16,000자, 입력 JSON은 합계 100 KiB 이하다.
보조 파일 경로는 `references`, `scripts`, `assets`의 허용 텍스트 파일 또는
`agents/openai.yaml`로 제한한다. 숨김·상위 이동·비공개 인증/키 경로는 허용하지 않는다.
실제 파일 비교는 `.agents/skills/<folder>` 또는 `.cursor/skills/<folder>`에서 등록한 파일만 읽는다.
링크를 따라가지 않고 regular-file·읽기 전후 경로/inode·변경 시각·파일별 256 KiB·총 2 MiB 한도를 검사한다.
같은 OS 사용자 권한의 악성 프로세스가 디렉터리를 순간 교체하는 상황을 완전히 격리하는
OS `openat` 샌드박스와 동일한 보장은 아니다. 비신뢰 공유 디렉터리는 점검 대상으로 쓰지 않는다.

## 기존 DB와 이동

쓰기 연결은 기존 v4 기록·영수증을 보존하는 추가 테이블 마이그레이션으로 v5를 연다.
읽기 전용 화면은 v1–v4 DB도 바꾸지 않고 열며 구버전의 스킬 목록은 비어 있다.
전체 백업·복원과 단일 프로젝트 내보내기·가져오기는 모든 스킬 버전·지정·관측을 포함한다.
기존 v4 백업도 지원하며, 가져오기는 새 목적지만 v5로 초기화/변환한다.
원본 패키지의 명령을 실행하거나 이전 기기의 관측을 현재 사실로 승격하지 않는다.

## 다른 사용자·프로젝트에서 설치

화면에서 버전을 선택하고 **스킬 패키지 내려받기**를 누르면 `*.skilly-skill.json`을 받는다.
CLI도 같은 형식을 내보낸다. 선택한 스킬 전문·보조 파일·설치 안내·출처·버전·내용 해시만
포함하며, 프로젝트 DB·작업 기록·설치 위치·파일 관측 이력은 포함하지 않는다.
스킬 전문 자체에 프로젝트 이름이나 전용 MCP 서버명이 적혀 있을 수 있으므로 공유 전 내용을 확인한다.
해시는 내용 손상 비교용이고 서명이나 배포자 신원 인증이 아니다. 외부 업로드나 전달은 자동 수행하지 않는다.

```sh
skilly skill-export --db /absolute/memory.sqlite --project-id PROJECT_UUID --skill use-skilly --output /absolute/new-use-skilly.json
skilly skill-install --input /absolute/new-use-skilly.json --project /absolute/target-project --tool codex
skilly skill-verify --input /absolute/new-use-skilly.json --project /absolute/target-project --tool codex
```

Skilly CLI가 PATH에 없으면 Skilly 저장소에서 먼저 `npm run build` 후 위 명령의 `skilly`를
`node /absolute/Skilly/dist/runtime/local/main.js`로 바꾼다. 별도의 글로벌 설치나 네트워크 다운로드는 필요 없다.
대상 프로젝트 디렉터리는 이미 존재해야 한다. Cursor는 `--tool cursor`를 사용한다.
`--folder use-skilly-copy`처럼 다른 새 이름을 지정할 수 있으나 스킬 내부 이름·MCP 연결은 자동 변경하지 않는다.

설치는 JSON 구조·허용 경로·합계 크기·내용 해시를 먼저 검증한 뒤 새 스킬 폴더만 만든다.
기존 폴더가 있으면 비어 있어도 중단하며, 덮어쓰기·삭제·설치 스크립트 실행은 하지 않는다.
일부 쓰기 실패 시 폴더를 보존하고 `installation_incomplete`로 보고한다. 이 출력은 설치 완료가 아니다.
공유 디렉터리의 적대적인 동시 변경을 격리하는 OS 샌드박스는 아니므로 신뢰하는 로컬 프로젝트를 사용한다.

설치/확인은 DB나 `skilly.project.json` 없이도 동작한다. 확인 결과가 `matches`이면 종료 코드 0,
변경·누락·확인 불가이면 2, 잘못된 입력/실행 오류는 1이다. 명령은 관측 결과를 표준 출력으로 반환하며
DB 설치 상태는 자동 변경하지 않는다. AI에 등록·설치 지정·`memory_check_skill_installation`을 요청하면
그 프로젝트 DB에도 관측을 남겨 화면에서 볼 수 있다. 다른 프로젝트의 기존 관측을 재사용하지 않는다.

`use-skilly` 설치는 MCP 연결 자체를 설치하지 않는다. 대상 프로젝트의 공개 식별 파일과 로컬 MCP 연결을
기존 Codex 연동 절차로 준비하고 새 AI 세션에서 스킬과 `memory_resolve_project` 호출을 확인한다.
특정 프로젝트 전용 스킬을 다른 서비스에 그대로 쓰지 말고 일반 배포본을 선택하거나 내용을 검토해 새 버전으로 등록한다.
파일 일치·설치 완료와 AI의 실제 로딩·사용은 별도다.

CLI 소스 준비에는 Node.js 24 이상이 필요하다. 처음 받은 Skilly 소스에서는 `npm ci` 후
`npm run build`를 실행한다. 설치한 파일은 소유자 읽기/쓰기(0600)이며 실행 권한은 추가하지 않는다.
스크립트가 필요한 경우 내용을 검토한 뒤 `bash scripts/example.sh`, `python scripts/example.py`,
`node scripts/example.mjs`처럼 해당 인터프리터를 명시한다. 파일 비교 결과는 실행 가능 권한이나
스크립트 동작을 검증하지 않는다.
