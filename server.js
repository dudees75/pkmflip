const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data', 'cards.json');
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── DATA PERSISTENCE ──────────────────────────────────────
async function readCards() {
  try {
    await fs.ensureFile(DATA_FILE);
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeCards(cards) {
  await fs.ensureFile(DATA_FILE);
  await fs.writeFile(DATA_FILE, JSON.stringify(cards, null, 2));
}

// ── EBAY TOKEN ────────────────────────────────────────────
let ebayToken = '';
let tokenExpiry = 0;

async function getEbayToken() {
  if (ebayToken && Date.now() < tokenExpiry - 60000) return ebayToken;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) return null;
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });
  const data = await res.json();
  if (!res.ok) return null;
  ebayToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return ebayToken;
}

// ── MARKET PRICE (eBay sold listings median) ──────────────
const priceCache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

async function getMarketPrice(cardName) {
  const cacheKey = cardName.toLowerCase();
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.price;

  try {
    const appId = EBAY_CLIENT_ID;
    if (!appId) return null;

    const params = new URLSearchParams({
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.0.3',
      'SECURITY-APPNAME': appId,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'keywords': `pokemon ${cardName}`,
      'categoryId': '183454',
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value': 'true',
      'itemFilter(1).name': 'Currency',
      'itemFilter(1).value': 'USD',
      'sortOrder': 'EndTimeSoonest',
      'paginationInput.entriesPerPage': '50'
    });

    const r = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params}`);
    if (!r.ok) return null;
    const data = await r.json();
    const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

    let prices = items
      .map(item => parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0))
      .filter(p => p > 1);

    if (prices.length < 3) return null;

    prices.sort((a, b) => a - b);
    const trim = Math.max(1, Math.floor(prices.length * 0.1));
    const trimmed = prices.slice(trim, prices.length - trim);
    const mid = Math.floor(trimmed.length / 2);
    const median = trimmed.length % 2 === 0
      ? (trimmed[mid - 1] + trimmed[mid]) / 2
      : trimmed[mid];

    const price = Math.round(median * 100) / 100;
    priceCache.set(cacheKey, { price, ts: Date.now() });
    return price;
  } catch {
    return null;
  }
}

// ── POKEMON TCG IMAGE ─────────────────────────────────────
const imgCache = new Map();

async function getPokemonImage(cardName) {
  const key = cardName.toLowerCase();
  if (imgCache.has(key)) return imgCache.get(key);

  try {
    const cleaned = cardName
      .replace(/\b(PSA|BGS|CGC|SGC)\s*[\d.]+\b/gi, '')
      .replace(/\b(holo|rare|ultra|secret|full art|alt art|rainbow|gold|ex|gx|vmax|vstar|v\b)/gi, '')
      .replace(/[^a-zA-Z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')[0];

    const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(cleaned)}&pageSize=1`);
    if (!r.ok) return null;
    const data = await r.json();
    const img = data?.data?.[0]?.images?.small || null;
    imgCache.set(key, img);
    return img;
  } catch {
    return null;
  }
}

// ── CARD SCAN (Claude Vision) ─────────────────────────────
app.post('/api/scan', async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'No Anthropic API key configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 }
            },
            {
              type: 'text',
              text: 'Identify this Pokemon card. Respond with ONLY a JSON object with these fields: {"name": "full card name including set and variant", "grade": "PSA/BGS/CGC grade if visible or null", "condition": "raw condition estimate NM/LP/MP/HP if ungraded"}. Example: {"name": "Charizard VMAX Alt Art", "grade": "PSA 10", "condition": null}. If this is not a Pokemon card respond with {"name": null, "grade": null, "condition": null}.'
            }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed.name) return res.json({ detected: false });

    const fullName = [parsed.name, parsed.grade].filter(Boolean).join(' ');
    const [marketPrice, image] = await Promise.all([
      getMarketPrice(fullName),
      getPokemonImage(parsed.name)
    ]);

    res.json({ detected: true, name: fullName, grade: parsed.grade, condition: parsed.condition, marketPrice, image });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LOT SCAN (Claude Vision — multiple cards) ─────────────
app.post('/api/scan-lot', async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: 'No Anthropic API key configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 }
            },
            {
              type: 'text',
              text: 'Identify all visible Pokemon cards in this image. Respond with ONLY a JSON array. Each item: {"name": "card name", "grade": "grade if in slab or null", "condition": "NM/LP/MP/HP if raw"}. Example: [{"name":"Charizard VMAX","grade":"PSA 10","condition":null},{"name":"Pikachu VMAX","grade":null,"condition":"NM"}]. Return empty array [] if no Pokemon cards visible.'
            }
          ]
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    const results = await Promise.all(parsed.map(async (card) => {
      const fullName = [card.name, card.grade].filter(Boolean).join(' ');
      const [marketPrice, image] = await Promise.all([
        getMarketPrice(fullName),
        getPokemonImage(card.name)
      ]);
      return { name: fullName, grade: card.grade, condition: card.condition, marketPrice, image };
    }));

    res.json({ cards: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MARKET PRICE LOOKUP ───────────────────────────────────
app.get('/api/market-price', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const price = await getMarketPrice(name);
  const image = await getPokemonImage(name);
  res.json({ price, image });
});

// ── CARDS CRUD ────────────────────────────────────────────
app.get('/api/cards', async (req, res) => {
  const cards = await readCards();
  res.json(cards);
});

app.post('/api/cards', async (req, res) => {
  const cards = await readCards();
  const card = {
    id: Date.now().toString(),
    ...req.body,
    buyDate: new Date().toISOString(),
    sold: false
  };
  cards.push(card);
  await writeCards(cards);
  res.json(card);
});

app.patch('/api/cards/:id/sell', async (req, res) => {
  const cards = await readCards();
  const idx = cards.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Card not found' });
  cards[idx] = { ...cards[idx], sold: true, salePrice: req.body.salePrice, soldDate: new Date().toISOString() };
  await writeCards(cards);
  res.json(cards[idx]);
});

app.delete('/api/cards/:id', async (req, res) => {
  const cards = await readCards();
  const filtered = cards.filter(c => c.id !== req.params.id);
  await writeCards(filtered);
  res.json({ ok: true });
});

// ── EXCHANGE RATES ────────────────────────────────────────
app.get('/api/rates', async (req, res) => {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await r.json();
    res.json({ CAD: data.rates.CAD, EUR: data.rates.EUR, GBP: data.rates.GBP });
  } catch {
    res.json({ CAD: 1.38, EUR: 0.92, GBP: 0.79 });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PKMflip running on port ${PORT}`));
