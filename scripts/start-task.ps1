# scripts/start-task.ps1
<#
.SYNOPSIS
一键启动前端 + 后端 + app-task（本地开发模式，3 个进程）
.DESCRIPTION
基础设施（mysql/mongo/redis/APISIX/XXL-JOB）请自行启动，例如：
  docker compose up -d mysql mongo redis
.EXAMPLE
.\scripts\start-task.ps1
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

$LogDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$PidFile = Join-Path $LogDir ".task-stack.pids"

function LogInfo { param([string]$Msg) Write-Host "[INFO] $Msg" -ForegroundColor Cyan }
function LogOk   { param([string]$Msg) Write-Host "[OK]   $Msg" -ForegroundColor Green }
function LogFail { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
function LogWarn { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }

# Already running?
if (Test-Path $PidFile) {
    LogWarn "PID file exists. Run .\scripts\stop-task.ps1 first, or remove $PidFile"
    exit 1
}

# Try conda (optional)
$condaEnv = "mind-base"
try { conda activate $condaEnv 2>$null } catch {}

# 1. backend (uvicorn :8000)
LogInfo "Starting backend (uvicorn :8000)..."
$b = Start-Process python -ArgumentList "-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8000" `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput (Join-Path $LogDir "backend.log") `
    -RedirectStandardError (Join-Path $LogDir "backend.err") `
    -PassThru -WindowStyle Hidden

# 2. app-task (uvicorn :8001)
LogInfo "Starting app-task (uvicorn :8001)..."
$a = Start-Process python -ArgumentList "-m","uvicorn","main:app","--app-dir","app-task","--host","127.0.0.1","--port","8001" `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput (Join-Path $LogDir "app-task.log") `
    -RedirectStandardError (Join-Path $LogDir "app-task.err") `
    -PassThru -WindowStyle Hidden

# 3. frontend (npm run dev :3000)
LogInfo "Starting frontend (npm run dev :3000)..."
$frontendDir = Join-Path $ProjectRoot "frontend"
$f = Start-Process npm -ArgumentList "run","dev" `
    -WorkingDirectory $frontendDir `
    -RedirectStandardOutput (Join-Path $LogDir "frontend.log") `
    -RedirectStandardError (Join-Path $LogDir "frontend.err") `
    -PassThru -WindowStyle Hidden

# Save PIDs
"$($b.Id) $($a.Id) $($f.Id)" | Set-Content -Path $PidFile -Encoding ASCII

# Wait for ports
function Test-PortOpen {
    param([int]$Port)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect("127.0.0.1", $Port)
        $client.Close()
        return $true
    } catch { return $false }
}
function WaitPort {
    param([int]$Port, [string]$Name)
    for ($i = 0; $i -lt 80; $i++) {
        if (Test-PortOpen $Port) { LogOk "$Name ready at :$Port"; return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

if (-not (WaitPort 8000 "backend"))   { LogFail "backend not ready (check logs\backend.err)"; exit 1 }
if (-not (WaitPort 8001 "app-task"))  { LogFail "app-task not ready (check logs\app-task.err)"; exit 1 }
if (-not (WaitPort 3000 "frontend"))  { LogFail "frontend not ready (check logs\frontend.err)"; exit 1 }

Write-Host ""
LogOk "Stack started (local dev):"
Write-Host "  Frontend  http://localhost:3000" -ForegroundColor Cyan
Write-Host "  Backend   http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host "  app-task  http://localhost:8001/docs" -ForegroundColor Cyan
Write-Host ""
LogInfo "PIDs: backend=$($b.Id)  app-task=$($a.Id)  frontend=$($f.Id)"
LogInfo "Logs: logs\backend.log  logs\app-task.log  logs\frontend.log"
LogInfo "Stop: .\scripts\stop-task.ps1"
LogWarn "Infra (mysql/mongo/redis/APISIX/XXL-JOB) NOT started by this script - run separately."

exit 0
