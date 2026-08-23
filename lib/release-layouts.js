const { recordLayoutsFor } = require("./record-layouts");
const { listInterfaces } = require("./sofistik-interface");

// The length CDB stores a record at is the layout it was written with, and the
// release reading a database is not always the release that wrote it. SOFiSTiK
// does not keep every older form readable through a newer header: a record is
// appended to, but a field is also inserted into the middle of one, and a record
// grows so that a newer database no longer fits an older header at all. So when
// the installed release does not describe the form a database holds, the
// releases installed beside it are asked, and the one that describes exactly
// that length answers.
//
// Nothing here guesses. A layout is used only when its size is the stored size,
// which makes the decode as exact as a version-matched read.

// The other releases installed beside this one, newest first, each with the
// layouts its headers describe. Read once and held, because parsing a release's
// headers costs about a megabyte of text and the answer belongs to the release.
function siblingLayouts(installation, options = {}) {
  const { environmentRoot, installRoot } = installation;
  if (!environmentRoot) return [];
  const siblings = [];
  for (const installed of listInterfaces({ ...options, environmentRoot })) {
    if (installed.installRoot === installRoot) continue;
    try {
      siblings.push({
        version: installed.version,
        layouts: recordLayoutsFor(installed.installRoot, options),
      });
    } catch {
      // A release whose headers cannot be read is one this cannot learn from.
    }
  }
  return siblings;
}

// Where a layout puts its values, with no regard for what it calls them. Two
// releases that lay a length out the same way but renamed a field between them
// decode the same bytes to the same numbers, and that is not a disagreement
// worth refusing over - SOFiSTiK has reused a slot under a new name more than
// once, and a beam stress record is the same 116 bytes either way.
function placementOf(layout) {
  return layout.fields.map(({ kind, offset, count }) => `${kind}:${offset}:${count}`).join(",");
}

// How far a release is from the one being read through. A database is most
// often written by the release reading it or by one near it, and an older
// release is nearer than a newer one at the same distance, because a database
// older than the interface is the ordinary case and a newer one is not.
function releaseDistance(version, installedVersion) {
  const from = Number(installedVersion);
  const to = Number(version);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(to - from) * 2 + (to > from ? 1 : 0);
}

// The layout that describes a record at the length a database stores it in.
//
// Returns `{ layout }` with the layout to decode with, `{ layout: null }` when
// no installed release describes that length, or `{ ambiguous }` when two of
// them describe it differently - there is nothing to choose between those, and
// nothing is chosen. `version` names the release the layout came from, and
// `alsoDescribedBy` the others that describe it identically.
function layoutDescribing({ layouts, siblings, version }, recordName, storedLength) {
  const installed = layouts.layout(recordName);
  if (installed.size === storedLength) return { layout: installed, version: null };
  const matches = [];
  for (const sibling of siblings) {
    if (!sibling.layouts.has(recordName)) continue;
    const candidate = sibling.layouts.layout(recordName);
    if (candidate.size !== storedLength) continue;
    const placement = placementOf(candidate);
    const seen = matches.find((match) => match.placement === placement);
    if (seen) seen.releases.push({ version: sibling.version, layout: candidate });
    else matches.push({ placement, releases: [{ version: sibling.version, layout: candidate }] });
  }
  if (matches.length > 1) {
    return {
      layout: null,
      ambiguous: matches.map(({ releases }) => releases.map((release) => release.version)),
    };
  }
  if (matches.length === 0) return { layout: null };
  const releases = matches[0].releases.sort(
    (left, right) =>
      releaseDistance(left.version, version) - releaseDistance(right.version, version),
  );
  return {
    layout: releases[0].layout,
    version: releases[0].version,
    alsoDescribedBy: releases.slice(1).map((release) => release.version),
  };
}

module.exports = { layoutDescribing, placementOf, releaseDistance, siblingLayouts };
