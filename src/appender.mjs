// Serialized file appends.
//
// Websocket frames arrive faster than a write completes, and every frame writes
// straight away rather than waiting for the redraw tick. Firing appendFile per
// frame without a queue lets two writes land out of order, which for a change
// log destroys the one property it exists to provide.

import { appendFile } from 'node:fs/promises';

/**
 * @param {string} file  path to append to
 * @param {(text: string) => Promise<void>} [write]  injectable for tests
 * @returns {(text: string) => Promise<void>} enqueues text, resolves when written
 */
export function appender(file, write = (text) => appendFile(file, text)) {
  let queue = Promise.resolve();
  return (text) => {
    queue = queue
      .then(() => write(text))
      .catch((err) => console.error(`write to ${file} failed: ${err.message}`));
    return queue;
  };
}
