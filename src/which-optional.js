"use strict";

/** shutil.which equivalent without throwing. */
function whichOptional(bin) {
  const { execFileSync } = require("child_process");
  try {
    const out = execFileSync("which", [bin], { encoding: "utf8", timeout: 5000 });
    const p = out.trim().split("\n")[0];
    return p || null;
  } catch {
    return null;
  }
}

module.exports = whichOptional;
