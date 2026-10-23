# Lowdown stdio 샌드박스 실행 이미지 — 설치(npm install --ignore-scripts)와 실행에 같이 쓴다.
# 비밀값·키는 넣지 않는다. 사용자는 docker run --user 로 정한다(root 로 돌리지 않는다).
FROM node:24-bookworm-slim

# git: git 의존성이 있는 패키지 설치용. coreutils(timeout)은 기본 포함.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm config set update-notifier false --location=global

LABEL org.opencontainers.image.source="https://github.com/PetShopBros/lowdown-proxy" \
      org.opencontainers.image.description="Lowdown stdio sandbox: npm install --ignore-scripts, then initialize + tools/list only"
