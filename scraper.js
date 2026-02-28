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

function parseHeroRow(row) {
  try {
    const d        = row.data || row;
    const heroData = d.main_hero?.data || {};
    const name     = heroData.name || heroData.hero_name;
    if (!name) return null;

    const winRate  = d.main_hero_win_rate;
    const banRate  = d.main_hero_ban_rate;
    const pickRate = d.main_hero_appearance_rate;

    return {
      name,
      role:      heroData.role || heroData.type || heroData.hero_type || '—',
      winRate:   winRate  != null ? `${(winRate  * 100).toFixed(1)}%` : '—',
      banRate:   banRate  != null ? `${(banRate  * 100).toFixed(1)}%` : '—',
      pickRate:  pickRate != null ? `${(pickRate * 100).toFixed(1)}%` : '—',
      tier:      tierFromWinRate(winRate),
      img:       heroData.head || heroData.image || heroData.icon || '',
      heroId:    d.main_heroid || heroData.id || null,
      _winRate:  winRate  || 0,
      _banRate:  banRate  || 0,
      _pickRate: pickRate || 0,
    };
  } catch { return null; }
}

// Known MLBB hero IDs — Moonton assigns sequential IDs.
// Heroes currently go from roughly ID 1 to ~150 (with gaps for unreleased/removed).
// We scan all IDs and skip 404s.
function knownHeroIds() {
  const ids = [];
  for (let i = 1; i <= 160; i++) ids.push(i);
  return ids;
}

// Parse a hero-detail response into our standard hero shape
function parseDetailAsHero(raw, heroId) {
  try {
    const outer = raw?.data || raw;
    const d     = outer?.data || outer;

    const name = d.name || d.hero_name;
    if (!name) return null;

    return {
      name,
      role:      d.role || d.type || d.hero_type || '—',
      winRate:   '—',
      banRate:   '—',
      pickRate:  '—',
      tier:      'Unranked',
      img:       d.head || d.head_image || d.image || d.icon || d.avatar || '',
      heroId,
      _winRate:  0,
      _banRate:  0,
      _pickRate: 0,
    };
  } catch { return null; }
}

// ─── Fetch ALL heroes ─────────────────────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[API] Fetching hero rank list (page 1)...');

  // Step 1: get rank stats for the top 20 from the rank endpoint
  const rankMap = {}; // heroId -> rank stats
  try {
    const raw  = await post('/hero-rank/', { page_size: 20, page_index: 1 });
    const rows = raw?.data?.records || [];
    for (const row of rows) {
      const h = parseHeroRow(row);
      if (h?.heroId) rankMap[h.heroId] = h;
    }
    console.log(`[API] Got rank stats for ${Object.keys(rankMap).length} heroes`);
  } catch (e) {
    console.error('[API] Rank fetch failed:', e.message);
  }

  // Step 2: scan all known hero IDs via the detail endpoint to get full roster
  // Batch requests in groups of 10 to avoid overwhelming the API
  const allHeroes = [];
  const seenIds   = new Set(Object.keys(rankMap).map(Number));

  // First add the rank heroes (they have full stats)
  Object.values(rankMap).forEach(h => allHeroes.push(h));

  const ids      = knownHeroIds().filter(id => !seenIds.has(id));
  const BATCH    = 10;
  let found      = 0;

  console.log(`[API] Scanning ${ids.length} hero IDs for remaining heroes...`);

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch   = ids.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(id => get(`/hero-detail/${id}/`))
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status !== 'fulfilled') continue;
      const hero = parseDetailAsHero(r.value, batch[j]);
      if (!hero) continue;
      allHeroes.push(hero);
      seenIds.add(batch[j]);
      found++;
    }

    // Small delay to be respectful to the API
    if (i + BATCH < ids.length) await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[API] ID scan complete: +${found} additional heroes`);
  console.log(`[API] Total heroes: ${allHeroes.length}`);
  return allHeroes;
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
    const [detail, counters, compatibility] = await Promise.allSettled([
      get(`/hero-detail/${heroId}/`),
      get(`/hero-counter/${heroId}/`),
      get(`/hero-compatibility/${heroId}/`),
    ]);

    const d    = detail.value?.data        || detail.value        || {};
    const c    = counters.value?.data      || counters.value      || {};
    const comp = compatibility.value?.data || compatibility.value || {};
    const dInner = d.data || d;

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

    return {
      name:        dInner.name || String(heroId),
      role:        dInner.role || dInner.type || dInner.hero_type,
      description: dInner.story || dInner.lore || dInner.description || '',
      img:         dInner.head_image || dInner.image || dInner.head || dInner.avatar || '',
      stats: {
        durability: dInner.durability || 0,
        offense:    dInner.offense    || 0,
        control:    dInner.control    || 0,
        mobility:   dInner.mobility   || 0,
        support:    dInner.support    || 0,
      },
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
