// scraper.js — Hero data from mlbb-stats.ridwaanhall.com
const axios = require('axios');

const BASE = 'https://mlbb-stats.ridwaanhall.com/api';
const HEADERS = { 'User-Agent': 'mlbbai-app/1.0' };

async function get(path) {
  const res = await axios.get(`${BASE}${path}`, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

async function post(path, body) {
  const res = await axios.post(`${BASE}${path}`, body, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return res.data;
}

function tierFromWinRate(wr) {
  if (wr == null) return 'Unranked';
  const pct = wr * 100;
  if (pct >= 56) return 'S+';
  if (pct >= 53) return 'S';
  if (pct >= 51) return 'A';
  if (pct >= 49) return 'B';
  return 'C';
}

// Parse a hero-rank record into stats object
function parseRankRow(row) {
  const d        = row.data || row;
  const heroData = d.main_hero?.data || {};
  const winRate  = d.main_hero_win_rate;
  const banRate  = d.main_hero_ban_rate;
  const pickRate = d.main_hero_appearance_rate;
  const heroId   = d.main_heroid;
  if (!heroId) return null;
  return {
    heroId,
    name:      heroData.name || null,
    img:       heroData.head || heroData.image || '',
    winRate:   winRate  != null ? `${(winRate  * 100).toFixed(1)}%` : '—',
    banRate:   banRate  != null ? `${(banRate  * 100).toFixed(1)}%` : '—',
    pickRate:  pickRate != null ? `${(pickRate * 100).toFixed(1)}%` : '—',
    tier:      tierFromWinRate(winRate),
    _winRate:  winRate  || 0,
    _banRate:  banRate  || 0,
    _pickRate: pickRate || 0,
  };
}

// ─── Fetch stats for ALL heroes ───────────────────────────────────────────────
// The /hero-rank/ endpoint only returns 20 at a time, but accepts a
// "main_heroid" filter to get stats for a specific hero.
// We fetch all 131 hero IDs from /hero-list/, then query /hero-rank/
// for each hero individually in batches.
async function fetchAllHeroStats(heroIds) {
  const statsMap = {};
  const BATCH = 10; // parallel requests per batch
  let fetched = 0;

  console.log(`[API] Fetching rank stats for ${heroIds.length} heroes...`);

  for (let i = 0; i < heroIds.length; i += BATCH) {
    const batch = heroIds.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(id => post('/hero-rank/', { main_heroid: id }))
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status !== 'fulfilled') continue;

      const rows = r.value?.data?.records || [];
      for (const row of rows) {
        const stats = parseRankRow(row);
        if (stats?.heroId) {
          statsMap[stats.heroId] = stats;
          fetched++;
          break; // only need first match per hero
        }
      }
    }

    // Small delay between batches to be respectful
    if (i + BATCH < heroIds.length) await new Promise(r => setTimeout(r, 150));
  }

  console.log(`[API] Got rank stats for ${fetched}/${heroIds.length} heroes`);
  return statsMap;
}

// ─── Main hero stats fetch ────────────────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[API] Fetching full hero roster from /hero-list/...');

  // Step 1: get complete roster from /hero-list/
  const heroMap = {};

  try {
    const raw  = await get('/hero-list/');
    const rows = raw?.data?.records || [];
    console.log(`[API] hero-list returned ${rows.length} heroes`);

    for (const row of rows) {
      const d      = row.data || row;
      const hd     = d.hero?.data || {};
      const name   = hd.name;
      const heroId = d.hero_id;
      if (!name || !heroId) continue;

      heroMap[heroId] = {
        name,
        role:      hd.role || hd.type || hd.hero_type || '—',
        winRate:   '—',
        banRate:   '—',
        pickRate:  '—',
        tier:      'Unranked',
        img:       hd.head || hd.image || hd.icon || '',
        heroId,
        _winRate:  0,
        _banRate:  0,
        _pickRate: 0,
      };
    }
    console.log(`[API] Parsed ${Object.keys(heroMap).length} heroes from roster`);
  } catch (e) {
    console.error('[API] hero-list error:', e.message);
  }

  // Step 2: fetch rank stats for every hero individually
  const heroIds = Object.keys(heroMap).map(Number);
  const statsMap = await fetchAllHeroStats(heroIds);

  // Step 3: merge stats into hero map
  let merged = 0;
  for (const [heroId, stats] of Object.entries(statsMap)) {
    const id = Number(heroId);
    if (!heroMap[id]) continue;
    heroMap[id].winRate  = stats.winRate;
    heroMap[id].banRate  = stats.banRate;
    heroMap[id].pickRate = stats.pickRate;
    heroMap[id].tier     = stats.tier;
    heroMap[id]._winRate  = stats._winRate;
    heroMap[id]._banRate  = stats._banRate;
    heroMap[id]._pickRate = stats._pickRate;
    // Use rank image if hero-list image is missing
    if (!heroMap[id].img && stats.img) heroMap[id].img = stats.img;
    merged++;
  }

  console.log(`[API] Merged stats for ${merged}/${Object.keys(heroMap).length} heroes`);

  const heroes = Object.values(heroMap);
  console.log(`[API] Total heroes: ${heroes.length}`);
  return heroes;
}

// ─── Single Hero Detail ───────────────────────────────────────────────────────
async function scrapeHeroDetail(heroIdOrSlug, allHeroes = []) {
  let heroId = heroIdOrSlug;
  if (isNaN(heroIdOrSlug)) {
    const match = allHeroes.find(h => h.name?.toLowerCase() === String(heroIdOrSlug).toLowerCase());
    heroId = match?.heroId || null;
  }
  if (!heroId) { console.warn(`[API] No heroId for: ${heroIdOrSlug}`); return {}; }

  console.log(`[API] Fetching detail heroId: ${heroId}`);
  try {
    const [detailRaw, counters, compatibility] = await Promise.allSettled([
      get(`/hero-detail/${heroId}/`),
      get(`/hero-counter/${heroId}/`),
      get(`/hero-compatibility/${heroId}/`),
    ]);

    const detailRecords = detailRaw.value?.data?.records || [];
    const detailData    = detailRecords[0]?.data || {};
    const heroAttr      = detailData.hero?.data || {};

    const c    = counters.value?.data      || counters.value      || {};
    const comp = compatibility.value?.data || compatibility.value || {};

    function findArr(obj, depth = 0) {
      if (depth > 4) return null;
      if (Array.isArray(obj) && obj.length) return obj;
      if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) { const f = findArr(v, depth + 1); if (f) return f; }
      }
      return null;
    }

    let build = [];
    try {
      const guide  = await get(`/academy/guide/${heroId}/builds/`);
      const builds = findArr(guide) || [];
      if (builds.length) build = (builds[0].items || builds[0].equipment || []).map(i => i.name || i.item_name).filter(Boolean);
    } catch {}

    const ability = heroAttr.abilityshow || [];
    const stats = {
      durability: parseInt(ability[0]) || heroAttr.durability || 0,
      offense:    parseInt(ability[1]) || heroAttr.offense    || 0,
      control:    parseInt(ability[2]) || heroAttr.control    || 0,
      mobility:   parseInt(ability[3]) || heroAttr.mobility   || 0,
      support:    parseInt(ability[4]) || heroAttr.support    || 0,
    };

    return {
      name:        heroAttr.name || detailData.name || String(heroId),
      role:        heroAttr.role || heroAttr.type   || heroAttr.hero_type || '—',
      description: heroAttr.story || heroAttr.lore  || heroAttr.description || '',
      img:         detailData.head_big || detailData.head || heroAttr.head || '',
      stats,
      build,
      counters:  (findArr(c)    || []).map(h => h.name || h.hero_name || h).filter(x => typeof x === 'string'),
      teammates: (findArr(comp) || []).map(h => h.name || h.hero_name || h).filter(x => typeof x === 'string'),
    };
  } catch (err) {
    console.error(`[API] Detail error (${heroId}):`, err.message);
    return {};
  }
}

// ─── Tier List & Leaderboard ──────────────────────────────────────────────────
async function scrapeTierList() {
  const heroes = await scrapeHeroStats();
  const tiers  = {};
  heroes.forEach(h => {
    if (!tiers[h.tier]) tiers[h.tier] = [];
    tiers[h.tier].push(h.name);
  });
  const order = ['S+', 'S', 'A', 'B', 'C', 'Unranked'];
  const sorted = {};
  order.forEach(t => { if (tiers[t]) sorted[t] = tiers[t]; });
  Object.keys(tiers).forEach(t => { if (!sorted[t]) sorted[t] = tiers[t]; });
  return sorted;
}

async function scrapeLeaderboard() {
  const heroes = await scrapeHeroStats();
  if (!heroes.length) return [];
  const top = (arr, category, stat) =>
    arr.slice(0, 10).map((h, i) => ({ rank: i+1, name: h.name, category, role: h.role||'—', points: h[stat], hero: h.name, img: h.img }));
  return [
    ...top([...heroes].sort((a,b) => b._winRate  - a._winRate),  'Top Win Rate', 'winRate'),
    ...top([...heroes].sort((a,b) => b._banRate  - a._banRate),  'Most Banned',  'banRate'),
    ...top([...heroes].sort((a,b) => b._pickRate - a._pickRate), 'Most Picked',  'pickRate'),
  ];
}

module.exports = { scrapeHeroStats, scrapeHeroDetail, scrapeTierList, scrapeLeaderboard };
