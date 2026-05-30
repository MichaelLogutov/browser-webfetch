import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crashReportCount, waitForNewCrashReport, deleteProfile } from '../src/reclaim.js';

const tmpProfile = () => mkdtempSync(join(tmpdir(), 'bwf-reclaim-unit-'));
function addDump(profileDir: string, name: string): void {
  const dir = join(profileDir, 'Crashpad', 'reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), 'x');
}

describe('crashReportCount', () => {
  it('returns 0 when there is no Crashpad/reports dir', () => {
    const p = tmpProfile();
    expect(crashReportCount(p)).toBe(0);
    rmSync(p, { recursive: true, force: true });
  });

  it('counts only .dmp files', () => {
    const p = tmpProfile();
    addDump(p, 'a.dmp');
    addDump(p, 'b.dmp');
    addDump(p, 'settings.dat');
    expect(crashReportCount(p)).toBe(2);
    rmSync(p, { recursive: true, force: true });
  });
});

describe('waitForNewCrashReport', () => {
  it('returns true when a new dump appears before the deadline', async () => {
    const p = tmpProfile();
    addDump(p, 'a.dmp');
    const before = crashReportCount(p);
    setTimeout(() => addDump(p, 'b.dmp'), 100);
    expect(await waitForNewCrashReport(p, before, 2000)).toBe(true);
    rmSync(p, { recursive: true, force: true });
  });

  it('returns false when no new dump appears before the deadline', async () => {
    const p = tmpProfile();
    addDump(p, 'a.dmp');
    expect(await waitForNewCrashReport(p, crashReportCount(p), 300)).toBe(false);
    rmSync(p, { recursive: true, force: true });
  });
});

describe('deleteProfile', () => {
  it('removes the profile directory', () => {
    const p = tmpProfile();
    addDump(p, 'a.dmp');
    deleteProfile(p);
    expect(existsSync(p)).toBe(false);
  });
});
