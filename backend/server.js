// server.js — Express API + hourly scrape scheduler
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const NodeCache = require('node-cache');

const { scrapeHeroStats, scrapeHeroDetail, scrapeTierList, scrapeLeaderboard } = require('./scraper');
const { analyzeHero, analyzeSynergy } = require('./ai');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1hr default TTL

app.use(cors());
app.use(express.json());

// ─── Data Store (in-memory, refreshed by cron) ────────────────────────────────
let store = {
  heroes:      [],
  tierList:    {},
  leaderboard: [],
  lastUpdated: null,
  status:      'initializing'
};

// ─── Master Scrape Function ───────────────────────────────────────────────────
async function runScrape() {
  console.log('\n[CRON] Starting full scrape cycle...');
  store.status = 'scraping';

  try {
    const [heroes, tierList, leaderboard] = await Promise.all([
      scrapeHeroStats(),
      scrapeTierList(),
      scrapeLeaderboard()
    ]);

    store.heroes      = heroes;
    store.tierList    = tierList;
    store.leaderboard = leaderboard;
    store.lastUpdated = new Date().toISOString();
    store.status      = 'ready';

    // Clear AI cache on new data
    cache.flushAll();

    console.log(`[CRON] Scrape complete. Heroes: ${heroes.length}, Tier groups: ${Object.keys(tierList).length}, Players: ${leaderboard.length}`);
  } catch (err) {
    store.status = 'error';
    console.error('[CRON] Scrape failed:', err.message);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check / status
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
      'POST /api/scrape (manual trigger)'
    ]
  });
});

// All heroes (win rate, ban rate, pick rate, tier)
app.get('/api/heroes', (req, res) => {
  const { role, tier, sort } = req.query;
  let heroes = [...store.heroes];

  if (role)  heroes = heroes.filter(h => h.role?.toLowerCase().includes(role.toLowerCase()));
  if (tier)  heroes = heroes.filter(h => h.tier?.toLowerCase() === tier.toLowerCase());
  if (sort === 'winrate') heroes.sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate));
  if (sort === 'banrate') heroes.sort((a, b) => parseFloat(b.banRate) - parseFloat(a.banRate));
  if (sort === 'pickrate') heroes.sort((a, b) => parseFloat(b.pickRate) - parseFloat(a.pickRate));

  res.json({ count: heroes.length, lastUpdated: store.lastUpdated, data: heroes });
});

// Single hero detail (live scrape of detail page + cached)
app.get('/api/heroes/:slug', async (req, res) => {
  const slug = req.params.slug.toLowerCase();
  const cacheKey = `hero_detail_${slug}`;

  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  // Find base data
  const base = store.heroes.find(h => h.name?.toLowerCase() === slug || h.href?.includes(slug));

  // Scrape detail page
  const detail = await scrapeHeroDetail(slug);
  const full   = { ...(base || { name: slug }), ...detail };

  cache.set(cacheKey, full, 3600);
  res.json({ source: 'live', data: full });
});

// Tier list
app.get('/api/tier-list', (req, res) => {
  res.json({ lastUpdated: store.lastUpdated, data: store.tierList });
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    lastUpdated: store.lastUpdated,
    data: store.leaderboard.slice(0, limit)
  });
});

// AI hero analysis (cached per hero, refreshes with each scrape)
app.get('/api/analyze/:heroName', async (req, res) => {
  const name     = req.params.heroName;
  const cacheKey = `ai_analysis_${name.toLowerCase()}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', hero: name, analysis: cached });

  // Find hero data to give AI context
  const heroData = store.heroes.find(h => h.name?.toLowerCase() === name.toLowerCase()) || { name };

  try {
    const analysis = await analyzeHero(heroData);
    cache.set(cacheKey, analysis, 3600);
    res.json({ source: 'ai', hero: name, analysis });
  } catch (err) {
    res.status(500).json({ error: 'AI analysis failed', message: err.message });
  }
});

// AI synergy report
app.get('/api/synergy/:hero1/:hero2', async (req, res) => {
  const { hero1, hero2 }  = req.params;
  const cacheKey = `synergy_${hero1.toLowerCase()}_${hero2.toLowerCase()}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', heroes: [hero1, hero2], synergy: cached });

  const h1Data = store.heroes.find(h => h.name?.toLowerCase() === hero1.toLowerCase()) || { name: hero1 };
  const h2Data = store.heroes.find(h => h.name?.toLowerCase() === hero2.toLowerCase()) || { name: hero2 };

  try {
    const synergy = await analyzeSynergy(h1Data, h2Data);
    cache.set(cacheKey, synergy, 3600);
    res.json({ source: 'ai', heroes: [hero1, hero2], synergy });
  } catch (err) {
    res.status(500).json({ error: 'Synergy analysis failed', message: err.message });
  }
});

// Manual scrape trigger (protect this in production!)
app.post('/api/scrape', async (req, res) => {
  const secret = req.headers['x-scrape-secret'];
  if (secret !== process.env.SCRAPE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Scrape started' });
  runScrape(); // run async
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
  console.log(`📡 Scraping mlbb.gg every hour`);
  console.log(`🤖 AI powered by Claude (Anthropic)\n`);
  // Run initial scrape on startup
  await runScrape();
});
