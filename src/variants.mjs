// The two behaviours under test, as plain ES modules so the demo runs on stock
// Node with no toolchain.
//
// `currentReadOrInitJson` is the body of `readOrInitJson` from
// sonarqube-cli/src/commands/integrate/_common/hooks.ts, copied as-is except
// for dropping the TypeScript generics. `demo.mjs --sonar-src <path>` loads the
// real .ts file instead and asserts the two agree, so this copy cannot drift
// silently.
//
// `fixedReadOrInitJson` is the proposed replacement, matching `readJson` in
// core/framework/resources/json-patch.ts.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

export class InvalidJsonError extends Error {
  constructor(path) {
    super(`${path} contains invalid JSON.`);
    this.name = 'InvalidJsonError';
  }
}

export async function currentReadOrInitJson(path, defaultValue) {
  if (!existsSync(path)) return defaultValue;
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return defaultValue;
  }
}

export async function fixedReadOrInitJson(path, defaultValue) {
  if (!existsSync(path)) return defaultValue;
  const raw = await readFile(path, 'utf-8');
  if (raw.trim().length === 0) return defaultValue;
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError(path);
  }
}

/**
 * The write-back sequence from `installHook` in
 * sonarqube-cli/src/commands/integrate/claude/hooks.ts:
 *
 *   const settings = await readOrInitJson(settingsPath, { hooks: {} });
 *   settings.hooks ??= {};
 *   upsertHookEntry(settings, eventType, marker, matcher, command, timeout);
 *   await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
 *
 * `read` is injected so the same sequence can be driven with either variant.
 */
export async function installHook(settingsPath, read, entry) {
  const settings = await read(settingsPath, { hooks: {} });
  settings.hooks ??= {};
  upsertHookEntry(settings, entry);
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/** `upsertHookEntry` from the same file: drop entries owned by the marker, append ours. */
function upsertHookEntry(settings, { eventType, marker, matcher, command, timeout }) {
  const isOwned = (e) => Array.isArray(e.hooks) && e.hooks.some((h) => h.command.includes(marker));
  settings.hooks[eventType] = [
    ...(settings.hooks[eventType] ?? []).filter((e) => !isOwned(e)),
    { matcher, hooks: [{ type: 'command', command, timeout }] },
  ];
}
