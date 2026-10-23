#!/usr/bin/env bash
# 정시 실행(sandbox/dispatch.sh) systemd 유닛 설치. 여러 번 실행해도 안전하다. 타이머는 켜지 않는다(토큰을 넣은 뒤 직접 켠다).
# 사용: sudo bash sandbox/dispatch-setup.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "root 로 실행하세요: sudo bash $0"; exit 1; }
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

install -d -o root -g root -m 755 /etc/lowdown
if [ ! -f /etc/lowdown/dispatch.env ]; then
  install -o root -g root -m 600 "$REPO_DIR/sandbox/dispatch.env.example" /etc/lowdown/dispatch.env
fi
chmod 600 /etc/lowdown/dispatch.env

sed "s#@REPO_DIR@#$REPO_DIR#g" "$REPO_DIR/sandbox/systemd/lowdown-dispatch@.service" > /etc/systemd/system/lowdown-dispatch@.service
for t in scanner npm pypi; do
  install -m 644 "$REPO_DIR/sandbox/systemd/lowdown-dispatch-$t.timer" /etc/systemd/system/lowdown-dispatch-$t.timer
done
systemctl daemon-reload

cat <<EOF
정시 실행 유닛 설치 완료. 남은 단계(직접):
  1) 토큰 입력:  sudo nano /etc/lowdown/dispatch.env
  2) 토큰 확인:  sudo systemd-run -p EnvironmentFile=/etc/lowdown/dispatch.env -p DynamicUser=yes --wait --pipe \\
                   /bin/bash $REPO_DIR/sandbox/dispatch.sh --check scanner.yml
  3) 켜기:       sudo systemctl enable --now lowdown-dispatch-scanner.timer lowdown-dispatch-npm.timer lowdown-dispatch-pypi.timer
  4) 확인:       systemctl list-timers 'lowdown-*'
기록:            journalctl -u 'lowdown-dispatch@*' --since today
멈추기:          sudo systemctl disable --now lowdown-dispatch-scanner.timer lowdown-dispatch-npm.timer lowdown-dispatch-pypi.timer
EOF
