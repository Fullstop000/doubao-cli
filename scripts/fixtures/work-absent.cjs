// Test-only preload. Hide only the Work installation probe from this process;
// all subsequent filesystem, CDP, app and server operations remain real.
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const existsSync = fs.existsSync;
fs.existsSync = function (value) {
  return value === '/Applications/DoubaoWork.app' ? false : existsSync.call(this, value);
};
syncBuiltinESMExports();
