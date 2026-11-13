#!/usr/bin/env node
// scripts/audit-gate.mjs — the npm audit gate used by the Dagger security check.
//
// Usage: npm audit --json > audit.json; node scripts/audit-gate.mjs audit.json [.audit-allowlist.json]
//
// Fails on any HIGH or CRITICAL advisory unless that advisory's GHSA id is in
// the allowlist with a reason. A package flagged only through allowlisted
// advisories passes; anything else blocks.
import { readFileSync } from 'node:fs';

const [reportPath, allowPath = '.audit-allowlist.json'] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: node scripts/audit-gate.mjs <npm-audit.json> [allowlist.json]');
  process.exit(2);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
// Fail closed: a registry or network error still produces JSON, just without
// a vulnerability map. Treating that as "no findings" would pass the gate.
if (report.error || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
  console.error('npm audit did not produce a report: ' + JSON.stringify(report.error ?? report).slice(0, 500));
  process.exit(1);
}
const allowlist = new Map(JSON.parse(readFileSync(allowPath, 'utf8')).map((entry) => [entry.id, entry]));
const vulnerabilities = report.vulnerabilities;
const gating = new Set(['high', 'critical']);

function advisories(name, seen = new Set()) {
  if (seen.has(name) || !vulnerabilities[name]) return [];
  seen.add(name);
  return vulnerabilities[name].via.flatMap((via) =>
    typeof via === 'string'
      ? advisories(via, seen)
      : [{ id: String(via.url ?? '').split('/').pop(), title: via.title, severity: via.severity, package: via.name }],
  );
}

const blocking = new Map();
const allowed = new Map();
for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  if (!gating.has(vulnerability.severity)) continue;
  for (const advisory of advisories(name)) {
    if (!gating.has(advisory.severity)) continue;
    (allowlist.has(advisory.id) ? allowed : blocking).set(advisory.id, advisory);
  }
}

for (const advisory of allowed.values()) {
  console.log('allowed  ' + advisory.id + '  ' + advisory.package + ': ' + allowlist.get(advisory.id).reason);
}
for (const advisory of blocking.values()) {
  console.log('BLOCKING ' + advisory.id + '  ' + advisory.package + ' (' + advisory.severity + '): ' + advisory.title);
}
if (blocking.size) process.exit(1);
console.log('npm audit gate: no unlisted high or critical advisories');
