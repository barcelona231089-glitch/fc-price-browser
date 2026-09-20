const GATE_KEY = Symbol.for('fc.parse.futbin.rate-gate.v1');

function gateState() {
  if (!globalThis[GATE_KEY]) {
    globalThis[GATE_KEY] = { nextRequestAt: 0, waits: 0, acquisitions: 0, lastAcquiredAt: null };
  }
  return globalThis[GATE_KEY];
}

export async function acquireParseFutbinSlot({ minDelayMs = 13000 } = {}) {
  const state = gateState();
  const delay = Math.max(1000, Math.min(60000, Number(minDelayMs) || 13000));
  const now = Date.now();
  if (state.nextRequestAt > now) {
    state.waits += 1;
    await new Promise(resolve => setTimeout(resolve, state.nextRequestAt - now));
  }
  state.acquisitions += 1;
  state.lastAcquiredAt = new Date().toISOString();
  state.nextRequestAt = Date.now() + delay;
  return { ...state };
}

export function getParseFutbinRateGateStatus() {
  return { ...gateState() };
}

export function resetParseFutbinRateGateForTests() {
  globalThis[GATE_KEY] = { nextRequestAt: 0, waits: 0, acquisitions: 0, lastAcquiredAt: null };
}