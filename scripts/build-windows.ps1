$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$systemTemp = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::GetTempPath()
).TrimEnd("\")
$tempOutput = Join-Path $systemTemp (
    "paperxcel-release-" + [Guid]::NewGuid().ToString("N")
)
$releaseRoot = Join-Path $projectRoot "release"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE."
    }
}

function Remove-CheckedDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$AllowedRoot,
        [int]$Attempts = 6,
        [int]$DelayMilliseconds = 1000
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $resolvedRoot = (Resolve-Path -LiteralPath $AllowedRoot).Path.TrimEnd("\")
    if (-not $resolvedPath.StartsWith(
        "$resolvedRoot\",
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to remove a directory outside $resolvedRoot."
    }
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            Remove-Item -LiteralPath $resolvedPath -Recurse -Force -ErrorAction Stop
            return
        }
        catch {
            if ($attempt -eq $Attempts) {
                throw
            }
            Start-Sleep -Milliseconds $DelayMilliseconds
        }
    }
}

Push-Location $projectRoot
try {
    Invoke-Checked npm.cmd run build

    if (-not $env:ELECTRON_MIRROR) {
        $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    }
    if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
        $env:ELECTRON_BUILDER_BINARIES_MIRROR = (
            "https://npmmirror.com/mirrors/electron-builder-binaries/"
        )
    }

    Invoke-Checked npx.cmd electron-builder --win zip `
        "--config.directories.output=$tempOutput"

    $packagedApp = Join-Path $tempOutput "win-unpacked"
    $packagedExecutable = Join-Path $packagedApp "PaperXcel.exe"
    if (-not (Test-Path -LiteralPath $packagedExecutable)) {
        throw "electron-builder did not produce a complete unpacked application."
    }

    $previousExecutable = $env:PAPERXCEL_EXECUTABLE_PATH
    try {
        $env:PAPERXCEL_EXECUTABLE_PATH = $packagedExecutable
        Invoke-Checked node.exe tests/packaged-smoke.mjs
    }
    finally {
        if ($null -eq $previousExecutable) {
            Remove-Item Env:PAPERXCEL_EXECUTABLE_PATH -ErrorAction SilentlyContinue
        }
        else {
            $env:PAPERXCEL_EXECUTABLE_PATH = $previousExecutable
        }
    }

    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $releaseRoot -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "SHA256SUMS.txt" -or
            $_.Name -like "PaperXcel-*-win-x64.zip.sha256"
        } |
        Remove-Item -Force
    Get-ChildItem -LiteralPath $tempOutput -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (
            Join-Path $releaseRoot $_.Name
        ) -Force
    }

    $packageVersion = (
        Get-Content -LiteralPath (Join-Path $projectRoot "package.json") `
            -Raw |
        ConvertFrom-Json
    ).version
    $portableArchivePath = Join-Path $releaseRoot (
        "PaperXcel-$packageVersion-win-x64.zip"
    )
    if (-not (Test-Path -LiteralPath $portableArchivePath)) {
        throw "The Windows portable ZIP was not published to the release directory."
    }
    $portableArchive = Get-Item -LiteralPath $portableArchivePath

    Write-Output "Windows portable release ready: $($portableArchive.FullName)"
}
finally {
    Pop-Location
    if (Test-Path -LiteralPath $tempOutput) {
        Remove-CheckedDirectory $tempOutput $systemTemp
    }
}
