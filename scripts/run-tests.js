"use strict";

/**
 * Test runner shim: `node --test` with the SQLite row store disabled so test
 * runs never touch the real ~/.doramonitor/doramonitor.db. Store tests that
 * need it set DORAMONITOR_DB to a tmpdir path themselves.
 */

process.env.DORAMONITOR_DISABLE_STORE = "1";

const { spawnSync } = require("child_process");
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
