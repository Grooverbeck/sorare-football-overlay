import type { FootballPosition } from '@sorare-overlay/shared';

export interface PlayerTargetIdentity {
  slug?: string;
  playerName?: string;
  position?: FootballPosition;
  teamSlug?: string;
}

export function normalizePlayerName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase();
}

export function teamSlugsLikelyMatch(
  candidate: string | undefined,
  expected: string | undefined,
): boolean {
  if (!candidate || !expected) return false;
  const candidateNormalized = candidate.trim().toLowerCase();
  const expectedNormalized = expected.trim().toLowerCase();
  return (
    candidateNormalized === expectedNormalized ||
    candidateNormalized.startsWith(`${expectedNormalized}-`) ||
    expectedNormalized.startsWith(`${candidateNormalized}-`)
  );
}

export function playerNamesLikelyMatch(
  query: string,
  displayName: string,
): boolean {
  const requested = normalizePlayerName(query).split(/\s+/);
  const candidate = normalizePlayerName(displayName).split(/\s+/);
  if (requested.join(' ') === candidate.join(' ')) return true;
  if (requested.length !== 2 || candidate.length !== 2) return false;
  const [requestedFirst, requestedLast] = requested;
  const [candidateFirst, candidateLast] = candidate;
  return Boolean(
    requestedFirst &&
      candidateFirst &&
      requestedLast === candidateLast &&
      Math.min(requestedFirst.length, candidateFirst.length) >= 3 &&
      (requestedFirst.startsWith(candidateFirst) ||
        candidateFirst.startsWith(requestedFirst)),
  );
}

export function playerTargetKey(target: PlayerTargetIdentity): string {
  const base = target.slug
    ? `slug:${target.slug}:${target.position ?? 'default'}`
    : `name:${normalizePlayerName(target.playerName ?? '')}:${target.position ?? 'default'}`;
  return target.teamSlug ? `${base}:team:${target.teamSlug}` : base;
}

export function playerRequestIdentity(
  target: Pick<PlayerTargetIdentity, 'slug' | 'playerName'>,
): string {
  return target.slug
    ? `slug:${target.slug}`
    : `name:${normalizePlayerName(target.playerName ?? '')}`;
}
