#!/bin/bash
# Syncthing Relay + Discovery Server 安装脚本
# 服务器: cn.laobu.net (CentOS 7, x86_64)
# Relay 端口: 8849
# Discovery 端口: 8443
#
# 参考文档:
#   https://docs.syncthing.net/users/strelaysrv.html
#   https://docs.syncthing.net/users/stdiscosrv.html
#   Relay 下载: https://github.com/syncthing/relaysrv/releases
#   Discovery 下载: https://github.com/syncthing/discosrv/releases

set -e

RELAY_PORT=8849
DISCO_PORT=8443
DOMAIN="cn.laobu.net"
INSTALL_DIR="/opt/syncthing-relay"
RELAY_KEYS_DIR="/etc/strelaysrv"
DISCO_DATA_DIR="/var/lib/stdiscosrv"
SVC_USER="strelaysrv"

VERSION="v2.0.16"

# strelaysrv: https://github.com/syncthing/relaysrv/releases/tag/v2.0.16
RELAY_URL="https://github.com/syncthing/relaysrv/releases/download/${VERSION}/strelaysrv-linux-amd64-${VERSION}.tar.gz"
RELAY_PKG="strelaysrv-linux-amd64-${VERSION}.tar.gz"

# stdiscosrv: https://github.com/syncthing/discosrv/releases/tag/v2.0.16
DISCO_URL="https://github.com/syncthing/discosrv/releases/download/${VERSION}/stdiscosrv-linux-amd64-${VERSION}.tar.gz"
DISCO_PKG="stdiscosrv-linux-amd64-${VERSION}.tar.gz"

download() {
  local url="$1" output="$2"
  if command -v wget &>/dev/null; then
    wget -q "${url}" -O "${output}"
  else
    curl -fSL "${url}" -o "${output}"
  fi
}

validate_pkg() {
  local pkg="$1" url="$2" name="$3"
  if [ ! -s "${pkg}" ] || [ "$(stat -c%s "${pkg}" 2>/dev/null || echo 0)" -lt 10000 ]; then
    echo "错误: ${name} 下载失败，请手动下载后放到 /tmp/${pkg}"
    echo "  ${url}"
    exit 1
  fi
}

echo "=== 1. 创建服务用户和目录 ==="
id ${SVC_USER} &>/dev/null || useradd -r -s /sbin/nologin ${SVC_USER}
mkdir -p ${INSTALL_DIR} ${RELAY_KEYS_DIR} ${DISCO_DATA_DIR}
chown ${SVC_USER}:${SVC_USER} ${RELAY_KEYS_DIR} ${DISCO_DATA_DIR}

echo "=== 2. 下载 strelaysrv ${VERSION} ==="
cd /tmp
[ -f "${RELAY_PKG}" ] || download "${RELAY_URL}" "${RELAY_PKG}"
validate_pkg "${RELAY_PKG}" "${RELAY_URL}" "strelaysrv"

echo "=== 3. 下载 stdiscosrv ${VERSION} ==="
[ -f "${DISCO_PKG}" ] || download "${DISCO_URL}" "${DISCO_PKG}"
validate_pkg "${DISCO_PKG}" "${DISCO_URL}" "stdiscosrv"

echo "=== 4. 解压并安装 ==="
tar xzf "${RELAY_PKG}"
cp "strelaysrv-linux-amd64-${VERSION}/strelaysrv" ${INSTALL_DIR}/
chmod +x ${INSTALL_DIR}/strelaysrv

tar xzf "${DISCO_PKG}"
cp "stdiscosrv-linux-amd64-${VERSION}/stdiscosrv" ${INSTALL_DIR}/
chmod +x ${INSTALL_DIR}/stdiscosrv

rm -rf /tmp/strelaysrv-linux-amd64-* /tmp/stdiscosrv-linux-amd64-*
rm -f /tmp/${RELAY_PKG} /tmp/${DISCO_PKG}
echo "已安装: ${INSTALL_DIR}/strelaysrv, ${INSTALL_DIR}/stdiscosrv"

echo "=== 5. 创建 Relay systemd 服务 ==="
# strelaysrv 参数说明 (https://docs.syncthing.net/users/strelaysrv.html):
#   -listen        监听地址 (默认 :22067)
#   -ext-address   对外广播的可达地址
#   -keys          TLS 证书存储目录（首次启动自动生成）
#   -pools=""      不加入公共池，保持私有
#   -status-srv="" 禁用状态页
cat > /etc/systemd/system/syncthing-relay.service << EOF
[Unit]
Description=Syncthing Relay Server
Documentation=https://docs.syncthing.net/users/strelaysrv.html
After=network.target

[Service]
User=${SVC_USER}
ExecStart=${INSTALL_DIR}/strelaysrv \\
  -listen=:${RELAY_PORT} \\
  -ext-address=${DOMAIN}:${RELAY_PORT} \\
  -keys=${RELAY_KEYS_DIR} \\
  -pools="" \\
  -status-srv="" \\
  -provided-by="mdeditor-sync"
Restart=on-failure
RestartSec=10
ProtectSystem=full
ProtectHome=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

echo "=== 6. 创建 Discovery systemd 服务 ==="
# stdiscosrv 参数说明 (https://docs.syncthing.net/users/stdiscosrv.html):
#   --listen     监听地址 (默认 :8443)
#   --cert/--key TLS 证书路径（首次启动自动生成到 db-dir）
#   --db-dir     数据库和证书存储目录
cat > /etc/systemd/system/syncthing-discovery.service << EOF
[Unit]
Description=Syncthing Discovery Server
Documentation=https://docs.syncthing.net/users/stdiscosrv.html
After=network.target

[Service]
User=${SVC_USER}
ExecStart=${INSTALL_DIR}/stdiscosrv \\
  --listen=:${DISCO_PORT} \\
  --db-dir=${DISCO_DATA_DIR} \\
  --cert=${DISCO_DATA_DIR}/cert.pem \\
  --key=${DISCO_DATA_DIR}/key.pem
Restart=on-failure
RestartSec=10
ProtectSystem=full
ProtectHome=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

echo "=== 7. 防火墙放行端口 ==="
open_port() {
  local port=$1
  if command -v firewall-cmd &>/dev/null && systemctl is-active firewalld &>/dev/null; then
    firewall-cmd --permanent --add-port=${port}/tcp
  else
    iptables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || \
      iptables -I INPUT -p tcp --dport ${port} -j ACCEPT
  fi
}

open_port ${RELAY_PORT}
open_port ${DISCO_PORT}

if command -v firewall-cmd &>/dev/null && systemctl is-active firewalld &>/dev/null; then
  firewall-cmd --reload
else
  service iptables save 2>/dev/null || true
fi
echo "已放行: ${RELAY_PORT}/tcp, ${DISCO_PORT}/tcp"

echo "=== 8. 启动服务 ==="
systemctl daemon-reload
systemctl enable syncthing-relay syncthing-discovery
systemctl start syncthing-relay syncthing-discovery

echo "=== 9. 获取 Device ID ==="
sleep 3

RELAY_ID=$(journalctl -u syncthing-relay --no-pager -n 30 2>/dev/null | grep -oP '(?<=relay://)[^ ]+' | head -1 || true)
DISCO_ID=$(journalctl -u syncthing-discovery --no-pager -n 30 2>/dev/null | grep -oP 'Server device ID is \K[A-Z0-9-]+' | head -1 || true)

echo ""
echo "=========================================="
echo "  安装完成"
echo "=========================================="
echo ""
systemctl --no-pager status syncthing-relay 2>&1 | head -3 || true
echo ""
systemctl --no-pager status syncthing-discovery 2>&1 | head -3 || true
echo ""
echo "=========================================="
echo "  客户端配置"
echo "=========================================="
echo ""
echo "1) Relay (Settings -> Connections -> Sync Protocol Listen Addresses):"
if [ -n "${RELAY_ID}" ]; then
  echo "   relay://${RELAY_ID}"
else
  echo "   relay://${DOMAIN}:${RELAY_PORT}/?id=<RELAY_DEVICE_ID>"
  echo "   获取 ID: journalctl -u syncthing-relay --no-pager | grep 'relay://'"
fi
echo ""
echo "2) Discovery (Settings -> Connections -> Global Discovery Servers):"
if [ -n "${DISCO_ID}" ]; then
  echo "   https://${DOMAIN}:${DISCO_PORT}/?id=${DISCO_ID}"
else
  echo "   https://${DOMAIN}:${DISCO_PORT}/?id=<DISCO_DEVICE_ID>"
  echo "   获取 ID: journalctl -u syncthing-discovery --no-pager | grep 'device ID'"
fi
echo ""
echo "=========================================="
echo "  日志"
echo "=========================================="
echo "  Relay:     journalctl -u syncthing-relay -f"
echo "  Discovery: journalctl -u syncthing-discovery -f"
echo "=========================================="
