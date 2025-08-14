#!/bin/bash
set -e  # Exit immediately if a command exits with a non-zero status.

INITIAL_CWD=$(pwd)
echo "Hook invoked with initial CWD: $INITIAL_CWD"

LAST_DIR_COMPONENT=$(basename "$INITIAL_CWD")
echo "Last directory component of CWD: $LAST_DIR_COMPONENT"

if [ "$LAST_DIR_COMPONENT" = "frontend" ]; then
    echo "Detected frontend context (CWD's last component is 'frontend'). Skipping Python backend build steps."
    exit 0
fi

echo "Not a frontend context. Proceeding with Python backend build."

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
PROJECT_ROOT="$SCRIPT_DIR/../../"

echo "Changing working directory to project root: $PROJECT_ROOT"
cd "$PROJECT_ROOT"

MAIN_FILE_NAME="python_backend"
MAIN_FILE="src/HushCut.py"   # adjust if your entrypoint is elsewhere

echo "Activating Python virtual environment from: $PROJECT_ROOT/python-backend/venv/bin/activate"
source python-backend/venv/bin/activate

echo "Installing/updating Python dependencies..."
pip install -r python-backend/requirements.txt

echo "Running PyInstaller in onefile mode..."
pyinstaller --onefile --name "$MAIN_FILE_NAME" --optimize=2 \
    --distpath dist/python_backend \
    python-backend/$MAIN_FILE

echo "Copying PyInstaller output to Wails build directory..."
TARGET_WAILS_BIN_DIR="build/bin/python_backend"

# Remove old binary if present
if [ -f "$TARGET_WAILS_BIN_DIR" ]; then
    echo "Removing existing file: $TARGET_WAILS_BIN_DIR"
    rm "$TARGET_WAILS_BIN_DIR"
fi

mkdir -p "$(dirname "$TARGET_WAILS_BIN_DIR")"

# Move the onefile binary into place
mv -f "dist/python_backend/$MAIN_FILE_NAME" "$TARGET_WAILS_BIN_DIR"
chmod +x "$TARGET_WAILS_BIN_DIR"

# If we have a macOS .app bundle, copy directly into Contents/Resources
MACAPP_DIR="build/bin/HushCut.app"
if [ -d "$MACAPP_DIR" ]; then
    echo "Detected macOS app bundle. Copying Python backend into Resources..."
    RESOURCES_DIR="$MACAPP_DIR/Contents/Resources"
    rm -f "$RESOURCES_DIR/python_backend"
    cp "$TARGET_WAILS_BIN_DIR" "$RESOURCES_DIR/python_backend"
fi

echo "Cleaning up PyInstaller temporary directories..."
rm -rf build/main  # PyInstaller's own build folder
rm -rf dist

echo "Pre-build hook for Python backend completed successfully."
exit 0
