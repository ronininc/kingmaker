#!/bin/bash
# HomeSafe-Bench deployment script
# Runs npm install to fetch openai SDK dependency

set -e
cd "$(dirname "$0")"
npm install
echo "✅ HomeSafe-Bench dependencies installed"
