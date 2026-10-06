# Lowdown — Project Brief

## 한 줄 정의
Agents should not have to trust an agent/tool they've never interacted with.
누적된 상호작용 이력을 다른 에이전트가 조회해서 다음 선택에 반영하는 실험.

## 핵심 데이터 모델 (4층)
1. Interaction — 무슨 일이 일어났나 (자동 기록, 사실만)
2. Decision — 왜 이걸 골랐나 (후보 대비 선택 이유)
3. Outcome — tool 실행 성공과 task 성공을 분리
4. Opinion — 품질 판단 (v0에서는 제외, 나중에 LLM judge로)

## 설계 원칙
- Read-first: 조회(GET)는 처음부터 무료·완전공개. 기여(리뷰) 요구는 진입장벽이라 늦춘다.
- Provenance 구분: synthetic(합성 트래픽) vs seeded(본인 트래픽) vs organic(외부 발견) 반드시 태깅.
- target_type을 agent/tool/service/human으로 열어둠 — MCP 전용으로 좁히지 않음.
- 별점 강요 안 함. interaction record가 평판의 최소 단위.

## v0 범위
- v0.1: lowdown-proxy — stdio 패스스루 + interaction 자동 기록
- v0.2: compare_tools() — 후보 2~3개 실제 실행 비교, 규칙기반(성공률/latency), judge 없음
- v0.3: get_lowdown(target) — 외부 공개 조회 API/MCP 도구

## v0.4 — Scanner (cold-start 관찰)
- Scanner는 제품이 아니라 Lowdown의 cold-start 데이터 생산기다. 사용자가 없어도 관찰 데이터가 쌓이게 한다.
- 대상: 공식 MCP Registry의 원격(streamable-http) 서버. 하루 1회 initialize → tools/list 까지만 호출한다. tools/call 은 하지 않는다.
- 관찰(scanner_observations)과 상호작용(interactions)은 섞지 않는다. 관찰 = 우리가 봤다, interaction = 실제 에이전트가 썼다.
- 사실만 기록한다: 401/403 은 http_status 숫자 그대로, 해석은 조회 시점에 한다. 원격 서버가 보낸 tool 이름·설명문은 저장하지 않고 개수와 해시만 저장한다.
- 조회: GET /api/reputation/:target 응답의 `scanner` 블록 (success_rate 에 합산하지 않음). target 표기는 `mcp:` + Registry 이름.
- 공개 데이터: 주 1회 CSV 를 lowdown-data 저장소로 내보낸다.
- 7일 PoC 기준: 사람 개입 없이 7일 동안 매일 실행되고 매일 reached_level ≥ 1 관찰이 남는다.
- 범위 밖: 별점/Reliability Score, Local Scanner, 모니터링 SaaS, 알림.

## 하지 않는 것 (v0)
- 결제/에스크로, 온체인, 토큰
- 행동 이상탐지, critic/audience 등급 분리, 신뢰도 가중치
- LLM judge 기반 품질평가
- 프레임워크 어댑터(LangChain 등)
- 웹사이트/랭킹/배지

## 경쟁 지형 (2026-09 기준 확인됨)
- ERC-8004 (MetaMask/Ethereum Foundation/Google/Coinbase 공저) — Identity/Reputation/Validation 온체인 표준
- Agent Reputation MCP Server (npm, 이름 동일하나 초기 단계)
- azeth-protocol, LAWBOR, notifuturo/vouch, Vouch Protocol — 각각 다른 각도의 유사 시도
- Claude Market, null-trust-score, mcp-vitals 등 — MCP 스코어링(텔레메트리형), 우리와 데이터 모델이 다름(경험 축적 vs 정적 측정)
→ 결론: "빈 공간"이 아니라 "이미 여럿이 탐색 중인 문제"에 다른 데이터 모델로 진입. 선점이 아니라 기록이 목표.

## 성공 기준 (30일)
- Level 1 존재: GitHub/npm/MCP Registry 공개, 실행 가능, DESIGN.md 존재 — 무조건 달성
- Level 2 흔적: star 소량, 외부 설치, issue/PR, 언급
- Level 3 사용: 외부 에이전트의 organic get_lowdown 호출
- Level 4 보너스: fork, 타 프로젝트 연결, ERC-8004 생태계 논의에서 언급

## 배포 순서
npm+GitHub 공개 → 공식 MCP Registry 등록 → (신호 관찰) → 개인 프로젝트 저자 개별 연락(tae0y, imagiever-ar 등) → (그래도 부족하면) GeekNews/r-mcp 공유

## 국내 전환 조건부 전략
- 1차: 30일 국제 실험 그대로 진행 (기존 v0.1~v0.3, 글로벌 MCP Registry 등록)
- 전환 조건: Level 2(흔적) 기준 중 하나 이상 달성 시 국내 전환 착수
  - star 소량 / 외부 설치 확인 / issue·PR 발생 / 외부 언급
- 전환 시 실행:
  - 카카오 PlayMCP 등록/제휴 가능성 확인
  - 국내 채널(GeekNews, OKKY) 우선 공유
  - 국내 MCP 프로젝트 개별 연락: mcp-saju(molpass), tae0y, 단감소프트(cafe-mcp), korean-public-data-mcp
  - AI기본법(2026.1.22 시행) 연계 포지셔닝은 법률 자문 전까지 보류 — 마케팅 문구로 단정적으로 쓰지 않음
- 전환 조건 미달 시: 국내 전환 없이 Level 1(존재)로 실험 종료, 유산으로 기록
