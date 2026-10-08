export function ratePosition(rate) {
  return rate <= 1 ? (rate * 4 - 1) * 4 : rate * 4 + 8;
}

export function positionRate(position) {
  const value = Math.max(0, Math.min(24, position));
  return value <= 12 ? (Math.round(value / 4) + 1) / 4 : (Math.round(value) - 8) / 4;
}

export function playerPortalRoot(player, fullscreenElement, body) {
  return player && fullscreenElement === player ? player : player?.closest('[role="dialog"]') || body;
}
