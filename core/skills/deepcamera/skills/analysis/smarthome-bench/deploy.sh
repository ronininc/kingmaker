#!/usr/bin/env bash
# SmartHome-Bench deployment script
# Called by Aegis deployment agent during skill installation

set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "📦 Deploying SmartHome-Bench from: $SKILL_DIR"

# ── Check system dependencies ─────────────────────────────────────────────────

echo "🔍 Checking system dependencies..."

if ! command -v yt-dlp &>/dev/null; then
    echo "⚠️  yt-dlp not found. Attempting install..."
    if command -v brew &>/dev/null; then
        brew install yt-dlp
    elif command -v pip3 &>/dev/null; then
        pip3 install yt-dlp
    elif command -v apt-get &>/dev/null; then
        sudo apt-get install -y yt-dlp 2>/dev/null || pip3 install yt-dlp
    else
        echo "❌ Cannot install yt-dlp automatically. Please install manually:"
        echo "   pip install yt-dlp   OR   brew install yt-dlp"
        exit 1
    fi
fi
echo "  ✅ yt-dlp: $(yt-dlp --version)"

if ! command -v ffmpeg &>/dev/null; then
    echo "⚠️  ffmpeg not found. Attempting install..."
    if command -v brew &>/dev/null; then
        brew install ffmpeg
    elif command -v apt-get &>/dev/null; then
        sudo apt-get install -y ffmpeg
    else
        echo "❌ Cannot install ffmpeg automatically. Please install manually:"
        echo "   brew install ffmpeg   OR   apt-get install ffmpeg"
        exit 1
    fi
fi
echo "  ✅ ffmpeg: $(ffmpeg -version 2>&1 | head -1)"

# ── Install npm dependencies ──────────────────────────────────────────────────

echo "📦 Installing npm dependencies..."
cd "$SKILL_DIR"
npm install --production

echo "✅ SmartHome-Bench deployed successfully"
