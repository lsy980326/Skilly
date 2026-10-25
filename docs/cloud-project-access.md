# 개인 클라우드 인증·프로젝트 접근 권한

## 지원 범위

이번 기반은 **배포하지 않은 fetch 처리 함수**다. 테스트 키와 로컬 D1에서 검증하며 실제
Cloudflare 계정·로그인·DNS·Access 정책·실사용 DB·기존 MCP/화면 설정을 연결하지 않는다.

| 방식 | 현재 처리 |
|---|---|
| Cloudflare Access의 사용자용 application JWT | 주입한 공개 JWKS로 RS256·issuer·audience·시간·`type=app`·비어 있지 않은 sub 검증 |
| 이메일 헤더·본문의 user/role/authenticated | 권한 근거로 사용하지 않음 |
| Access 서비스 토큰 | 개인 사용자와 섞지 않도록 빈 sub는 거절. 별도 머신 주체 계약은 후속 |
| 쿠키·임의 Bearer 토큰 | fallback 없음. `Cf-Access-Jwt-Assertion`만 검증 |
| 사전 제공 Access JWT의 MCP HTTP 연결 | 고정 scope의 9개 도구. 로컬 SDK/HTTP/D1 검증 범위는 [인증된 MCP 연결](cloud-mcp.md) 참조 |
| OIDC/OAuth 로그인·토큰 발급·갱신 | 구현 범위 밖. 실제 계정·클라이언트 설정 연동은 별도 검증 필요 |

등록·키 수명 관리에는 `createManagedCloudHandler(binding, policyId)`를 사용한다.
호스트가 제공한 공개키와 등록 의도를 테스트 D1에 보관하며, 실제 계정 설정을 읽거나
외부 인증 서버에 접속하지 않는다. [소유자 등록·키 갱신과 회수](cloud-owner-keys.md)를 따른다.

Cloudflare는 origin에서도 전달된 JWT의 서명을 검증하도록 안내한다. Edge에 Access가 있다는
이유로 헤더를 그대로 신뢰하지 않는다. JWT 검증은 이미 설치된 `jose@6.2.13`을 직접
의존성으로 명시해 사용한다. Web Crypto 기반으로 Node/Workers에서 같은 검증을 사용하고,
서명 알고리즘이나 토큰 디코더를 직접 구현하지 않는다.

공식 근거:
- [Access JWT 검증](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [사용자·서비스 application token의 차이](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Jose JWT 검증과 로컬 JWKS](https://github.com/panva/jose)

## 신뢰 경계

`CloudflareAccessAuthenticator(policy)`는 호스트가 제공한 issuer·application audience·공개키
snapshot만 사용한다. JWT의 `jku/x5u/jwk`는 거절하며 키 주소를 따라가지 않는다.
실제 키 다운로드·계정 연결·환경/인증 파일 읽기는 없다.

- 알고리즘은 RS256, 키는 공개 RSA 서명/verify 키로 한정한다. private 필드·중복 kid·다른 용도는 거절한다.
- `iss/sub/aud/exp/iat`가 필요하다. issuer와 audience를 고정하고 만료·미래 nbf/iat·과도한 수명을 거절한다.
- 토큰은 최대 16 KiB, 키는 최대 4개다. 본문 토큰·쿠키·이메일 헤더로 우회하지 않는다.
- 키 snapshot의 `fetched_at/valid_until`은 호스트 선언이며 최대 24시간이다. 유효기간이 지나면
  503으로 차단하고 재사용하지 않는다. 키 교체/갱신은 호스트가 새 검증기를 준비해야 한다.
- 토큰/키를 저장·기록·에러에 출력하지 않는다. 원래 테스트 키는 메모리에서 생성하며 실사용 키를 읽지 않는다.

주체는 `(issuer, sub)`다. 이메일·표시 이름·요청의 actor는 인증 주체가 아니다.
같은 이메일이라도 다른 주체나 조직이면 기존 권한을 이어받지 않는다.

## 프로젝트 권한

`010-project-access.sql`은 별도 신규/테스트 D1에 명시적으로 적용한다. SQLite나 기존 D1,
로컬 이전 실행기의 001–009 초기화에 자동 등록하지 않는다. 스키마가 없으면 503으로 차단한다.

`D1ProjectAccess.grant(principal, scope, role, state, expectedVersion)`는 **신뢰된 호스트의
관리 경계**다. 사용자 HTTP 작업으로 권한을 부여하거나 프로젝트를 자동 생성하지 않는다.
대상 프로젝트는 호스트가 먼저 준비해야 한다. 최초 소유자도 호스트가 exact issuer/sub를
사전 지정한 등록 의도로만 확정한다. 실제 개인 계정 로그인과 관리 UI는 아직 연결하지 않는다.

- scope는 project ID·repository·environment의 정확한 조합이다. 누락·와일드카드·자동 확대가 없다.
- `owner/editor`는 일반 보고를 읽고 쓸 수 있고, `viewer`는 읽기만 가능하다. HTTP 권한 관리 API는 없다.
- 권한은 수정·삭제하지 않고 새 버전으로 active/revoked를 추가한다. 예상 버전이 다르면 충돌로 거절한다.
- 매 요청마다 최신 버전을 확인한다. unknown 프로젝트와 권한 없는 프로젝트는 모두 같은 403이다.
- 조회 SQL 전후 및 응답 전에 버전을 재확인한다. 조회 중 취소된 결과는 반환하지 않는다.
- 쓰기 batch 앞에 같은 주체·scope·권한 버전 guard 두 문장을 넣는다. guard 확인 전에 권한이 취소되면
  원문·revision·영수증 전체가 롤백된다. 취소 후 재부여돼도 이전 버전 binding은 사용할 수 없다.
  기존 업무의 최대 40문장에 보안 guard 2문장이 추가된다. 기존 저장소의 결과 인덱스는 유지한다.
- 권한은 프로젝트 내보내기·이전 자료에 포함하지 않는다. 목적지의 권한은 별도 등록해야 하며
  원문이나 imported metadata로 권한을 부여하지 않는다. 기존 쓰기 세대 차단도 그대로 적용한다.

## 첫 HTTP 업무 경계

`createCloudHandler(binding, authenticator)`가 반환하는 함수는 요청을 처리할 뿐 listener나
배포 설정을 만들지 않는다. 경로는 `POST /v1/projects/<UUID>/memory`이고 입력은 다음 형태다.

```json
{
  "repository": "web",
  "environment": "development",
  "command": {
    "operation": "tasks",
    "input": { "limit": 5 }
  }
}
```

인증 → 제한된 JSON 입력 → scope 권한 → 해당 scope의 저장/조회 → 권한 재확인 순서다.
요청은 최대 64 KiB며 알 수 없는 필드는 거절한다. 응답에는 `Cache-Control: no-store`를 사용하고,
CORS 허용이나 자격증명/SQL을 포함한 에러 응답을 추가하지 않는다.

허용된 첫 묶음:

| 작업 | 의미 |
|---|---|
| begin | 서버가 새 작업 ID·시각을 만들고 일반 작업 시작 보고 저장 |
| checkpoint | 같은 scope의 활성 작업에 메모·변경·문제 보고 저장 |
| finish | 같은 작업에 종료 보고 저장. 검증 완료나 실제 프로세스 종료를 뜻하지 않음 |
| tasks/task/record | 고정 scope의 작업·원문·AI 보고 조회 |
| context | 고정 scope의 기존 현재 지식 통합 조회. 직접 관측과 AI 보고의 구분 유지 |
| receipt | 같은 주체·scope·쓰기 종류·원래 키의 저장 영수증 조회 |

임의 권한 부여·프로젝트 생성·raw mutation·실행 관측/파일 관측·이벤트 수신·역사 가져오기·이전
활성화는 이 memory HTTP 입력으로 제공하지 않는다. 관리형 핸들러의 별도 owner 경로도
호스트가 사전 지정한 최초 소유자만 확정한다. 보고의 checks가 passed여도 직접 검사 관측은
생성하지 않으며 `claims_verified=false`를 유지한다. 구조화 결정·계획·스킬 등 더 넓은 쓰기
표면은 별도 계약으로 연결해야 한다. 현재 MCP 도구 전체를 제공하는 API가 아니다.

영수증 키는 서버가 주체·project/repository/environment·쓰기 종류·요청 키의 해시로 만든다.
같은 프로젝트의 다른 사용자나 저장소가 같은 키를 써도 영수증을 공유하지 않는다.
재생 결과의 scope도 다시 확인하며 raw 저장 키를 조회하는 입력은 없다.
같은 요청의 재시도는 원래 결과를 반환하고 다른 내용은 충돌이다. 전송 큐나 자동 재실행은 없다.

## 검증과 남은 운영 경계

관련 검사는 `npm run test:cloud`로 실행한다. 실제 계정이나 설치 토큰이 필요하지 않다.

`tests/cloud-auth.test.mjs`는 실제 로컬 서명/검증으로 잘못된 서명·알고리즘·발급자·대상·시간·
키·주체와 위조 헤더를 확인한다. `tests/cloud-project-access.test.mjs`는 실제 Miniflare/workerd의
요청 처리와 테스트 D1에서 교차 프로젝트/저장소/환경 거부, 조회 전용 권한, 정상 보고 저장·
재시도·새 연결 재조회, 권한 취소 경합과 전체 롤백을 확인한다. 경합 시점은 테스트가 주입한다.

실제 계정 로그인·Access 배포·외부 인증키 갱신 서비스·원격 MCP OAuth·TLS/방화벽·클라이언트
저장소 선택·오프라인 전송 큐·계정별 사용량 예산은 아직 운영 검증하지 않았다.
외부 사용자 차단/토큰 철회는 자동 수신하지 않는다. 관리형 경로에서 호스트가 공개키를
회수한 것은 기존 연결도 최신 D1 정책과 비교해 차단한다. 앱의 권한
취소는 다음 SQL/응답 확인에서 적용하지만, 이미 완료된 응답을 회수하거나 DB 커밋 후
권한 취소로 응답만 차단된 경우 기존 커밋을 되돌리는 것은 아니다. 새 유효한 권한으로
원래 영수증을 조회해야 한다. 별도 승인 없이 실사용 연결로 전환하지 않는다.
