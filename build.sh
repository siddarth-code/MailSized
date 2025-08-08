#!/bin/bash

# Debugging: Show current directory and files
echo "=== Current directory ==="
pwd
echo "=== Files in directory ==="
ls -la

# Install dependencies
echo "=== Installing dependencies ==="
pip install -r requirements.txt

# Show installed packages
echo "=== Installed packages ==="
pip freeze

# Create temp_uploads directory if needed
mkdir -p temp_uploads