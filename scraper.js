// scraper.js — Powered by mlbb-stats.ridwaanhall.com (data sourced from Moonton's official MLBB servers)
// Docs: https://mlbb-stats-docs.ridwaanhall.com/
const axios = require('axios');

const BASE = 'https://mlbb-stats.ridwaanhall.com/api';
const HEADERS = { 'User-Agent': 'mlbbai-app/1.0' };

async function get(path) {
  const res = await axios.get(`${BASE}${path}`, { headers: HEADERS, timeout: 15000 });
  return res.data;
}

// ─── Derive tier from win rate (API doesn't supply one) ───────────────────────
function tierFromWinRate(wr) {
  if (wr == null) return 'Unranked';
  const pct = wr * 100;
  if (pct >= 56) return 'S+';
  if (pct >= 53) return 'S';
  if (pct >= 51) return 'A';
  if (pct >= 49) return 'B';
  return 'C';
}

// ─── Parse a single row from /hero-rank/ ─────────────────────────────────────
// Confirmed shape from logs:
// row.data.main_hero.data.{ name, head }
// row.data.{ main_hero_win_rate, main_hero_ban_rate, main_hero_appearance_rate, main_heroid }
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
      role:     heroData.role || heroData.type || heroData.hero_type || '—',
      winRate:  winRate  != null ? `${(winRate  * 100).toFixed(1)}%` : '—',
      banRate:  banRate  != null ? `${(banRate  * 100).toFixed(1)}%` : '—',
      pickRate: pickRate != null ? `${(pickRate * 100).toFixed(1)}%` : '—',
      tier:     tierFromWinRate(winRate),
      img:      heroData.head || heroData.image || heroData.icon || '',
      heroId:   d.main_heroid || heroData.id || null,
    };
  } catch {
    return null;
  }
}

// ─── Hero List ────────────────────────────────────────────────────────────────
async function scrapeHeroStats() {
  console.log('[API] Fetching hero rank list...');
  try {
    const raw  = await get('/hero-rank/');
    // Confirmed: raw.data is the array
    const rows = Array.isArray(raw.data) ? raw.data : [];
    console.log(`[API] hero-rank: ${rows.length} rows`);

    const heroes = rows.map(parseHeroRow).filter(Boolean);
    console.log(`[API] Parsed ${heroes.length} heroes`);
    return heroes;
  } catch (err) {
    console.error('[API] Hero list error:', err.message);
    return [];
  }
}

// ─── Single Hero Detail (uses heroId, not slug) ───────────────────────────────
async function scrapeHeroDetail(heroIdOrSlug, allHeroes = []) {
  // Resolve to a numeric heroId if we got a name/slug
  let heroId = heroIdOrSlug;
  if (isNaN(heroIdOrSlug)) {
    const match = allHeroes.find(
      h => h.name?.toLowerCase() === String(heroIdOrSlug).toLowerCase()
    );
    heroId = match?.heroId || null;
  }

  if (!heroId) {
    console.warn(`[API] No heroId found for: ${heroIdOrSlug}`);
    return {};
  }

  console.log(`[API] Fetching detail for heroId: ${heroId}`);
  try {
    const [detail, counters, compatibility] = await Promise.allSettled([
      get(`/hero-detail/${heroId}/`),
      get(`/hero-counter/${heroId}/`),
      get(`/hero-compatibility/${heroId}/`),
    ]);

    // Each response: { code, data: { ... } }
    const d    = detail.value?.data        || detail.value        || {};
    const c    = counters.value?.data      || counters.value      || {};
    const comp = compatibility.value?.data || compatibility.value || {};

    // Flatten one more level if needed
    const dInner = d.data || d;

    // Extract counter/teammate arrays from whatever shape they come in
    const counterArr  = Array.isArray(c)        ? c        :
                        Array.isArray(c.data)   ? c.data   :
                        Array.isArray(c.counters) ? c.counters : [];
    const teammateArr = Array.isArray(comp)       ? comp       :
                        Array.isArray(comp.data)  ? comp.data  :
                        Array.isArray(comp.teammates) ? comp.teammates : [];

    let build = [];
    try {
      const guide  = await get(`/academy/guide/${heroId}/builds/`);
      const builds = Array.isArray(guide?.data) ? guide.data
                   : Array.isArray(guide)        ? guide
                   : [];
      if (builds.length) {
        const top = builds[0];
        build = (top.items || top.equipment || [])
          .map(i => i.name || i.item_name)
          .filter(Boolean);
      }
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
      counters:  counterArr.map(h  => h.name || h.hero_name || h).filter(x => typeof x === 'string'),
      teammates: teammateArr.map(h => h.name || h.hero_name || h).filter(x => typeof x === 'string'),
    };
  } catch (err) {
    console.error(`[API] Detail error (${heroId}):`, err.message);
    return {};
  }
}

// ─── Tier List ────────────────────────────────────────────────────────────────
async function scrapeTierList() {
  console.log('[API] Fetching tier list...');
  try {
    const raw  = await get('/hero-rank/');
    const rows = Array.isArray(raw.data) ? raw.data : [];
    const tiers = {};

    rows.forEach(row => {
      const hero = parseHeroRow(row);
      if (!hero) return;
      if (!tiers[hero.tier]) tiers[hero.tier] = [];
      tiers[hero.tier].push(hero.name);
    });

    // Sort tiers in order
    const order = ['S+', 'S', 'A', 'B', 'C', 'Unranked'];
    const sorted = {};
    order.forEach(t => { if (tiers[t]) sorted[t] = tiers[t]; });
    Object.keys(tiers).forEach(t => { if (!sorted[t]) sorted[t] = tiers[t]; });

    console.log(`[API] Tier groups: ${Object.keys(sorted).length}`);
    return sorted;
  } catch (err) {
    console.error('[API] Tier list error:', err.message);
    return {};
  }
}

// ─── Leaderboard (MPL ID player stats) ───────────────────────────────────────
async function scrapeLeaderboard() {
  console.log('[API] Fetching leaderboard...');
  try {
    // Try the MPL ID endpoint — confirmed it returns an array
    const raw = await get('/mplid/player-stats/');

    // raw might be the array directly, or wrapped in .data
    const rows = Array.isArray(raw)      ? raw
               : Array.isArray(raw.data) ? raw.data
               : [];

    console.log(`[API] Leaderboard rows: ${rows.length}`);
    if (rows[0]) console.log('[API] Leaderboard row[0]:', JSON.stringify(rows[0]));

    const players = rows.map((p, i) => {
      const inner = p.data || p;
      // Try every possible field name for player name
      const name =
        inner.player_name || inner.playerName || inner.name ||
        inner.username    || inner.nickname   || inner.gameName ||
        inner.game_name   || inner.ign;

      if (!name) return null;

      return {
        rank:   inner.rank     || inner.position || i + 1,
        name,
        server: inner.team     || inner.server   || inner.region   || inner.country || '—',
        points: inner.rating   || inner.points   || inner.score    || inner.kda     || '—',
        hero:   inner.most_used_hero || inner.hero || inner.main_hero || inner.favorite_hero || '—',
      };
    }).filter(Boolean);

    console.log(`[API] Players parsed: ${players.length}`);
    return players.slice(0, 100);
  } catch (err) {
    console.error('[API] Leaderboard error:', err.message);
    return [];
  }
}

module.exports = { scrapeHeroStats, scrapeHeroDetail, scrapeTierList, scrapeLeaderboard };
