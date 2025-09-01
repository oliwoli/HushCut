# Stop script execution on any error, similar to `set -e` in Bash.
$ErrorActionPreference = "Stop"

$InitialCWD = Get-Location
Write-Host "Hook invoked with initial CWD: $($InitialCWD.Path)"

# Get the last component of the directory path.
$LastDirComponent = (Split-Path $InitialCWD.Path -Leaf)
Write-Host "Last directory component of CWD: $LastDirComponent"

# If we are in the 'frontend' directory, skip the backend build.
if ($LastDirComponent -eq "frontend") {
    Write-Host "Detected frontend context (CWD's last component is 'frontend'). Skipping Python backend build steps."
    exit 0
}

Write-Host "Not a frontend context. Proceeding with Python backend build."

# $PSScriptRoot is a built-in variable for the directory of the script.
$ScriptDir = $PSScriptRoot
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path

Write-Host "Changing working directory to project root: $ProjectRoot"
Set-Location $ProjectRoot

# --- Configuration ---
$MainFileName = "python_backend"
$MainFilePath = "python-backend\src\HushCut.py" # Using backslashes for Windows paths

# --- Build Steps ---
try {
    Write-Host "Activating Python virtual environment..."
    # The activation script for PowerShell is different.
    . ".\python-backend\venv\Scripts\Activate.ps1"

    Write-Host "Installing/updating Python dependencies..."
    pip install -r python-backend\requirements.txt

    Write-Host "Running PyInstaller in onefile mode..."
    pyinstaller --onefile --name "$MainFileName" --optimize=2 `
        --distpath "dist\python_backend" `
        "$MainFilePath"

    Write-Host "Copying PyInstaller output to Wails build directory..."
    $TargetWailsBinFile = "build\bin\$($MainFileName).exe"
    $TargetWailsBinDir = Split-Path $TargetWailsBinFile -Parent

    # Ensure the target directory exists, similar to `mkdir -p`.
    if (-not (Test-Path $TargetWailsBinDir)) {
        New-Item -ItemType Directory -Path $TargetWailsBinDir -Force | Out-Null
    }

    # Remove old binary if it's present.
    if (Test-Path $TargetWailsBinFile) {
        Write-Host "Removing existing file: $TargetWailsBinFile"
        Remove-Item $TargetWailsBinFile -Force
    }
    
    # Move the new executable into place.
    $SourceFile = "dist\python_backend\$($MainFileName).exe"
    Move-Item -Path $SourceFile -Destination $TargetWailsBinFile -Force

    # The macOS .app bundle logic is not applicable on Windows, but is kept here for reference.
    # if ($IsMacOS) { ... }

    Write-Host "Cleaning up PyInstaller temporary directories..."
    if (Test-Path "build\$MainFileName") { Remove-Item -Path "build\$MainFileName" -Recurse -Force }
    if (Test-Path "dist") { Remove-Item -Path "dist" -Recurse -Force }
    if (Test-Path "$($MainFileName).spec") { Remove-Item "$($MainFileName).spec" -Force }

    Write-Host "Pre-build hook for Python backend completed successfully."

} catch {
    Write-Error "An error occurred during the build process: $_"
    exit 1
}

exit 0
