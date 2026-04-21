# PKMflip — Pokemon Card Profit Tracker

## Environment Variables (set in Railway)

| Variable | Required | Description |
|---|---|---|
| `EBAY_CLIENT_ID` | Yes | eBay Developer App ID (for market prices) |
| `EBAY_CLIENT_SECRET` | Yes | eBay Developer Cert ID |
| `ANTHROPIC_API_KEY` | Yes | Claude API key (for card scanning) |

## Local Development

```bash
npm install
EBAY_CLIENT_ID=xxx EBAY_CLIENT_SECRET=xxx ANTHROPIC_API_KEY=xxx node server.js
```

Then open http://localhost:3000

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Connect repo in Railway
3. Add environment variables
4. Deploy — Railway auto-detects Node.js
