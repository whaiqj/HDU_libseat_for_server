#!/bin/sh
# 服务器部署前置脚本（服务器两步部署的第一步）：
#   1. sh scripts/deploy.sh          ← 本脚本：生成/校验 .env 与 auth.caddy，检查 Docker 环境
#   2. docker compose up -d --build  ← 第二步：构建并启动全部五个服务
#
# 从本机打包（scripts/package-for-server.ps1）复制过来的项目已带真实 .env / auth.caddy，
# 本脚本会校验其完整性；若缺失则自动生成模板并明确提示需补填的项
set -e
cd "$(dirname "$0")/.."

# ---------- [1/5] .env 初始化 ----------
if [ ! -f .env ]; then
  echo "==> [1/5] .env 不存在，生成模板（随机 ACCOUNT_SECRET_KEY / DB_PASSWORD）"
  sh scripts/init-env.sh
else
  echo "==> [1/5] .env 已存在，跳过生成"
fi

# ---------- [2/5] .env 必填项校验 ----------
echo "==> [2/5] 校验 .env 必填项"
env_value() {
  grep -E "^$1=" .env | head -n 1 | cut -d= -f2- | tr -d '\r'
}

ERRORS=""
require_env() {
  val=$(env_value "$1")
  if [ -z "$val" ]; then
    ERRORS="$ERRORS\n  - $1 未设置（编辑 .env 补填）"
  fi
}

require_env ACCOUNT_SECRET_KEY
require_env DB_PASSWORD
require_env FRONTEND_PORT

# 通知模式为 wxpusher 时，推送凭据必填
NOTIFY_MODE=$(env_value NOTIFY_MODE)
if [ "$NOTIFY_MODE" = "wxpusher" ]; then
  require_env WXPUSHER_APP_TOKEN
  require_env WXPUSHER_TOPIC_ID
fi

# 消息转发相关变量（MESSAGE_FORWARD_ENABLED / INTERVAL_MS）均有代码内默认值，可不填
if [ -n "$ERRORS" ]; then
  echo "配置校验失败：$ERRORS"
  exit 1
fi
echo "     必填项齐全（NOTIFY_MODE=${NOTIFY_MODE:-mock}）"

# ---------- [3/5] auth.caddy 校验（Caddy Basic Auth） ----------
echo "==> [3/5] 校验 auth.caddy（对外入口 Basic Auth 凭据）"
if [ ! -f auth.caddy ]; then
  cp auth.caddy.example auth.caddy
  echo "     auth.caddy 不存在，已从模板生成——必须填入真实哈希后重新运行本脚本"
  echo "     生成方式：docker run --rm caddy:2-alpine caddy hash-password --plaintext '你的密码'"
  exit 1
fi
if grep -q '替换为' auth.caddy; then
  echo "     auth.caddy 仍是占位符，Caddy 会启动失败（fail-fast 保护）"
  echo "     生成方式：docker run --rm caddy:2-alpine caddy hash-password --plaintext '你的密码'"
  echo "     然后编辑 auth.caddy，把用户名与完整哈希替换进去"
  exit 1
fi
echo "     Basic Auth 凭据已配置"

# ---------- [4/5] Docker 环境检查 ----------
echo "==> [4/5] 检查 Docker 环境"
if ! command -v docker >/dev/null 2>&1; then
  echo "     docker 未安装：先安装 Docker Engine 与 compose 插件"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "     docker compose 插件不可用（docker compose version 失败）"
  exit 1
fi
echo "     Docker 与 Compose 可用"

# 对外端口占用检查（ss 不可用时静默跳过）
FRONTEND_PORT=$(env_value FRONTEND_PORT)
if command -v ss >/dev/null 2>&1; then
  if ss -tln 2>/dev/null | grep -q ":$FRONTEND_PORT "; then
    echo "     警告：端口 $FRONTEND_PORT 已被占用，请修改 .env 的 FRONTEND_PORT"
    exit 1
  fi
  echo "     端口 $FRONTEND_PORT 空闲"
fi

# ---------- [5/5] 就绪提示 ----------
cat <<EOF

全部检查通过。执行第二步启动：

  docker compose up -d --build

首次构建需拉取镜像 + 安装依赖（数分钟）；启动后 docker compose ps 确认五个服务 healthy。
访问地址：http://<服务器IP>:$FRONTEND_PORT（Basic Auth 用户名/密码见 auth.caddy / 你的设定）
EOF
