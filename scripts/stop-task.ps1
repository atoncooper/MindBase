# scripts/stop-task.ps1
<#
.SYNOPSIS
停止前端 + 后端 + app-task（本地开发模式启动的 3 个进程）
.EXAMPLE
.\scripts\stop-task.ps1
#>

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

if ($PSCommandPath) {
    $ScriptDir = Split-Path -Parent $PSCommandPath
} else {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location -Path $ProjectRoot

$PidFile = Join-Path $ProjectRoot "logs\.task-stack.pids"

function LogInfo { param([string]$Msg) Write-Host "[INFO] $Msg" -ForegroundColor Cyan }
function LogOk   { param([string]$Msg) Write-Host "[OK]   $Msg" -ForegroundColor Green }
function LogWarn { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }

if (-not (Test-Path $PidFile)) {
    LogWarn "No PID file ($PidFile). Nothing to stop."
    exit 0
}

$pids = (Get-Content $PidFile).Split(" ")
$names = @("backend", "app-task", "frontend")
for ($i = 0; $i -lt $pids.Length; $i++) {
    $pidStr = $pids[$i].Trim()
    $name = if ($i -lt $names.Length) { $names[$i] } else { "process" }
    if ($pidStr -match "^\d+$") {
        $procId = [int]$pidStr
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $procId -Force
            LogOk "Stopped $name (PID $procId)"
        } else {
            LogWarn "${name}: PID $procId not running (skip)"
        }
    }
}

Remove-Item $PidFile -Force
LogOk "Stack stopped"
exit 0
