#!/bin/bash
set -e

INITIAL_CWD=$(pwd)
echo "Hook invoked with initial CWD: $INITIAL_CWD"

LAST_DIR_COMPONENT=$(basename "$INITIAL_CWD")
echo "Last directory component of CWD: $LAST_DIR_COMPONENT"

if [ "$LAST_DIR_COMPONENT" = "frontend" ]; then
    echo "Detected frontend context. Skipping Python backend build."
    exit 0
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
PROJECT_ROOT="$SCRIPT_DIR/../../"
BACKEND_DIR="$PROJECT_ROOT/python-backend"

echo "Changing working directory to backend root: $BACKEND_DIR"
cd "$BACKEND_DIR"

MAIN_FILE_NAME="python_backend"
MAIN_FILE="src/HushCut.py"

echo "Syncing Python environment via uv..."
uv sync --frozen

echo "Running PyInstaller in onefile mode..."
uv run pyinstaller --onefile --name "$MAIN_FILE_NAME" --optimize=2 \
    --distpath "$PROJECT_ROOT/dist/python_backend" \
    "$MAIN_FILE"

TARGET_WAILS_BIN_DIR="$PROJECT_ROOT/build/bin/python_backend"

echo "Copying PyInstaller output to Wails build directory..."

if [ -f "$TARGET_WAILS_BIN_DIR" ]; then
    echo "Removing existing file: $TARGET_WAILS_BIN_DIR"
    rm "$TARGET_WAILS_BIN_DIR"
fi

mkdir -p "$(dirname "$TARGET_WAILS_BIN_DIR")"
mv -f "$PROJECT_ROOT/dist/python_backend/$MAIN_FILE_NAME" "$TARGET_WAILS_BIN_DIR"
chmod +x "$TARGET_WAILS_BIN_DIR"

MACAPP_DIR="$PROJECT_ROOT/build/bin/HushCut.app"
if [ -d "$MACAPP_DIR" ]; then
    echo "Detected macOS app bundle. Copying backend into Resources..."
    RESOURCES_DIR="$MACAPP_DIR/Contents/Resources"
    rm -f "$RESOURCES_DIR/python_backend"
    cp "$TARGET_WAILS_BIN_DIR" "$RESOURCES_DIR/python_backend"
fi

echo "Cleaning up PyInstaller temporary directories..."
rm -rf "$PROJECT_ROOT/dist"

echo "Pre-build hook for Python backend completed successfully."
exit 0
