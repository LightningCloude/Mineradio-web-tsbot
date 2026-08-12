export function selectRippleSlots(ripples, maxSlots, maxAge = 2) {
  return ripples
    .filter(ripple => ripple && ripple.str >= 0.005 && ripple.age >= 0 && ripple.age <= maxAge)
    .sort((a, b) => a.age - b.age)
    .slice(0, maxSlots);
}

export function clampRippleOrigin(x, y, planeSize, margin = 0.08) {
  const half = Math.max(0, planeSize * (0.5 - margin));
  return Object.freeze({
    x: Math.max(-half, Math.min(half, Number(x) || 0)),
    y: Math.max(-half, Math.min(half, Number(y) || 0)),
  });
}
