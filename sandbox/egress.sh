#!/usr/bin/env bash
# 컨테이너(docker0) → 바깥 연결 제한. 설치 컨테이너만 네트워크를 쓴다(npm 레지스트리). 실행 컨테이너는 --network none.
#   허용: DNS(호스트가 쓰는 상위 네임서버), 공인 인터넷
#   차단: 클라우드 메타데이터(169.254.0.0/16), 사설망(10/8, 172.16/12, 192.168/16, 100.64/10), 호스트 자신(INPUT)
# 다시 실행해도 같은 상태가 된다(전용 체인을 비우고 다시 채운다).
set -euo pipefail

BR=docker0
CHAIN=LOWDOWN-EGRESS

iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"

# DNS: systemd-resolved 의 상위 네임서버
NS="$(awk '/^nameserver/ {print $2}' /run/systemd/resolve/resolv.conf 2>/dev/null | grep -E '^[0-9.]+$' || true)"
for ns in $NS; do
  iptables -A "$CHAIN" -i "$BR" -d "$ns" -p udp --dport 53 -j RETURN
  iptables -A "$CHAIN" -i "$BR" -d "$ns" -p tcp --dport 53 -j RETURN
done
for net in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
  iptables -A "$CHAIN" -i "$BR" -d "$net" -j DROP
done
iptables -A "$CHAIN" -j RETURN

iptables -N DOCKER-USER 2>/dev/null || true
iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER 1 -j "$CHAIN"

# 컨테이너 → 호스트 자신(sshd 등) 차단
iptables -C INPUT -i "$BR" -j DROP 2>/dev/null || iptables -I INPUT 1 -i "$BR" -j DROP

echo "egress rules: dns=[${NS//$'\n'/ }] chain=$CHAIN"
