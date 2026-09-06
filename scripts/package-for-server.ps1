# 打包服务器部署包（在 Windows 本机运行）：
#   powershell -ExecutionPolicy Bypass -File scripts/package-for-server.ps1
# 产出 server-package/hdu-seat-server.tar.gz：
#   - 排除 node_modules / dist / .git / .vscode / 单元测试 / 开发调试脚本 / 开发 compose 覆盖文件 / 计划文档
#   - 保留真实 .env 与 auth.caddy（含密钥，压缩包仅用于上传到自己的服务器，切勿外发）
# 服务器上解压后两步部署：
#   1. sh scripts/deploy.sh
#   2. docker compose up -d --build
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$root = (Get-Location).Path

$outDir = Join-Path $root 'server-package'
$stage = Join-Path $outDir 'hdu-seat-server'
$tarball = Join-Path $outDir 'hdu-seat-server.tar.gz'

if (Test-Path $outDir) {
  # 删除旧输出可能撞上索引器/杀软瞬时占用，重试 3 次
  for ($i = 0; $i -lt 3; $i++) {
    try { Remove-Item -Recurse -Force $outDir -ErrorAction Stop; break }
    catch { if ($i -eq 2) { throw }; Start-Sleep -Seconds 2 }
  }
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# 排除目录：依赖/构建产物/版本控制/编辑器/测试/文档目录/打包输出自身
# 排除文件：单元测试、开发调试脚本、开发 compose 覆盖、除 README 外的 markdown
$robocopyArgs = @(
  $root, $stage, '/E',
  '/XD', 'node_modules', 'dist', '.git', '.vscode', 'coverage', 'test', 'docs', 'server-package',
  '/XF', '*.spec.ts', 'docker-compose.dev.yml',
  'debug-cookies.ts', 'scrape-api-names.ts', 'verify-appoint-messages.ts', 'package-for-server.ps1',
  '*.md'
)
& robocopy @robocopyArgs
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }

# README 单独放回（/XF *.md 已排除全部 markdown）
Copy-Item (Join-Path $root 'README.md') $stage

# 清除隐藏/系统属性（.gitignore 等点开头文件在 Windows 上带 Hidden 属性）
Get-ChildItem $stage -Recurse -Force |
  Where-Object { $_.Attributes -band ([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System) } |
  ForEach-Object { $_.Attributes = 'Normal' }

# 用 tar.gz 打包（Windows 10+ 自带 bsdtar）：
# 不用 zip —— .NET/Compress-Archive 生成的 zip 条目用反斜杠分隔路径，
# Linux 解压后文件名会带上字面反斜杠，目录结构损坏；tar 在两端行为一致
if (Test-Path $tarball) { Remove-Item -Force $tarball }
& tar -czf $tarball -C $outDir hdu-seat-server
if ($LASTEXITCODE -ne 0) { throw "tar 打包失败，退出码 $LASTEXITCODE" }

$sizeMb = [math]::Round((Get-Item $tarball).Length / 1MB, 1)
$specLeft = (Get-ChildItem $stage -Recurse -Filter '*.spec.ts' | Measure-Object).Count
Write-Host ""
Write-Host "打包完成：$tarball（$sizeMb MB）"
Write-Host "已排除：node_modules / dist / .git / .vscode / 单元测试 / 开发脚本 / 计划文档"
if ($specLeft -gt 0) { Write-Host "警告：包内仍残留 $specLeft 个 spec 文件" }

# 打包内容安全提醒：zip 内含真实 .env（密钥/CAS 凭据）与 auth.caddy（Basic Auth 哈希）
if (-not (Test-Path (Join-Path $stage '.env'))) { Write-Host '警告：.env 未打入包内（服务器上 deploy.sh 会生成模板并要求补填）' }
if (-not (Test-Path (Join-Path $stage 'auth.caddy'))) { Write-Host '警告：auth.caddy 未打入包内' }
Write-Host "上传到服务器后两步部署：sh scripts/deploy.sh && docker compose up -d --build"
