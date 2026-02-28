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

// ─── Diagnostics — run once on boot to understand API shapes ─────────────────
let diagDone = false;
async function runDiagnostics(knownId) {
  if (diagDone) return;
  diagDone = true;
  console.log('\n[DIAG] ========== API DIAGNOSTIC ==========');

  // 1. What does hero-detail look like for a known ID?
  try {
    const r = await get(`/hero-detail/${knownId}/`);
    console.log(`[DIAG] hero-detail/${knownId} keys:`, Object.keys(r || {}));
    console.log(`[DIAG] hero-detail/${knownId} full:`, JSON.stringify(r).slice(0, 800));
  } catch(e) { console.log(`[DIAG] hero-detail/${knownId} ERROR:`, e.message); }

  // 2. What does hero-detail look like for ID 1?
  try {
    const r = await get('/hero-detail/1/');
    console.log('[DIAG] hero-detail/1 full:', JSON.stringify(r).slice(0, 400));
  } catch(e) { console.log('[DIAG] hero-detail/1 ERROR:', e.message); }

  // 3. Does the rank endpoint have a "list all" or "no pagination" mode?
  try {
    const r = await get('/hero-rank/?page_size=999&page=1&limit=999&offset=0&all=true');
    const count = r?.data?.records?.length || r?.data?.data?.length || 0;
    console.log('[DIAG] hero-rank all-params record count:', count);
    console.log('[DIAG] hero-rank data keys:', Object.keys(r?.data || {}));
  } catch(e) { console.log('[DIAG] hero-rank all-params ERROR:', e.message); }

  // 4. Try hero-list endpoint
  try {
    const r = await get('/hero-list/');
    console.log('[DIAG] hero-list full:', JSON.stringify(r).slice(0, 600));
  } catch(e) { console.log('[DIAG] hero-list ERROR:', e.message); }

  // 5. Try heroes endpoint
  try {
    const r = await get('/heroes/');
    console.log('[DIAG] /heroes/ full:', JSON.stringify(r).slice(0, 600));
  } catch(e) { console.log('[DIAG] /heroes/ ERROR:', e.message); }

  // 6. Check the rank data keys to find total_count path
  try {
    const r = await post('/hero-rank/', {});
    console.log('[DIAG] hero-rank POST empty body:', JSON.stringify(r).slice(0, 400));
    if (r?.data) {
      console.log('[DIAG] hero-rank data keys:', Object.keys(r.data));
      console.log('[DIAG] hero-rank total fields:', JSON.stringify({
        total_count: r.data.total_count,
        count: r.data.count,
        total: r.data.total,
        num_pages: r.data.num_pages,
        page_count: r.data.page_count,
      }));
    }
  } catch(e) { console.log('[DIAG] hero-rank POST ERROR:', e.message); }

  console.log('[DIAG] ==========================================\n');
}

// ─── Fetch ALL heroes ─────────────────────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[API] Fetching hero rank list...');

  const allHeroes = [];
  const seenIds   = new Set();

  try {
    const raw  = await post('/hero-rank/', {});
    const rows = raw?.data?.records || [];

    // Run diagnostics using first known hero ID
    const firstId = rows[0]?.data?.main_heroid;
    if (firstId) await runDiagnostics(firstId);

    for (const row of rows) {
      const h = parseHeroRow(row);
      if (!h?.heroId) continue;
      if (seenIds.has(h.heroId)) continue;
      seenIds.add(h.heroId);
      allHeroes.push(h);
    }

    const total = raw?.data?.total_count || raw?.data?.count || raw?.data?.total || '?';
    console.log(`[API] Got ${allHeroes.length} heroes from rank (API total: ${total})`);

  } catch (e) {
    console.error('[API] Rank fetch error:', e.message);
  }

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
