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

TARGET_WAILS_BIN="$PROJECT_ROOT/bin/python_backend"
LEGACY_WAILS_BIN="$PROJECT_ROOT/build/bin/python_backend"

echo "Copying PyInstaller output to Wails bin directories..."

mkdir -p "$(dirname "$TARGET_WAILS_BIN")"
cp -f "$PROJECT_ROOT/dist/python_backend/$MAIN_FILE_NAME" "$TARGET_WAILS_BIN"
chmod +x "$TARGET_WAILS_BIN"

mkdir -p "$(dirname "$LEGACY_WAILS_BIN")"
cp -f "$PROJECT_ROOT/dist/python_backend/$MAIN_FILE_NAME" "$LEGACY_WAILS_BIN"
chmod +x "$LEGACY_WAILS_BIN"

# Copy to any existing macOS app bundles
for app_bundle in "$PROJECT_ROOT/bin/HushCut.app" "$PROJECT_ROOT/bin/HushCut.dev.app" "$PROJECT_ROOT/build/bin/HushCut.app"; do
    if [ -d "$app_bundle" ]; then
        echo "Detected macOS app bundle at $app_bundle. Copying backend into Resources..."
        resources_dir="$app_bundle/Contents/Resources"
        mkdir -p "$resources_dir"
        cp -f "$TARGET_WAILS_BIN" "$resources_dir/python_backend"
        chmod +x "$resources_dir/python_backend"
    fi
done

echo "Cleaning up PyInstaller temporary directories..."
rm -rf "$PROJECT_ROOT/dist"

echo "Pre-build hook for Python backend completed successfully."
exit 0
