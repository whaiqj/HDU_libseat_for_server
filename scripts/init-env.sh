#!/bin/sh
# 一次性初始化脚本：基于 .env.example 生成 .env
# - ACCOUNT_SECRET_KEY：随机 32 字节 hex（AES-256-GCM 加密密钥）
# - DB_PASSWORD：随机 16 字节 hex（MySQL root 密码，mysql 容器与后端共用）
# .env 已在 .gitignore 中，不会进入版本控制；重复执行会跳过，不会覆盖已有配置
set -e
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env 已存在，跳过初始化。"
  exit 0
fi

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

secret_key=$(rand_hex 32)
db_password=$(rand_hex 16)

sed -e "s|^ACCOUNT_SECRET_KEY=.*|ACCOUNT_SECRET_KEY=$secret_key|" \
    -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$db_password|" \
    .env.example > .env

echo ".env 已生成（随机 ACCOUNT_SECRET_KEY / DB_PASSWORD），位于项目根目录，不会提交到 git。"
echo "如需手机远程访问或微信推送等，可稍后编辑 .env 补充 CAS 凭据等配置。"
