#!/usr/bin/env node
// Reproduction: the post-update hook migration can overwrite a user's
// .claude/settings.json when that file does not parse.
//
//   node demo.mjs
//   node demo.mjs --sonar-src /path/to/sonarqube-cli   (also runs the real .ts)
//
// Exits non-zero if any case does not behave as described.

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  currentReadOrInitJson,
  fixedReadOrInitJson,
  installHook,
  InvalidJsonError,
} from './src/variants.mjs';

/** A settings.json like one a Claude Code user actually keeps. */
const USER_SETTINGS = {
  model: 'claude-opus-4-20250514',
  env: { FOO: 'bar' },
  permissions: {
    allow: ['Bash(npm run test:*)'],
    deny: ['Bash(curl:*)', 'Read(./.env)'],
  },
  statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/my-audit-hook.sh' }] },
    ],
  },
};

/** What git leaves behind in a committed .claude/settings.json after a conflict. */
function withConflictMarkers(settings) {
  const body = JSON.stringify(settings, null, 2).split('\n');
  const head = body.slice(0, Math.floor(body.length / 2));
  const tail = body.slice(Math.floor(body.length / 2));
  return [
    '<<<<<<< HEAD',
    ...head,
    '=======',
    ...tail,
    '>>>>>>> feature/add-hook',
  ].join('\n');
}

const ENTRY = {
  eventType: 'PreToolUse',
  marker: 'sonar-secrets',
  matcher: 'Read',
  command: '"${CLAUDE_PROJECT_DIR}/.claude/hooks/sonar-secrets/build-scripts/pretool-secrets.sh"',
  timeout: 60,
};

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'sq-repro-'));
  try {
    await mkdir(join(home, '.claude'), { recursive: true });
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Keys the user had that are no longer present, and whether their own hook survived. */
function survivors(before, after) {
  const lost = Object.keys(before).filter((k) => !(k in after));
  const userHook = JSON.stringify(after.hooks?.PreToolUse ?? []).includes('my-audit-hook.sh');
  return { lost, userHook };
}

const cases = [];
function record(name, pass, detail) {
  cases.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(`       ${detail}`);
}

// ---------------------------------------------------------------------------

/** Control: a settings.json that parses is merged, not replaced. */
async function caseValidSettingsPreserved() {
  await withTempHome(async (home) => {
    const p = join(home, '.claude', 'settings.json');
    await writeFile(p, JSON.stringify(USER_SETTINGS, null, 2), 'utf-8');

    await installHook(p, currentReadOrInitJson, ENTRY);

    const after = JSON.parse(await readFile(p, 'utf-8'));
    const { lost, userHook } = survivors(USER_SETTINGS, after);
    const sonarHook = JSON.stringify(after.hooks.PreToolUse).includes('sonar-secrets');
    record(
      'CONTROL: valid settings.json is merged, nothing is lost',
      lost.length === 0 && userHook && sonarHook,
      `lost_keys=[${lost}], user_hook_kept=${userHook}, sonar_hook_added=${sonarHook}`,
    );
  });
}

/** The defect: an unparseable settings.json is replaced by the installed entry alone. */
async function caseInvalidSettingsOverwritten() {
  await withTempHome(async (home) => {
    const p = join(home, '.claude', 'settings.json');
    const corrupted = withConflictMarkers(USER_SETTINGS);
    await writeFile(p, corrupted, 'utf-8');

    await installHook(p, currentReadOrInitJson, ENTRY);

    const after = JSON.parse(await readFile(p, 'utf-8'));
    const { lost, userHook } = survivors(USER_SETTINGS, after);
    record(
      'DEFECT: unparseable settings.json is overwritten, user settings are gone',
      lost.length === 4 && !userHook,
      `lost_keys=[${lost.join(', ')}], user_hook_kept=${userHook}, ` +
        `bytes_before=${corrupted.length}, bytes_after=${JSON.stringify(after).length}`,
    );
  });
}

/** With the fix, the read fails and the file on disk is left exactly as it was. */
async function caseFixRefusesAndPreserves() {
  await withTempHome(async (home) => {
    const p = join(home, '.claude', 'settings.json');
    const corrupted = withConflictMarkers(USER_SETTINGS);
    await writeFile(p, corrupted, 'utf-8');

    let threw = null;
    try {
      await installHook(p, fixedReadOrInitJson, ENTRY);
    } catch (err) {
      threw = err;
    }

    const onDisk = await readFile(p, 'utf-8');
    record(
      'FIX: unparseable settings.json raises, file is byte-for-byte unchanged',
      threw instanceof InvalidJsonError && onDisk === corrupted,
      `threw=${threw?.name ?? 'none'}, file_unchanged=${onDisk === corrupted}`,
    );
  });
}

/** An absent file still initialises, so the fix does not break a fresh install. */
async function caseFixStillInitialises() {
  await withTempHome(async (home) => {
    const p = join(home, '.claude', 'settings.json');
    await installHook(p, fixedReadOrInitJson, ENTRY);
    const after = JSON.parse(await readFile(p, 'utf-8'));
    const added = JSON.stringify(after.hooks.PreToolUse).includes('sonar-secrets');
    record(
      'FIX: absent settings.json is still created (fresh install unaffected)',
      added,
      `sonar_hook_added=${added}`,
    );
  });
}

/** An empty file is treated as absent, matching json-patch.ts. */
async function caseFixTreatsEmptyAsDefault() {
  await withTempHome(async (home) => {
    const p = join(home, '.claude', 'settings.json');
    await writeFile(p, '   \n', 'utf-8');
    await installHook(p, fixedReadOrInitJson, ENTRY);
    const after = JSON.parse(await readFile(p, 'utf-8'));
    const added = JSON.stringify(after.hooks.PreToolUse).includes('sonar-secrets');
    record('FIX: empty settings.json is treated as absent', added, `sonar_hook_added=${added}`);
  });
}

/**
 * Optional: load the real readOrInitJson out of a sonarqube-cli checkout and
 * confirm the copy in src/variants.mjs behaves identically, so this repo cannot
 * quietly describe behaviour the project no longer has.
 */
async function caseMatchesRealSource(sonarSrc) {
  const rel = 'src/commands/integrate/_common/hooks.ts';
  const url = pathToFileURL(join(sonarSrc, rel)).href;
  let real;
  try {
    ({ readOrInitJson: real } = await import(url));
  } catch (err) {
    record(
      'real source: readOrInitJson behaves as src/variants.mjs describes',
      false,
      `could not import ${rel}: ${err.message}`,
    );
    return;
  }

  await withTempHome(async (home) => {
    const p = join(home, '.claude', 'settings.json');
    await writeFile(p, withConflictMarkers(USER_SETTINGS), 'utf-8');
    const fromReal = await real(p, { hooks: {} });
    const fromCopy = await currentReadOrInitJson(p, { hooks: {} });
    const same = JSON.stringify(fromReal) === JSON.stringify(fromCopy);
    record(
      'real source: readOrInitJson behaves as src/variants.mjs describes',
      same && JSON.stringify(fromReal) === '{"hooks":{}}',
      `real_returned=${JSON.stringify(fromReal)}, copy_returned=${JSON.stringify(fromCopy)}, identical=${same}`,
    );
  });
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const srcIndex = argv.indexOf('--sonar-src');
  const sonarSrc = srcIndex === -1 ? null : argv[srcIndex + 1];

  console.log('sonarqube-cli: post-update hook migration vs an unparseable settings.json\n');

  await caseValidSettingsPreserved();
  await caseInvalidSettingsOverwritten();
  await caseFixRefusesAndPreserves();
  await caseFixStillInitialises();
  await caseFixTreatsEmptyAsDefault();

  if (sonarSrc) {
    console.log('');
    await caseMatchesRealSource(sonarSrc);
  } else {
    console.log('\n(skipped the check against a real checkout; pass --sonar-src <path> to run it)');
  }

  const passed = cases.filter((c) => c.pass).length;
  console.log(`\n${passed}/${cases.length} cases behaved as described`);
  return passed === cases.length ? 0 : 1;
}

main().then((code) => process.exit(code));
