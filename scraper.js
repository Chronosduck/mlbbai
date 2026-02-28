// scraper.js — Hero data from Moonton's official MLBB API (same source as mlbb-stats.ridwaanhall.com)
const axios = require('axios');

// Wrapper API for detail/counter/compatibility endpoints
const WRAPPER = 'https://mlbb-stats.ridwaanhall.com/api';
// Moonton's official stats API (used by the in-game client and mlbb.gg)
const MOONTON = 'https://mlbb-stats.ridwaanhall.com/api'; // fallback — try direct below

const HEADERS = { 'User-Agent': 'mlbbai-app/1.0' };

async function get(base, path) {
  const res = await axios.get(`${base}${path}`, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

async function post(base, path, body) {
  const res = await axios.post(`${base}${path}`, body, { headers: { ...HEADERS, 'Content-Type': 'application/json' }, timeout: 15000 });
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

// ─── Fetch ALL heroes ─────────────────────────────────────────────────────────
// Strategy: fetch pages 1..N using the wrapper, but each page independently
// so duplicates are caught. The wrapper hardcaps at 20/page so we need 7 pages.
async function scrapeHeroStats() {
  console.log('[API] Fetching all heroes...');
  const allHeroes = [];
  const seenIds   = new Set();

  // Try Moonton direct first (full page_size=126), fall back to wrapper pagination
  try {
    const raw = await post(WRAPPER, '/hero-rank/', {
      page_size:   126,
      page_index:  1,
      sorts_field: 'main_heroid',
      sorts_order: 'desc',
      day:         7,
      rank:        'all',
    });
    const rows = raw?.data?.records || [];
    if (rows.length > 20) {
      // Direct large-page worked
      rows.forEach(row => {
        const hero = parseHeroRow(row);
        if (!hero) return;
        const key = hero.heroId || hero.name;
        if (seenIds.has(key)) return;
        seenIds.add(key);
        allHeroes.push(hero);
      });
      console.log(`[API] Got ${allHeroes.length} heroes (single request)`);
      return allHeroes;
    }
  } catch (e) {
    console.log('[API] Large-page attempt failed, falling back to pagination:', e.message);
  }

  // Fallback: iterate pages using wrapper (20/page) with different sort each batch
  // to get different slices. The wrapper sorts by ban_rate desc by default.
  // We fetch sorted by win_rate, ban_rate, pick_rate, and heroid to maximize coverage.
  const sortFields = [
    { sorts_field: 'main_hero_ban_rate',        sorts_order: 'desc' },
    { sorts_field: 'main_hero_win_rate',        sorts_order: 'desc' },
    { sorts_field: 'main_hero_appearance_rate', sorts_order: 'desc' },
    { sorts_field: 'main_hero_ban_rate',        sorts_order: 'asc'  },
    { sorts_field: 'main_hero_win_rate',        sorts_order: 'asc'  },
    { sorts_field: 'main_hero_appearance_rate', sorts_order: 'asc'  },
    { sorts_field: 'main_heroid',               sorts_order: 'desc' },
  ];

  for (const sort of sortFields) {
    try {
      const raw  = await post(WRAPPER, '/hero-rank/', { page_size: 20, page_index: 1, ...sort });
      const rows = raw?.data?.records || [];
      let added = 0;
      for (const row of rows) {
        const hero = parseHeroRow(row);
        if (!hero) continue;
        const key = hero.heroId || hero.name;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        allHeroes.push(hero);
        added++;
      }
      console.log(`[API] Sort ${sort.sorts_field} ${sort.sorts_order}: +${added} new (total: ${allHeroes.length})`);
    } catch (e) {
      console.error('[API] Sort fetch failed:', e.message);
    }
  }

  // Also try rank filters to get heroes that might only appear in certain brackets
  const rankFilters = ['epic', 'legend', 'mythic', 'honor', 'glory'];
  for (const rank of rankFilters) {
    try {
      const raw  = await post(WRAPPER, '/hero-rank/', {
        page_size:   20, page_index: 1,
        sorts_field: 'main_hero_ban_rate', sorts_order: 'desc',
        rank,
      });
      const rows = raw?.data?.records || [];
      let added = 0;
      for (const row of rows) {
        const hero = parseHeroRow(row);
        if (!hero) continue;
        const key = hero.heroId || hero.name;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        allHeroes.push(hero);
        added++;
      }
      if (added > 0) console.log(`[API] Rank ${rank}: +${added} new (total: ${allHeroes.length})`);
    } catch {}
  }

  console.log(`[API] Total heroes fetched: ${allHeroes.length}`);
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
      get(WRAPPER, `/hero-detail/${heroId}/`),
      get(WRAPPER, `/hero-counter/${heroId}/`),
      get(WRAPPER, `/hero-compatibility/${heroId}/`),
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
      const guide  = await get(WRAPPER, `/academy/guide/${heroId}/builds/`);
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

// ─── Tier List & Leaderboard (derived from hero stats) ───────────────────────
async function scrapeTierList() {
  // Called by server.js only during boot — server.js now calls scrapeHeroStats() once
  // and derives tier list itself, so this is just a thin wrapper
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
