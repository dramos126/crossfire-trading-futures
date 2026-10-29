import { describe, it, expect } from "vitest";

import { acquireRunLock, releaseRunLock, type LockFs } from "./run-lock";

const FILE = "/tmp/crossfire-backtest.lock";

function fakeFs(initial: string | null = null): LockFs & { contents: () => string | null } {
  let store = initial;
  return {
    read: () => store,
    write: (_file, contents) => {
      store = contents;
    },
    remove: () => {
      store = null;
    },
    contents: () => store,
  };
}

describe("acquireRunLock", () => {
  it("takes a free lock and writes the pid", () => {
    const fs = fakeFs();
    acquireRunLock({ file: FILE, pid: 4242, fs, isAlive: () => true });
    expect(fs.contents()?.trim()).toBe("4242");
  });

  it("refuses while a live run holds it, naming the pid", () => {
    const fs = fakeFs("991\n");
    expect(() =>
      acquireRunLock({ file: FILE, pid: 4242, fs, isAlive: () => true }),
    ).toThrow("another backtest run is in progress (pid 991); wait for it");
    expect(fs.contents()?.trim()).toBe("991");
  });

  it("clears a stale lock whose pid is gone and proceeds", () => {
    const fs = fakeFs("991\n");
    acquireRunLock({ file: FILE, pid: 4242, fs, isAlive: () => false });
    expect(fs.contents()?.trim()).toBe("4242");
  });

  it("treats an uninterpretable lock as absent rather than refusing forever", () => {
    const fs = fakeFs("not a pid\n");
    acquireRunLock({ file: FILE, pid: 4242, fs, isAlive: () => true });
    expect(fs.contents()?.trim()).toBe("4242");
  });
});

describe("releaseRunLock", () => {
  it("removes its own lock", () => {
    const fs = fakeFs("4242\n");
    releaseRunLock({ file: FILE, pid: 4242, fs });
    expect(fs.contents()).toBeNull();
  });

  it("is idempotent", () => {
    const fs = fakeFs("4242\n");
    releaseRunLock({ file: FILE, pid: 4242, fs });
    releaseRunLock({ file: FILE, pid: 4242, fs });
    expect(fs.contents()).toBeNull();
  });

  it("leaves a lock another run has since taken", () => {
    const fs = fakeFs("991\n");
    releaseRunLock({ file: FILE, pid: 4242, fs });
    expect(fs.contents()?.trim()).toBe("991");
  });
});
