# sonarqube-cli: a corrupt settings.json gets overwritten instead of reported

A small reproduction, plus a one line fix, for a case in
[SonarSource/sonarqube-cli](https://github.com/SonarSource/sonarqube-cli) where
the post-update hook migration can replace a user's `.claude/settings.json`
with only the hook it is installing.

Node 18+, no dependencies, no network, nothing installed.

```bash
node demo.mjs
```

It writes a settings file into a temp directory, runs the real write-back
sequence against it, and prints what survived. It exits non-zero if any case
does not behave as described.

## What happens

`readOrInitJson` in `src/commands/integrate/_common/hooks.ts` returns the
default value when a file exists but does not parse:

```ts
export async function readOrInitJson<T>(path: string, defaultValue: T): Promise<T> {
  if (!existsSync(path)) return defaultValue;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return defaultValue;
  }
}
```

Its caller, `installHook` in `src/commands/integrate/claude/hooks.ts`, merges
that result and writes it straight back:

```ts
const settings = await readOrInitJson<AgentSettings>(settingsPath, { hooks: {} });
settings.hooks ??= {};
upsertHookEntry(settings, eventType, marker, matcher, command, timeout);
await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
```

So when the file does not parse, the merge starts from `{ hooks: {} }` and the
write replaces the user's file with just the Sonar entry. `permissions`, `env`,
`model`, `statusLine` and the user's own hooks are gone. There is no backup and
no message, because the catch around the caller logs at debug level and is
marked non-critical.

## How it is reached

`installHooks` is called by `migrateClaudeCodeHooks`, which runs from
`runPostUpdateActions`. That is registered as a Commander `preAction` hook, so
it runs before any command once the stored CLI version is older than the
running one. No `integrate` command is involved and the user is not asked.

`migrateClaudeCodeHooks` returns early when
`hasInstalledDeclarativeIntegration(state)` is true, so this does not affect
people whose Claude integration was installed by the current declarative path.
It affects the people the migration exists for: those with a legacy install
recorded in `state.agentExtensions`, or in `state.agents['claude-code']` with a
global hooks directory present.

The step that runs just before, `migrateDeclarativeIntegrations`, does not
catch the bad file first. `reconcileIntegration` returns immediately when the
integration is not in `state.integrations.installed`, which is true for exactly
these users.

## Why a settings file would not parse

The reproduction corrupts the file the way git does, by leaving conflict
markers in it. Project level `.claude/settings.json` is commonly committed, so
a conflict during a merge or rebase is an ordinary thing to walk into. Hand
editing is the other common cause, since the file has no comment support and
people add trailing commas or `//` lines.

## What the run shows

```
[PASS] CONTROL: valid settings.json is merged, nothing is lost
       lost_keys=[], user_hook_kept=true, sonar_hook_added=true
[PASS] DEFECT: unparseable settings.json is overwritten, user settings are gone
       lost_keys=[model, env, permissions, statusLine], user_hook_kept=false, bytes_before=566, bytes_after=186
[PASS] FIX: unparseable settings.json raises, file is byte-for-byte unchanged
       threw=InvalidJsonError, file_unchanged=true
[PASS] FIX: absent settings.json is still created (fresh install unaffected)
       sonar_hook_added=true
[PASS] FIX: empty settings.json is treated as absent
       sonar_hook_added=true
```

`PASS` means the case behaved as described, not that the behaviour is wanted.
The second one is the defect.

To check the copy in `src/variants.mjs` against the real thing, point the demo
at a checkout. It imports the actual `hooks.ts` and compares:

```bash
node --experimental-strip-types demo.mjs --sonar-src /path/to/sonarqube-cli
```

```
[PASS] real source: readOrInitJson behaves as src/variants.mjs describes
       real_returned={"hooks":{}}, copy_returned={"hooks":{}}, identical=true
```

## The fix

[`fixed/hooks.ts`](fixed/hooks.ts) is the project's own file with one change,
and [`fix.patch`](fix.patch) is the diff. A file that exists but does not parse
raises instead of returning the default:

```ts
export async function readOrInitJson<T>(path: string, defaultValue: T): Promise<T> {
  if (!existsSync(path)) return defaultValue;
  const raw = await readFile(path, 'utf-8');
  if (raw.trim().length === 0) return defaultValue;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CommandFailedError(`${path} contains invalid JSON.`, {
      remediationHint: 'Fix or delete the file, then re-run.',
    });
  }
}
```

This is the behaviour the project already has elsewhere. `readJson` in
`src/core/framework/resources/json-patch.ts` raises
`"<path> contains invalid JSON. Please fix or delete it and re-run."` for the
same situation, and there is a passing test covering it for
`sonar integrate claude`. Only the legacy migration path misses it.

## One thing the fix does not do

`installHooks` wraps the call in a try/catch that logs at debug level and
carries the comment "Non-critical". With this change the file is no longer
destroyed, but the migration still skips quietly and the user is not told why.
Surfacing it is a separate decision for the maintainers, so it is not in this
patch.

## Scope

The reproduction drives the write-back sequence from `installHook` with each
variant of the read. It does not run the CLI, so it does not prove the
surrounding migration conditions at runtime. Those were read from the source
and are described above so they can be checked.

The two unaffected callers of `readOrInitJson`, in
`integrate/antigravity/hooks.ts` and `integrate/copilot/hooks.ts`, are
read-only probes that never write the document back. They are not part of this
report.

## Licence

`fixed/hooks.ts` is a modified copy of a file from sonarqube-cli, which is
LGPL-3.0. This repository is therefore LGPL-3.0 as well, and the modification
is marked at the top of that file so it can be dropped into the project
directly.
