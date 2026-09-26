# lowdown-proxy

Agents should not have to trust an agent/tool they've never interacted with.

`lowdown-proxy`는 MCP 클라이언트와 서버 사이를 투명하게 통과하는 stdio 프록시입니다.
통신 내용은 그대로 전달하면서, 동시에 어떤 도구가 호출됐고 성공/실패했는지, 얼마나
걸렸는지를 자동으로 기록합니다.

기록된 데이터는 다른 에이전트가 "이 도구를 써도 되는가"를 판단할 때 참고할 수 있는
최소한의 공통 근거가 됩니다.

자세한 배경과 설계 원칙은 [DESIGN.md](./DESIGN.md)를 참고하세요.

## 설치 없이 실행

```bash
npx lowdown-proxy -- npx some-mcp-server
```

기존 MCP 클라이언트 설정에서 서버를 감싸기만 하면 됩니다.

```jsonc
// 기존
{
  "mcpServers": {
    "search": { "command": "npx", "args": ["search-mcp-server"] }
  }
}

// lowdown-proxy로 감싼 뒤
{
  "mcpServers": {
    "search": {
      "command": "npx",
      "args": ["lowdown-proxy", "--target", "search-mcp-server", "--", "npx", "search-mcp-server"]
    }
  }
}
```

## 옵션

| 플래그 | 설명 | 기본값 |
|---|---|---|
| `--actor` | 호출 주체 식별자 | `anonymous` |
| `--target` | 기록될 대상 이름 (도구 식별자) | 실행 명령어 문자열 |
| `--source` | `organic` \| `seeded` \| `synthetic` | `organic` |

## 환경변수

기록 기능을 쓰려면 아래 두 값이 필요합니다. 없어도 프록시는 정상 동작합니다
(패스스루가 최우선, 기록은 부가 기능).

```bash
export LOWDOWN_SUPABASE_URL="https://xxxx.supabase.co"
export LOWDOWN_SUPABASE_KEY="..."
```

## 설계 원칙 (요약)

- **패스스루 우선**: 기록 로직이 실패하거나 느려도 실제 MCP 통신은 절대 막지 않습니다.
- **사실만 기록**: v0는 성공/실패/지연시간만 기록합니다. 품질 판단(별점 등)은 범위 밖입니다.
- **출처 구분**: 모든 기록은 `organic`(자연 유입) / `seeded`(직접 심은 트래픽) /
  `synthetic`(합성 벤치마크)으로 태깅됩니다. 나중에 "실제 수요가 있었는가"를 검증할 때
  이 구분이 핵심 근거가 됩니다.

## 상태

이 프로젝트는 2026년 9월 시작된 **30일 공개 실험**입니다. 확장 계획과 소거된 방향들은
[DESIGN.md](./DESIGN.md)에 정리되어 있습니다.

## License

MIT
