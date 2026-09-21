import test from "node:test";
import assert from "node:assert/strict";

async function loadFresh(tag) {
  return import(`../futbinDirectBrainV1.js?${tag}-${Date.now()}`);
}

test("server collector stays fail-closed unless both activation flags are set", async () => {
  const oldEnabled = process.env.FUTBIN_SERVER_COLLECTOR_ENABLED;
  const oldConfirmed = process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED;
  const oldDirect = process.env.FUTBIN_DIRECT_ENABLED;
  const oldDirectConfirmed = process.env.FUTBIN_DIRECT_ACTIVATION_CONFIRMED;
  try {
    delete process.env.FUTBIN_DIRECT_ENABLED;
    delete process.env.FUTBIN_DIRECT_ACTIVATION_CONFIRMED;
    process.env.FUTBIN_SERVER_COLLECTOR_ENABLED = "true";
    delete process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED;
    let mod = await loadFresh("off");
    assert.equal(mod.getDirectFutbinBrainStatus().enabled, false);

    process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED = "true";
    mod = await loadFresh("on");
    const status = mod.getDirectFutbinBrainStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.serverCollectorEnabled, true);
    assert.equal(status.endpointPolicy.noAccessBypass, true);
    assert.equal(status.endpointPolicy.noHiddenEndpointDiscovery, true);
  } finally {
    if (oldEnabled == null) delete process.env.FUTBIN_SERVER_COLLECTOR_ENABLED; else process.env.FUTBIN_SERVER_COLLECTOR_ENABLED = oldEnabled;
    if (oldConfirmed == null) delete process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED; else process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED = oldConfirmed;
    if (oldDirect == null) delete process.env.FUTBIN_DIRECT_ENABLED; else process.env.FUTBIN_DIRECT_ENABLED = oldDirect;
    if (oldDirectConfirmed == null) delete process.env.FUTBIN_DIRECT_ACTIVATION_CONFIRMED; else process.env.FUTBIN_DIRECT_ACTIVATION_CONFIRMED = oldDirectConfirmed;
  }
});

test("server collector uses the known public price endpoint and preserves source checked time", async () => {
  const oldEnabled = process.env.FUTBIN_SERVER_COLLECTOR_ENABLED;
  const oldConfirmed = process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED;
  try {
    process.env.FUTBIN_SERVER_COLLECTOR_ENABLED = "true";
    process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED = "true";
    const mod = await loadFresh("fetch");
    mod.resetDirectFutbinBrainForTests();
    const seen = [];
    const fakeFetch = async url => {
      seen.push(String(url));
      return {
        ok: true,
        async json() {
          return { data: [{ ID: 778, Player_Resource: 230899, Player_ID: 230899, Player_Fullname: "Ademola Lookman", LCPrice: 12250, checked: "2026-09-22 00:08:21" }] };
        }
      };
    };
    const rows = [{ eaId: 230899, overall: 82, cardType: "Base Rare", price: 12000, aiConfidence: 90 }];
    const result = await mod.enrichRowsWithDirectFutbinBrain(rows, { gameYear: 27, fetcher: fakeFetch });
    assert.equal(result.ok, true);
    assert.equal(rows[0].futbinId, 778);
    assert.equal(rows[0].futbinPrice, 12250);
    assert.equal(rows[0].futbinCheckedAt, "2026-09-22 00:08:21");
    assert.ok(seen.some(url => url.includes("/27/getPlayersPrice?")));
  } finally {
    if (oldEnabled == null) delete process.env.FUTBIN_SERVER_COLLECTOR_ENABLED; else process.env.FUTBIN_SERVER_COLLECTOR_ENABLED = oldEnabled;
    if (oldConfirmed == null) delete process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED; else process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED = oldConfirmed;
  }
});
