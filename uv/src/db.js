import pg from 'pg';
const { Pool } = pg;
import { GAME_YEAR } from './config.js';

export let pool = null;
let ownsPool = false;

function ensureOwnPool() {
  if (pool || !process.env.DATABASE_URL) return pool;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    // Memory-conscious fallback. In the combined Quaxly build the Trader Brain
    // passes its existing Pool, so no second PostgreSQL pool is created.
    max: 2
  });
  ownsPool = true;
  return pool;
}

export function configureDbPool(externalPool) {
  if (!externalPool) return false;
  pool = externalPool;
  ownsPool = false;
  return true;
}

export function isDbEnabled() { return Boolean(pool || process.env.DATABASE_URL); }

export async function saveUvGenerationJob(job) {
  ensureOwnPool();
  if (!pool || !job?.jobId) return false;
  await pool.query(`
    INSERT INTO uv_generation_jobs (job_id, game_year, job_payload, updated_at)
    VALUES ($1, $2, $3::jsonb, NOW())
    ON CONFLICT (job_id, game_year)
    DO UPDATE SET job_payload = EXCLUDED.job_payload, updated_at = NOW()
  `, [String(job.jobId), Number(GAME_YEAR), JSON.stringify(job)]);
  return true;
}

export async function loadUvGenerationJob(jobId) {
  ensureOwnPool();
  if (!pool || !jobId) return null;
  const { rows } = await pool.query(`
    SELECT job_payload
    FROM uv_generation_jobs
    WHERE job_id = $1 AND game_year = $2
    LIMIT 1
  `, [String(jobId), Number(GAME_YEAR)]);
  return rows[0]?.job_payload || null;
}

export async function deleteUvGenerationJob(jobId) {
  ensureOwnPool();
  if (!pool || !jobId) return false;
  await pool.query(`DELETE FROM uv_generation_jobs WHERE job_id = $1 AND game_year = $2`, [String(jobId), Number(GAME_YEAR)]);
  return true;
}

export async function closeDb() {
  if (pool && ownsPool) await pool.end();
  if (ownsPool) pool = null;
  ownsPool = false;
}

export async function initDb() {
  ensureOwnPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_price_history (
      ea_id BIGINT NOT NULL,
      platform VARCHAR(20) NOT NULL,
      game_year SMALLINT,
      price INTEGER NOT NULL,
      source VARCHAR(30) NOT NULL DEFAULT 'FUT.GG',
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE uv_price_history ADD COLUMN IF NOT EXISTS game_year SMALLINT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uv_price_history_card_year_time ON uv_price_history (ea_id, platform, game_year, recorded_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_cards (
      ea_id BIGINT NOT NULL,
      game_year SMALLINT NOT NULL,
      name VARCHAR(180),
      rating SMALLINT,
      version VARCHAR(120),
      card_type VARCHAR(80),
      position VARCHAR(30),
      club VARCHAR(180),
      league VARCHAR(180),
      futgg_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Legacy uv_cards used ea_id alone as its primary key. Migrate additively:
  // legacy rows remain unassigned (NULL year) and are never read as current-season evidence.
  await pool.query(`ALTER TABLE uv_cards ADD COLUMN IF NOT EXISTS game_year SMALLINT`);
  await pool.query(`ALTER TABLE uv_cards DROP CONSTRAINT IF EXISTS uv_cards_pkey`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_uv_cards_card_year ON uv_cards (ea_id, game_year) WHERE game_year IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_market_snapshots (
      id BIGSERIAL PRIMARY KEY,
      platform VARCHAR(20) NOT NULL,
      game_year SMALLINT,
      direction VARCHAR(20),
      change_pct NUMERIC(12,4),
      stability_score NUMERIC(6,2),
      mover_count INTEGER NOT NULL DEFAULT 0,
      payload JSONB,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_demand_snapshots (
      id BIGSERIAL PRIMARY KEY,
      platform VARCHAR(20) NOT NULL,
      game_year SMALLINT,
      most_used_ok BOOLEAN NOT NULL DEFAULT FALSE,
      momentum_ok BOOLEAN NOT NULL DEFAULT FALSE,
      most_used_matches INTEGER NOT NULL DEFAULT 0,
      momentum_matches INTEGER NOT NULL DEFAULT 0,
      payload JSONB,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_generation_jobs (
      job_id VARCHAR(80) NOT NULL,
      game_year SMALLINT NOT NULL,
      job_payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_id, game_year)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uv_generation_jobs_updated ON uv_generation_jobs (updated_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_generated_lists (
      id BIGSERIAL PRIMARY KEY,
      budget INTEGER NOT NULL,
      platform VARCHAR(20) NOT NULL,
      game_year SMALLINT,
      card_count SMALLINT NOT NULL,
      total_buy INTEGER NOT NULL,
      total_expected_profit INTEGER NOT NULL,
      avg_uv_score NUMERIC(6,2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE uv_market_snapshots ADD COLUMN IF NOT EXISTS game_year SMALLINT`);
  await pool.query(`ALTER TABLE uv_demand_snapshots ADD COLUMN IF NOT EXISTS game_year SMALLINT`);
  await pool.query(`ALTER TABLE uv_generated_lists ADD COLUMN IF NOT EXISTS game_year SMALLINT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_list_items (
      list_id BIGINT NOT NULL REFERENCES uv_generated_lists(id) ON DELETE CASCADE,
      slot SMALLINT NOT NULL,
      ea_id BIGINT NOT NULL,
      buy_price INTEGER NOT NULL,
      start_price INTEGER NOT NULL,
      sell_price INTEGER NOT NULL,
      ea_tax INTEGER NOT NULL,
      net_profit INTEGER NOT NULL,
      uv_score NUMERIC(6,2),
      payload JSONB NOT NULL,
      PRIMARY KEY (list_id, slot)
    )
  `);

  // v2.4.1 saved-list metadata. Additive migrations keep all existing
  // PostgreSQL data and make old generated lists readable without a reset.
  await pool.query(`ALTER TABLE uv_generated_lists ADD COLUMN IF NOT EXISTS summary_payload JSONB`);
  await pool.query(`ALTER TABLE uv_generated_lists ADD COLUMN IF NOT EXISTS last_recheck_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE uv_generated_lists ADD COLUMN IF NOT EXISTS last_recheck_summary JSONB`);
  await pool.query(`ALTER TABLE uv_list_items ADD COLUMN IF NOT EXISTS last_recheck JSONB`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uv_generated_lists_created ON uv_generated_lists (created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_list_evaluations (
      list_id BIGINT NOT NULL REFERENCES uv_generated_lists(id) ON DELETE CASCADE,
      slot SMALLINT NOT NULL,
      ea_id BIGINT NOT NULL,
      platform VARCHAR(20) NOT NULL,
      horizon_hours SMALLINT NOT NULL,
      buy_price INTEGER NOT NULL,
      observed_price INTEGER NOT NULL,
      price_change_pct NUMERIC(12,4),
      survived BOOLEAN NOT NULL,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (list_id, slot, horizon_hours)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uv_eval_card_platform ON uv_list_evaluations (ea_id, platform, evaluated_at DESC)`);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_trade_feedback (
      list_id BIGINT NOT NULL,
      slot SMALLINT NOT NULL,
      outcome VARCHAR(20) NOT NULL,
      sold_price INTEGER,
      relists INTEGER NOT NULL DEFAULT 0,
      note VARCHAR(500),
      resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (list_id, slot),
      FOREIGN KEY (list_id, slot) REFERENCES uv_list_items(list_id, slot) ON DELETE CASCADE
    )
  `);
  await pool.query(`ALTER TABLE uv_trade_feedback ADD COLUMN IF NOT EXISTS actual_buy_price INTEGER`);
  await pool.query(`ALTER TABLE uv_trade_feedback ADD COLUMN IF NOT EXISTS listed_price INTEGER`);
  await pool.query(`ALTER TABLE uv_trade_feedback ADD COLUMN IF NOT EXISTS market_price_at_buy INTEGER`);
  await pool.query(`ALTER TABLE uv_trade_feedback ADD COLUMN IF NOT EXISTS market_price_at_sale INTEGER`);
  await pool.query(`ALTER TABLE uv_trade_feedback ADD COLUMN IF NOT EXISTS listed_at TIMESTAMPTZ`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uv_trade_feedback_time ON uv_trade_feedback (resolved_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uv_trade_journal (
      id BIGSERIAL PRIMARY KEY,
      list_id BIGINT NOT NULL,
      slot SMALLINT NOT NULL,
      event VARCHAR(20) NOT NULL,
      price INTEGER,
      relists INTEGER,
      note VARCHAR(500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (list_id, slot) REFERENCES uv_list_items(list_id, slot) ON DELETE CASCADE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_uv_trade_journal_slot ON uv_trade_journal (list_id, slot, created_at DESC)`);
}

export async function recordSnapshot(cards, platform, limit = 700) {
  if (!pool || !cards?.length) return;
  const sample = cards.slice(0, limit);
  const values = [];
  const placeholders = [];
  let i = 1;
  for (const card of sample) {
    if (!Number.isFinite(card.eaId) || !Number.isFinite(card.price)) continue;
    placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, 'FUT.GG', NOW())`);
    values.push(card.eaId, platform, GAME_YEAR, card.price);
  }
  if (placeholders.length) await pool.query(`INSERT INTO uv_price_history (ea_id, platform, game_year, price, source, recorded_at) VALUES ${placeholders.join(',')}`, values);
}

export async function upsertCards(cards) {
  if (!pool || !cards?.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of cards.slice(0, 1000)) {
      await client.query(`
        INSERT INTO uv_cards (ea_id, game_year, name, rating, version, card_type, position, club, league, futgg_url, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (ea_id, game_year) WHERE game_year IS NOT NULL DO UPDATE SET
          name=EXCLUDED.name, rating=EXCLUDED.rating, version=EXCLUDED.version, card_type=EXCLUDED.card_type,
          position=EXCLUDED.position, club=EXCLUDED.club, league=EXCLUDED.league, futgg_url=EXCLUDED.futgg_url, updated_at=NOW()
      `, [c.eaId, GAME_YEAR, c.name, c.overall, c.rarityName || c.cardType, c.cardType, c.position, c.club, c.league, c.url]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

export async function loadHistoryFeatures(eaIds, platform) {
  const map = new Map();
  if (!pool || !eaIds?.length) return map;
  const result = await pool.query(`
    WITH history AS (
      SELECT
        ea_id,
        price,
        recorded_at,
        LAG(price) OVER (PARTITION BY ea_id ORDER BY recorded_at) AS prev_price
      FROM uv_price_history
      WHERE platform=$1
        AND game_year=$3
        AND ea_id = ANY($2::bigint[])
        AND recorded_at > NOW() - INTERVAL '24 hours'
    )
    SELECT
      ea_id,
      AVG(price)::numeric AS avg_price,
      AVG(price) FILTER (WHERE recorded_at > NOW() - INTERVAL '6 hours')::numeric AS avg_6h,
      AVG(price) FILTER (WHERE recorded_at > NOW() - INTERVAL '1 hour')::numeric AS avg_1h,
      STDDEV_POP(price)::numeric AS stddev_price,
      MIN(price) AS min_price,
      MAX(price) AS max_price,
      COUNT(*)::int AS samples,
      COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '6 hours')::int AS samples_6h,
      COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '1 hour')::int AS samples_1h,
      COUNT(DISTINCT price)::int AS unique_prices,
      COUNT(*) FILTER (WHERE prev_price IS NOT NULL AND price <> prev_price)::int AS price_changes,
      EXTRACT(EPOCH FROM (MAX(recorded_at) - MIN(recorded_at))) / 3600.0 AS observed_hours,
      MAX(recorded_at) AS last_at
    FROM history
    GROUP BY ea_id
  `, [platform, eaIds, GAME_YEAR]);
  for (const row of result.rows) {
    const avg = Number(row.avg_price || 0);
    const sd = Number(row.stddev_price || 0);
    const samples = Number(row.samples || 0);
    const uniquePrices = Number(row.unique_prices || 0);
    const priceChanges = Number(row.price_changes || 0);
    const stability = avg > 0 ? Math.max(0, Math.min(100, 100 - (sd / avg) * 500)) : 50;
    const changeRate = samples > 1 ? priceChanges / (samples - 1) : 0;
    const uniqueRate = samples > 0 ? uniquePrices / samples : 0;
    const activityScore = samples >= 4
      ? Math.max(20, Math.min(100, 35 + changeRate * 45 + uniqueRate * 30 + Math.min(uniquePrices, 8) * 2))
      : null;
    map.set(String(row.ea_id), {
      avg24h: avg || null,
      avg6h: Number(row.avg_6h || 0) || null,
      avg1h: Number(row.avg_1h || 0) || null,
      min24h: Number(row.min_price || 0) || null,
      max24h: Number(row.max_price || 0) || null,
      samples,
      samples6h: Number(row.samples_6h || 0),
      samples1h: Number(row.samples_1h || 0),
      uniquePrices,
      priceChanges,
      observedHours: Number(row.observed_hours || 0),
      activityScore,
      stability
    });
  }
  return map;
}

export async function saveGeneratedList(result) {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const summaryPayload = { ...result };
    delete summaryPayload.cards;
    delete summaryPayload.listId;
    const head = await client.query(`
      INSERT INTO uv_generated_lists (budget, platform, game_year, card_count, total_buy, total_expected_profit, avg_uv_score, summary_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id
    `, [result.budget, result.platform, GAME_YEAR, result.cards.length, result.totalBuy, result.totalExpectedProfit, result.avgUvScore, JSON.stringify(summaryPayload)]);
    const listId = head.rows[0].id;
    const itemRows = result.cards.map((c, slot) => ({
      slot: slot + 1,
      ea_id: Number(c.eaId),
      buy_price: Number(c.buyPrice),
      start_price: Number(c.startPrice),
      sell_price: Number(c.sellPrice),
      ea_tax: Number(c.eaTax),
      net_profit: Number(c.netProfit),
      uv_score: Number(c.uvScore || 0),
      payload: c
    }));
    if (itemRows.length) {
      await client.query(`
        INSERT INTO uv_list_items (list_id, slot, ea_id, buy_price, start_price, sell_price, ea_tax, net_profit, uv_score, payload)
        SELECT $1, x.slot, x.ea_id, x.buy_price, x.start_price, x.sell_price, x.ea_tax, x.net_profit, x.uv_score, x.payload
        FROM jsonb_to_recordset($2::jsonb) AS x(
          slot smallint, ea_id bigint, buy_price integer, start_price integer, sell_price integer,
          ea_tax integer, net_profit integer, uv_score numeric, payload jsonb
        )
      `, [listId, JSON.stringify(itemRows)]);
    }
    await client.query('COMMIT');
    return listId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}


export async function recordMarketSnapshot(context, platform) {
  if (!pool || !context) return;
  await pool.query(`
    INSERT INTO uv_market_snapshots (platform, game_year, direction, change_pct, stability_score, mover_count, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
  `, [platform, GAME_YEAR, context.direction || null, Number.isFinite(context.changePct) ? context.changePct : null,
      Number.isFinite(context.stabilityScore) ? context.stabilityScore : null,
      Array.isArray(context.movers) ? context.movers.length : 0, JSON.stringify(context)]);
}


export async function recordDemandSnapshot(context, platform) {
  if (!pool || !context) return;
  await pool.query(`
    INSERT INTO uv_demand_snapshots (platform, game_year, most_used_ok, momentum_ok, most_used_matches, momentum_matches, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
  `, [platform, GAME_YEAR, Boolean(context.mostUsedOk), Boolean(context.momentumOk),
      Number(context.mostUsedMatches || 0), Number(context.momentumMatches || 0), JSON.stringify(context)]);
}

export async function loadWatchPlatforms() {
  if (!pool) return [];
  const result = await pool.query(`
    SELECT DISTINCT platform
    FROM uv_generated_lists
    WHERE game_year=$1 AND created_at > NOW() - INTERVAL '14 days'
    ORDER BY platform
  `, [GAME_YEAR]);
  return result.rows.map(r => r.platform).filter(Boolean);
}

export async function loadWatchedEaIds(platform, limit = 350) {
  if (!pool) return [];
  const result = await pool.query(`
    SELECT ea_id
    FROM (
      SELECT li.ea_id, MAX(gl.created_at) AS last_seen
      FROM uv_list_items li
      JOIN uv_generated_lists gl ON gl.id = li.list_id
      WHERE gl.platform=$1 AND gl.game_year=$3 AND gl.created_at > NOW() - INTERVAL '14 days'
      GROUP BY li.ea_id
      ORDER BY last_seen DESC
      LIMIT $2
    ) watched
  `, [platform, limit, GAME_YEAR]);
  return result.rows.map(r => Number(r.ea_id)).filter(Number.isFinite);
}

export async function recordSmartSnapshot(cards, platform, limit = 350, heartbeatMinutes = 15) {
  if (!pool || !cards?.length) return { inserted: 0, considered: 0 };
  const sample = cards.filter(c => Number.isFinite(c.eaId) && Number.isFinite(c.price)).slice(0, limit);
  if (!sample.length) return { inserted: 0, considered: 0 };
  const ids = sample.map(c => c.eaId);
  const latest = await pool.query(`
    SELECT DISTINCT ON (ea_id) ea_id, price, recorded_at
    FROM uv_price_history
    WHERE platform=$1 AND game_year=$3 AND ea_id = ANY($2::bigint[])
    ORDER BY ea_id, recorded_at DESC
  `, [platform, ids, GAME_YEAR]);
  const byId = new Map(latest.rows.map(r => [String(r.ea_id), { price: Number(r.price), at: new Date(r.recorded_at).getTime() }]));
  const cutoff = Date.now() - heartbeatMinutes * 60_000;
  const chosen = sample.filter(c => {
    const prev = byId.get(String(c.eaId));
    return !prev || prev.price !== c.price || !Number.isFinite(prev.at) || prev.at <= cutoff;
  });
  if (!chosen.length) return { inserted: 0, considered: sample.length };

  const values = [];
  const placeholders = [];
  let i = 1;
  for (const card of chosen) {
    placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, 'FUT.GG', NOW())`);
    values.push(card.eaId, platform, GAME_YEAR, card.price);
  }
  await pool.query(`INSERT INTO uv_price_history (ea_id, platform, game_year, price, source, recorded_at) VALUES ${placeholders.join(',')}`, values);
  return { inserted: chosen.length, considered: sample.length };
}

export async function evaluateGeneratedLists(platform, limit = 1200) {
  if (!pool) return { inserted: 0 };
  const result = await pool.query(`
    WITH pending AS (
      SELECT
        gl.id AS list_id,
        li.slot,
        li.ea_id,
        gl.platform,
        h.hours AS horizon_hours,
        li.buy_price,
        ph.price AS observed_price,
        ((ph.price - li.buy_price)::numeric / NULLIF(li.buy_price, 0)) * 100 AS price_change_pct,
        (ph.price >= li.buy_price * 0.97) AS survived
      FROM uv_generated_lists gl
      JOIN uv_list_items li ON li.list_id = gl.id
      CROSS JOIN (VALUES (1), (6), (24)) AS h(hours)
      JOIN LATERAL (
        SELECT price, recorded_at
        FROM uv_price_history
        WHERE platform = gl.platform
          AND game_year = $3
          AND ea_id = li.ea_id
          AND recorded_at >= gl.created_at + make_interval(hours => h.hours)
        ORDER BY recorded_at ASC
        LIMIT 1
      ) ph ON TRUE
      LEFT JOIN uv_list_evaluations e
        ON e.list_id = gl.id AND e.slot = li.slot AND e.horizon_hours = h.hours
      WHERE gl.platform=$1
        AND gl.game_year=$3
        AND gl.created_at > NOW() - INTERVAL '30 days'
        AND gl.created_at <= NOW() - INTERVAL '1 hour'
        AND e.list_id IS NULL
      ORDER BY gl.created_at DESC, h.hours ASC
      LIMIT $2
    )
    INSERT INTO uv_list_evaluations
      (list_id, slot, ea_id, platform, horizon_hours, buy_price, observed_price, price_change_pct, survived, evaluated_at)
    SELECT list_id, slot, ea_id, platform, horizon_hours, buy_price, observed_price, price_change_pct, survived, NOW()
    FROM pending
    ON CONFLICT (list_id, slot, horizon_hours) DO NOTHING
    RETURNING 1
  `, [platform, limit, GAME_YEAR]);
  return { inserted: result.rowCount || 0 };
}

export async function loadPerformanceFeatures(eaIds, platform) {
  const map = new Map();
  if (!pool || !eaIds?.length) return map;
  const result = await pool.query(`
    WITH agg AS (
      SELECT
        ea_id,
        horizon_hours,
        COUNT(*)::int AS eval_count,
        AVG(CASE WHEN survived THEN 1.0 ELSE 0.0 END)::numeric AS survival_rate,
        AVG(price_change_pct)::numeric AS avg_change_pct,
        MAX(evaluated_at) AS last_evaluated_at
      FROM uv_list_evaluations e
      JOIN uv_generated_lists gl ON gl.id=e.list_id
      WHERE e.platform=$1
        AND gl.game_year=$3
        AND e.ea_id = ANY($2::bigint[])
        AND evaluated_at > NOW() - INTERVAL '30 days'
      GROUP BY ea_id, horizon_hours
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY ea_id
        ORDER BY CASE horizon_hours WHEN 24 THEN 3 WHEN 6 THEN 2 ELSE 1 END DESC, eval_count DESC
      ) AS rn
      FROM agg
    )
    SELECT * FROM ranked WHERE rn=1
  `, [platform, eaIds, GAME_YEAR]);

  for (const row of result.rows) {
    const evalCount = Number(row.eval_count || 0);
    const survivalRate = Number(row.survival_rate || 0);
    const avgChangePct = Number(row.avg_change_pct || 0);
    const horizonHours = Number(row.horizon_hours || 0);
    const rawChangeScore = Math.max(15, Math.min(100, 55 + avgChangePct * 4));
    const rawScore = survivalRate * 75 + rawChangeScore * 0.25;
    const confidence = Math.min(1, evalCount / 6);
    const performanceScore = Math.max(20, Math.min(100, 50 * (1 - confidence) + rawScore * confidence));
    map.set(String(row.ea_id), {
      evalCount,
      horizonHours,
      survivalRate,
      avgChangePct,
      performanceScore,
      lastEvaluatedAt: row.last_evaluated_at || null
    });
  }
  return map;
}

export async function loadTraderRulePerformance(platform) {
  const map = new Map();
  if (!pool) return map;
  const result = await pool.query(`
    WITH tagged AS (
      SELECT
        tag.value AS rule_tag,
        e.survived,
        e.price_change_pct
      FROM uv_list_evaluations e
      JOIN uv_list_items li
        ON li.list_id = e.list_id AND li.slot = e.slot
      JOIN uv_generated_lists gl ON gl.id=e.list_id
      CROSS JOIN LATERAL jsonb_array_elements_text(
        COALESCE(li.payload->'traderKnowledge'->'ruleTags', '[]'::jsonb)
      ) AS tag(value)
      WHERE e.platform=$1
        AND gl.game_year=$2
        AND e.evaluated_at > NOW() - INTERVAL '30 days'
        AND e.horizon_hours IN (6, 24)
    )
    SELECT
      rule_tag,
      COUNT(*)::int AS samples,
      AVG(CASE WHEN survived THEN 1.0 ELSE 0.0 END)::numeric AS survival_rate,
      AVG(price_change_pct)::numeric AS avg_change_pct
    FROM tagged
    GROUP BY rule_tag
  `, [platform, GAME_YEAR]);

  for (const row of result.rows) {
    const samples = Number(row.samples || 0);
    const survivalRate = Number(row.survival_rate || 0);
    const avgChangePct = Number(row.avg_change_pct || 0);
    const changeScore = Math.max(20, Math.min(100, 55 + avgChangePct * 3));
    const raw = survivalRate * 80 + changeScore * 0.20;
    const confidence = Math.min(1, samples / 20);
    const priceSafetyScore = Math.max(20, Math.min(100, 50 * (1 - confidence) + raw * confidence));
    map.set(String(row.rule_tag), {
      ruleTag: String(row.rule_tag),
      samples,
      survivalRate,
      avgChangePct,
      priceSafetyScore
    });
  }
  return map;
}

export async function getLearningStatus() {
  if (!pool) return { enabled: false, evaluations: 0, cards: 0, lists: 0 };
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS evaluations,
      COUNT(DISTINCT ea_id)::int AS cards,
      COUNT(DISTINCT list_id)::int AS lists,
      MAX(evaluated_at) AS last_evaluated_at
    FROM uv_list_evaluations e
    JOIN uv_generated_lists gl ON gl.id=e.list_id
    WHERE gl.game_year=$1
  `, [GAME_YEAR]);
  const row = result.rows[0] || {};
  return {
    enabled: true,
    evaluations: Number(row.evaluations || 0),
    cards: Number(row.cards || 0),
    lists: Number(row.lists || 0),
    lastEvaluatedAt: row.last_evaluated_at || null
  };
}



function priceBandSql(field = 'li.buy_price') {
  return `CASE
    WHEN ${field} < 1500 THEN 'P0_1500'
    WHEN ${field} < 5000 THEN 'P1500_5000'
    WHEN ${field} < 15000 THEN 'P5000_15000'
    WHEN ${field} < 50000 THEN 'P15000_50000'
    WHEN ${field} < 100000 THEN 'P50000_100000'
    ELSE 'P100000_PLUS' END`;
}

function profitBandSql(field = "COALESCE((li.payload->>'requestedTargetProfit')::numeric, li.net_profit)") {
  return `CASE
    WHEN ${field} < 700 THEN 'N0_699'
    WHEN ${field} < 1000 THEN 'N700_999'
    WHEN ${field} < 1250 THEN 'N1000_1249'
    WHEN ${field} < 1500 THEN 'N1250_1499'
    WHEN ${field} < 2000 THEN 'N1500_1999'
    WHEN ${field} < 2500 THEN 'N2000_2499'
    ELSE 'N2500_3000' END`;
}

function demandBandSql() {
  return `CASE
    WHEN COALESCE((li.payload->>'saleLikelihoodIndex')::numeric, 50) >= 70 THEN 'HIGH'
    WHEN COALESCE((li.payload->>'saleLikelihoodIndex')::numeric, 50) >= 55 THEN 'MID'
    ELSE 'LOW' END`;
}

function cardTypeBandSql() {
  return `CASE WHEN LOWER(COALESCE(li.payload->>'cardType',''))='special' THEN 'SPECIAL' ELSE 'BASE' END`;
}

function supplyBandSql() {
  return `CASE WHEN COALESCE((li.payload->>'inPacksHit')::boolean, false) THEN 'IN_PACKS' ELSE 'OUT_OF_PACKS' END`;
}

export async function loadTargetSupportPerformance(platform) {
  const map = new Map();
  if (!pool) return map;
  const priceBand = priceBandSql();
  const profitBand = profitBandSql();
  const demandBand = demandBandSql();
  const cardTypeBand = cardTypeBandSql();
  const supplyBand = supplyBandSql();

  const market = await pool.query(`
    SELECT
      ${priceBand} AS price_band,
      ${profitBand} AS profit_band,
      ${cardTypeBand} AS card_type_band,
      ${demandBand} AS demand_band,
      ${supplyBand} AS supply_band,
      COUNT(*)::int AS samples,
      AVG(CASE WHEN e.survived THEN 1.0 ELSE 0.0 END)::numeric AS survival_rate,
      AVG(LEAST(1.0, GREATEST(0.0,
        (e.observed_price - li.buy_price)::numeric / NULLIF(li.sell_price - li.buy_price, 0)
      )))::numeric AS avg_target_proximity,
      AVG(CASE WHEN e.observed_price >= li.sell_price * 0.98 THEN 1.0 ELSE 0.0 END)::numeric AS market_support_rate
    FROM uv_list_evaluations e
    JOIN uv_list_items li ON li.list_id=e.list_id AND li.slot=e.slot
    JOIN uv_generated_lists gl ON gl.id=e.list_id
    WHERE e.platform=$1
      AND gl.game_year=$2
      AND e.evaluated_at > NOW() - INTERVAL '45 days'
      AND e.horizon_hours IN (6,24)
    GROUP BY 1,2,3,4,5
  `, [platform, GAME_YEAR]);

  for (const row of market.rows) {
    const samples = Number(row.samples || 0);
    const survivalRate = Number(row.survival_rate || 0);
    const proximity = Number(row.avg_target_proximity || 0);
    const supportRate = Number(row.market_support_rate || 0);
    const raw = Math.max(0, Math.min(100, survivalRate * 30 + proximity * 45 + supportRate * 25));
    const confidence = Math.min(1, samples / 24);
    const marketSupportScore = Math.max(15, Math.min(95, 50 * (1 - confidence) + raw * confidence));
    const key = [row.price_band, row.profit_band, row.card_type_band, row.demand_band, row.supply_band].join('|');
    map.set(key, {
      profileKey: key,
      priceBand: row.price_band,
      profitBand: row.profit_band,
      cardTypeBand: row.card_type_band,
      demandBand: row.demand_band,
      supplyBand: row.supply_band,
      marketSamples: samples,
      survivalRate,
      avgTargetProximity: proximity,
      marketSupportRate: supportRate,
      marketSupportScore,
      reportedFeedbackSamples: 0,
      reportedSellRate: null,
      combinedSupportScore: marketSupportScore
    });
  }

  const feedback = await pool.query(`
    SELECT
      ${priceBand} AS price_band,
      ${profitBand} AS profit_band,
      ${cardTypeBand} AS card_type_band,
      ${demandBand} AS demand_band,
      ${supplyBand} AS supply_band,
      COUNT(*)::int AS samples,
      AVG(CASE WHEN f.outcome='sold' THEN 1.0 ELSE 0.0 END)::numeric AS sold_rate,
      AVG(f.relists)::numeric AS avg_relists,
      AVG(CASE WHEN f.outcome='sold' THEN f.relists::numeric END)::numeric AS avg_sold_relists,
      AVG(CASE WHEN f.outcome='sold' AND f.sold_price IS NOT NULL
        THEN FLOOR(f.sold_price * 0.95) - COALESCE(f.actual_buy_price, li.buy_price) END)::numeric AS avg_reported_net_profit,
      AVG(CASE WHEN f.outcome='sold' AND f.sold_price IS NOT NULL AND COALESCE(f.actual_buy_price, li.buy_price) > 0
        THEN ((FLOOR(f.sold_price * 0.95) - COALESCE(f.actual_buy_price, li.buy_price))::numeric / COALESCE(f.actual_buy_price, li.buy_price)) * 100 END)::numeric AS avg_reported_roi_pct,
      AVG(li.net_profit)::numeric AS avg_recommended_net_profit,
      AVG(GREATEST(0, EXTRACT(EPOCH FROM (f.resolved_at - COALESCE(f.listed_at, gl.created_at))) / 3600.0))::numeric AS avg_resolution_hours
    FROM uv_trade_feedback f
    JOIN uv_list_items li ON li.list_id=f.list_id AND li.slot=f.slot
    JOIN uv_generated_lists gl ON gl.id=f.list_id
    WHERE gl.platform=$1
      AND gl.game_year=$2
      AND f.outcome IN ('sold','unsold','expired')
      AND f.resolved_at > NOW() - INTERVAL '90 days'
    GROUP BY 1,2,3,4,5
  `, [platform, GAME_YEAR]);

  for (const row of feedback.rows) {
    const key = [row.price_band, row.profit_band, row.card_type_band, row.demand_band, row.supply_band].join('|');
    const prior = map.get(key) || {
      profileKey: key,
      priceBand: row.price_band,
      profitBand: row.profit_band,
      cardTypeBand: row.card_type_band,
      demandBand: row.demand_band,
      supplyBand: row.supply_band,
      marketSamples: 0,
      survivalRate: null,
      avgTargetProximity: null,
      marketSupportRate: null,
      marketSupportScore: 50
    };
    const feedbackSamples = Number(row.samples || 0);
    const soldRate = Number(row.sold_rate || 0);
    const avgRelists = Number.isFinite(Number(row.avg_relists)) ? Number(row.avg_relists) : null;
    const avgNetProfit = Number.isFinite(Number(row.avg_reported_net_profit)) ? Number(row.avg_reported_net_profit) : null;
    const avgRecommendedNetProfit = Number.isFinite(Number(row.avg_recommended_net_profit)) ? Number(row.avg_recommended_net_profit) : null;
    const avgReportedRoiPct = Number.isFinite(Number(row.avg_reported_roi_pct)) ? Number(row.avg_reported_roi_pct) : null;
    const avgResolutionHours = Number.isFinite(Number(row.avg_resolution_hours)) ? Number(row.avg_resolution_hours) : null;
    const feedbackConfidence = Math.min(1, feedbackSamples / 16);
    const relistEfficiencyScore = avgRelists == null ? 50 : Math.max(15, Math.min(100, 100 - avgRelists * 11));
    const profitRatio = avgNetProfit != null && avgRecommendedNetProfit != null && avgRecommendedNetProfit > 0
      ? avgNetProfit / avgRecommendedNetProfit
      : null;
    const profitRealizationScore = profitRatio == null
      ? (avgReportedRoiPct == null ? 50 : Math.max(20, Math.min(90, 50 + avgReportedRoiPct * 1.4)))
      : Math.max(15, Math.min(95, 50 + (profitRatio - 1) * 45));
    const resolutionSpeedScore = avgResolutionHours == null ? 50
      : avgResolutionHours <= 6 ? 92
      : avgResolutionHours <= 12 ? 84
      : avgResolutionHours <= 24 ? 72
      : avgResolutionHours <= 48 ? 58
      : avgResolutionHours <= 72 ? 46 : 34;
    const rawOutcomeScore = Math.max(0, Math.min(100,
      soldRate * 100 * 0.52 + relistEfficiencyScore * 0.20 + profitRealizationScore * 0.18 + resolutionSpeedScore * 0.10
    ));
    const reportedOutcomeScore = Math.max(10, Math.min(95, 50 * (1 - feedbackConfidence) + rawOutcomeScore * feedbackConfidence));
    const actualWeight = 0.62 * feedbackConfidence;
    const combined = Math.max(10, Math.min(95, prior.marketSupportScore * (1 - actualWeight) + reportedOutcomeScore * actualWeight));
    map.set(key, {
      ...prior,
      reportedFeedbackSamples: feedbackSamples,
      reportedSellRate: soldRate,
      reportedOutcomeScore,
      avgReportedRelists: avgRelists,
      avgSoldRelists: Number.isFinite(Number(row.avg_sold_relists)) ? Number(row.avg_sold_relists) : null,
      avgReportedNetProfit: avgNetProfit,
      avgRecommendedNetProfit,
      avgReportedRoiPct,
      avgResolutionHours,
      relistEfficiencyScore,
      profitRealizationScore,
      resolutionSpeedScore,
      combinedSupportScore: combined
    });
  }
  return map;
}

export async function recordTradeJournalEvent({ listId, slot, event, price = null, relists = null, note = null }) {
  if (!pool) throw new Error('PostgreSQL ist nicht konfiguriert.');
  const id = Number(listId);
  const s = Number(slot);
  const normalized = String(event || '').toLowerCase();
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(s) || s <= 0) throw new Error('listId/slot ungueltig.');
  if (!['bought','listed','relisted','skipped','sold','expired','unsold'].includes(normalized)) throw new Error('event ungueltig.');
  const exists = await pool.query(`
    SELECT 1 FROM uv_list_items li
    JOIN uv_generated_lists gl ON gl.id=li.list_id
    WHERE li.list_id=$1 AND li.slot=$2 AND gl.game_year=$3
  `, [id, s, GAME_YEAR]);
  if (!exists.rowCount) throw new Error('Listenposition nicht gefunden.');
  const n = Number(price);
  const safePrice = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  const safeRelists = relists == null ? null : Math.max(0, Math.min(999, Math.floor(Number(relists) || 0)));
  const safeNote = note == null ? null : String(note).slice(0, 500);
  const saved = await pool.query(`
    INSERT INTO uv_trade_journal (list_id, slot, event, price, relists, note)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id, created_at
  `, [id, s, normalized, safePrice, safeRelists, safeNote]);
  return { ok: true, id: Number(saved.rows[0].id), listId: id, slot: s, event: normalized, price: safePrice, relists: safeRelists, createdAt: saved.rows[0].created_at };
}

export async function recordTradeFeedback({ listId, slot, outcome, soldPrice = null, relists = 0, note = null, actualBuyPrice = null, listedPrice = null, marketPriceAtBuy = null, marketPriceAtSale = null, listedAt = null }) {
  if (!pool) throw new Error('PostgreSQL ist nicht konfiguriert.');
  const normalized = String(outcome || '').toLowerCase();
  if (!['bought', 'sold', 'unsold', 'expired', 'skipped'].includes(normalized)) throw new Error('outcome muss bought, sold, unsold, expired oder skipped sein.');
  const id = Number(listId);
  const s = Number(slot);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(s) || s <= 0) throw new Error('listId/slot ungueltig.');
  const exists = await pool.query(`
    SELECT gl.platform, li.ea_id, li.buy_price, li.sell_price
    FROM uv_list_items li
    JOIN uv_generated_lists gl ON gl.id=li.list_id
    WHERE li.list_id=$1 AND li.slot=$2 AND gl.game_year=$3
  `, [id, s, GAME_YEAR]);
  if (!exists.rowCount) throw new Error('Listenposition nicht gefunden.');
  const safePrice = value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };
  const safeSoldPrice = safePrice(soldPrice);
  const safeActualBuyPrice = safePrice(actualBuyPrice);
  const safeListedPrice = safePrice(listedPrice);
  const safeMarketPriceAtBuy = safePrice(marketPriceAtBuy);
  const safeMarketPriceAtSale = safePrice(marketPriceAtSale);
  const safeRelists = Math.max(0, Math.min(999, Math.floor(Number(relists || 0))));
  const safeNote = note == null ? null : String(note).slice(0, 500);
  const parsedListedAt = listedAt ? new Date(listedAt) : null;
  const safeListedAt = parsedListedAt && Number.isFinite(parsedListedAt.getTime()) ? parsedListedAt.toISOString() : null;
  await pool.query(`
    INSERT INTO uv_trade_feedback (
      list_id, slot, outcome, sold_price, relists, note, actual_buy_price, listed_price,
      market_price_at_buy, market_price_at_sale, listed_at, resolved_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT (list_id, slot) DO UPDATE SET
      outcome=EXCLUDED.outcome, sold_price=EXCLUDED.sold_price, relists=EXCLUDED.relists,
      note=EXCLUDED.note, actual_buy_price=COALESCE(EXCLUDED.actual_buy_price, uv_trade_feedback.actual_buy_price),
      listed_price=COALESCE(EXCLUDED.listed_price, uv_trade_feedback.listed_price),
      market_price_at_buy=COALESCE(EXCLUDED.market_price_at_buy, uv_trade_feedback.market_price_at_buy),
      market_price_at_sale=COALESCE(EXCLUDED.market_price_at_sale, uv_trade_feedback.market_price_at_sale),
      listed_at=COALESCE(EXCLUDED.listed_at, uv_trade_feedback.listed_at), resolved_at=NOW()
  `, [id, s, normalized, safeSoldPrice, safeRelists, safeNote, safeActualBuyPrice, safeListedPrice, safeMarketPriceAtBuy, safeMarketPriceAtSale, safeListedAt]);
  await pool.query(`
    INSERT INTO uv_trade_journal (list_id, slot, event, price, relists, note)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [id, s, normalized, safeSoldPrice || safeActualBuyPrice || safeListedPrice, safeRelists, safeNote]);
  return { ok: true, listId: id, slot: s, outcome: normalized, soldPrice: safeSoldPrice, relists: safeRelists, actualBuyPrice: safeActualBuyPrice, listedPrice: safeListedPrice, marketPriceAtBuy: safeMarketPriceAtBuy, marketPriceAtSale: safeMarketPriceAtSale, listedAt: safeListedAt };
}

export async function getTradeFeedbackStatus(platform = null) {
  if (!pool) return { enabled: false, total: 0, sold: 0, reportedSellRate: null };
  const values = [GAME_YEAR];
  let where = 'WHERE gl.game_year=$1';
  if (platform) { values.push(platform); where += ' AND gl.platform=$2'; }
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE f.outcome IN ('sold','unsold','expired'))::int AS total,
      COUNT(*) FILTER (WHERE f.outcome='sold')::int AS sold,
      COUNT(*) FILTER (WHERE f.outcome='unsold')::int AS unsold,
      COUNT(*) FILTER (WHERE f.outcome='expired')::int AS expired,
      COUNT(*) FILTER (WHERE f.outcome='bought')::int AS bought,
      COUNT(*) FILTER (WHERE f.outcome='skipped')::int AS skipped,
      AVG(f.relists) FILTER (WHERE f.outcome IN ('sold','unsold','expired'))::numeric AS avg_relists,
      AVG(CASE WHEN f.outcome='sold' AND f.sold_price IS NOT NULL
        THEN FLOOR(f.sold_price * 0.95) - COALESCE(f.actual_buy_price, li.buy_price) END)::numeric AS avg_sold_net_profit,
      AVG(GREATEST(0, EXTRACT(EPOCH FROM (f.resolved_at - COALESCE(f.listed_at, gl.created_at))) / 3600.0)) FILTER (WHERE f.outcome IN ('sold','unsold','expired'))::numeric AS avg_resolution_hours,
      MAX(f.resolved_at) AS last_at
    FROM uv_trade_feedback f
    JOIN uv_generated_lists gl ON gl.id=f.list_id
    JOIN uv_list_items li ON li.list_id=f.list_id AND li.slot=f.slot
    ${where}
  `, values);
  const row = result.rows[0] || {};
  const total = Number(row.total || 0);
  const sold = Number(row.sold || 0);
  return {
    enabled: true,
    total,
    sold,
    unsold: Number(row.unsold || 0),
    expired: Number(row.expired || 0),
    bought: Number(row.bought || 0),
    skipped: Number(row.skipped || 0),
    reportedSellRate: total > 0 ? sold / total : null,
    avgRelists: Number.isFinite(Number(row.avg_relists)) ? Number(row.avg_relists) : null,
    avgSoldNetProfit: Number.isFinite(Number(row.avg_sold_net_profit)) ? Number(row.avg_sold_net_profit) : null,
    avgResolutionHours: Number.isFinite(Number(row.avg_resolution_hours)) ? Number(row.avg_resolution_hours) : null,
    lastAt: row.last_at || null
  };
}

export async function saveListRecheck(listId, rows = [], summary = {}, checkedAt = new Date()) {
  if (!pool) return { ok: false, saved: 0 };
  const id = Number(listId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('listId ungueltig.');

  // v2.4.3: persist the full 100-slot live recheck in one set-based UPDATE.
  // The previous implementation executed one UPDATE per slot (100+ DB round trips)
  // before the HTTP response could finish, which could make the UI look as if the
  // live-check button did nothing on remote PostgreSQL deployments.
  const payloadRows = (Array.isArray(rows) ? rows : [])
    .map(row => ({ slot: Number(row?.slot), payload: row }))
    .filter(row => Number.isInteger(row.slot) && row.slot > 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT 1 FROM uv_generated_lists WHERE id=$1 AND game_year=$2 FOR UPDATE`, [id, GAME_YEAR]);
    if (!current.rowCount) throw new Error('Liste nicht gefunden.');
    let saved = 0;
    if (payloadRows.length) {
      const result = await client.query(`
        UPDATE uv_list_items AS item
        SET last_recheck = src.payload
        FROM jsonb_to_recordset($2::jsonb) AS src(slot integer, payload jsonb)
        WHERE item.list_id=$1 AND item.slot=src.slot
      `, [id, JSON.stringify(payloadRows)]);
      saved = Number(result.rowCount || 0);
    }
    await client.query(`
      UPDATE uv_generated_lists
      SET last_recheck_at=$2, last_recheck_summary=$3::jsonb
      WHERE id=$1
    `, [id, checkedAt instanceof Date ? checkedAt : new Date(checkedAt), JSON.stringify(summary || {})]);
    await client.query('COMMIT');
    return { ok: true, saved };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function loadGeneratedList(listId) {
  if (!pool) throw new Error('PostgreSQL ist nicht konfiguriert.');
  const id = Number(listId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('listId ungueltig.');
  const head = await pool.query(`
    SELECT id, budget, platform, card_count, total_buy, total_expected_profit, avg_uv_score, summary_payload, last_recheck_at, last_recheck_summary, created_at
    FROM uv_generated_lists
    WHERE id=$1 AND game_year=$2
  `, [id, GAME_YEAR]);
  if (!head.rowCount) throw new Error('Liste nicht gefunden.');
  const items = await pool.query(`
    SELECT li.slot, li.ea_id, li.buy_price, li.start_price, li.sell_price, li.ea_tax, li.net_profit, li.uv_score, li.payload, li.last_recheck,
           f.outcome AS feedback_outcome, f.sold_price, f.relists, f.actual_buy_price, f.listed_price, f.listed_at, f.resolved_at
    FROM uv_list_items li
    LEFT JOIN uv_trade_feedback f ON f.list_id=li.list_id AND f.slot=li.slot
    WHERE li.list_id=$1
    ORDER BY slot ASC
  `, [id]);
  const journal = await pool.query(`
    SELECT DISTINCT ON (slot) slot, event, price, relists, note, created_at
    FROM uv_trade_journal
    WHERE list_id=$1
    ORDER BY slot, created_at DESC
  `, [id]);
  const journalBySlot = new Map(journal.rows.map(r => [Number(r.slot), {
    event: r.event,
    price: r.price == null ? null : Number(r.price),
    relists: r.relists == null ? null : Number(r.relists),
    note: r.note || null,
    createdAt: r.created_at
  }]));
  const h = head.rows[0];
  return {
    id: Number(h.id),
    budget: Number(h.budget),
    platform: h.platform,
    cardCount: Number(h.card_count),
    totalBuy: Number(h.total_buy),
    totalExpectedProfit: Number(h.total_expected_profit),
    avgUvScore: Number(h.avg_uv_score || 0),
    summaryPayload: h.summary_payload || null,
    lastRecheckAt: h.last_recheck_at || null,
    lastRecheckSummary: h.last_recheck_summary || null,
    createdAt: h.created_at,
    items: items.rows.map(r => ({
      slot: Number(r.slot),
      eaId: Number(r.ea_id),
      buyPrice: Number(r.buy_price),
      startPrice: Number(r.start_price),
      sellPrice: Number(r.sell_price),
      eaTax: Number(r.ea_tax),
      netProfit: Number(r.net_profit),
      uvScore: Number(r.uv_score || 0),
      payload: r.payload || {},
      lastRecheck: r.last_recheck || null,
      feedback: r.feedback_outcome ? {
        outcome: r.feedback_outcome, soldPrice: r.sold_price == null ? null : Number(r.sold_price),
        relists: Number(r.relists || 0), actualBuyPrice: r.actual_buy_price == null ? null : Number(r.actual_buy_price),
        listedPrice: r.listed_price == null ? null : Number(r.listed_price), listedAt: r.listed_at || null, resolvedAt: r.resolved_at || null
      } : null,
      journal: journalBySlot.get(Number(r.slot)) || null
    }))
  };
}

export async function listGeneratedLists(platform = null, limit = 25) {
  if (!pool) return [];
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit || 25))));
  const values = [GAME_YEAR];
  let where = "WHERE gl.game_year=$1 AND COALESCE((gl.summary_payload->>'transientRecheckOnly')::boolean, false) = false";
  if (platform) { values.push(platform); where += ' AND gl.platform=$2'; }
  values.push(safeLimit);
  const limitPos = values.length;
  const result = await pool.query(`
    SELECT
      gl.id, gl.budget, gl.platform, gl.card_count, gl.total_buy, gl.total_expected_profit,
      gl.avg_uv_score, gl.summary_payload, gl.last_recheck_at, gl.last_recheck_summary, gl.created_at,
      COUNT(f.*)::int AS feedback_count,
      COUNT(f.*) FILTER (WHERE f.outcome='sold')::int AS sold_count
    FROM uv_generated_lists gl
    LEFT JOIN uv_trade_feedback f ON f.list_id=gl.id
    ${where}
    GROUP BY gl.id
    ORDER BY gl.created_at DESC
    LIMIT $${limitPos}
  `, values);
  return result.rows.map(r => ({
    id: Number(r.id),
    budget: Number(r.budget),
    platform: r.platform,
    cardCount: Number(r.card_count),
    totalBuy: Number(r.total_buy),
    totalExpectedProfit: Number(r.total_expected_profit),
    avgUvScore: Number(r.avg_uv_score || 0),
    createdAt: r.created_at,
    lastRecheckAt: r.last_recheck_at || null,
    lastRecheckSummary: r.last_recheck_summary || null,
    feedbackCount: Number(r.feedback_count || 0),
    soldCount: Number(r.sold_count || 0)
  }));
}


export async function loadRealMarketRegimeRows(platform) {
  if (!pool) return [];
  const result = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (ea_id) ea_id, price, recorded_at
      FROM uv_price_history
      WHERE platform=$1 AND game_year=$2
        AND recorded_at > NOW() - INTERVAL '75 minutes'
      ORDER BY ea_id, recorded_at DESC
    )
    SELECT l.ea_id, l.price,
      p5.price AS price_5m, p15.price AS price_15m, p60.price AS price_1h
    FROM latest l
    LEFT JOIN LATERAL (
      SELECT price FROM uv_price_history h
      WHERE h.platform=$1 AND h.game_year=$2 AND h.ea_id=l.ea_id
        AND h.recorded_at <= l.recorded_at - INTERVAL '5 minutes'
        AND h.recorded_at >= l.recorded_at - INTERVAL '10 minutes'
      ORDER BY h.recorded_at DESC LIMIT 1
    ) p5 ON TRUE
    LEFT JOIN LATERAL (
      SELECT price FROM uv_price_history h
      WHERE h.platform=$1 AND h.game_year=$2 AND h.ea_id=l.ea_id
        AND h.recorded_at <= l.recorded_at - INTERVAL '15 minutes'
        AND h.recorded_at >= l.recorded_at - INTERVAL '25 minutes'
      ORDER BY h.recorded_at DESC LIMIT 1
    ) p15 ON TRUE
    LEFT JOIN LATERAL (
      SELECT price FROM uv_price_history h
      WHERE h.platform=$1 AND h.game_year=$2 AND h.ea_id=l.ea_id
        AND h.recorded_at <= l.recorded_at - INTERVAL '60 minutes'
        AND h.recorded_at >= l.recorded_at - INTERVAL '75 minutes'
      ORDER BY h.recorded_at DESC LIMIT 1
    ) p60 ON TRUE
  `, [platform, GAME_YEAR]);
  return result.rows;
}
