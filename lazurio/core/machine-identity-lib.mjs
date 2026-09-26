import { existsSync, readFileSync } from "node:fs";

// Core owns the one Machine identity reader, so the Launchpad server and the
// CLI Doctor classify a Machine the same way.
export const MACHINE_IDENTITY_FILE = "/etc/lazurio/lazurio.machine.json";

const machineLoginPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * `/etc/lazurio/lazurio.machine.json` (Machines docs/machine-identity.md).
 * Tells a personal VM (no Organization install) from an Organization one.
 * The declared account does not gate sign-in: until Dashboard binds a
 * Machine to an account, whoever operates it signs in with any account.
 */
export function parseMachineAssignment(raw) {
  let value;
  try {
    value = JSON.parse(String(raw ?? ""));
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
  if (value?.schema_version !== "lazurio.machine.v1") return Object.freeze({ kind: "invalid" });
  const owner = value.owner ?? {};
  const machineKind = value.machine?.kind;
  if (machineKind === "personal-vm" && owner.kind === "principal") {
    return expectedAccount("principal", owner.github_login, owner.github_id);
  }
  if (machineKind === "workspace-vm" && owner.kind === "organization") {
    const assignment = owner.assignment;
    if (!assignment) return Object.freeze({ kind: "unassigned" });
    if (assignment.kind === "team") return Object.freeze({ kind: "team" });
    if (assignment.kind === "operator") {
      return expectedAccount("operator", assignment.github_login, assignment.github_id);
    }
  }
  return Object.freeze({ kind: "invalid" });
}

function expectedAccount(kind, login, id) {
  if (typeof login !== "string" || !machineLoginPattern.test(login) || !Number.isSafeInteger(id) || id <= 0) {
    return Object.freeze({ kind: "invalid" });
  }
  return Object.freeze({ kind, github_login: login, github_id: id });
}

export function readMachineAssignment({ path = MACHINE_IDENTITY_FILE, exists = existsSync, read = readFileSync } = {}) {
  if (!exists(path)) return Object.freeze({ kind: "none" });
  try {
    return parseMachineAssignment(read(path, "utf8"));
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}

// A shared Team Machine (workspace-vm assigned to a Team) has no personal
// owner, so it has no Personalspace. Every other assignment keeps today's
// behaviour, including an absent or unreadable identity file.
export function machineOffersPersonalspace(assignment) {
  return assignment?.kind !== "team";
}
