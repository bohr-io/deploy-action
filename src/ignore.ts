// A practical subset of gitignore matching for .assetsignore: comments, blank
// lines, *, ?, [...], **, leading / (anchored), trailing / (directories only),
// ! negation and backslash escapes. It follows the `ignore` package wrangler
// uses where that differs from git: matching is case-insensitive, character
// classes never negate ([!a] and [^a] match "!", "^" or "a"), and dir/**/
// ignores everything below dir.

interface Rule {
  negate: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

/** Tells whether a POSIX path, relative to the ignore file's directory, is ignored. */
export type IgnoreMatcher = (relativePath: string, isDirectory: boolean) => boolean;

export function createIgnoreMatcher(lines: Iterable<string>): IgnoreMatcher {
  const rules: Rule[] = [];
  for (const line of lines) {
    const rule = compileRule(line);
    if (rule) rules.push(rule);
  }

  // The last matching rule wins, as in git.
  const decide = (path: string, isDirectory: boolean): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.negate !== ignored || (rule.directoryOnly && !isDirectory)) continue;
      if (rule.regex.test(path)) ignored = !rule.negate;
    }
    return ignored;
  };

  return (relativePath, isDirectory) => {
    // Like git, a path inside an ignored directory cannot be re-included.
    for (let slash = relativePath.indexOf('/'); slash !== -1; slash = relativePath.indexOf('/', slash + 1)) {
      if (decide(relativePath.slice(0, slash), true)) return true;
    }
    return decide(relativePath, isDirectory);
  };
}

function compileRule(line: string): Rule | undefined {
  let pattern = trimTrailingSpaces(line);
  if (pattern === '' || pattern.startsWith('#')) return undefined;

  const negate = pattern.startsWith('!');
  if (negate) pattern = pattern.slice(1);

  let directoryOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  if (pattern === '') return undefined;
  // dir/**/ also covers the files directly in dir.
  if (pattern.endsWith('/**')) directoryOnly = false;

  // A slash at the start or in the middle anchors the pattern to the ignore file's directory.
  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^\/+/, '');

  try {
    return {
      negate,
      directoryOnly,
      regex: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globToRegex(pattern)}$`, 'i'),
    };
  } catch {
    // A malformed character class: the line matches nothing.
    return undefined;
  }
}

/** Drops trailing whitespace (including the CR of CRLF files) unless escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && /\s/.test(line.charAt(end - 1))) {
    let backslashes = 0;
    while (line.charAt(end - 2 - backslashes) === '\\') backslashes++;
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

function globToRegex(glob: string): string {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === '\\' && i + 1 < glob.length) {
      i++;
      source += escapeRegex(glob.charAt(i));
    } else if (char === '*') {
      if (glob.charAt(i + 1) === '*') {
        const startsSegment = i === 0 || glob.charAt(i - 1) === '/';
        const atEnd = i + 2 === glob.length;
        if (startsSegment && atEnd) {
          // "dir/**" matches everything below dir; "**" alone matches everything.
          source += '.*';
          i++;
          continue;
        }
        if (startsSegment && glob.charAt(i + 2) === '/') {
          // "**/" matches zero or more directories.
          source += '(?:.*/)?';
          i += 2;
          continue;
        }
        // Any other run of asterisks acts like a single one.
        while (glob.charAt(i + 1) === '*') i++;
      }
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', i + 1);
      const body = end === -1 ? '' : glob.slice(i + 1, end);
      if (end === -1 || body.includes('/')) {
        source += '\\[';
      } else {
        // Every character is literal except ranges; out-of-order ranges are dropped (fatal for RegExp).
        const literal = body.replace(/[\\^[]/g, '\\$&');
        source += `[${literal.replace(/(.)-(.)/g, (range, from: string, to: string) => (from <= to ? range : ''))}]`;
        i = end;
      }
    } else {
      source += escapeRegex(char);
    }
  }
  return source;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
