// scraper.js — Uses free MLBB Stats API (mlbb-stats.rone.dev)
const axios = require('axios');

const BASE = 'https://mlbb-stats.rone.dev/api';
const HEADERS = { 'User-Agent': 'mlbbai-app/1.0' };

async function get(path) {
  const res = await axios.get(`${BASE}${path}`, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

// ─── Safely extract an array from any API response shape ─────────────────────
function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];

  // Try common wrapper keys in order of likelihood
  const keys = ['data', 'results', 'list', 'rows', 'heroes', 'items', 'records'];
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
    // One level deeper: e.g. data.data.list
    if (data[key] && typeof data[key] === 'object') {
      for (const inner of keys) {
        if (Array.isArray(data[key][inner])) return data[key][inner];
      }
    }
  }

  // Last resort: return values of the object if they look like hero entries
  const vals = Object.values(data);
  if (vals.length && typeof vals[0] === 'object') return vals;

  console.warn('[API] extractArray: could not find array in response. Keys:', Object.keys(data));
  return [];
}

// ─── Hero List with win/ban/pick rates ────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[API] Fetching hero rank list...');
  try {
    const raw = await get('/hero-rank/');
    console.log('[API] hero-rank raw keys:', raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw);

    const rows = extractArray(raw);
    console.log('[API] hero-rank rows sample:', JSON.stringify(rows[0] || {}));

    const heroes = rows.map(h => ({
      name:      h.name || h.hero_name || h.heroName,
      role:      h.role || h.type || h.lane || h.hero_type,
      winRate:   h.win_rate   ? `${(h.win_rate * 100).toFixed(1)}%`   : (h.winRate   || h.win_rate_str   || '—'),
      banRate:   h.ban_rate   ? `${(h.ban_rate * 100).toFixed(1)}%`   : (h.banRate   || h.ban_rate_str   || '—'),
      pickRate:  h.pick_rate  ? `${(h.pick_rate * 100).toFixed(1)}%`  : (h.pickRate  || h.pick_rate_str  || '—'),
      tier:      h.tier || h.rank || h.grade || '—',
      img:       h.image || h.icon || h.head_image || h.avatar || '',
      heroId:    h.hero_id || h.id || null,
    })).filter(h => h.name);

    console.log(`[API] Got ${heroes.length} heroes`);
    return heroes;
  } catch (err) {
    console.error('[API] Hero list error:', err.message);
    return [];
  }
}

// ─── Single Hero Detail ───────────────────────────────────────────────────────
async function scrapeHeroDetail(slug) {
  console.log(`[API] Fetching detail: ${slug}`);
  try {
    const [detail, stats, counters, compatibility] = await Promise.allSettled([
      get(`/hero-detail/${slug}/`),
      get(`/hero-detail-stats/${slug}/`),
      get(`/hero-counter/${slug}/`),
      get(`/hero-compatibility/${slug}/`),
    ]);

    const rawDetail = detail.value || {};
    const rawStats  = stats.value  || {};
    const rawC      = counters.value || {};
    const rawComp   = compatibility.value || {};

    // Extract nested data objects
    const d = rawDetail.data || rawDetail;
    const s = rawStats.data  || rawStats;
    const c = rawC.data      || rawC;
    const comp = rawComp.data || rawComp;

    // Build recommended items from academy
    let build = [];
    try {
      const guide = await get(`/academy/guide/${slug}/builds/`);
      const builds = extractArray(guide);
      if (builds.length) {
        const top = builds[0];
        build = (top.items || top.equipment || []).map(i => i.name || i.item_name).filter(Boolean);
      }
    } catch {}

    // Extract counters / teammates from various possible shapes
    const counterList = extractArray(c.counters || c.counter_heroes || c.data || c);
    const teammateList = extractArray(comp.teammates || comp.best_partners || comp.data || comp);

    return {
      name:        d.name || slug,
      role:        d.role || d.type || d.hero_type,
      description: d.story || d.lore || d.description || '',
      img:         d.head_image || d.image || d.avatar || '',
      stats: {
        durability: s.durability || 0,
        offense:    s.offense    || 0,
        control:    s.control    || 0,
        mobility:   s.mobility   || 0,
        support:    s.support    || 0,
      },
      build,
      counters:  counterList.map(h => h.name || h.hero_name || h).filter(x => typeof x === 'string'),
      teammates: teammateList.map(h => h.name || h.hero_name || h).filter(x => typeof x === 'string'),
    };
  } catch (err) {
    console.error(`[API] Detail error (${slug}):`, err.message);
    return {};
  }
}

// ─── Tier List ────────────────────────────────────────────────────────────────
async function scrapeTierList() {
  console.log('[API] Fetching tier list...');
  try {
    const raw = await get('/hero-rank/');
    console.log('[API] tier-list raw keys:', raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw);

    const rows = extractArray(raw);
    const tiers = {};

    rows.forEach(h => {
      const tier = h.tier || h.rank || h.grade || 'Unranked';
      if (!tiers[tier]) tiers[tier] = [];
      const name = h.name || h.hero_name;
      if (name) tiers[tier].push(name);
    });

    console.log(`[API] Tier groups: ${Object.keys(tiers).length}`);
    return tiers;
  } catch (err) {
    console.error('[API] Tier list error:', err.message);
    return {};
  }
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
async function scrapeLeaderboard() {
  console.log('[API] Fetching leaderboard...');
  try {
    const raw = await get('/mplid/player-stats/');
    console.log('[API] leaderboard raw keys:', raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw);

    const rows = extractArray(raw);

    const players = rows.map((p, i) => ({
      rank:   p.rank || i + 1,
      name:   p.player_name || p.name || p.username,
      server: p.team || p.server || p.region || '—',
      points: p.rating || p.points || p.kda || p.score || '—',
      hero:   p.most_used_hero || p.hero || p.favorite_hero || '—',
    })).filter(p => p.name);

    console.log(`[API] Players: ${players.length}`);
    return players.slice(0, 100);
  } catch (err) {
    console.error('[API] Leaderboard error:', err.message);
    return [];
  }
}

module.exports = { scrapeHeroStats, scrapeHeroDetail, scrapeTierList, scrapeLeaderboard };
