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

app.use(cors());
app.use(express.json());

// ─── Data Store ───────────────────────────────────────────────────────────────
let store = {
  heroes:      [],
  tierList:    {},
  leaderboard: [],
  lastUpdated: null,
  status:      'initializing'
};

// ─── Build tier list from hero array ─────────────────────────────────────────
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

// ─── Build leaderboard from hero array ───────────────────────────────────────
function buildLeaderboard(heroes) {
  const top = (arr, category, stat) =>
    arr.slice(0, 10).map((h, i) => ({
      rank: i + 1, name: h.name, category,
      role: h.role || '—', points: h[stat], hero: h.name, img: h.img,
    }));

  const byWin  = top([...heroes].sort((a, b) => b._winRate  - a._winRate),  'Top Win Rate',  'winRate');
  const byBan  = top([...heroes].sort((a, b) => b._banRate  - a._banRate),  'Most Banned',   'banRate');
  const byPick = top([...heroes].sort((a, b) => b._pickRate - a._pickRate), 'Most Picked',   'pickRate');

  return [...byWin, ...byBan, ...byPick];
}

// ─── Master Scrape — fetches heroes ONCE, derives everything else ─────────────
async function runScrape() {
  console.log('\n[CRON] Starting scrape cycle...');
  store.status = 'scraping';

  try {
    const heroes = await scrapeHeroStats(); // single paginated fetch

    store.heroes      = heroes;
    store.tierList    = buildTierList(heroes);
    store.leaderboard = buildLeaderboard(heroes);
    store.lastUpdated = new Date().toISOString();
    store.status      = 'ready';

    cache.flushAll();

    console.log(`[CRON] Done. Heroes: ${heroes.length}, Tiers: ${Object.keys(store.tierList).length}, Leaderboard: ${store.leaderboard.length}`);
  } catch (err) {
    store.status = 'error';
    console.error('[CRON] Scrape failed:', err.message);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    service: 'MLBB Analysis API',
    status: store.status,
    lastUpdated: store.lastUpdated,
    heroCount: store.heroes.length,
    endpoints: [
      'GET /api/heroes',
      'GET /api/heroes/:slug',
      'GET /api/tier-list',
      'GET /api/leaderboard',
      'GET /api/analyze/:heroName',
      'GET /api/synergy/:hero1/:hero2',
      'POST /api/scrape (manual trigger)',
    ]
  });
});

app.get('/api/heroes', (req, res) => {
  const { role, tier, sort } = req.query;
  let heroes = [...store.heroes];

  if (role) heroes = heroes.filter(h => h.role?.toLowerCase().includes(role.toLowerCase()));
  if (tier) heroes = heroes.filter(h => h.tier?.toLowerCase() === tier.toLowerCase());
  if (sort === 'winrate')  heroes.sort((a, b) => b._winRate  - a._winRate);
  if (sort === 'banrate')  heroes.sort((a, b) => b._banRate  - a._banRate);
  if (sort === 'pickrate') heroes.sort((a, b) => b._pickRate - a._pickRate);

  res.json({ count: heroes.length, lastUpdated: store.lastUpdated, data: heroes });
});

app.get('/api/heroes/:slug', async (req, res) => {
  const slug     = req.params.slug.toLowerCase();
  const cacheKey = `hero_detail_${slug}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  const base   = store.heroes.find(h => h.name?.toLowerCase() === slug);
  const detail = await scrapeHeroDetail(slug, store.heroes);
  const full   = { ...(base || { name: slug }), ...detail };

  cache.set(cacheKey, full, 3600);
  res.json({ source: 'live', data: full });
});

app.get('/api/tier-list', (req, res) => {
  res.json({ lastUpdated: store.lastUpdated, data: store.tierList });
});

app.get('/api/leaderboard', (req, res) => {
  const { category, limit } = req.query;
  let data = [...store.leaderboard];
  if (category) data = data.filter(e => e.category.toLowerCase().includes(category.toLowerCase()));
  res.json({ lastUpdated: store.lastUpdated, data: data.slice(0, parseInt(limit) || 50) });
});

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

app.get('/api/synergy/:hero1/:hero2', async (req, res) => {
  const { hero1, hero2 } = req.params;
  const cacheKey = `synergy_${hero1.toLowerCase()}_${hero2.toLowerCase()}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', heroes: [hero1, hero2], synergy: cached });

  const h1 = store.heroes.find(h => h.name?.toLowerCase() === hero1.toLowerCase()) || { name: hero1 };
  const h2 = store.heroes.find(h => h.name?.toLowerCase() === hero2.toLowerCase()) || { name: hero2 };

  try {
    const synergy = await analyzeSynergy(h1, h2);
    cache.set(cacheKey, synergy, 3600);
    res.json({ source: 'ai', heroes: [hero1, hero2], synergy });
  } catch (err) {
    res.status(500).json({ error: 'Synergy analysis failed', message: err.message });
  }
});

app.post('/api/scrape', async (req, res) => {
  if (req.headers['x-scrape-secret'] !== process.env.SCRAPE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Scrape started' });
  runScrape();
});

// ─── Cron: every hour ─────────────────────────────────────────────────────────
cron.schedule('0 * * * *', () => {
  console.log('[CRON] Hourly scrape triggered');
  runScrape();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n🚀 MLBB API running on port ${PORT}`);
  console.log(`📡 Scraping mlbb-stats.ridwaanhall.com every hour`);
  console.log(`🤖 AI powered by Claude (Anthropic)\n`);
  await runScrape();
});
