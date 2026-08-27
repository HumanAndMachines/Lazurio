export function parseLaunchpadServerArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--open") {
      parsed.open = true;
      continue;
    }
    if (arg === "--reuse") {
      parsed.reuse = true;
      continue;
    }
    if (arg === "--agent-entry") {
      parsed.agentEntry = true;
      continue;
    }
    if (arg === "--personalspace") {
      parsed.personalspace = true;
      continue;
    }
    if (arg.startsWith("--organization=")) {
      parsed.organization = requiredValue(arg.slice("--organization=".length), "--organization");
      continue;
    }
    if (arg === "--organization") {
      parsed.organization = requiredFollowingValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      parsed.port = arg.slice("--port=".length);
      continue;
    }
    if (arg === "--port") {
      parsed.port = requiredFollowingValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      parsed.host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--host") {
      parsed.host = requiredFollowingValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      parsed.root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--root") {
      parsed.root = requiredFollowingValue(args, index, arg);
      index += 1;
    }
  }
  if (parsed.organization !== undefined && parsed.personalspace) {
    throw new Error("--organization a --personalspace se vzájemně vylučují.");
  }
  if ((parsed.organization !== undefined || parsed.personalspace) && !parsed.agentEntry) {
    throw new Error("--organization a --personalspace vyžadují interní --agent-entry kontrakt.");
  }
  return parsed;
}

function requiredFollowingValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Chybí hodnota pro ${name}.`);
  }
  return value;
}

function requiredValue(value, name) {
  if (value === "") throw new Error(`Chybí hodnota pro ${name}.`);
  return value;
}
