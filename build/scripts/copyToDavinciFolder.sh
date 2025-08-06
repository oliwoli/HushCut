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

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
PROJECT_ROOT="$SCRIPT_DIR/../../"

# Define both user and system-level folders
if [[ "$OSTYPE" == "darwin"* ]]; then
  USER_DAVINCI_FOLDER="$HOME/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit"
else
  USER_DAVINCI_FOLDER="$HOME/.local/share/DaVinciResolve/Fusion/Scripts/Edit"
fi

echo "Changing working directory to project root: $PROJECT_ROOT"
cd "$PROJECT_ROOT"

# Function to copy files into a target folder
copy_files() {
  TARGET_FOLDER="$1"
  echo "Copying files to: $TARGET_FOLDER"
  mkdir -p "$TARGET_FOLDER"

  # cp "python-backend/src/HushCut.py" "$TARGET_FOLDER/HushCut.py"
  # chmod +x "$TARGET_FOLDER/HushCut.py"
  
  # cp "build/bin/HushCut" "$TARGET_FOLDER/HushCut"
  # chmod +x "$TARGET_FOLDER/HushCut"


  cp "python-backend/src/HushCut.lua" "$TARGET_FOLDER/HushCut.lua"
  
  # cp "python-backend/src/dkjson.lua" "$TARGET_FOLDER/dkjson.lua"
  
  # cp "build/bin/python_backend" "$TARGET_FOLDER/python_backend"

  # Copy HushCut.app directory for macOS
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Copying HushCut.app to $TARGET_FOLDER"
    rm -rf "$TARGET_FOLDER/HushCut.app"
    cp -r "build/bin/HushCut.app" "$TARGET_FOLDER/HushCut.app"
    echo "Making HushCut binary executable"
    chmod +x "$TARGET_FOLDER/HushCut.app/Contents/MacOS/HushCut"
  else
    cp "build/bin/HushCut" "$TARGET_FOLDER/HushCut"
  fi
}

# Determine the target folder based on OS
# Determine the target folder based on OS and copy files
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "Detected macOS. Copying to both user and system DaVinci Resolve folders."
  copy_files "$USER_DAVINCI_FOLDER"
else
  # For other OS, defaulting to USER_DAVINCI_FOLDER
  echo "Detected non-macOS. Copying to user DaVinci Resolve folder."
  copy_files "$USER_DAVINCI_FOLDER"
fi

