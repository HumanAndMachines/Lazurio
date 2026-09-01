#!/usr/bin/env bun
import {
  prepareResidentCheckpoint,
  reconcileResidentRuntime,
  reconcileResidentZulip,
  residentStatus,
  resumeResidentCheckpoint,
  verifyResident,
} from "./controller-lib.mjs";
import { lstatSync, readFileSync } from "node:fs";

function usage() {
  return [
    "bun resident/controller.mjs runtime --contract PATH --secrets PATH",
    "bun resident/controller.mjs zulip --contract PATH --secrets PATH",
    "bun resident/controller.mjs checkpoint-prepare --contract PATH --output PATH",
    "bun resident/controller.mjs checkpoint-resume --contract PATH",
    "bun resident/controller.mjs status --contract PATH",
    "bun resident/controller.mjs verify --contract PATH",
  ].join("\n");
}

function parseArguments(argv) {
  const [operation, ...rest] = argv;
  if (!operation || operation === "--help" || operation === "-h") {
    return { help: true };
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!/^--(contract|secrets|output)$/.test(flag || "") || !value) {
      throw new Error("invalid arguments");
    }
    const key = flag.slice(2);
    if (values[key] !== undefined) throw new Error("duplicate argument");
    values[key] = value;
  }
  if (!values.contract) throw new Error("--contract is required");
  return { operation, ...values };
}

function readJson(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4 * 1024 * 1024) {
    throw new Error(label + " is not a safe bounded regular file");
  }
  const bytes = readFileSync(path);
  if (bytes.includes(0)) throw new Error(label + " contains invalid bytes");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(label + " is not valid JSON");
  }
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  if (input.help) {
    process.stdout.write(usage() + "\n");
    return;
  }
  const contract = readJson(input.contract, "Resident controller contract");
  let result;
  switch (input.operation) {
    case "runtime":
      if (!input.secrets) throw new Error("runtime requires --secrets");
      result = reconcileResidentRuntime(
        contract,
        readJson(input.secrets, "Resident secret bundle"),
      );
      break;
    case "zulip":
      if (!input.secrets) throw new Error("zulip requires --secrets");
      result = await reconcileResidentZulip(
        contract,
        readJson(input.secrets, "Resident secret bundle"),
      );
      break;
    case "checkpoint-prepare":
      if (!input.output) throw new Error("checkpoint-prepare requires --output");
      result = prepareResidentCheckpoint(contract, input.output);
      break;
    case "checkpoint-resume":
      result = resumeResidentCheckpoint(contract);
      break;
    case "status":
      result = residentStatus(contract);
      break;
    case "verify":
      result = verifyResident(contract);
      break;
    default:
      throw new Error("unsupported operation");
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write("resident controller: " + message + "\n");
  process.exit(1);
});
