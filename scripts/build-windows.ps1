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

function Assert-PackagedApplication {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AppDirectory
    )

    $asarPath = Join-Path $AppDirectory "resources\app.asar"
    $asarCli = Join-Path $projectRoot (
        "node_modules\@electron\asar\bin\asar.js"
    )
    if (-not (Test-Path -LiteralPath $asarPath)) {
        throw "The packaged application is missing resources\app.asar."
    }
    if (-not (Test-Path -LiteralPath $asarCli)) {
        throw "The local @electron/asar CLI is required for package validation."
    }

    $entries = @(& node.exe $asarCli list $asarPath)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect the packaged app.asar archive."
    }

    $requiredEntries = @(
        "\out\main\index.js",
        "\out\main\pdf.worker.min.mjs",
        "\out\renderer\pdfjs\standard_fonts\LiberationSans-Regular.ttf",
        "\out\renderer\pdfjs\wasm\openjpeg.wasm"
    )
    foreach ($entry in $requiredEntries) {
        if ($entries -notcontains $entry) {
            throw "The packaged application is missing required file: $entry"
        }
    }
    if (-not ($entries | Where-Object {
        $_ -match '^\\out\\main\\pdf-[^\\]+\.js$'
    } | Select-Object -First 1)) {
        throw "The packaged application is missing the bundled PDF.js main chunk."
    }
    if (-not ($entries | Where-Object {
        $_ -match '^\\out\\renderer\\assets\\pdf\.worker\.min-[^\\]+\.mjs$'
    } | Select-Object -First 1)) {
        throw "The packaged application is missing the PDF.js renderer worker."
    }

    # Runtime JavaScript is bundled into out/. Keep dependency trees, old
    # Python/ONNX workers, and local embedding models out of portable releases.
    $forbiddenPatterns = @(
        '(^|\\)node_modules(\\|$)',
        '(^|\\)models(\\|$)',
        '(^|\\)onnxruntime(?:-node|-common)?(\\|$)',
        '(^|\\)@huggingface(\\|$)',
        '(^|\\)pymupdf(\\|$)',
        '(^|\\)python(?:3)?(?:\.exe)?(\\|$)',
        'model_optimized(?:_int8)?\.onnx$',
        'paperxcel-worker(?:\.exe)?$'
    )
    foreach ($pattern in $forbiddenPatterns) {
        $match = $entries | Where-Object { $_ -match $pattern } |
            Select-Object -First 1
        if ($match) {
            throw "Forbidden release artifact found in app.asar: $match"
        }
    }

    $resourceModels = Join-Path $AppDirectory "resources\models"
    if (Test-Path -LiteralPath $resourceModels) {
        throw "Forbidden model directory found in the packaged application."
    }

    Write-Output (
        "Package contents verified: PDF.js runtime present; " +
        "Python and local embedding models absent."
    )
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
    Assert-PackagedApplication $packagedApp

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

    $packageVersion = (
        Get-Content -LiteralPath (Join-Path $projectRoot "package.json") `
            -Raw |
        ConvertFrom-Json
    ).version
    $temporaryArchivePath = Join-Path $tempOutput (
        "PaperXcel-$packageVersion-win-x64.zip"
    )
    if (-not (Test-Path -LiteralPath $temporaryArchivePath)) {
        throw "electron-builder did not produce the Windows portable ZIP."
    }

    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $releaseRoot -Force |
        ForEach-Object {
            if ($_.PSIsContainer) {
                Remove-CheckedDirectory $_.FullName $releaseRoot
            }
            else {
                Remove-Item -LiteralPath $_.FullName -Force
            }
        }

    $portableArchivePath = Join-Path $releaseRoot (
        "PaperXcel-$packageVersion-win-x64.zip"
    )
    Copy-Item -LiteralPath $temporaryArchivePath `
        -Destination $portableArchivePath -Force
    $portableArchive = Get-Item -LiteralPath $portableArchivePath

    Write-Output (
        "Windows portable release ready: {0} ({1:N2} MiB)" -f
        $portableArchive.FullName,
        ($portableArchive.Length / 1MB)
    )
}
finally {
    Pop-Location
    if (Test-Path -LiteralPath $tempOutput) {
        Remove-CheckedDirectory $tempOutput $systemTemp
    }
}
