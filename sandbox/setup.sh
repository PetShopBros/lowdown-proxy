#!/usr/bin/env bash
# Lowdown stdio 샌드박스 서버 구성 — Ubuntu 24.04 새 서버에서 root 로 한 번 실행한다(다시 실행해도 안전).
#   sudo bash /opt/lowdown/lowdown-proxy/sandbox/setup.sh
# 하는 일: 스왑 2GB, 자동 보안 업데이트, Docker, gVisor(runsc), Node 24, 실행 사용자(lowdown, uid 10001),
#          컨테이너 바깥 연결 제한(내부망·메타데이터 차단), 실행 이미지 빌드, systemd 서비스·타이머 설치.
# 하지 않는 일: 키 입력(직접 /etc/lowdown/sandbox.env 에 넣는다), 타이머 시작(self-test 통과 뒤 직접 켠다).
# AWS 전용 기능은 쓰지 않는다. 다른 VPS 에서도 같은 스크립트로 다시 만든다.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_UID=10001
SANDBOX_ROOT=/var/lib/lowdown
IMAGE=lowdown-sandbox-node:1

log() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "root 로 실행하세요: sudo bash $0"; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] || { echo "Ubuntu 전용입니다 (현재 ${ID:-unknown})"; exit 1; }

log "1/9 swap 2GB"
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/90-lowdown.conf
sysctl -q -p /etc/sysctl.d/90-lowdown.conf

log "2/9 packages (docker.io, git, curl, jq, unattended-upgrades)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io git curl ca-certificates gnupg jq xz-utils iptables unattended-upgrades
systemctl enable --now docker

log "3/9 gVisor (runsc) — gvisor.dev 공식 apt 저장소"
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
  apt-get update -q
  apt-get install -y -q runsc
fi
runsc install >/dev/null 2>&1 || true   # docker 런타임 등록(이미 있으면 무시)
systemctl restart docker
docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' || { echo "docker 에 runsc 런타임이 없습니다"; exit 1; }

log "4/9 Node 24 (nodejs.org 공식 tarball, SHA256 확인)"
if ! /usr/local/bin/node --version 2>/dev/null | grep -q '^v24\.'; then
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) echo "지원하지 않는 CPU"; exit 1 ;; esac
  BASE=https://nodejs.org/dist/latest-v24.x
  TMP="$(mktemp -d)"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -oE "node-v24\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$FILE" ] || { echo "Node 24 파일을 찾지 못했습니다"; exit 1; }
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf "$TMP/$FILE" -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  rm -rf "$TMP"
fi
/usr/local/bin/node --version

log "5/9 user lowdown (uid $SANDBOX_UID), folders"
if ! id lowdown >/dev/null 2>&1; then
  useradd --system --uid "$SANDBOX_UID" --home-dir "$SANDBOX_ROOT" --shell /usr/sbin/nologin lowdown
fi
usermod -aG docker lowdown
install -d -o lowdown -g lowdown -m 700 "$SANDBOX_ROOT" "$SANDBOX_ROOT/work" "$SANDBOX_ROOT/npm-cache"
install -d -o root -g root -m 755 /etc/lowdown
if [ ! -f /etc/lowdown/sandbox.env ]; then
  install -o root -g root -m 600 "$REPO_DIR/sandbox/sandbox.env.example" /etc/lowdown/sandbox.env
fi
chmod 600 /etc/lowdown/sandbox.env

log "6/9 container egress limits"
install -o root -g root -m 755 "$REPO_DIR/sandbox/egress.sh" /usr/local/sbin/lowdown-egress
/usr/local/sbin/lowdown-egress

log "7/9 build image $IMAGE"
docker build -q -t "$IMAGE" "$REPO_DIR/sandbox"
docker run --rm --runtime=runsc --network none --user "$SANDBOX_UID:$SANDBOX_UID" "$IMAGE" node -e 'console.log("runsc ok", process.version)'

log "8/9 systemd units"
sed "s#@REPO_DIR@#$REPO_DIR#g" "$REPO_DIR/sandbox/systemd/lowdown-sandbox.service" > /etc/systemd/system/lowdown-sandbox.service
install -m 644 "$REPO_DIR/sandbox/systemd/lowdown-sandbox.timer" /etc/systemd/system/lowdown-sandbox.timer
install -m 644 "$REPO_DIR/sandbox/systemd/lowdown-egress.service" /etc/systemd/system/lowdown-egress.service
systemctl daemon-reload
systemctl enable --now lowdown-egress.service

log "9/9 next steps"
cat <<EOF
구성 완료. 남은 단계(직접):
  1) 키 입력:        sudo nano /etc/lowdown/sandbox.env
  2) SQL:            Supabase SQL Editor 에서 supabase/sandbox.sql 실행
  3) 격리 확인:      sudo -u lowdown bash -c 'cd $REPO_DIR && node sandbox/runner.ts --self-test'
  4) 대상 확인:      sudo systemd-run --uid=lowdown --gid=lowdown -p EnvironmentFile=/etc/lowdown/sandbox.env --wait --pipe \\
                       /usr/local/bin/node $REPO_DIR/sandbox/runner.ts --plan
  5) 첫 실행(10건):  sudo systemd-run --uid=lowdown --gid=lowdown -p EnvironmentFile=/etc/lowdown/sandbox.env -p WorkingDirectory=$REPO_DIR --wait --pipe \\
                       /usr/local/bin/node $REPO_DIR/sandbox/runner.ts --limit=10
  6) 매일 실행 켜기: sudo systemctl enable --now lowdown-sandbox.timer
멈추기:            sudo systemctl disable --now lowdown-sandbox.timer
EOF
