"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  readVersionFromDisk,
  detectMode,
  npmPrefixForPackage,
  parseRunArgs,
  resolveHealthHost,
  resolveGitUpstream,
  preflightSourceUpdate,
  isActivePhase,
  ACTIVE_PHASES,
  spawnApply,
  readStatus,
  writeStatus,
  STALE_MS,
} = require("../src/self-update");

test("self-update: readVersionFromDisk bypasses require cache", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dora-ver-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.3.3" }));
    assert.equal(readVersionFromDisk(dir), "1.3.3");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.4.0" }));
    assert.equal(readVersionFromDisk(dir), "1.4.0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("self-update: detects source vs npm mode and derives global prefix", () => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "dora-src-"));
  const npmDir = fs.mkdtempSync(path.join(os.tmpdir(), "dora-npm-"));
  try {
    fs.mkdirSync(path.join(srcDir, ".git"));
    assert.equal(detectMode(srcDir).mode, "source");
    assert.equal(detectMode(npmDir).mode, "npm");

    assert.equal(
      npmPrefixForPackage("/home/alice/.local/lib/node_modules/doramonitor", "linux"),
      "/home/alice/.local"
    );
    assert.equal(
      npmPrefixForPackage("C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\doramonitor", "win32"),
      "C:\\Users\\alice\\AppData\\Roaming\\npm"
    );
    assert.equal(npmPrefixForPackage(srcDir, "linux"), null);
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(npmDir, { recursive: true, force: true });
  }
});

test("self-update: parses --port / --host args and maps wildcard hosts to loopback", () => {
  assert.deepEqual(parseRunArgs([]), { port: 3847, host: "127.0.0.1" });
  assert.deepEqual(parseRunArgs(["--run", "--port", "3848", "--host", "0.0.0.0"]), {
    port: 3848,
    host: "0.0.0.0",
  });
  assert.equal(resolveHealthHost("0.0.0.0"), "127.0.0.1");
  assert.equal(resolveHealthHost("::"), "127.0.0.1");
  assert.equal(resolveHealthHost("127.0.0.1"), "127.0.0.1");
});

test("self-update: readStatus enforces stale timeout across ALL active phases and spawnApply locks them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dora-upd-"));
  const statusFile = path.join(dir, "status.json");
  const logFile = path.join(dir, "update.log");
  try {
    for (const phase of ACTIVE_PHASES) {
      assert.equal(isActivePhase(phase), true);
      // Fresh heartbeat blocks concurrent spawnApply
      writeStatus({ phase, progress: 50 }, statusFile);
      const blocked = spawnApply(undefined, { statusFile, logFile, _spawn: () => { throw new Error("should_not_spawn"); } });
      assert.equal(blocked.started, false);
      assert.ok(blocked.error.includes("正在进行"));

      // Stale heartbeat turns into timeout error and unblocks retry
      fs.writeFileSync(statusFile, JSON.stringify({ phase, progress: 50, heartbeat: Date.now() - STALE_MS - 1000 }));
      const st = readStatus(statusFile);
      assert.equal(st.phase, "error");
      assert.ok(st.error.includes("超时"));
    }

    // Fresh spawn pre-writes initial status before returning and passes server port/host
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.3.3" }));
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(statusFile, JSON.stringify({ phase: "done", progress: 100, fromVersion: "1.2.0", heartbeat: Date.now() }));
    let spawnedArgs = null;
    const started = spawnApply(dir, {
      port: 3848,
      host: "127.0.0.1",
      statusFile,
      logFile,
      _spawn: (_exe, args) => {
        spawnedArgs = args;
        return { pid: 4242, unref() {} };
      },
    });
    assert.equal(started.started, true);
    assert.equal(started.mode, "source");
    assert.deepEqual(spawnedArgs.slice(1), ["--run", "--port", "3848", "--host", "127.0.0.1"]);
    // Immediate read sees fresh "running" instead of previous update's "done"
    const nowStatus = readStatus(statusFile);
    assert.equal(nowStatus.phase, "running");
    assert.equal(nowStatus.progress, 1);
    assert.equal(nowStatus.fromVersion, "1.3.3");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("self-update: git upstream resolution and preflight guards", () => {
  // Detached HEAD aborts
  assert.throws(
    () => resolveGitUpstream("/repo", () => ""),
    /游离 HEAD/
  );
  // Untracked feature branch aborts
  assert.throws(
    () => resolveGitUpstream("/repo", (args) => {
      if (args[0] === "symbolic-ref") return "feat/test";
      throw new Error("no upstream");
    }),
    /未配置跟踪上游/
  );
  // Tracked custom upstream resolves cleanly
  assert.deepEqual(
    resolveGitUpstream("/repo", (args) => {
      if (args[0] === "symbolic-ref") return "release";
      if (args[0] === "rev-parse") return "upstream/v1";
      return "";
    }),
    { branch: "release", upstream: "upstream/v1", remote: "upstream", remoteBranch: "v1" }
  );

  // Dirty tracked working tree aborts in preflight
  assert.throws(
    () => preflightSourceUpdate("/repo", (args) => (args[0] === "status" ? " M src/server.js\n" : "")),
    /未提交修改/
  );

  // Real diverged code aborts in preflight
  assert.throws(
    () => preflightSourceUpdate("/repo", (args) => {
      if (args[0] === "status") return "";
      if (args[0] === "symbolic-ref") return "main";
      if (args[0] === "rev-parse") return "origin/main";
      if (args[0] === "merge-base") throw new Error("not ancestor");
      if (args[0] === "diff") return " src/server.js | 2 +-\n";
      return "";
    }),
    /实际代码差异/
  );

  // Identical-tree divergence selects hard reset
  const plan = preflightSourceUpdate("/repo", (args) => {
    if (args[0] === "status") return "";
    if (args[0] === "symbolic-ref") return "main";
    if (args[0] === "rev-parse") return "origin/main";
    if (args[0] === "merge-base") throw new Error("not ancestor");
    if (args[0] === "diff") return "";
    return "";
  });
  assert.equal(plan.upstream, "origin/main");
  assert.equal(plan.needsHardReset, true);
});
