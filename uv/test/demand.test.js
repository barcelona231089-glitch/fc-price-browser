import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMostUsedSignals, extractNamedVersionSignals, htmlToSearchText, attachFutggDemandSignals, buildPromoMarketScore, promoMarketState } from '../src/demand.js';

test('Most Used parser finds player and usage percentage from FUT.GG-style markup', () => {
  const html = `
    <section><h2>ST</h2><div>Striker</div><h3>What the Community Uses</h3>
      <div>#1 11% <strong>Eusébio</strong> <span>FC Pro World Champion ICON</span> ST RW LW</div>
      <div>#2 5% <strong>Ferran Torres</strong> <span>Festival of Football: Path to Glory</span></div>
    </section>`;
  const cards = [
    { eaId: 1, name: 'Eusébio', rarityName: 'FC Pro World Champion ICON', cardType: 'Special' },
    { eaId: 2, name: 'Ferran Torres', rarityName: 'Festival of Football: Path to Glory', cardType: 'Special' },
    { eaId: 3, name: 'Nobody', rarityName: 'Gold', cardType: 'Base Rare' }
  ];
  const parsed = extractMostUsedSignals(html, cards);
  const eusebio = parsed.get('eusebio');
  assert.ok(eusebio);
  assert.equal(eusebio.hits[0].pct, 11);
  assert.equal(eusebio.hits[0].audience, 'community');
  assert.equal(eusebio.hits[0].position, 'ST');
  assert.equal(eusebio.hits[0].rank, 1);
  assert.equal(parsed.has('nobody'), false);
});

test('Most Used parser keeps separate Pros and Community evidence across positions', () => {
  const html = `
    <h2>ST</h2><div>Striker</div><h3>What the Pros Use</h3><div>#2 8% <b>Alex Example</b> Summer Stars ST</div>
    <h3>What the Community Uses</h3><div>#1 14% <b>Alex Example</b> Summer Stars ST</div>
    <h2>LW</h2><div>Left Winger</div><h3>What the Community Uses</h3><div>#3 6% <b>Alex Example</b> Summer Stars LW</div>`;
  const cards = [{ eaId: 10, name: 'Alex Example', rarityName: 'Summer Stars', cardType: 'Special' }];
  const parsed = extractMostUsedSignals(html, cards).get('alex example');
  assert.ok(parsed);
  assert.equal(parsed.hits.length, 3);
  assert.ok(parsed.hits.some(h => h.audience === 'pros' && h.pct === 8));
  assert.ok(parsed.hits.some(h => h.audience === 'community' && h.position === 'LW' && h.pct === 6));
});

test('Version-aware presence rejects a different special version of same player', () => {
  const html = `<div>Player Card Alex Example Team of the Season ST 96</div>`;
  const cards = [
    { eaId: 11, name: 'Alex Example', rarityName: 'Summer Stars', cardType: 'Special', overall: 97 },
    { eaId: 12, name: 'Alex Example', rarityName: 'Team of the Season', cardType: 'Special', overall: 96 }
  ];
  const signals = extractNamedVersionSignals(html, cards, { requireVersionForSpecial: true });
  assert.equal(signals.has('11'), false);
  assert.equal(signals.has('12'), true);
  assert.equal(signals.get('12').versionMatched, true);
});

test('HTML normalizer keeps percentages, strips scripts and removes accents for matching', () => {
  const text = htmlToSearchText('<script>Fake 99% Eusébio</script><div>#1 14% <b>Jairzinho</b></div><div>Eusébio</div>');
  assert.ok(text.includes('14%'));
  assert.ok(text.includes('eusebio'));
  assert.equal(text.includes('fake 99%'), false);
});


test('v2.1 promo score rewards in-packs specials only when demand/momentum supports them', () => {
  const base = { cardType: 'Special' };
  const supplyOnly = buildPromoMarketScore(base, { inPacksHit: true, momentumHit: false, usage: null, supplyPressureScore: 72 });
  const hot = buildPromoMarketScore(base, {
    inPacksHit: true,
    momentumHit: true,
    usage: { popularityScore: 86, usagePct: 5 },
    supplyPressureScore: 72
  });
  assert.ok(hot > supplyOnly + 20);
  assert.equal(promoMarketState({ ...base, inPacksHit: true, promoMarketScore: supplyOnly }), 'SUPPLY_ONLY');
  assert.equal(promoMarketState({ ...base, inPacksHit: true, promoMarketScore: hot }), 'PROMO_HOT');
});
