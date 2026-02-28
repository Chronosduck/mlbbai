// scraper.js — Uses free MLBB Stats API (mlbb-stats.rone.dev)
// No scraping needed — real live data from a public API
const axios = require('axios');

const BASE = 'https://mlbb-stats.rone.dev/api';
const HEADERS = { 'User-Agent': 'mlbbai-app/1.0' };

async function get(path) {
  const res = await axios.get(`${BASE}${path}`, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

// ─── Hero List with win/ban/pick rates ────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[API] Fetching hero rank list...');
  try {
    const data = await get('/hero-rank/');
    const rows = data?.data || data?.results || data || [];

    const heroes = rows.map(h => ({
      name:      h.name || h.hero_name,
      role:      h.role || h.type || h.lane,
      winRate:   h.win_rate   ? `${(h.win_rate * 100).toFixed(1)}%`   : (h.winRate || '—'),
      banRate:   h.ban_rate   ? `${(h.ban_rate * 100).toFixed(1)}%`   : (h.banRate || '—'),
      pickRate:  h.pick_rate  ? `${(h.pick_rate * 100).toFixed(1)}%`  : (h.pickRate || '—'),
      tier:      h.tier || h.rank || '—',
      img:       h.image || h.icon || h.head_image || '',
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

    const d = detail.value?.data || detail.value || {};
    const s = stats.value?.data  || stats.value  || {};
    const c = counters.value?.data || counters.value || {};
    const comp = compatibility.value?.data || compatibility.value || {};

    // Build recommended items from academy
    let build = [];
    try {
      const guide = await get(`/academy/guide/${slug}/builds/`);
      const builds = guide?.data || guide?.results || [];
      if (builds.length) {
        const top = builds[0];
        build = (top.items || top.equipment || []).map(i => i.name || i.item_name).filter(Boolean);
      }
    } catch {}

    return {
      name:        d.name || slug,
      role:        d.role || d.type,
      description: d.story || d.lore || d.description || '',
      img:         d.head_image || d.image || '',
      stats: {
        durability: s.durability || 0,
        offense:    s.offense    || 0,
        control:    s.control    || 0,
        mobility:   s.mobility   || 0,
        support:    s.support    || 0,
      },
      build,
      counters:    (c.counters   || c.counter_heroes || []).map(h => h.name || h).filter(Boolean),
      teammates:   (comp.teammates || comp.best_partners || []).map(h => h.name || h).filter(Boolean),
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
    const data = await get('/hero-rank/');
    const rows = data?.data || data?.results || data || [];
    const tiers = {};

    rows.forEach(h => {
      const tier = h.tier || h.rank || 'Unranked';
      if (!tiers[tier]) tiers[tier] = [];
      tiers[tier].push(h.name || h.hero_name);
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
    const data = await get('/mplid/player-stats/');
    const rows = data?.data || data?.results || data || [];

    const players = rows.map((p, i) => ({
      rank:   p.rank || i + 1,
      name:   p.player_name || p.name,
      server: p.team || p.server || '—',
      points: p.rating || p.points || p.kda || '—',
      hero:   p.most_used_hero || p.hero || '—',
    })).filter(p => p.name);

    console.log(`[API] Players: ${players.length}`);
    return players.slice(0, 100);
  } catch (err) {
    console.error('[API] Leaderboard error:', err.message);
    return [];
  }
}

module.exports = { scrapeHeroStats, scrapeHeroDetail, scrapeTierList, scrapeLeaderboard };
