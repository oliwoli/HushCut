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

DAVINCI_FOLDER="$HOME/.local/share/DaVinciResolve/Fusion/Scripts/Edit"

echo "Changing working directory to project root: $PROJECT_ROOT"
cd "$PROJECT_ROOT"

cp "python-backend/src/HushCut.py" "$DAVINCI_FOLDER/HushCut.py"
cp "build/bin/python_backend" "$DAVINCI_FOLDER/python_backend"
cp -rfT "python-backend/src/hushcut_lib" "$DAVINCI_FOLDER/hushcut_lib"


exit 0
