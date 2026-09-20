export function roundQty(value: number): number {
  return Math.floor(value * 1_000_000) / 1_000_000;
}

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function midPrice(bid?: number, ask?: number): number {
  if (bid && ask) return (bid + ask) / 2;
  return bid ?? ask ?? 0;
}
