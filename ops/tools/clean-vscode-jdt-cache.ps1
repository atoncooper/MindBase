# Clean VS Code JDT (Java) language-server workspace cache - the same thing the
# "Java: Clean Java Language Server Workspace" command does, as a one-shot script.
# Flow: wait for ALL Code.exe to exit -> delete redhat.java caches -> relaunch VS Code.
# Safe: only redhat.java cache dirs are touched; extension/user settings are not modified.
$ErrorActionPreference = "Stop"
$targets = @(
    "$env:APPDATA\Code\User\globalStorage\redhat.java"
)
$wsRoot = "$env:APPDATA\Code\User\workspaceStorage"
if (Test-Path $wsRoot) {
    $targets += (Get-ChildItem $wsRoot -Directory | ForEach-Object { Join-Path $_.FullName "redhat.java" }) | Where-Object { Test-Path $_ }
}

Write-Host "[clean-jdt] waiting for ALL VS Code windows to close (close every Code.exe window)..."
while (Get-Process -Name Code -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 2
}
Write-Host "[clean-jdt] VS Code closed. Cleaning caches..."

foreach ($t in $targets) {
    if (Test-Path $t) {
        try {
            Remove-Item -Recurse -Force $t
            Write-Host "[clean-jdt] deleted $t"
        } catch {
            Write-Host "[clean-jdt] WARN could not delete $t : $($_.Exception.Message)"
        }
    } else {
        Write-Host "[clean-jdt] not present (skip): $t"
    }
}

Write-Host "[clean-jdt] done. Relaunching VS Code..."
Start-Process "code"
Write-Host "[clean-jdt] VS Code relaunched. Reopen the Java project and check the Problems panel."
