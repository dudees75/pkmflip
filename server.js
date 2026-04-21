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
    .replace(/\/\d{3}\b/g, '')
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
    let items = [];
    // Try with category filter first
    const r = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params}`);
    if (r.ok) {
      const data = await r.json();
      const errMsg = data?.findCompletedItemsResponse?.[0]?.errorMessage?.[0]?.error?.[0]?.message?.[0];
      if (errMsg) console.log('[EBAY] API error:', errMsg);
      const totalResults = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.['@count'];
      console.log('[EBAY] Query:', query, '-> results:', totalResults);
      items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    } else {
      const errText = await r.text().catch(() => 'unknown');
      console.log('[EBAY] HTTP error:', r.status, errText.slice(0, 300));
      // Fallback: try without category restriction
      const params2 = new URLSearchParams({
        'OPERATION-NAME':'findCompletedItems','SERVICE-VERSION':'1.0.3',
        'SECURITY-APPNAME':EBAY_CLIENT_ID,'RESPONSE-DATA-FORMAT':'JSON',
        'keywords':`pokemon card ${query}`,
        'itemFilter(0).name':'SoldItemsOnly','itemFilter(0).value':'true',
        'itemFilter(1).name':'Currency','itemFilter(1).value':'USD',
        'sortOrder':'EndTimeSoonest','paginationInput.entriesPerPage':'50'
      });
      const r2 = await fetch(`https://svcs.ebay.com/services/search/FindingService/v1?${params2}`);
      if (r2.ok) {
        const data2 = await r2.json();
        items = data2?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
        console.log('[EBAY] Fallback (no category) items:', items.length);
      } else {
        console.log('[EBAY] Fallback also failed:', r2.status);
        return null;
      }
    }
    let prices = items.map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__||0)).filter(p=>p>1);
    console.log('[EBAY] Valid prices found:', prices.length, prices.slice(0,5));
    if (prices.length < 1) return null;
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
    // Step 1: identify card with Claude Vision
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'You are a Pokemon card expert. Examine this card carefully. Read: 1) The exact Pokemon name at the top. 2) The card number at the bottom e.g. 093 from 093/167. 3) Art style: does artwork bleed to edges with no border = Illustration Rare or Special Illustration Rare; standard framed art = Standard. 4) If in a graded slab, the company and grade. Respond ONLY with JSON: {"name":"Pokemon name","number":"number with leading zeros e.g. 093","variant":"Illustration Rare, Special Illustration Rare, Full Art, Rainbow Rare, Alt Art, or Standard","grade":"PSA 10 or null","condition":"NM/LP/MP/HP or null"}. If not a Pokemon card: {"name":null}.' }
        ]}]
      })
    });
    const data = await r.json();
    const rawText = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    console.log('[SCAN] Vision response:', rawText);
    const parsed = JSON.parse(rawText);
    if (!parsed.name) return res.json({ detected: false });

    // Step 2: look up card in TCG API by name + number
    let verifiedSet = null;
    let image = null;
    let tcgCards = [];
    try {
      const numRaw = (parsed.number || '').replace(/\/.*/, '').trim();
      const numClean = numRaw.replace(/^0+/, '');
      if (numClean) {
        const q1 = `name:"${parsed.name}" number:${numClean}`;
        const r1 = await fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q1)}&pageSize=20`);
        if (r1.ok) tcgCards = (await r1.json())?.data || [];
        console.log('[SCAN] TCG by number:', q1, '->', tcgCards.length, 'found');
      }
      if (!tcgCards.length) {
        const q2 = `name:"${parsed.name}"`;
        const r2 = await fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q2)}&pageSize=20`);
        if (r2.ok) tcgCards = (await r2.json())?.data || [];
        console.log('[SCAN] TCG by name:', q2, '->', tcgCards.length, 'found');
      }
    } catch (e) { console.log('[SCAN] TCG fetch error:', e.message); }

    if (tcgCards.length === 1) {
      verifiedSet = tcgCards[0].set?.name || null;
      image = tcgCards[0].images?.large || tcgCards[0].images?.small || null;
      console.log('[SCAN] Single TCG match:', verifiedSet, tcgCards[0].rarity);
    } else if (tcgCards.length > 1) {
      // Step 3: visual cross-reference — fetch candidate images and ask Claude to pick best match
      const isIllustration = parsed.variant && /illustration|special/i.test(parsed.variant);
      const candidates = tcgCards.slice(0, 5).map(c => ({
        id: c.id, setName: c.set?.name, rarity: c.rarity,
        imageUrl: c.images?.small || c.images?.large,
        releaseDate: c.set?.releaseDate
      })).filter(c => c.imageUrl);

      // Fetch candidate images as base64
      const candidateImgs = await Promise.all(candidates.map(async c => {
        try {
          const cr = await fetch(c.imageUrl);
          if (!cr.ok) return null;
          const arrayBuf = await cr.arrayBuffer();
          return { ...c, b64: Buffer.from(arrayBuf).toString('base64') };
        } catch { return null; }
      }));
      const valid = candidateImgs.filter(Boolean);
      console.log('[SCAN] Visual match candidates:', valid.length);

      if (valid.length > 0) {
        try {
          const matchContent = [
            { type: 'text', text: `I scanned a Pokemon card: "${parsed.name}" number ${parsed.number}, variant "${parsed.variant || 'unknown'}". Here is the original scan followed by ${valid.length} TCG database candidates. Which candidate best matches the scanned card visually (same artwork colors, background, art style)? Respond ONLY with JSON: {"bestMatchId":"candidate id","confidence":"high/medium/low"}` },
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            ...valid.flatMap((c, i) => [
              { type: 'text', text: `Candidate ${i + 1} id:${c.id} set:${c.setName} rarity:${c.rarity}:` },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.b64 } }
            ])
          ];
          const mr = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 100, messages: [{ role: 'user', content: matchContent }] })
          });
          const md = await mr.json();
          const mt = (md.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
          console.log('[SCAN] Visual match result:', mt);
          const mp = JSON.parse(mt);
          console.log('[SCAN] bestMatchId from Claude:', mp.bestMatchId);
          const best = (mp.bestMatchId && valid.find(c => c.id === mp.bestMatchId))
            || (isIllustration
              ? valid.find(c => c.rarity && /special illustration/i.test(c.rarity))
                || valid.find(c => c.rarity && /illustration rare/i.test(c.rarity))
                || valid[0]
              : valid.sort((a,b) => new Date(b.releaseDate||0) - new Date(a.releaseDate||0))[0]);
          const bestFull = tcgCards.find(c => c.id === best.id);
          verifiedSet = best.setName;
          image = bestFull?.images?.large || best.imageUrl;
          console.log('[SCAN] Picked:', best.id, best.setName, 'confidence:', mp.confidence);
        } catch (e) {
          console.log('[SCAN] Visual match error:', e.message);
          // Fallback: prefer illustration rare or most recent
          const fallback = (isIllustration
            ? tcgCards.find(c => c.rarity && /illustration|special/i.test(c.rarity))
            : null) || tcgCards.sort((a, b) => new Date(b.set?.releaseDate || 0) - new Date(a.set?.releaseDate || 0))[0];
          verifiedSet = fallback?.set?.name || null;
          image = fallback?.images?.large || fallback?.images?.small || null;
        }
      }
    }

    // Build display name and eBay query
    const variant = parsed.variant && parsed.variant !== 'Standard' ? ` ${parsed.variant}` : '';
    const displayName = `${parsed.name}${variant}`.trim();
    const fullName = [displayName, parsed.grade].filter(Boolean).join(' ');
    const ebayNumber = parsed.number ? parsed.number.replace(/^0+/, '') : null;
    const ebayQuery = [parsed.name, ebayNumber, parsed.variant !== 'Standard' ? parsed.variant : null, verifiedSet, parsed.grade].filter(Boolean).join(' ');
    console.log('[SCAN] eBay query:', ebayQuery);

    const marketPrice = await getMarketPrice(ebayQuery);
    console.log('[SCAN] marketPrice:', marketPrice, '| image:', image ? 'found' : 'null');
    res.json({ detected: true, name: fullName, grade: parsed.grade, condition: parsed.condition, marketPrice, image });
  } catch (e) {
    console.log('[SCAN] Fatal error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
