// server.js — Express API + hourly scrape scheduler
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const cron      = require('node-cron');
const NodeCache = require('node-cache');

const { scrapeHeroStats, scrapeHeroDetail } = require('./scraper');
const { analyzeHero, analyzeSynergy }       = require('./ai');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Simple in-memory rate limiter — max 60 requests/min per IP
const rateLimitMap = new Map();
app.use((req, res, next) => {
  // Skip rate limiting for scrape health check
  if (req.path === '/') return next();

  const ip  = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const max = 60;

  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);

  if (entry.count > max) {
    return res.status(429).json({ error: 'Too many requests. Limit: 60/min.' });
  }
  next();
});

// Clean up rate limit map every 5 minutes to avoid memory leak
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, entry] of rateLimitMap) {
    if (entry.start < cutoff) rateLimitMap.delete(ip);
  }
}, 300_000);

// ─── Data Store ───────────────────────────────────────────────────────────────
let store = {
  heroes:      [],
  tierList:    {},
  leaderboard: [],
  lastUpdated: null,
  status:      'initializing',
  scrapeErrors: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildTierList(heroes) {
  const tiers = {};
  heroes.forEach(h => {
    if (!tiers[h.tier]) tiers[h.tier] = [];
    tiers[h.tier].push(h.name);
  });
  const order  = ['S+', 'S', 'A', 'B', 'C', 'Unranked'];
  const sorted = {};
  order.forEach(t => { if (tiers[t]) sorted[t] = tiers[t]; });
  Object.keys(tiers).forEach(t => { if (!sorted[t]) sorted[t] = tiers[t]; });
  return sorted;
}

function buildLeaderboard(heroes) {
  const top = (arr, category, stat) =>
    arr.slice(0, 10).map((h, i) => ({
      rank: i + 1, name: h.name, category,
      role: h.role || '—', points: h[stat], hero: h.name, img: h.img,
    }));
  return [
    ...top([...heroes].sort((a, b) => b._winRate  - a._winRate),  'Top Win Rate', 'winRate'),
    ...top([...heroes].sort((a, b) => b._banRate  - a._banRate),  'Most Banned',  'banRate'),
    ...top([...heroes].sort((a, b) => b._pickRate - a._pickRate), 'Most Picked',  'pickRate'),
  ];
}

// ─── Master Scrape ────────────────────────────────────────────────────────────
async function runScrape() {
  console.log('\n[CRON] Starting scrape cycle...');
  store.status = 'scraping';

  try {
    const heroes = await scrapeHeroStats();

    if (!heroes.length) throw new Error('Scrape returned 0 heroes');

    store.heroes      = heroes;
    store.tierList    = buildTierList(heroes);
    store.leaderboard = buildLeaderboard(heroes);
    store.lastUpdated = new Date().toISOString();
    store.status      = 'ready';
    store.scrapeErrors = 0;

    cache.flushAll();
    console.log(`[CRON] Done. Heroes: ${heroes.length}, Tiers: ${Object.keys(store.tierList).length}, Leaderboard: ${store.leaderboard.length}`);
  } catch (err) {
    store.scrapeErrors++;
    store.status = store.heroes.length ? 'stale' : 'error'; // stale = old data still served
    console.error(`[CRON] Scrape failed (attempt ${store.scrapeErrors}):`, err.message);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    service:     'MLBB Analysis API',
    status:      store.status,
    lastUpdated: store.lastUpdated,
    heroCount:   store.heroes.length,
    scrapeErrors: store.scrapeErrors,
    endpoints: [
      'GET  /api/heroes?role=&tier=&sort=winrate|banrate|pickrate&search=',
      'GET  /api/heroes/:name',
      'GET  /api/tier-list',
      'GET  /api/leaderboard?category=&limit=',
      'GET  /api/analyze/:heroName',
      'GET  /api/synergy/:hero1/:hero2',
      'GET  /api/search?q=',
      'POST /api/scrape  (x-scrape-secret header required)',
    ]
  });
});

// Hero list — with search support
app.get('/api/heroes', (req, res) => {
  const { role, tier, sort, search } = req.query;
  let heroes = [...store.heroes];

  if (search) {
    const q = search.toLowerCase();
    heroes = heroes.filter(h => h.name?.toLowerCase().includes(q) || h.role?.toLowerCase().includes(q));
  }
  if (role) heroes = heroes.filter(h => h.role?.toLowerCase().includes(role.toLowerCase()));
  if (tier) heroes = heroes.filter(h => h.tier?.toLowerCase() === tier.toLowerCase());
  if (sort === 'winrate')  heroes.sort((a, b) => b._winRate  - a._winRate);
  if (sort === 'banrate')  heroes.sort((a, b) => b._banRate  - a._banRate);
  if (sort === 'pickrate') heroes.sort((a, b) => b._pickRate - a._pickRate);

  // Strip internal _fields from response
  const clean = heroes.map(({ _winRate, _banRate, _pickRate, ...h }) => h);
  res.json({ count: clean.length, lastUpdated: store.lastUpdated, data: clean });
});

// Hero search endpoint
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ data: [] });

  const results = store.heroes
    .filter(h => h.name?.toLowerCase().includes(q) || h.role?.toLowerCase().includes(q))
    .slice(0, 10)
    .map(({ _winRate, _banRate, _pickRate, ...h }) => h);

  res.json({ query: q, count: results.length, data: results });
});

// Single hero detail
app.get('/api/heroes/:slug', async (req, res) => {
  const slug     = req.params.slug.toLowerCase();
  const cacheKey = `hero_detail_${slug}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  const base = store.heroes.find(h => h.name?.toLowerCase() === slug);
  if (!base) return res.status(404).json({ error: `Hero "${slug}" not found` });

  const detail = await scrapeHeroDetail(slug, store.heroes);
  const { _winRate, _banRate, _pickRate, ...baseClean } = base;
  const full   = { ...baseClean, ...detail };

  cache.set(cacheKey, full, 3600);
  res.json({ source: 'live', data: full });
});

// Tier list
app.get('/api/tier-list', (req, res) => {
  res.json({ lastUpdated: store.lastUpdated, data: store.tierList });
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const { category, limit } = req.query;
  let data = [...store.leaderboard];
  if (category) data = data.filter(e => e.category.toLowerCase().includes(category.toLowerCase()));
  res.json({ lastUpdated: store.lastUpdated, data: data.slice(0, parseInt(limit) || 50) });
});

// AI hero analysis
app.get('/api/analyze/:heroName', async (req, res) => {
  const name     = req.params.heroName;
  const cacheKey = `ai_analysis_${name.toLowerCase()}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', hero: name, analysis: cached });

  const heroData = store.heroes.find(h => h.name?.toLowerCase() === name.toLowerCase()) || { name };

  try {
    const analysis = await analyzeHero(heroData);
    cache.set(cacheKey, analysis, 3600);
    res.json({ source: 'ai', hero: name, analysis });
  } catch (err) {
    res.status(500).json({ error: 'AI analysis failed', message: err.message });
  }
});

// AI synergy
app.get('/api/synergy/:hero1/:hero2', async (req, res) => {
  const { hero1, hero2 } = req.params;

  if (hero1.toLowerCase() === hero2.toLowerCase()) {
    return res.status(400).json({ error: 'Cannot analyze synergy between the same hero' });
  }

  const cacheKey = [hero1, hero2].map(h => h.toLowerCase()).sort().join('_'); // order-independent cache
  const cached = cache.get(`synergy_${cacheKey}`);
  if (cached) return res.json({ source: 'cache', heroes: [hero1, hero2], synergy: cached });

  const h1 = store.heroes.find(h => h.name?.toLowerCase() === hero1.toLowerCase()) || { name: hero1 };
  const h2 = store.heroes.find(h => h.name?.toLowerCase() === hero2.toLowerCase()) || { name: hero2 };

  try {
    const synergy = await analyzeSynergy(h1, h2);
    cache.set(`synergy_${cacheKey}`, synergy, 3600);
    res.json({ source: 'ai', heroes: [hero1, hero2], synergy });
  } catch (err) {
    res.status(500).json({ error: 'Synergy analysis failed', message: err.message });
  }
});

// Manual scrape trigger
app.post('/api/scrape', async (req, res) => {
  if (req.headers['x-scrape-secret'] !== process.env.SCRAPE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (store.status === 'scraping') {
    return res.status(409).json({ error: 'Scrape already in progress' });
  }
  res.json({ message: 'Scrape started' });
  runScrape();
});

// ─── Serve frontend from /public folder ──────────────────────────────────────
// Put index.html inside a /public folder next to server.js.
// Backend and frontend share one Railway service — no URL config needed.
const path = require('path');
const fs   = require('fs');
const publicDir = path.join(__dirname, 'public');

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res) => {
    const indexFile = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
    res.status(404).json({ error: 'Not found' });
  });
} else {
  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });
}

// ─── Cron: every hour ─────────────────────────────────────────────────────────
cron.schedule('0 * * * *', () => {
  console.log('[CRON] Hourly scrape triggered');
  runScrape();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  console.log(`
🚀 MLBB API running on port ${PORT}`);
  console.log(`🌐 Public URL: ${host}`);
  console.log(`📡 Scraping mlbb-stats.ridwaanhall.com every hour`);
  console.log(`🤖 AI powered by Claude (Anthropic)\n`);
  await runScrape();
});
