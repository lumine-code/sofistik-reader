const path = require("node:path");

let addon = null;

function loadNativeAddon() {
  addon ||= require("node-gyp-build")(path.join(__dirname, ".."));
  return addon;
}

module.exports = { loadNativeAddon };
