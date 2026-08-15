export function supportsCompactViewPath(pathname: string): boolean {
  const segments = pathname
    .toLowerCase()
    .split('/')
    .filter(Boolean);

  if (segments.includes('compose-team')) return false;

  return segments.some(
    (segment) =>
      segment === 'lineups' ||
      segment === 'squad' ||
      segment === 'squads' ||
      segment.startsWith('squad-'),
  );
}
