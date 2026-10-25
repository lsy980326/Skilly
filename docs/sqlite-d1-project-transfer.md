# SQLite ↔ 로컬 D1 프로젝트 이전

## 현재 범위

`SqliteD1ProjectTransfer`는 명시적으로 전달한 SQLite 파일과 로컬 D1 binding 사이의
호스트 내부 API다. SQLite → D1 → **새 SQLite DB**로 왕복하며, D1에서 추가된 원문도
돌아온다. 사용 중인 DB 경로·MCP 설정·인증·신뢰는 자동 변경하지 않는다. 원격 연결,
배포, 실사용 전환, 동기화, 기존 목적지 병합이나 파일 삭제는 포함하지 않는다.

SQLite 원본은 v15/v16만 받는다. D1에는 001–009를 **신규/테스트 DB에 명시적으로**
적용해야 한다. 돌아온 새 SQLite만 v16으로 생성한다. 일반 실행기의 자동 마이그레이션은
v15에 머물며 기존 v15를 자동 변경하지 않는다. v16은 새 실행기·화면·백업/논리 교환에서
읽을 수 있고, 구버전 도구에는 넘기지 않는다.

```ts
const move = new SqliteD1ProjectTransfer(sqlitePath, localD1Binding, projectId, newOperationDirectory);
await move.prepare();                 // 원본 봉인 + 차단된 D1 사본
const active = await move.activate(); // 호스트가 선택한 세대의 D1만 쓰기 허용
const writer = withD1Generation(localD1Binding, active.target.generation);
// writer로 허용된 일반 작업을 수행한다.
const returned = await move.returnToSqlite(newReturnDirectory);
// returned.active_sqlite_db는 명시적으로 선택해야 하는 새 DB다. 연결을 자동 전환하지 않는다.
```

재연결 시 **같은 원본 파일·D1 저장소·operation 디렉터리**로 새 객체를 만들고 `status()`를
조회한다. 다른 binding이나 inode를 대신 끼우면 거절한다. 처음부터 SQLite 이력이 없던
D1 프로젝트의 독립적인 가져오기 명령은 아직 없으며, `d1ToLocal` 변환 경계는 명시적인
설치 루트 매핑이 필요한 경우 `root_mapping_required`로 중단한다. 파일 경로를 추정하지 않는다.

## 정보 보존

D1의 `skilly-d1-project` schema 9는 기존 schema 8의 26개 업무 테이블에
`storage_origins`를 추가한다. SQLite v16에도 같은 보존 테이블을 둔다. 8 형식은 계속
지원하며, 9를 지원하지 않는 목적지는 가져오기 전에 거절한다.

- 기록 ID·원문·정정 관계·시각·보고 출처와 기록/계획 진행 순번을 유지한다.
- 결정·계획 버전·완료 조건·진행 보고·실행 연결, 기능 별칭·경로와 작업 연결을 유지한다.
- 검사 상세·코드 관측·소스 지문은 D1의 내장 JSON과 SQLite의 분리 행 사이에서 변환한다.
  원래 JSON 문자열·행 유무도 보존한다. 없는 검사는 새로 관측했다고 만들지 않는다.
- 스킬 전문·파일·버전·관측 ID·사용 보고를 유지한다. 과거 관측과 현재 설치 지정은 분리하고,
  명시된 설치 루트는 해시로 대응한다. 설치 파일은 읽거나 설치하지 않는다.
- SQLite에만 있는 복구 대기/확인/거절 요청, 완료 확인, 등록 영수증, 이벤트 연결 실패와
  최초 출처도 보존한다. D1에서는 보존 자료이며 **저장 성공이나 자동 복구 큐로 바꾸지 않는다**.
- D1에만 있는 assignment 이력·영수증 commit token·이벤트 메타데이터도 SQLite에 보존해
  다시 D1으로 갈 때 유지한다. 이 보존 자료는 현재 실행이나 사용자 인증의 증거가 아니다.

보존 행도 형식·내용 해시·내부 프로젝트 소유권을 확인한 후에만 복원한다. 임의 SQL은
받지 않으며 저장된 경로·검사 명령·스킬 스크립트를 실행하지 않는다. source/root 경로는
과거 설치 메타데이터이며 새 기기의 설치 상태로 승격하지 않는다. 향후 원격 전송은
별도 인증·권한·선택 범위를 검토해야 하며 이 모듈은 전송하지 않는다.

### 이벤트와 중단 저장 지점

원래 이벤트·링크 ID, 순번·루트/세션 해시, 중단 당시 기록 ID·순번·조회 시각을 유지한다.
SQLite의 비원자적 조회라는 `meaning`을 D1 트랜잭션 관측으로 바꾸지 않는다.
D1 조회는 `snapshot_origin=sqlite_hook_history`와 원래 `source_association_status`를 별도로
표시하며 연결 확인 실패는 `association_unconfirmed`로 남는다. 돌아온 과거 이벤트도
`event_imports`로 분리하고 현재 세션 binding/anchor로 재사용하지 않는다.
새 호스트 이벤트와 명시적 연결이 필요하다. 수신되지 않은 누락 개수는 알 수 없다.

## 한 곳에서만 쓰기 허용

1. 제한·변환 사전 검사를 통과한 뒤 원본 main → recovery → events 순서로 봉인한다.
   이미 열려 있는 원본 연결도 DB 트리거가 막는다. 다른 프로젝트는 봉인하지 않는다.
2. 고정된 outbound 묶음을 operation 폴더에 보존하고, D1에 원문·보존 자료·차단 권한을
   단일 batch로 가져온다. 응답 유실 후 같은 묶음을 재사용한다.
3. 활성화 의도를 디스크에 남긴 후 정확한 D1 세대를 연다. 기존 세대 writer는 거절한다.
4. 복귀 위치는 한 번 선택하면 바꾸지 않는다. D1 세대를 증가시켜 봉인한 뒤 최신 묶음을
   새 SQLite 세 파일로 가져온다. 원래 SQLite를 다시 열지 않는다.
5. 복귀의 모든 파일과 검사를 완료한 뒤 `selected-return.json`을 먼저 남긴다. recovery/events를
   연 뒤 main을 마지막에 연다. 지연된 과거 D1 활성화는 세대가 달라 거절된다.

중단된 불완전 `copy-N`은 그대로 남기고 새 차단 사본으로 다시 만든다. 선택 완료 표식이
있으면 같은 사본만 재사용하므로 복귀 후의 새 쓰기를 덮어쓰지 않는다. 활성화 전에 D1
가져오기가 실패한 경우도 D1에 차단 표식을 남기고 새 SQLite로 복귀할 수 있다.
손상·분실한 선택 사본을 자동 교체하거나 원본을 임의로 열지 않는다. operation 폴더도
보존해야 한다. 여러 DB의 원자적 커밋·디스크 손실 복구·동일 OS 사용자의 직접 SQL
변조까지 보장하지 않는다. 묶음 해시는 서명·인증이 아니다.

## 한도와 검증

D1 묶음은 보존 자료를 포함해 1 MiB / 2,000행, 테이블 JSON 256 KiB, 행 64 KiB다.
보존할 원문 한 행은 60 KiB를 넘으면 거절한다. 사전 읽기도 1 MiB / 2,000행으로 제한하고
부분 성공·자동 분할·조용한 잘림은 없다. 미종료 실행 관측은 이전하지 않으며 작업을 임의
종료하거나 검사 명령을 재실행하지 않는다. 작업 상태 active는 실제 실행 중이라는 뜻이 아니다.

`tests/portable-transfer.test.mjs`는 테스트 SQLite와 실제 Miniflare/workerd, 재시작한 D1 binding,
새 SQLite MCP 및 화면의 읽기 모델로 왕복을 확인한다. 중단·응답 유실·연결 실패·검사 자료는
합성 주입이며 실제 Codex 중지나 원격 네트워크 장애 관측과 구분한다. 복귀 사본의 저장 성공도
원문 내용이나 AI 완료 보고를 검증 완료로 바꾸지 않는다.
