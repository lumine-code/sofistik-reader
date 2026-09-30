const path = require("node:path");
const {
  DEFAULT_ENVIRONMENT_ROOT,
  listInterfaces,
  resolveInterface,
} = require("../lib/sofistik-interface");

const root = path.resolve("SOFiSTiK");

// A fake installation tree: every version directory exists, but only the listed
// editions ship an interface DLL.
function installation(versions) {
  const paths = new Set();
  for (const [version, editions] of Object.entries(versions)) {
    const installRoot = path.join(root, version, `SOFiSTiK ${version}`);
    paths.add(installRoot);
    for (const edition of editions) {
      const mark = edition === "educational" ? "_edu" : "";
      paths.add(path.join(installRoot, "interfaces", "64bit", `sof_cdb_w${mark}-${version}.dll`));
    }
  }
  return {
    environmentRoot: root,
    exists: (filePath) => paths.has(filePath),
    readdir: () => [...Object.keys(versions), "common", "licence.txt"],
  };
}

function interfaceFor(version, edition) {
  return resolveInterface({ version, edition, environmentRoot: root, exists: () => true });
}

function dllName(version, edition) {
  return path.basename(interfaceFor(version, edition).dllPath);
}

describe("resolveInterface", () => {
  it("preserves the public default installation root", () => {
    expect(DEFAULT_ENVIRONMENT_ROOT).toBe("C:\\Program Files\\SOFiSTiK");
    expect(resolveInterface({ version: "2026", exists: () => true }).environmentRoot).toBe(
      path.resolve(DEFAULT_ENVIRONMENT_ROOT),
    );
  });

  it("derives the installation and the interface from a release year", () => {
    const installRoot = path.join(root, "2026", "SOFiSTiK 2026");
    expect(interfaceFor("2026")).toEqual({
      version: "2026",
      edition: "professional",
      // The root comes back with the installation: a database can hold a record
      // in a form its own release does not describe, and the releases installed
      // beside it are where that form is described.
      environmentRoot: path.resolve(root),
      installRoot,
      dllPath: path.join(installRoot, "interfaces", "64bit", "sof_cdb_w-2026.dll"),
    });
    expect(interfaceFor(2026, "educational").dllPath).toBe(
      path.join(installRoot, "interfaces", "64bit", "sof_cdb_w_edu-2026.dll"),
    );
  });

  it("names the interface series each release actually ships", () => {
    expect(dllName("2018", "professional")).toBe("cdb_w50_x64.dll");
    expect(dllName("2018", "educational")).toBe("cdb_w_edu50_x64.dll");
    expect(dllName("2020", "professional")).toBe("sof_cdb_w-70.dll");
    expect(dllName("2020", "educational")).toBe("sof_cdb_w_edu-70.dll");
    // Releases from 2022 on are named after themselves, so an unreleased year
    // resolves without this library learning about it.
    expect(dllName("2022", "professional")).toBe("sof_cdb_w-2022.dll");
    expect(dllName("2031", "educational")).toBe("sof_cdb_w_edu-2031.dll");
  });

  it("requires an explicit four-digit year before probing installed releases", () => {
    const exists = jasmine.createSpy("exists").and.returnValue(true);
    const readdir = jasmine.createSpy("readdir").and.returnValue(["2026"]);
    for (const version of [
      undefined,
      null,
      "",
      "Auto",
      "latest",
      "26",
      "2026-01",
      "20260",
      "../2026",
    ])
      expect(() =>
        resolveInterface({ version, environmentRoot: root, exists, readdir }),
      ).toThrowError();
    expect(exists).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
    expect(interfaceFor(" 2026 ").version).toBe("2026");
  });

  it("accepts only exact edition names and never substitutes an available edition", () => {
    for (const edition of [
      "Professional",
      " educational",
      "educational ",
      "student",
      null,
      { toString: () => "professional" },
    ])
      expect(() => interfaceFor("2026", edition)).toThrowError(/"professional" or "educational"/);
    expect(() =>
      resolveInterface({
        version: "2026",
        edition: "educational",
        ...installation({ 2026: ["professional"] }),
      }),
    ).toThrowError(/educational SOFiSTiK 2026 CDB interface is missing:.*sof_cdb_w_edu-2026\.dll/);
  });

  it("reports what it looked for instead of failing inside the native loader", () => {
    expect(() => resolveInterface({})).toThrowError(/"version" is required/);
    expect(() => resolveInterface({ version: "26" })).toThrowError(/four-digit/);
    expect(() => resolveInterface({ version: "2026", edition: "student" })).toThrowError(
      /"professional" or "educational"/,
    );
    expect(() =>
      resolveInterface({ version: "2026", environmentRoot: root, exists: () => false }),
    ).toThrowError(
      new RegExp(
        `SOFiSTiK 2026 is not installed\\. No SOFiSTiK release is installed below ${escaped(root)}`,
      ),
    );
    // A version that is missing names the ones that are there, so the answer is
    // "install 2024", not "something went wrong".
    expect(() =>
      resolveInterface({ version: "2023", ...installation({ 2024: ["professional"] }) }),
    ).toThrowError(/SOFiSTiK 2023 is not installed\. Installed below .*: 2024 \(professional\)\./);
    expect(() =>
      resolveInterface({
        version: "2020",
        edition: "educational",
        environmentRoot: root,
        exists: (filePath) => !filePath.endsWith(".dll"),
      }),
    ).toThrowError(/educational SOFiSTiK 2020 CDB interface is missing:.*sof_cdb_w_edu-70\.dll/);
  });
});

describe("listInterfaces", () => {
  it("lists legacy series using the DLL each edition actually supplies", () => {
    const root2018 = path.join(root, "2018", "SOFiSTiK 2018");
    const root2020 = path.join(root, "2020", "SOFiSTiK 2020");
    const paths = new Set([
      root2018,
      path.join(root2018, "interfaces", "64bit", "cdb_w_edu50_x64.dll"),
      root2020,
      path.join(root2020, "interfaces", "64bit", "sof_cdb_w-70.dll"),
    ]);
    expect(
      listInterfaces({
        environmentRoot: root,
        exists: (file) => paths.has(file),
        readdir: () => ["2018", "2020"],
      }),
    ).toEqual([
      { version: "2020", installRoot: root2020, editions: ["professional"] },
      { version: "2018", installRoot: root2018, editions: ["educational"] },
    ]);
  });

  it("requires a CDB interface even when an executable marks the release installed", () => {
    const installRoot = path.join(root, "2026", "SOFiSTiK 2026");
    const paths = new Set([installRoot, path.join(installRoot, "sps.exe")]);
    const options = {
      environmentRoot: root,
      exists: (file) => paths.has(file),
      readdir: () => ["2026"],
    };
    expect(listInterfaces(options)).toEqual([]);
    expect(() => resolveInterface({ version: "2026", ...options })).toThrowError(
      /professional SOFiSTiK 2026 CDB interface is missing:/,
    );
  });

  it("reports the installed releases newest first, with their editions", () => {
    expect(
      listInterfaces(
        installation({ 2022: ["educational"], 2026: ["professional", "educational"] }),
      ),
    ).toEqual([
      {
        version: "2026",
        installRoot: path.join(root, "2026", "SOFiSTiK 2026"),
        editions: ["professional", "educational"],
      },
      {
        version: "2022",
        installRoot: path.join(root, "2022", "SOFiSTiK 2022"),
        editions: ["educational"],
      },
    ]);
  });

  it("is empty rather than throwing when SOFiSTiK is not installed", () => {
    expect(
      listInterfaces({ environmentRoot: root, readdir: () => [], exists: () => false }),
    ).toEqual([]);
    // A release directory that ships no interface is not an installation.
    expect(listInterfaces(installation({ 2025: [] }))).toEqual([]);
    // Nothing here touches the real filesystem, and a missing root is not an error.
    expect(listInterfaces({ environmentRoot: path.join(root, "absent") })).toEqual([]);
  });
});

function escaped(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
