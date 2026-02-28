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

  const keys = ['data', 'results', 'list', 'rows', 'heroes', 'items', 'records'];
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && typeof data[key] === 'object') {
      for (const inner of keys) {
        if (Array.isArray(data[key][inner])) return data[key][inner];
      }
    }
  }

  const vals = Object.values(data);
  if (vals.length && typeof vals[0] === 'object') return vals;

  return [];
}

// ─── Parse a single hero row from /hero-rank/ ─────────────────────────────────
// Actual shape:
// { data: { main_hero: { data: { head, name } }, main_hero_win_rate,
//           main_hero_ban_rate, main_hero_appearance_rate, main_heroid } }
function parseHeroRow(row) {
  try {
    const inner    = row.data || row;
    const heroData = inner.main_hero?.data || {};

    const name = heroData.name || heroData.hero_name;
    if (!name) return null;

    const winRate  = inner.main_hero_win_rate;
    const banRate  = inner.main_hero_ban_rate;
    const pickRate = inner.main_hero_appearance_rate;
    const role     = heroData.role || heroData.type || heroData.hero_type || inner.role || '—';
    const tier     = inner.tier || inner.rank || inner.grade || heroData.tier || '—';
    const img      = heroData.head || heroData.image || heroData.icon || '';
    const heroId   = inner.main_heroid || heroData.id || null;

    return {
      name,
      role,
      winRate:  winRate  != null ? `${(winRate  * 100).toFixed(1)}%` : '—',
      banRate:  banRate  != null ? `${(banRate  * 100).toFixed(1)}%` : '—',
      pickRate: pickRate != null ? `${(pickRate * 100).toFixed(1)}%` : '—',
      tier,
      img,
      heroId,
    };
  } catch {
    return null;
  }
}

// ─── Hero List with win/ban/pick rates ────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[API] Fetching hero rank list...');
  try {
    const raw  = await get('/hero-rank/');
    const rows = extractArray(raw.data ?? raw);

    console.log(`[API] hero-rank: ${rows.length} rows found`);

    const heroes = rows.map(parseHeroRow).filter(Boolean);
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

    const d    = detail.value?.data        || detail.value        || {};
    const s    = stats.value?.data         || stats.value         || {};
    const c    = counters.value?.data      || counters.value      || {};
    const comp = compatibility.value?.data || compatibility.value || {};

    const dInner = d.data || d;
    const sInner = s.data || s;

    let build = [];
    try {
      const guide  = await get(`/academy/guide/${slug}/builds/`);
      const builds = extractArray(guide?.data ?? guide);
      if (builds.length) {
        const top = builds[0];
        build = (top.items || top.equipment || []).map(i => i.name || i.item_name).filter(Boolean);
      }
    } catch {}

    const counterList  = extractArray(c.counters    || c.counter_heroes || c.data || c);
    const teammateList = extractArray(comp.teammates || comp.best_partners || comp.data || comp);

    return {
      name:        dInner.name || slug,
      role:        dInner.role || dInner.type || dInner.hero_type,
      description: dInner.story || dInner.lore || dInner.description || '',
      img:         dInner.head_image || dInner.image || dInner.head || dInner.avatar || '',
      stats: {
        durability: sInner.durability || 0,
        offense:    sInner.offense    || 0,
        control:    sInner.control    || 0,
        mobility:   sInner.mobility   || 0,
        support:    sInner.support    || 0,
      },
      build,
      counters:  counterList.map(h  => h.name || h.hero_name || h).filter(x => typeof x === 'string'),
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
    const raw   = await get('/hero-rank/');
    const rows  = extractArray(raw.data ?? raw);
    const tiers = {};

    rows.forEach(row => {
      const hero = parseHeroRow(row);
      if (!hero) return;
      const tier = hero.tier || 'Unranked';
      if (!tiers[tier]) tiers[tier] = [];
      tiers[tier].push(hero.name);
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
    const raw  = await get('/mplid/player-stats/');

    console.log('[API] leaderboard raw type:', typeof raw, Array.isArray(raw) ? '(array)' : '');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      console.log('[API] leaderboard raw keys:', Object.keys(raw));
    }

    const rows = extractArray(raw?.data ?? raw);
    console.log(`[API] leaderboard rows: ${rows.length}`);
    if (rows[0]) console.log('[API] leaderboard sample row keys:', Object.keys(rows[0]));

    const players = rows.map((p, i) => {
      const inner = p.data || p;
      return {
        rank:   inner.rank || i + 1,
        name:   inner.player_name || inner.name || inner.username || inner.nickname,
        server: inner.team || inner.server || inner.region || '—',
        points: inner.rating || inner.points || inner.kda || inner.score || '—',
        hero:   inner.most_used_hero || inner.hero || inner.favorite_hero || '—',
      };
    }).filter(p => p.name);

    console.log(`[API] Players parsed: ${players.length}`);
    return players.slice(0, 100);
  } catch (err) {
    console.error('[API] Leaderboard error:', err.message);
    return [];
  }
}

module.exports = { scrapeHeroStats, scrapeHeroDetail, scrapeTierList, scrapeLeaderboard };
