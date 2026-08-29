"use strict";

/** shutil.which equivalent without throwing. Windows uses `where` and the
 * bundled System32\OpenSSH location as fallback. */
function whichOptional(bin) {
  const { execFileSync } = require("child_process");
  try {
    if (process.platform === "win32") {
      try {
        const out = execFileSync("where", [bin], { encoding: "utf8", timeout: 5000 });
        const first = out.trim().split(/\r?\n/)[0].trim();
        if (first) return first;
      } catch {
        // fall through
      }
      const bundled = `C:\\Windows\\System32\\OpenSSH\\${bin}.exe`;
      return require("fs").existsSync(bundled) ? bundled : null;
    }
    const out = execFileSync("which", [bin], { encoding: "utf8", timeout: 5000 });
    const p = out.trim().split("\n")[0];
    return p || null;
  } catch {
    return null;
  }
}

module.exports = whichOptional;
