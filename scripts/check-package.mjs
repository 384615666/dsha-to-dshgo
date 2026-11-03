#!/usr/bin/env node
// M5 packaging gate: inspect the npm tarball manifest without publishing.
// The shipped package must contain ONLY allowlisted runtime files, carry no
// fixtures/backups/credentials/absolute user paths, stay under the size
// limit, and define no install-time scripts (the market install must not run
// arbitrary lifecycle code).
//
// Usage: node scripts/check-package.mjs
// Exit 0 = PASS, 1 = FAIL (details in the JSON output).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const MAX_UNPACKED = 50 * 1024 * 1024
const problems = []

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
  if (pkg.scripts?.[name]) problems.push(`install-time script must not exist: scripts.${name}`)
}

const allowed = [
  /^package\.json$/,
  /^LICENSE$/,
  /^README(?:\.en)?\.md$/,
  /^cordis\.patch\.yml$/,
  /^lib\/[^/]+(?:\.js|\/[^/]+\.js)$/,
  /^bin\/[^/]+\.mjs$/,
]
const forbiddenPath = /(?:^|\/)(?:test|tests|fixtures?|migration-planning|p0-lab|node_modules)(?:\/|$)|\.(?:dshbak|gz|zst|zstd|credentials|env|pem|key)$|(?:^|\/)\.env/i

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const out = execFileSync(npmCmd, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
  // Node 24 on Windows refuses to spawn .cmd files without a shell.
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'ignore'],
})
const info = JSON.parse(out)[0]
const files = Array.isArray(info.files) ? info.files : []
if (files.length === 0) problems.push('npm pack reported no files')
for (const file of files) {
  const p = file.path
  if (!allowed.some(re => re.test(p))) problems.push(`file outside the allowlist: ${p}`)
  if (forbiddenPath.test(p)) problems.push(`forbidden artifact shipped: ${p}`)
}
for (const required of ['package.json', 'lib/index.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  if (!files.some(f => f.path === required)) problems.push(`required file missing from the tarball: ${required}`)
}
if (typeof info.unpackedSize !== 'number' || info.unpackedSize > MAX_UNPACKED) {
  problems.push(`unpacked size ${info.unpackedSize} exceeds the ${MAX_UNPACKED} B limit`)
}

// Credential/private-path markers in every shipped text artifact.
const markerPatterns = [
  { name: 'api-key', re: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { name: 'backup-file-name', re: /DSHA-data-v5-[0-9a-f-]{8,}/i },
  { name: 'windows-user-path', re: /[A-Za-z]:\\{1,2}Users\\{1,2}/ },
  { name: 'posix-user-path', re: /\/Users\/[A-Za-z0-9._-]+\// },
]
for (const file of files) {
  if (!/\.(?:js|mjs|json|ya?ml|md)$/.test(file.path)) continue
  const text = readFileSync(join(root, file.path), 'utf8')
  for (const { name, re } of markerPatterns) {
    if (re.test(text)) problems.push(`${file.path}: private marker "${name}"`)
  }
}

const result = {
  ok: problems.length === 0,
  package: `${pkg.name}@${pkg.version}`,
  files: files.length,
  packedBytes: info.size ?? null,
  unpackedBytes: info.unpackedSize ?? null,
  limitBytes: MAX_UNPACKED,
  problems,
}
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.ok ? 0 : 1
