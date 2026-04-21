const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const DATABASE_URL = process.env.DATABASE_URL || '';
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || 'pkmflip-change-this-secret';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cost NUMERIC(10,2) NOT NULL,
        market_price NUMERIC(10,2),
        image TEXT,
        buy_date TIMESTAMPTZ DEFAULT NOW(),
        sold BOOLEAN DEFAULT FALSE,
        sale_price NUMERIC(10,2),
        sold_date TIMESTAMPTZ
      );
    `);
    console.log('DB ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  } finally {
    client.release();
  }
}

function auth(req, res, next) {
  const token = req.cookies?.token || (req.headers?.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name',
      [email.toLowerCase().trim(), hash, displayName || email.split('@')[0]]
    );
    const user = r.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, displayName: user.display_name }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30*24*60*60*1000 });
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name } });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    console.error(e);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: user.id, email: user.email, displayName: user.display_name }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30*24*60*60*1000 });
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name } });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, displayName: req.user.displayName } });
});

app.get('/api/cards', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT id, name, cost::float, market_price::float as "marketPrice", image,
     buy_date as "buyDate", sold, sale_price::float as "salePrice", sold_date as "soldDate"
     FROM cards WHERE user_id = $1 ORDER BY buy_date DESC`,
    [req.user.id]
  );
  res.json(r.rows);
});

app.post('/api/cards', auth, async (req, res) => {
  const { name, cost, marketPrice, image } = req.body;
  const id = Date.now().toString();
  const r = await pool.query(
    `INSERT INTO cards (id, user_id, name, cost, market_price, image)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, name, cost::float, market_price::float as "marketPrice", image, buy_date as "buyDate", sold`,
    [id, req.user.id, name, cost, marketPrice||null, image||null]
  );
  res.json(r.rows[0]);
});

app.patch('/api/cards/:id/sell', auth, async (req, res) => {
  const r = await pool.query(
    `UPDATE cards SET sold=TRUE, sale_price=$1, sold_date=NOW()
     WHERE id=$2 AND user_id=$3
     RETURNING id, name, cost::float, market_price::float as "marketPrice", image,
     buy_date as "buyDate", sold, sale_price::float as "salePrice", sold_date as "soldDate"`,
    [req.body.salePrice, req.params.id, req.user.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Card not found' });
  res.json(r.rows[0]);
});

app.delete('/api/cards/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM cards WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

const priceCache = new Map();
function ebaySearchQuery(cardName) {
  return cardName
    .replace(/\b(PSA|BGS|CGC|SGC)\s*[\d.]+\b/gi, '')
    .replace(/\b\d{3}\/\d{3}\b/g, '')
    .replace(/\b(MEP|SVP|SSP|SVI|PAL|OBF|PAR|TWM|SCR|TEF|PRE|JTC|SFA)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

async function getMarketPrice(cardName) {
  const key = cardName.toLowerCase();
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.ts < 7200000) return cached.price;
  try {
    if (!EBAY_CLIENT_ID) return null;
    const query = ebaySearchQuery(cardName);
    const params = new URLSearchParams({
      'OPERATION-NAME':'findCompletedItems','SERVICE-VERSION':'1.0.3',
      'SECURITY-APPNAME':EBAY_CLIENT_ID,'RESPONSE-DATA-FORMAT':'JSON',
      'keywords':`pokemon ${query}`,'categoryId':'183454',
      'itemFilter(0).name':'SoldItemsOnly','itemFilter(0).value':'true',
      'itemFilter(1).name':'Currency','itemFilter(1).value':'USD',
      'sortOrder':'EndTimeSoonest','paginationInput.entriesPerPage':'50'
    });
    const r = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params}`);
    if (!r.ok) return null;
    const data = await r.json();
    const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    let prices = items.map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__||0)).filter(p=>p>1);
    if (prices.length < 3) return null;
    prices.sort((a,b)=>a-b);
    const trim = Math.max(1, Math.floor(prices.length*0.1));
    const t = prices.slice(trim, prices.length-trim);
    const mid = Math.floor(t.length/2);
    const median = t.length%2===0 ? (t[mid-1]+t[mid])/2 : t[mid];
    const price = Math.round(median*100)/100;
    priceCache.set(key, {price, ts:Date.now()});
    return price;
  } catch { return null; }
}

const imgCache = new Map();
async function getPokemonImage(cardName, cardNumber, setCode) {
  const key = (cardName + (cardNumber||'') + (setCode||'')).toLowerCase();
  if (imgCache.has(key)) return imgCache.get(key);
  try {
    let img = null;
    if (cardNumber && setCode) {
      const numClean = cardNumber.replace(/\/.*/, '').replace(/^0+/, '');
      const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=number:${numClean} set.ptcgoCode:${setCode.toLowerCase()}&pageSize=5`);
      if (r.ok) {
        const cards = (await r.json())?.data || [];
        const match = cards.find(c => c.rarity && /illustration|special/i.test(c.rarity)) || cards[0];
        img = match?.images?.large || match?.images?.small || null;
      }
    }
    if (!img) {
      const cleaned = cardName.replace(/\b(PSA|BGS|CGC|SGC)\s*[\d.]+\b/gi,'').replace(/[^a-zA-Z\s]/g,' ').trim().split(' ')[0];
      const r = await fetch(`https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(cleaned)}&pageSize=8`);
      if (r.ok) {
        const cards = (await r.json())?.data || [];
        const match = cards.find(c => c.rarity && /illustration|special/i.test(c.rarity)) || cards[0];
        img = match?.images?.large || match?.images?.small || null;
      }
    }
    imgCache.set(key, img);
    return img;
  } catch { return null; }
}

app.get('/api/market-price', auth, async (req, res) => {
  const [price, image] = await Promise.all([getMarketPrice(req.query.name), getPokemonImage(req.query.name)]);
  res.json({ price, image });
});

app.post('/api/scan', auth, async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64 || !ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Missing image or API key' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({
        model:'claude-opus-4-5', max_tokens:300,
        messages:[{role:'user',content:[
          {type:'image',source:{type:'base64',media_type:mediaType||'image/jpeg',data:imageBase64}},
          {type:'text',text:'Identify this Pokemon card carefully. Look at the card name, set symbol, card number, and art style. Respond ONLY with JSON: {"name":"Pokemon name only e.g. Tyrunt","set":"set name e.g. Prismatic Evolutions","number":"card number e.g. 070","setCode":"set code e.g. MEP","variant":"art variant e.g. Illustration Rare, Full Art, Rainbow Rare, Alt Art, or Standard","grade":"PSA/BGS/CGC grade if in slab or null","condition":"NM/LP/MP/HP if raw or null"}. If not a Pokemon card: {"name":null}.'}
        ]}]
      })
    });
    const data = await r.json();
    const parsed = JSON.parse((data.content?.[0]?.text||'{}').replace(/```json|```/g,'').trim());
    if (!parsed.name) return res.json({ detected: false });
    const variant = parsed.variant ? ` ${parsed.variant}` : '';
    const displayName = `${parsed.name}${variant}`.trim();
    const fullName = [displayName, parsed.grade].filter(Boolean).join(' ');
    const ebayName = [parsed.name, parsed.variant, parsed.grade].filter(Boolean).join(' ');
    const [marketPrice, image] = await Promise.all([
      getMarketPrice(ebayName),
      getPokemonImage(parsed.name, parsed.number, parsed.setCode)
    ]);
    res.json({ detected:true, name:fullName, grade:parsed.grade, condition:parsed.condition, marketPrice, image });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scan-lot', auth, async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64 || !ANTHROPIC_API_KEY) return res.status(400).json({ error: 'Missing image or API key' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({
        model:'claude-opus-4-5', max_tokens:1000,
        messages:[{role:'user',content:[
          {type:'image',source:{type:'base64',media_type:mediaType||'image/jpeg',data:imageBase64}},
          {type:'text',text:'Identify all Pokemon cards visible. Respond ONLY with JSON array: [{"name":"card name","grade":"grade or null","condition":"NM/LP/MP/HP or null"}]. Return [] if none.'}
        ]}]
      })
    });
    const data = await r.json();
    const parsed = JSON.parse((data.content?.[0]?.text||'[]').replace(/```json|```/g,'').trim());
    const results = await Promise.all(parsed.map(async card => {
      const fullName = [card.name, card.grade].filter(Boolean).join(' ');
      const [marketPrice, image] = await Promise.all([getMarketPrice(fullName), getPokemonImage(card.name)]);
      return { name:fullName, grade:card.grade, condition:card.condition, marketPrice, image };
    }));
    res.json({ cards: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rates', async (req, res) => {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await r.json();
    res.json({ CAD: data.rates.CAD, EUR: data.rates.EUR, GBP: data.rates.GBP });
  } catch { res.json({ CAD:1.38, EUR:0.92, GBP:0.79 }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`PKMflip v2 on port ${PORT}`);
  if (DATABASE_URL) await initDB();
  else console.warn('No DATABASE_URL set');
});
