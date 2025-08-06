#!/bin/bash
set -e # Exit immediately if a command exits with a non-zero status.

INITIAL_CWD=$(pwd)
echo "Hook invoked with initial CWD: $INITIAL_CWD"

LAST_DIR_COMPONENT=$(basename "$INITIAL_CWD")
echo "Last directory component of CWD: $LAST_DIR_COMPONENT"

if [ "$LAST_DIR_COMPONENT" = "frontend" ]; then
    echo "Detected frontend context (CWD's last component is 'frontend'). Skipping Python backend build steps."
    exit 0
fi

echo "Not a frontend context. Proceeding with Python backend build."
echo "Activating virtual environment and building Python binary with PyInstaller..."

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

PROJECT_ROOT="$SCRIPT_DIR/../../"

echo "Changing working directory to project root: $PROJECT_ROOT"
cd "$PROJECT_ROOT"
MAIN_FILE_NAME="HushCut"
MAIN_FILE="python-backend/HushCut.spec"

echo "Activating Python virtual environment from: $PROJECT_ROOT/python-backend/venv/bin/activate"
source python-backend/venv/bin/activate

echo "Installing/updating Python dependencies..."
pip install -r python-backend/requirements.txt

echo "Running PyInstaller with file: $MAIN_FILE"
pyinstaller $MAIN_FILE -y

echo "Copying PyInstaller output to Wails build directory..."

PYINSTALLER_DIST_MAIN_DIR="dist/$MAIN_FILE_NAME" # PyInstaller output directory for the 'main' executable
TARGET_WAILS_BIN_DIR="build/bin/python_backend"      # Wails expects the backend executable here

if [ -f "$TARGET_WAILS_BIN_DIR" ]; then
  echo "Removing existing file: $TARGET_WAILS_BIN_DIR"
  rm "$TARGET_WAILS_BIN_DIR"
fi

mkdir -p "$TARGET_WAILS_BIN_DIR"

echo "Cleaning up old backend dependencies in $PROJECT_ROOT/$TARGET_WAILS_BIN_DIR/_internal (if any)..."
rm -rf "$TARGET_WAILS_BIN_DIR/_internal"

echo "Moving new backend executable to $PROJECT_ROOT/$TARGET_WAILS_BIN_DIR/python_backend..."
mv -f "$PYINSTALLER_DIST_MAIN_DIR/$MAIN_FILE_NAME" "$TARGET_WAILS_BIN_DIR/python_backend"

echo "Moving new backend dependencies to $PROJECT_ROOT/$TARGET_WAILS_BIN_DIR/_internal..."
mv -f "$PYINSTALLER_DIST_MAIN_DIR/_internal" "$TARGET_WAILS_BIN_DIR/"

echo "Cleaning up PyInstaller temporary directories (PROJECT_ROOT/build/main and PROJECT_ROOT/dist)..."
rm -rf build/main # This is PyInstaller's own 'build' folder, not PROJECT_ROOT/build
rm -rf dist       # PyInstaller's 'dist' folder
echo "Pre-build hook for Python backend completed successfully."
exit 0
