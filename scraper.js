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

// ─── Fetch ALL heroes ─────────────────────────────────────────────────────────
// /hero-list/ returns full roster (confirmed from diagnostics)
// /hero-rank/ returns top 20 with win/ban/pick stats
// We merge them: all heroes from hero-list, stats overlaid from hero-rank
async function scrapeHeroStats() {
  console.log('[API] Fetching full hero roster from /hero-list/...');

  // Step 1: get complete roster from /hero-list/
  // Confirmed shape: { data: { records: [ { data: { hero: { data: { head, name } }, hero_id, relation } } ] } }
  const heroMap = {}; // heroId -> hero object

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

  // Step 2: overlay win/ban/pick stats from /hero-rank/ (top 20)
  try {
    const raw  = await post('/hero-rank/', {});
    const rows = raw?.data?.records || [];
    let overlaid = 0;

    for (const row of rows) {
      const d        = row.data || row;
      const heroData = d.main_hero?.data || {};
      const heroId   = d.main_heroid;
      const winRate  = d.main_hero_win_rate;
      const banRate  = d.main_hero_ban_rate;
      const pickRate = d.main_hero_appearance_rate;

      if (!heroId) continue;

      // Update existing entry or create new one
      if (!heroMap[heroId]) {
        heroMap[heroId] = {
          name:     heroData.name || String(heroId),
          role:     heroData.role || heroData.type || '—',
          img:      heroData.head || '',
          heroId,
        };
      }

      heroMap[heroId].winRate  = winRate  != null ? `${(winRate  * 100).toFixed(1)}%` : '—';
      heroMap[heroId].banRate  = banRate  != null ? `${(banRate  * 100).toFixed(1)}%` : '—';
      heroMap[heroId].pickRate = pickRate != null ? `${(pickRate * 100).toFixed(1)}%` : '—';
      heroMap[heroId].tier     = tierFromWinRate(winRate);
      heroMap[heroId]._winRate  = winRate  || 0;
      heroMap[heroId]._banRate  = banRate  || 0;
      heroMap[heroId]._pickRate = pickRate || 0;
      overlaid++;
    }
    console.log(`[API] Overlaid stats on ${overlaid} heroes`);
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

  console.log(`[API] Fetching detail heroId: ${heroId}`);
  try {
    // hero-detail returns { data: { records: [ { data: { head, head_big, hero: { data: {...} } } } ] } }
    const [detailRaw, counters, compatibility] = await Promise.allSettled([
      get(`/hero-detail/${heroId}/`),
      get(`/hero-counter/${heroId}/`),
      get(`/hero-compatibility/${heroId}/`),
    ]);

    // Parse detail — confirmed shape from diagnostics:
    // raw.data.records[0].data.hero.data -> hero attributes
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

    // Parse ability scores from abilityshow array [durability, offense, control, mobility] or similar
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
