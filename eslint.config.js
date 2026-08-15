const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

module.exports = [
  { ignores: ["build/**", "node_modules/**"] },
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    files: ["**/*.js"],
    settings: { n: { version: ">=24.0.0", tryExtensions: [".js", ".json", ".node"] } },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["eslint.config.js", "spec/**"],
    languageOptions: {
      globals: globals.jasmine,
    },
    rules: {
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  prettier,
];
