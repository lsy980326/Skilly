# 최초 소유자 등록과 인증키 수명 관리

## 현재 범위

실제 계정·배포·인증 파일 없이, 호스트가 명시적으로 제공한 **공개키**와 예상 주체로
로컬 D1에서 검증하는 기반이다. `011-owner-key-lifecycle.sql`은 001–010 다음 신규/테스트
D1에 명시적으로 적용한다. 기존 SQLite·뷰어·MCP·이전 명령의 초기화나 실사용 DB는 바꾸지 않는다.

`createManagedCloudHandler(binding, policyId)`는 매 요청 D1의 최신 공개키 정책을 읽는다.
기존 `createCloudHandler(binding, new CloudflareAccessAuthenticator(staticPolicy))`는 고정 스냅샷
호환·검사 경계다. 그 경로는 D1의 키 회수 이력을 읽지 않으므로 관리형 회수 보장을 적용할 수 없다.
이전 경로로 자동 fallback하거나 실사용 연결을 자동 전환하지 않는다.

Cloudflare는 서명키 갱신 때 새 키와 이전 키의 겹치는 기간을 제공한다.
이 구현도 호스트가 제공한 키 집합으로 겹치는 기간을 명시적으로 선택할 수 있다.
[공식 키 갱신 안내](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
실제 키 다운로드·Cloudflare 쪽 키 생성/회수·외부 사용자/토큰 차단 알림 수신은 구현하지 않는다.

## 최초 소유자 등록

사용자 HTTP 요청은 프로젝트를 만들거나 원하는 소유자를 정할 수 없다. 호스트가 프로젝트를
먼저 준비하고, 정확한 `(issuer, sub)`와 프로젝트·저장소·환경을 지정한다. 이메일·본문의
role·처음 접속한 순서는 근거가 아니다. `sub`가 다른 계정은 같은 이메일이어도 거절한다.

```ts
const policies = new D1AuthPolicies(testBinding);
await policies.publish('personal', publicPolicy, 0); // 호스트 관리 경계: 공개키만
const enrollment = new D1OwnerEnrollment(testBinding);
const intent = await enrollment.prepare(scope, expectedPrincipal, 'personal', expirySeconds);
const handler = createManagedCloudHandler(testBinding, 'personal');
```

`prepare`는 최대 1시간 동안 유효한 공개 등록 ID를 반환한다. ID 자체는 비밀번호가 아니다.
서명 검증을 통과한 **미리 지정된 주체**만 다음 요청을 보낼 수 있다.

```text
POST /v1/projects/<UUID>/owner
Cf-Access-Jwt-Assertion: <외부로 출력하지 않을 토큰>
Content-Type: application/json

{"repository":"web","environment":"development","registration_id":"<반환된 UUID>"}
```

- 관리자가 준비하지 않은 ID·다른 scope·다른 주체는 403이다. role/subject 같은 추가 입력은 400이다.
- scope에 기존 ACL이 한 건이라도 있으면 최초 등록을 사용할 수 없다. viewer나 철회 이력도 포함한다.
- scope별 등록 의도는 UNIQUE이고 추가 전용이다. 두 요청이 동시에 등록해도 소유자와 영수증은 한 번만 생긴다.
- 인증 정책 guard·owner 부여·claim 영수증은 같은 D1 batch다. 중간 실패는 전체 롤백한다.
- 원래 ID·scope·주체의 재시도는 저장된 영수증을 반환한다. 배치 반환만으로 저장 성공을 만들지 않고
  primary 영수증을 다시 읽는다. 응답 유실 후에도 같은 입력으로 재시도한다.
- 소유권을 철회한 뒤 영수증을 다시 읽어도 과거 부여 이력만 반환하며 권한을 재부여하지 않는다.
  `granted_at`은 당시 저장 시각이지 현재 권한 상태가 아니다. `claims_verified=false`를 유지한다.
- 만료된 미소모 등록 의도를 자동 재발급하거나 예상 주체를 바꾸지 않는다. 현재 기반에는 이 경우의
  호스트 복구/취소 UI가 없으며, 사전 검토 없는 재선점으로 해결하지 않는다.

## 공개키 갱신·회수

`D1AuthPolicies.publish/revokeKey/revoke`는 **호스트 전용**이다. 공개 HTTP로 제공하거나
업무 원문·가져온 프로젝트의 설정으로 실행하지 않는다. 새 버전은 예상 버전과 일치할 때만 추가한다.

```ts
await policies.publish('personal', overlappingPublicPolicy, 1); // 이전 키 + 새 키
await policies.revokeKey('personal', oldKid, 2);                // 이전 키를 제외한 버전
await policies.revoke('personal', 3);                           // 모든 키 차단
```

- issuer·audience·허용 토큰 수명은 첫 정책에 고정한다. 가져온 snapshot의 fetched_at 역행도 거절한다.
- 같은 kid에 다른 공개키를 넣거나 같은 공개키에 새 kid를 붙이는 것을 거절한다.
- RSA n/e의 정규 공개키 지문을 별도로 저장한다. 키가 집합에서 빠지면 회수 지문을 누적하여
  나중에 같은 키를 다시 넣지 못한다. RSA modulus의 비정규 인코딩도 거절한다.
- 마지막 키 회수는 정책을 revoked로 만든다. 이전 snapshot을 재사용하지 않는다.
  새 키·새 kid로 같은 issuer/audience의 새 버전을 추가하면 다시 사용할 수 있다.
- 키 목록 최대 4개·snapshot 최대 24시간, 누적 키 이력 128개·정책 JSON 64 KiB 상한이다.
  상한 도달 시 거절하며 회수 이력을 삭제하거나 오래된 키를 되살리지 않는다.
- 매 요청 최신 버전 조회, 각 DB 조회 전후·응답 전 재확인, 쓰기 batch의 인증 버전·만료 SQL guard를
  적용한다. 기존 handler나 오래된 인증 lease도 새 버전을 거치지 않고 계속 쓸 수 없다.
  SQL guard 확인 전에 회수되면 업무 revision·작업·원문·영수증을 함께 롤백한다.
- snapshot 만료·정책 손상·스키마 없음·키 없음은 503, 회수된 키로 서명한 토큰은 401이다.
  이미 인증한 요청의 버전이 바뀌면 401 또는 최신 정책 상태에 따른 503으로 차단한다.
- 커밋 뒤 회수되면 이미 저장한 내용을 되돌릴 수는 없고 응답만 차단될 수 있다. 새 유효한 키로
  원래 요청을 재시도해 영수증을 확인한다. 완료된 응답도 회수할 수 없다.

이는 이 D1 저장소의 추가 전용 이력 기준이다. **DB 전체를 회수 전 백업으로 되돌리거나 다른
저장소로 복제한 뒤 계속 사용하는 경우**까지 외부 단조 기준 없이 회수 상태를 보장하지 않는다.
권한·인증 정책은 일반 프로젝트 내보내기에 포함하지 않으며 새 목적지에 호스트가 별도 준비해야 한다.

## 검증

`npm run test:cloud`는 인증·프로젝트 접근 검사와 `tests/cloud-owner-keys.test.mjs`를 실행한다.
후자는 실제 로컬 Miniflare/workerd·테스트 D1·메모리에서 생성한 RSA 테스트 키를 사용한다.
Worker outbound는 차단한다. 새 연결/실행기 재시작도 같은 테스트 DB로 확인한다.

동시 등록·다른 주체의 선점·철회 후 재선점·기존 권한 덮어쓰기·키 회전/회수·키 재도입·
조회/쓰기/등록 중 회수·응답 유실 전후·불완전한 어댑터 응답을 구분해 검사한다.
이 로컬 결과는 실제 계정 연결·원격 D1·배포·외부 키 수신·원격 MCP 동작의 검증이 아니다.
