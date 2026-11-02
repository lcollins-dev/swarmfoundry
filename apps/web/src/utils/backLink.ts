export interface IBackLink {
  to: string;
  label: string;
}

const PAGE_LABELS: [RegExp, (match: RegExpMatchArray) => string][] = [
  [/^\/overview$/, () => 'Overview'],
  [/^\/queue$/, () => 'Queue'],
  [/^\/tasks$/, () => 'Tasks'],
  [/^\/tasks\/(\d+)$/, match => `Task ${match[1]}`],
  [/^\/runs\/(\d+)$/, match => `Run ${match[1]}`],
  [/^\/triggers$/, () => 'Triggers'],
  [/^\/triggers\/([^/]+)$/, match => decodeURIComponent(match[1])],
  [/^\/config$/, () => 'Config'],
  [/^\/users$/, () => 'Users'],
  [/^\/users\/\d+$/, () => 'User'],
  [/^\/batch-jobs$/, () => 'Batch jobs'],
  [/^\/batch-jobs\/\d+$/, () => 'Batch job'],
  [/^\/edit-profile$/, () => 'Profile'],
];

/** The page a full path leads to, as a back link. Null for a page the console doesn't link back to. */
export const backLinkTo = (fullPath: string): IBackLink | null => {
  const url = new URL(fullPath, 'http://localhost');

  if (url.pathname === '/config' && url.searchParams.has('file')) {
    return { to: fullPath, label: url.searchParams.get('file') ?? 'Config' };
  }

  for (const [pattern, label] of PAGE_LABELS) {
    const match = url.pathname.match(pattern);

    if (match !== null) {
      return { to: fullPath, label: label(match) };
    }
  }

  return null;
};
