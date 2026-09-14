import { Buffer } from "node:buffer";
import { patchPermanentMlV1069961 } from "./v1069961Loader.mjs";
import { patchPermanentMlArchiveV1069965 } from "./v1069965Loader.mjs";

export const V1069966_ARCHIVE_PARAM_FIX_VERSION = "10.69.9.6.6-archive-param-fix";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

export function patchPermanentMlArchiveParamV1069966(source) {
  let out = String(source || "");

  // The hook can receive either the raw module or the already-v10.69.9.6.5-patched
  // module depending on loader-chain order. Make the patch order-independent.
  if (!out.includes("v10.69.9.6.5 time-aware historical labels")) {
    out = patchPermanentMlV1069961(out);
    out = patchPermanentMlArchiveV1069965(out);
  }

  // Root cause: v10.69.9.6.5 reused PostgreSQL $1 with incompatible
  // explicit types in one UNION. The archive branch used $1::smallint while
  // the FC26 legacy branch uses $1::text. PostgreSQL rejects that statement
  // before reading rows. Remove $1 from the archive branches entirely and
  // embed only the internal numeric game-year value. The remaining $1 stays
  // text-compatible for own/legacy history.
  const oldPredicate = "game_year = $1::smallint AND platform = '${HISTORICAL_ARCHIVE_PLATFORM}'";
  const coveragePredicate = "game_year = ${Number(year)} AND platform = '${HISTORICAL_ARCHIVE_PLATFORM}'";
  const cyclePredicate = "game_year = ${Number(sourceYear)} AND platform = '${HISTORICAL_ARCHIVE_PLATFORM}'";
  out = out.replace(oldPredicate, coveragePredicate);
  out = out.replace(oldPredicate, cyclePredicate);

  // Surface future archive-source failures instead of silently turning them into
  // zero coverage / zero cycle samples.
  const oldCycleCatch = 'cycleByYear[year] = await trainHistoricalCycleModels(pool, year).catch(() => ({ sampleCount: 0, cards: 0, spanDays: 0 }));';
  const newCycleCatch = `cycleByYear[year] = await trainHistoricalCycleModels(pool, year).catch(error => {\n        console.error(\`[v10.69.9.6.6] Permanent-ML cycle FC\${year} failed: \${error?.message || error}\`);\n        return { sampleCount: 0, cards: 0, spanDays: 0, error: String(error?.message || error) };\n      });`;
  out = out.replace(oldCycleCatch, newCycleCatch);

  const oldCoverageCatch = 'coverageByYear[year] = await historicalCoverageForYear(pool, year).catch(() => ({ gameYear: year, observations: 0, cards: 0, observedCalendarDays: 0, earliestAt: null, latestAt: null, spanDays: 0 }));';
  const newCoverageCatch = `coverageByYear[year] = await historicalCoverageForYear(pool, year).catch(error => {\n        console.error(\`[v10.69.9.6.6] Permanent-ML coverage FC\${year} failed: \${error?.message || error}\`);\n        return { gameYear: year, observations: 0, cards: 0, observedCalendarDays: 0, earliestAt: null, latestAt: null, spanDays: 0, error: String(error?.message || error) };\n      });`;
  out = out.replace(oldCoverageCatch, newCoverageCatch);

  out = out.replace(
    'export const PERMANENT_ML_VERSION = "10.69.9.6.5";',
    'export const PERMANENT_ML_VERSION = "10.69.9.6.6";'
  );

  if (!out.includes("game_year = ${Number(year)}") || !out.includes("game_year = ${Number(sourceYear)}")) {
    throw new Error("[v10.69.9.6.6] archive parameter compatibility fix missing");
  }
  if (!out.includes("[v10.69.9.6.6] Permanent-ML cycle FC")) {
    throw new Error("[v10.69.9.6.6] cycle error visibility patch missing");
  }
  if (!out.includes("[v10.69.9.6.6] Permanent-ML coverage FC")) {
    throw new Error("[v10.69.9.6.6] coverage error visibility patch missing");
  }
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module") return result;
  const raw = sourceText(result.source);
  if (raw == null) return result;

  if (url.endsWith("/permanentMlBrainV106996.js")) {
    try {
      const source = patchPermanentMlArchiveParamV1069966(raw);
      console.log("[v10.69.9.6.6] Permanent-ML archive parameter compatibility fix ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.6] archive parameter fix disabled: ${error?.stack || error}`);
      return result;
    }
  }

  return result;
}

export const __test = { sourceText, patchPermanentMlArchiveParamV1069966 };
