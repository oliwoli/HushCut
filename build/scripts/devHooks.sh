#!/bin/bash
set -e

# Run your pre-dev logic here
echo "Running pre-dev hook..."
cd ../
bash ./build/scripts/preBuild.sh
# bash ./build/scripts/postBuild.sh

# Wait forever so this process doesn't exit immediately and kill dev mode
# You can replace this with any watcher, like chokidar, etc.
echo "Watcher started. Press Ctrl+C to stop."
cd frontend

echo "starting pnpm dev"
pwd
pnpm run dev
