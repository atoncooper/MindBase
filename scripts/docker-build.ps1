# scripts/docker-build.ps1
<#
.SYNOPSIS
构建 MindBase Docker 镜像并清理悬空镜像（dangling images）

.DESCRIPTION
自建镜像使用固定 tag（:latest），每次重新构建时旧镜像失去 tag 变为
<none>:<none> 悬空镜像并堆积占盘。本脚本在构建完成后自动执行
`docker image prune -f` 清理悬空镜像（不影响有 tag 的镜像）。

.EXAMPLE
.\scripts\docker-build.ps1            # 构建全部服务并清理
.\scripts\docker-build.ps1 backend    # 只构建 backend 并清理
#>

param(
    [string[]]$Service = @()
)

$ErrorActionPreference = "Stop"

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$PROJECT_ROOT = Split-Path -Parent $SCRIPT_DIR
Set-Location $PROJECT_ROOT

$composeArgs = @("compose", "build")
if ($Service.Count -gt 0) {
    $composeArgs += $Service
}

Write-Host "[INFO] docker $($composeArgs -join ' ')" -ForegroundColor Cyan
& docker @composeArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] 镜像构建失败" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "[INFO] 清理悬空镜像: docker image prune -f" -ForegroundColor Cyan
& docker image prune -f

Write-Host "[OK]   构建完成，悬空镜像已清理" -ForegroundColor Green
exit 0
