#!/bin/bash
# LUMINA Deployment Script
# Run this from the Assignment_1_Lumina root folder

echo "🚀 Deploying LUMINA..."

# ── Step 1: Create MongoDB indexes ──────────────────────────
echo "\n📦 Creating MongoDB indexes..."
node scripts/create-indexes.mjs

# ── Step 2: Deploy Agent Service ────────────────────────────
echo "\n🤖 Deploying Agent Service to Fly.io..."
cd backend/agent

fly launch --no-deploy --name lumina-agent --region bom

# Set all secrets (never in fly.toml!)
fly secrets set \
  MONGODB_URI="$MONGODB_URI" \
  OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  TAVILY_API_KEY="$TAVILY_API_KEY"

fly deploy
AGENT_URL=$(fly status --json | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('https://'+d.Hostname);
")
echo "✅ Agent deployed at: $AGENT_URL"

# ── Step 3: Deploy Gateway ───────────────────────────────────
echo "\n🚪 Deploying Gateway to Fly.io..."
cd ../gateway

fly launch --no-deploy --name lumina-gateway --region bom

fly secrets set \
  AGENT_URL="$AGENT_URL"

fly deploy
GATEWAY_URL=$(fly status --json | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('https://'+d.Hostname);
")
echo "✅ Gateway deployed at: $GATEWAY_URL"

# ── Step 4: Test deployment ──────────────────────────────────
echo "\n🔍 Testing deployment..."
curl -sf "$GATEWAY_URL/health" && echo "✅ Health check passed!"

cd ../..
echo "\n✅ Deployment complete!"
echo "Gateway URL: $GATEWAY_URL"
echo "Submit this URL on Vercel after deploying the UI"