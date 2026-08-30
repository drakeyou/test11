// Was this module the script node was told to run?
//
// The obvious form is wrong in two ways, and both fail silently — the guard is
// merely false, main() never runs, and the process exits 0 having printed
// nothing at all:
//
//   if (import.meta.url === `file://${process.argv[1]}`)
//
//   - a path that needs percent-encoding (a space, Cyrillic, "#", "%") is
//     encoded in import.meta.url and raw in argv[1], so they never match:
//     "/Users/me/My Files/x.mjs" vs "file:///Users/me/My%20Files/x.mjs";
//   - node resolves the entry point's symlinks for import.meta.url but leaves
//     argv[1] exactly as typed, so a project reached through a symlink (an
//     iCloud or Dropbox folder, a /tmp path on macOS) never matches either.
//
// Comparing real filesystem paths sidesteps both.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} metaUrl import.meta.url of the calling module
 * @param {string} [argv1] the entry path node was given
 */
export function isEntryPoint(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
