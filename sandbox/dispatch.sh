#!/usr/bin/env bash
# 정해진 시각에 GitHub Actions 워크플로를 수동 실행(workflow_dispatch, daily=true)으로 시작한다.
# GitHub 의 예약 실행(schedule)은 부하에 따라 몇 시간씩 늦거나 빠질 수 있어서, 이 서버의 systemd 타이머가 정시에 "실행" 버튼을 대신 누른다.
# 실제 작업은 지금처럼 GitHub Actions 에서 돈다. 워크플로의 기존 예약은 예비로 남고, 그날 이 실행이 이미 끝났으면 건너뛴다.
#
# 사용: dispatch.sh <scanner.yml|npm.yml|pypi.yml>          지금 실행 시작
#       dispatch.sh --check <scanner.yml|npm.yml|pypi.yml>  토큰·저장소 확인만(실행하지 않음, 워크플로 정보 읽기)
# 환경(/etc/lowdown/dispatch.env, root 600):
#   GITHUB_DISPATCH_TOKEN  이 저장소 하나에만 "Actions: Read and write" 권한이 있는 fine-grained 토큰
#   GITHUB_REPO            기본 PetShopBros/lowdown-proxy
set -euo pipefail

CHECK=0
if [ "${1:-}" = --check ]; then CHECK=1; shift; fi
WF="${1:-}"
case "$WF" in
  scanner.yml | npm.yml | pypi.yml) ;;
  *) echo "unknown workflow: '$WF' (scanner.yml, npm.yml, pypi.yml)" >&2; exit 2 ;;
esac
: "${GITHUB_DISPATCH_TOKEN:?GITHUB_DISPATCH_TOKEN is not set (/etc/lowdown/dispatch.env)}"
REPO="${GITHUB_REPO:-PetShopBros/lowdown-proxy}"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "invalid GITHUB_REPO" >&2; exit 2; }

API="https://api.github.com/repos/$REPO/actions/workflows/$WF"

if [ "$CHECK" = 1 ]; then
  out="$(curl -sS --max-time 30 -w '\n%{http_code}' \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" -H 'User-Agent: lowdown-dispatch' "$API")" || { echo "check: network error" >&2; exit 1; }
  code="${out##*$'\n'}"
  if [ "$code" = 200 ]; then
    echo "check ok: $REPO $WF state=$(printf '%s' "${out%$'\n'*}" | grep -o '"state": *"[a-z_]*"' | head -1 | sed 's/.*"\([a-z_]*\)"$/\1/')"
    exit 0
  fi
  echo "check failed: HTTP $code (token, repository access or Actions permission)" >&2
  exit 1
fi

URL="$API/dispatches"
BODY='{"ref":"main","inputs":{"daily":"true"}}'
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

for attempt in 1 2 3 4 5; do
  code="$(curl -sS -o "$OUT" -w '%{http_code}' --max-time 30 -X POST \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
    -H 'User-Agent: lowdown-dispatch' \
    --data "$BODY" "$URL")" || code=000
  if [ "$code" = 200 ] || [ "$code" = 204 ]; then
    echo "dispatched $WF on $REPO (HTTP $code, attempt $attempt)"
    exit 0
  fi
  # 응답 본문 앞부분만(토큰은 본문에 없다)
  echo "attempt $attempt: HTTP $code $(head -c 300 "$OUT" | tr '\n' ' ')" >&2
  # 인증·설정 오류는 다시 해도 같다
  case "$code" in 401 | 404 | 422) exit 1 ;; esac
  sleep $((attempt * 30))
done
echo "giving up: $WF was not dispatched (GitHub schedule will run it later as a backup)" >&2
exit 1
