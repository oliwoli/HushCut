#!/bin/bash
set -e

# Load .env file
set -o allexport
source .env
set +o allexport

# Run your script using Resolve's Python interpreter
/opt/resolve/python3.9/bin/python3 main.py
