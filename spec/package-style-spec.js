const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

describe("sofistik-reader library conventions", () => {
  it("is a Node library without editor or viewer dependencies", () => {
    expect(firstProseLine(readme)).toBe(manifest.description);
    expect(readme.split(/\r?\n/)[0]).toBe(`# ${manifest.name.replace("@lumine-code/", "")}`);
    expect(manifest.engines.lumine).toBeUndefined();
    expect(manifest.engines.node).toBe(">=24");
    expect(manifest.main).toBe("./lib/index");
    // A library is found through the npm registry, which weighs keywords
    // independently of the name, so unlike an editor package it may echo its own
    // name here.
    expect(manifest.keywords.length).toBeGreaterThanOrEqual(3);
    expect(manifest.keywords.length).toBeLessThanOrEqual(8);
    expect(manifest.keywords.every((keyword) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(keyword))).toBe(
      true,
    );

    const runtime = fs
      .readdirSync(path.join(root, "lib"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => fs.readFileSync(path.join(root, "lib", name), "utf8"))
      .join("\n");
    expect(runtime).not.toMatch(/\b(?:graviss|lumine)\b/i);
  });

  it("ships native build metadata and cross-platform checks", () => {
    expect(fs.existsSync(path.join(root, "binding.gyp"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src", "cdb-reader.cc"))).toBe(true);
    const workflows = path.join(root, ".github", "workflows");
    const ci = fs.readFileSync(path.join(workflows, "ci.yml"), "utf8");
    expect(ci).toMatch(/ubuntu-latest/);
    expect(ci).toMatch(/macos-latest/);
    expect(ci).toMatch(/windows-latest/);
    expect(ci).toMatch(/npm pack --dry-run/);
    expect(ci).toMatch(/workflow_call:/);
    const publish = fs.readFileSync(path.join(workflows, "publish.yml"), "utf8");
    expect(publish).toMatch(/uses: \.\/\.github\/workflows\/ci\.yml/);
    expect(publish).toMatch(/npm publish --access public --provenance/);
  });
});

function firstProseLine(markdown) {
  return markdown
    .split(/\r?\n/)
    .slice(1)
    .find((line) => line.trim());
}
