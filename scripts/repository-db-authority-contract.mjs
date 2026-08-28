import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CANONICAL_CONFIG = "repository-db.yaml";
const LEGACY_MANIFEST = "repository-db.manifest.json";

function fail(message) {
  throw new Error(message);
}

function regularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} is not a regular file`);
  }
}

export function repositoryDbAuthorityMarkerNames(repositoryDbRoot) {
  return [CANONICAL_CONFIG, LEGACY_MANIFEST].filter((name) =>
    existsSync(join(repositoryDbRoot, name))
  );
}

export function hasRepositoryDbAuthorityMarker(repositoryDbRoot) {
  return repositoryDbAuthorityMarkerNames(repositoryDbRoot).length > 0;
}

export function readMissionControlRepositoryDbAuthority(repositoryDbRoot) {
  const markers = repositoryDbAuthorityMarkerNames(repositoryDbRoot);
  if (markers.length === 0) {
    fail("repository-db authority marker is missing");
  }
  if (markers.length > 1) {
    fail("canonical and legacy repository-db authority markers coexist");
  }

  const markerName = markers[0];
  const markerPath = join(repositoryDbRoot, markerName);
  regularFile(markerPath, "repository-db authority marker");

  if (markerName === LEGACY_MANIFEST) {
    const manifest = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      manifest?.schema_version !== "companiesascode.repository_db.manifest.v1"
      || manifest?.data_mode !== "repository-db"
      || manifest?.data_root !== "data/mission-control"
    ) {
      fail("legacy repository-db manifest is not a canonical Mission Control authority");
    }
    return {
      markerName,
      markerPath,
      dataRoot: manifest.data_root,
    };
  }

  const config = Bun.YAML.parse(readFileSync(markerPath, "utf8"));
  if (
    config?.schema_version !== "repository-db.config.v1"
    || config?.app !== "mission-control"
    || config?.layout?.data !== "data"
    || config?.schema?.name !== "mission-control-data"
  ) {
    fail("repository-db config is not a canonical Mission Control authority");
  }
  return {
    markerName,
    markerPath,
    dataRoot: "data/mission-control",
  };
}
