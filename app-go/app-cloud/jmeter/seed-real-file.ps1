param(
    [int64]$Uid = 10001,
    [string]$AppBase = "https://127.0.0.1:8008",
    [int]$SizeMB = 10,
    # Edge upload_guard requires an app-user session for PUT bytes.
    # This is the opaque session token stored by the frontend under the
    # localStorage key "session_token"; send it as Authorization: Bearer.
    [string]$SessionToken = ""
)

$ErrorActionPreference = "Stop"
$size = [int64]$SizeMB * 1MB
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("cloud-seed-" + [guid]::NewGuid().ToString("N") + ".mp4")
[IO.File]::WriteAllBytes($tmp, (New-Object byte[] $size))

try {
    Write-Host "1/4 init upload uid=$Uid size=$size"
    $initBody = @{
        filename = "perf-real-" + [guid]::NewGuid().ToString("N") + ".mp4"
        fileSize = $size
        mimeType = "video/mp4"
    } | ConvertTo-Json -Compress

    $initRaw = curl.exe -sk -X POST "$AppBase/cloud/upload/init" `
        -H "X-Uid: $Uid" -H "Content-Type: application/json" `
        --data-binary $initBody
    $init = $initRaw | ConvertFrom-Json
    if (-not $init.uploadUuid) { throw "init failed: $initRaw" }
    if (-not $init.presignedUrls -or $init.presignedUrls.Count -eq 0) { throw "no presignedUrls: $initRaw" }
    $url = $init.presignedUrls[0].url
    Write-Host "    uploadUuid=$($init.uploadUuid) chunks=$($init.chunkCount)"

    Write-Host "2/4 PUT object bytes to OpenResty/MinIO"
    $headersFile = Join-Path ([IO.Path]::GetTempPath()) ("cloud-hdr-" + [guid]::NewGuid().ToString("N") + ".txt")
    $putArgs = @(
        "-sk", "-X", "PUT", "$url",
        "-H", "Content-Type: video/mp4",
        "--data-binary", "@$tmp",
        "-D", "$headersFile",
        "-o", "NUL"
    )
    if ($SessionToken -ne "") {
        $putArgs += @("-H", "Authorization: Bearer $SessionToken")
    }
    curl.exe @putArgs
    $putCode = (Get-Content $headersFile -ErrorAction SilentlyContinue | Select-String '^HTTP/' | Select-Object -Last 1).Line
    Write-Host "    PUT status=$putCode"
    $etagLine = Get-Content $headersFile | Where-Object { $_ -match '^ETag:' } | Select-Object -First 1
    if (-not $etagLine) { throw "PUT did not return ETag" }
    $etag = ($etagLine -replace '^ETag:\s*', '').Trim().Trim('"')
    Write-Host "    etag=$etag"

    Write-Host "3/4 complete multipart upload"
    $completeBody = @{
        parts = @(@{ PartNumber = 1; ETag = $etag })
    } | ConvertTo-Json -Depth 4 -Compress
    $completeRaw = curl.exe -sk -X POST "$AppBase/cloud/upload/$($init.uploadUuid)/complete" `
        -H "X-Uid: $Uid" -H "Content-Type: application/json" `
        --data-binary $completeBody
    $complete = $completeRaw | ConvertFrom-Json
    Write-Host "    status=$($complete.status) etag=$($complete.etag)"

    Write-Host "4/4 verify raw download URL"
    $raw = (curl.exe -sk -H "X-Uid: $Uid" "$AppBase/cloud/video/$($init.uploadUuid)/raw") | ConvertFrom-Json
    Write-Host "    rawUrl=$($raw.url)"
    Write-Host "OK uploadUuid=$($init.uploadUuid)"
    $init.uploadUuid
}
finally {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    Remove-Item -Force $headersFile -ErrorAction SilentlyContinue
}