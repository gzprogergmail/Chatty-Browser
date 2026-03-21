#!/bin/bash

echo "Installing Self-Contained Browser Agent..."
echo ""

echo "Step 1: Installing Node.js dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "Failed to install dependencies"
    exit 1
fi
echo ""

echo "Step 2: Installing Playwright browsers..."
npx playwright install chromium
if [ $? -ne 0 ]; then
    echo "Failed to install Playwright browsers"
    exit 1
fi
echo ""

echo "Step 3: Building TypeScript project..."
npm run build
if [ $? -ne 0 ]; then
    echo "Failed to build project"
    exit 1
fi
echo ""

echo "========================================"
echo "Setup complete!"
echo "========================================"
echo ""
echo "To run the agent:"
echo "  npm start"
echo ""
echo "Or in development mode:"
echo "  npm run dev"
echo ""
