export interface IConfigSegment {
  text: string;
  /** Set where the text names a trigger of the running config. */
  trigger?: string;
  /** Set where the text is the path of a file served beside the config. */
  file?: string;
}

/** The config page showing a served file, by its path from the config folder. */
export const configFilePath = (path: string): string => `/config?file=${encodeURIComponent(path)}`;

const TOP_LEVEL_TRIGGERS = /^triggers:\s*(#.*)?$/;
const KEY_LINE = /^(\s*)((["']?)([\w.-]+)\3)(:.*)$/;
// Splits a line around the characters YAML puts between scalars, keeping them.
const SCALAR_SPLIT = /([\s'"{}[\],]+)/;

/** A path as the config writes it, such as `./prompts/x.md`, as served, such as `prompts/x.md`. */
const servedPath = (value: string): string => value.replace(/^(\.\/)+/, '');

const linkPaths = (text: string, filePaths: ReadonlySet<string>): IConfigSegment[] =>
  text
    .split(SCALAR_SPLIT)
    .filter(part => part !== '')
    .map(part => (filePaths.has(servedPath(part)) ? { text: part, file: servedPath(part) } : { text: part }));

/**
 * Each line of the config file as segments, linking each trigger's key under the top-level `triggers` and each value
 * that is a served file's path. Reads the YAML by its lines, so it misses a trigger written in flow style.
 */
export const configLineSegments = (
  content: string,
  triggerNames: ReadonlySet<string>,
  filePaths: ReadonlySet<string>
): IConfigSegment[][] => {
  let inTriggers = false;
  let triggerIndent: number | null = null;

  return content.split(/\r?\n/).map(line => {
    const isContent = line.trim() !== '' && !line.trim().startsWith('#');
    const indent = line.length - line.trimStart().length;

    if (isContent && indent === 0) {
      inTriggers = TOP_LEVEL_TRIGGERS.test(line);
      triggerIndent = null;

      return linkPaths(line, filePaths);
    }

    if (inTriggers && isContent) {
      triggerIndent = triggerIndent ?? indent;

      const key = KEY_LINE.exec(line);

      if (key !== null && indent === triggerIndent && triggerNames.has(key[4])) {
        return [{ text: key[1] }, { text: key[2], trigger: key[4] }, ...linkPaths(key[5], filePaths)];
      }
    }

    return linkPaths(line, filePaths);
  });
};
