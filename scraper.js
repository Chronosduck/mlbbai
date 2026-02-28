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

function parseRankRow(row) {
  const d        = row.data || row;
  const heroData = d.main_hero?.data || {};
  const winRate  = d.main_hero_win_rate;
  const banRate  = d.main_hero_ban_rate;
  const pickRate = d.main_hero_appearance_rate;
  const heroId   = d.main_heroid;
  if (!heroId || winRate == null) return null;
  return {
    heroId,
    name:      heroData.name || null,
    img:       heroData.head || heroData.image || '',
    winRate:   `${(winRate  * 100).toFixed(1)}%`,
    banRate:   banRate  != null ? `${(banRate  * 100).toFixed(1)}%` : '—',
    pickRate:  pickRate != null ? `${(pickRate * 100).toFixed(1)}%` : '—',
    tier:      tierFromWinRate(winRate),
    _winRate:  winRate  || 0,
    _banRate:  banRate  || 0,
    _pickRate: pickRate || 0,
  };
}

// ─── Probe what params hero-rank accepts (run once) ───────────────────────────
let probeDone = false;
async function probeRankEndpoint(sampleId, sampleChannelId) {
  if (probeDone) return;
  probeDone = true;

  console.log('\n[PROBE] Testing hero-rank filter params...');

  const tests = [
    { label: 'main_heroid filter',       body: { main_heroid: sampleId } },
    { label: 'heroid filter',            body: { heroid: sampleId } },
    { label: 'hero_id filter',           body: { hero_id: sampleId } },
    { label: 'channel_id filter',        body: { channel_id: sampleChannelId } },
    { label: 'main_hero_channel filter', body: { main_hero_channel: sampleChannelId } },
    { label: 'sorts by win_rate asc',    body: { sorts_field: 'main_hero_win_rate', sorts_order: 'asc' } },
    { label: 'sorts by heroid asc',      body: { sorts_field: 'main_heroid', sorts_order: 'asc' } },
    { label: 'sorts by heroid desc',     body: { sorts_field: 'main_heroid', sorts_order: 'desc' } },
    { label: 'rank=legend',              body: { rank: 'legend' } },
    { label: 'rank=mythic',              body: { rank: 'mythic' } },
    { label: 'rank=epic',                body: { rank: 'epic' } },
    { label: 'offset=20',                body: { offset: 20 } },
    { label: 'skip=20',                  body: { skip: 20 } },
    { label: 'start=20',                 body: { start: 20 } },
    { label: 'from=20',                  body: { from: 20 } },
    { label: 'cursor=20',                body: { cursor: 20 } },
  ];

  for (const t of tests) {
    try {
      const raw   = await post('/hero-rank/', t.body);
      const rows  = raw?.data?.records || [];
      const first = rows[0]?.data?.main_heroid;
      const names = rows.slice(0,3).map(r => r?.data?.main_hero?.data?.name || r?.data?.main_heroid).join(', ');
      console.log(`[PROBE] ${t.label}: ${rows.length} rows, first heroId=${first}, heroes: ${names}`);
    } catch(e) {
      console.log(`[PROBE] ${t.label}: ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // Also check GET with query params
  const getTests = [
    '/hero-rank/?offset=20&limit=20',
    '/hero-rank/?skip=20',
    `/hero-rank/?main_heroid=${sampleId}`,
    `/hero-rank/?heroid=${sampleId}`,
    '/hero-rank/?page=2&page_size=20',
    '/hero-rank/?sorts_field=main_heroid&sorts_order=asc',
  ];

  for (const path of getTests) {
    try {
      const raw  = await get(path);
      const rows = raw?.data?.records || [];
      const first = rows[0]?.data?.main_heroid;
      console.log(`[PROBE] GET ${path}: ${rows.length} rows, first heroId=${first}`);
    } catch(e) {
      console.log(`[PROBE] GET ${path}: ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('[PROBE] Done.\n');
}

// ─── Main scrape ──────────────────────────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[API] Fetching full hero roster from /hero-list/...');

  const heroMap = {};

  // Step 1: full roster from hero-list
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
        winRate:   '—', banRate: '—', pickRate: '—',
        tier:      'Unranked',
        img:       hd.head || hd.image || hd.icon || '',
        heroId,
        _winRate: 0, _banRate: 0, _pickRate: 0,
      };
    }
    console.log(`[API] Parsed ${Object.keys(heroMap).length} heroes`);
  } catch (e) {
    console.error('[API] hero-list error:', e.message);
  }

  // Step 2: get default top-20 rank stats
  try {
    const raw  = await post('/hero-rank/', {});
    const rows = raw?.data?.records || [];
    let overlaid = 0;

    // Run probe using first hero's data
    if (rows[0]) {
      const d = rows[0].data || rows[0];
      await probeRankEndpoint(d.main_heroid, d.main_hero_channel?.id);
    }

    for (const row of rows) {
      const stats = parseRankRow(row);
      if (!stats?.heroId || !heroMap[stats.heroId]) continue;
      Object.assign(heroMap[stats.heroId], stats);
      overlaid++;
    }
    console.log(`[API] Overlaid stats for ${overlaid} heroes from default rank`);
  } catch (e) {
    console.error('[API] hero-rank error:', e.message);
  }

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
    return {
      name:        heroAttr.name || detailData.name || String(heroId),
      role:        heroAttr.role || heroAttr.type   || heroAttr.hero_type || '—',
      description: heroAttr.story || heroAttr.lore  || heroAttr.description || '',
      img:         detailData.head_big || detailData.head || heroAttr.head || '',
      stats: {
        durability: parseInt(ability[0]) || heroAttr.durability || 0,
        offense:    parseInt(ability[1]) || heroAttr.offense    || 0,
        control:    parseInt(ability[2]) || heroAttr.control    || 0,
        mobility:   parseInt(ability[3]) || heroAttr.mobility   || 0,
        support:    parseInt(ability[4]) || heroAttr.support    || 0,
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
