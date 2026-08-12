export const SHELF_WHEEL_SNAP_DELAY_MS = 110;

export function normalizeWheelDelta(deltaY, deltaMode = 0, viewportHeight = 900) {
  const delta = Number(deltaY) || 0;
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * Math.max(320, viewportHeight * 0.8);
  return delta;
}

export function wheelDeltaToCards(pixelDelta) {
  const delta = Number(pixelDelta) || 0;
  const magnitude = Math.abs(delta);
  if (magnitude < 0.01) return 0;

  // Precision touchpads need their small deltas accumulated continuously.
  if (magnitude < 48) return delta / 96;

  // A conventional wheel notch is normally 48-120 px. Faster wheels may
  // request more cards, but logarithmic shaping prevents huge OS deltas from
  // skipping the entire queue in one event.
  const cards = Math.min(2.75, Math.max(1, 1 + Math.log2(magnitude / 96) * 0.55));
  return Math.sign(delta) * cards;
}

export function applyShelfWheelInput({
  center,
  target,
  deltaY,
  deltaMode = 0,
  viewportHeight = 900,
  gapMs = Infinity,
  previousDirection = 0,
  maxIndex,
}) {
  const pixelDelta = normalizeWheelDelta(deltaY, deltaMode, viewportHeight);
  const direction = Math.sign(pixelDelta);
  if (!direction || maxIndex <= 0) {
    return { target, direction: previousDirection, pixelDelta, cards: 0 };
  }

  const changedDirection = previousDirection && direction !== previousDirection;
  const idleGesture = gapMs >= 150;
  const baseTarget = changedDirection || idleGesture ? Math.round(center) : target;
  const cards = wheelDeltaToCards(pixelDelta);
  const burstBonus = gapMs < 22 ? 0.8 : (gapMs < 48 ? 0.35 : 0);
  const maxLead = Math.min(4, 1.35 + Math.abs(cards) * 0.8 + burstBonus);
  const requested = baseTarget + cards;
  const leadLimited = Math.max(center - maxLead, Math.min(center + maxLead, requested));

  return {
    target: Math.max(0, Math.min(maxIndex, leadLimited)),
    direction,
    pixelDelta,
    cards,
  };
}

