param(
    [ValidateSet("read", "quota", "search", "upload-init")]
    [string]$Scenario = "read",
    [int]$Threads = 20,
    [int]$Ramp = 10,
    [int]$Duration = 60,
    [string]$HostName = "127.0.0.1",
    [int]$Port = 8007,
    [string]$Protocol = "https",
    [string]$UidsFile = "",
    [string]$Jmeter = "jmeter"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$plan = Join-Path $here ("app-cloud-" + $Scenario + ".jmx")
if (-not (Test-Path $plan)) {
    throw "Unknown scenario '$Scenario' (expected read, quota, search, upload-init)"
}

if ([string]::IsNullOrWhiteSpace($UidsFile)) {
    $UidsFile = Join-Path $here "uids.csv"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$resultDir = Join-Path $here ("results\" + $Scenario + "-" + $stamp)
$jtl = Join-Path $resultDir "results.jtl"
New-Item -ItemType Directory -Force -Path $resultDir | Out-Null

$jmeterArgs = @(
    "-n",
    "-t", $plan,
    "-q", (Join-Path $here "loadtest.properties"),
    "-l", $jtl,
    "-e", "-o", $resultDir,
    "-Jhost=$HostName",
    "-Jport=$Port",
    "-Jprotocol=$Protocol",
    "-Jthreads=$Threads",
    "-Jramp=$Ramp",
    "-Jduration=$Duration",
    "-JuidsFile=$UidsFile"
)

Write-Host "Running JMeter: $Scenario threads=$Threads ramp=$Ramp target=${Protocol}://${HostName}:${Port}"
& $Jmeter @jmeterArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
Write-Host "JMeter HTML report: $(Join-Path $resultDir 'index.html')"