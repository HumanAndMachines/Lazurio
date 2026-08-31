// bridge/run.ts — the Buddy bridge, as a host-level process.
//
// It runs under systemd next to the agent-runtime gateway (`buddy-bridge.service`),
// under its OWN uid `buddy-bridge`. It binds NO port. Everything it does it
// does by dialling out, on loopback:
//
//   Zulip          ← register + long-poll GET /events, POST /messages
//   agent runtime  ← POST /v1/chat/completions through a runtime-neutral seam
//
// THE THREE THINGS THIS FILE OWNS, and it owns them because everything below is
// a constructor argument and therefore testable without a host:
//
//   1. It is the ONLY place that reads `process.env`.
//   2. It runs the two startup gates, in order and fail-closed: the profile
//      custody gate, then the runtime seam.
//   3. It decides the exit code, which is the only thing a monitor ever sees.
//
// Public operator boundary: `manual/lazurio-resident-profiles.md`.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  createSystemMessageBuilder,
  readAgencyProfile,
} from "./agency/system-message.ts";
import {
  BRIDGE_EXIT_CONFIG_REFUSED,
  assertProfileMountIsSafe,
} from "./identity/profile-mount.ts";
import { EventBridge, createZulipEventsApi } from "./inbound/events.ts";
import {
  CONSOLE_LOGGER,
  buddyDisplayName,
  type BridgeAsyncReplySender,
  type BridgeEventLogger,
  type BridgeReplyProvider,
} from "./inbound/message.ts";
import { writePollerState } from "./inbound/poller-state.ts";
import { SessionRotations } from "./inbound/session-rotations.ts";
import { FileReplyQueue } from "./inbound/reply-queue.ts";
import { acquireSingletonLock } from "./inbound/singleton.ts";
import { TurnBreaker } from "./inbound/turn-breaker.ts";
import { DurableWatermark } from "./inbound/watermark.ts";
import { createRuntimeReplyProvider } from "./runtime-adapter/http-client.ts";
import { withSessionRecovery } from "./runtime-adapter/session-recovery.ts";
import { readRuntimeSeam, type RuntimeEnvironment } from "./runtime-adapter/seam.ts";
import {
  getOwnUserId,
  downloadRuntimeImage,
  sendToDirectMessage,
  sendToTopic,
  zulipConfigFromEnv,
  type ZulipConfig,
} from "./outbound/zulip.ts";

/**
 * The bridge's environment contract. The AGENT_RUNTIME_* keys are ours and
 * runtime-neutral; the BUDDY_* keys are wire names this repository declares end
 * to end, so no Principal's name is ever a key name; HERMES_API_* are read as
 * legacy aliases and never written (bridge/runtime-adapter/seam.ts).
 */
export interface BridgeRuntimeEnvironment extends RuntimeEnvironment {
  AGENT_RUNTIME_URL?: string;
  AGENT_RUNTIME_KEY?: string;
  AGENT_RUNTIME_SESSION_HEADER?: string;
  AGENT_RUNTIME_MODEL?: string;
  ZULIP_SITE?: string;
  BUDDY_BOT_EMAIL?: string;
  BUDDY_BOT_API_KEY?: string;
  BUDDY_NAME?: string;
  BUDDY_BRIDGE_QUEUE_DIR?: string;
  BUDDY_TURNS_PER_HOUR?: string;
  /**
   * The Principal's own `<login>-buddy` profile checkout. The bridge reads
   * CONSTITUTION.md and MANDATES.md out of it and puts them in front of every
   * turn (K3). Unset is a REFUSAL, not a default — see identity/profile-mount.ts.
   */
  BUDDY_PROFILE_DIR?: string;
  LAZURIO_BINDING_ID?: string;
  LAZURIO_BINDING_ROLE?: string;
  LAZURIO_RUNTIME_PERSONA?: string;
  LAZURIO_INSTRUCTION_FILE?: string;
  LAZURIO_ALLOWED_SENDER_IDS?: string;
  LAZURIO_ALLOWED_STREAM_IDS?: string;
  LAZURIO_TOPIC_POLICY?: string;
}

interface ManagedBindingRuntime {
  bindingId: string;
  role: "personal-home" | "organization";
  persona: "buddy" | "ai-colleague";
  instructionText: string;
  routingPolicy: {
    allowedSenderIds: ReadonlySet<number>;
    allowedStreamIds: ReadonlySet<number>;
    topicPolicy: "direct-only" | "any-in-allowed-stream";
  };
}

export function createZulipReplySender(
  config: ZulipConfig,
): BridgeAsyncReplySender {
  return async (input, content) => {
    if (input.replyTarget.kind === "stream") {
      const { streamId, topic } = input.replyTarget;
      await sendToTopic(config, streamId, topic, content);
      return;
    }
    if (input.replyTarget.recipientEmails.length === 0) {
      throw new Error("Zulip direct-message reply target is incomplete");
    }
    await sendToDirectMessage(config, input.replyTarget.recipientEmails, content);
  };
}

/**
 * The reply provider, wired to the resolved profile directory.
 *
 * `profileDir` is the RESOLVED path from the custody gate, never the declared
 * string: passing the declared string here would mean the gate judged one
 * directory and the reader opened another.
 */
export function configuredReplyProvider(
  env: BridgeRuntimeEnvironment,
  profileDir: string | undefined,
  logger: BridgeEventLogger = CONSOLE_LOGGER,
  zulip?: ZulipConfig,
  binding?: ManagedBindingRuntime,
): BridgeReplyProvider {
  const seam = readRuntimeSeam(env);
  if (seam.urlFrom !== "AGENT_RUNTIME_URL" || seam.keyFrom !== "AGENT_RUNTIME_KEY") {
    // Not fatal — a host installed by an older lane still works — but said out
    // loud, because a legacy name that nothing writes any more otherwise
    // survives for years by simply continuing to work.
    logger.warn(
      `[inbound] runtime seam resolved from legacy names (url=${seam.urlFrom} key=${seam.keyFrom})`,
    );
  }
  let systemMessage: (input: { senderName: string }) => string;
  if (binding?.role === "organization") {
    systemMessage = () => [
      binding.instructionText,
      "",
      `This turn came through Communication Binding ${binding.bindingId} from an immutable-id allowlisted sender.`,
      `Act only as ${binding.persona === "buddy" ? "the human Principal's Buddy" : "the AI Colleague Principal"} inside the selected Organization Authority Compartment.`,
      "Do not read, infer, or import Personalspace or another Organization through this turn.",
    ].join("\n");
  } else {
    if (!profileDir) {
      throw new Error("refusing to start: personal Buddy binding has no private profile directory");
    }
    const profile = readAgencyProfile(profileDir);
    for (const note of profile.notes) logger.info(`[inbound] agency: ${note}`);
    const build = createSystemMessageBuilder({
      buddyName: buddyDisplayName(env),
      profile,
    });
    systemMessage = ({ senderName }) => [
      ...(binding ? [binding.instructionText, ""] : []),
      build({ senderDisplayName: senderName }),
    ].join("\n");
  }
  return createRuntimeReplyProvider({
    endpoint: seam.url,
    apiKey: seam.key,
    model: seam.model,
    sessionHeader: seam.sessionHeader,
    loadImage: zulip ? (url) => downloadRuntimeImage(zulip, url) : undefined,
    systemMessage: (input) => systemMessage(input),
  });
}

function managedBindingFromEnvironment(
  env: BridgeRuntimeEnvironment,
): ManagedBindingRuntime | null {
  const declared = [
    env.LAZURIO_BINDING_ID,
    env.LAZURIO_BINDING_ROLE,
    env.LAZURIO_RUNTIME_PERSONA,
    env.LAZURIO_INSTRUCTION_FILE,
    env.LAZURIO_ALLOWED_SENDER_IDS,
    env.LAZURIO_ALLOWED_STREAM_IDS,
    env.LAZURIO_TOPIC_POLICY,
  ];
  if (declared.every((value) => value === undefined)) return null;
  if (declared.some((value) => value === undefined)) {
    throw new Error(
      "refusing to start: managed Communication Binding contract is incomplete",
    );
  }
  const bindingId = env.LAZURIO_BINDING_ID!.trim();
  const role = env.LAZURIO_BINDING_ROLE!.trim();
  const persona = env.LAZURIO_RUNTIME_PERSONA!.trim();
  const topicPolicy = env.LAZURIO_TOPIC_POLICY!.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bindingId)) {
    throw new Error("refusing to start: LAZURIO_BINDING_ID is not a canonical slug");
  }
  if (role !== "personal-home" && role !== "organization") {
    throw new Error("refusing to start: LAZURIO_BINDING_ROLE is invalid");
  }
  if (persona !== "buddy" && persona !== "ai-colleague") {
    throw new Error("refusing to start: LAZURIO_RUNTIME_PERSONA is invalid");
  }
  if (persona === "ai-colleague" && role !== "organization") {
    throw new Error("refusing to start: an AI Colleague cannot have a personal-home binding");
  }
  if (topicPolicy !== "direct-only" && topicPolicy !== "any-in-allowed-stream") {
    throw new Error("refusing to start: LAZURIO_TOPIC_POLICY is invalid");
  }
  const allowedSenderIds = parseImmutableIds(
    env.LAZURIO_ALLOWED_SENDER_IDS!,
    "LAZURIO_ALLOWED_SENDER_IDS",
    false,
  );
  const allowedStreamIds = parseImmutableIds(
    env.LAZURIO_ALLOWED_STREAM_IDS!,
    "LAZURIO_ALLOWED_STREAM_IDS",
    true,
  );
  if (topicPolicy === "direct-only" && allowedStreamIds.size !== 0) {
    throw new Error("refusing to start: a direct-only binding cannot expose streams");
  }
  return {
    bindingId,
    role,
    persona,
    instructionText: readManagedInstructionFile(env.LAZURIO_INSTRUCTION_FILE!),
    routingPolicy: { allowedSenderIds, allowedStreamIds, topicPolicy },
  };
}

function parseImmutableIds(
  value: string,
  label: string,
  emptyAllowed: boolean,
): ReadonlySet<number> {
  const trimmed = value.trim();
  if (trimmed === "" && emptyAllowed) return new Set();
  const raw = trimmed.split(",");
  const ids = raw.map((item) => Number(item));
  if (
    raw.some((item) => !/^[1-9][0-9]*$/.test(item)) ||
    ids.some((id) => !Number.isSafeInteger(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(`refusing to start: ${label} must contain unique positive ids`);
  }
  return new Set(ids);
}

function readManagedInstructionFile(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("refusing to start: LAZURIO_INSTRUCTION_FILE must be absolute");
  }
  let bytes: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
      throw new Error("unsafe");
    }
    const resolved = realpathSync(path);
    bytes = readFileSync(resolved);
  } catch {
    throw new Error(
      "refusing to start: managed binding instructions must be a readable, non-writable regular file",
    );
  }
  if (bytes.length === 0 || bytes.length > 512 * 1024 || bytes.includes(0)) {
    throw new Error("refusing to start: managed binding instructions are invalid");
  }
  return bytes.toString("utf8");
}

function turnsPerHour(env: BridgeRuntimeEnvironment): number | undefined {
  const declared = Number(env.BUDDY_TURNS_PER_HOUR);
  return Number.isInteger(declared) && declared > 0 ? declared : undefined;
}

/**
 * Where the poller says it can hear. One canonical path, so the drill, the
 * evidence collector and the local harness cannot each invent their own.
 */
export function pollerStatePath(queueDirectory: string): string {
  return join(queueDirectory, "state", "poller.json");
}

export interface BridgeRuntime {
  bridge: EventBridge;
  queue: FileReplyQueue;
  stop: () => Promise<void>;
}

/**
 * Wire the whole runtime from the environment.
 *
 * THE GATE ORDER IS PART OF THE CONTRACT. The profile custody gate runs FIRST,
 * before a socket is opened or a queue directory is created, because it is the
 * one gate about what this process may READ. Everything after it is about what
 * it may reach.
 */
export async function buildRuntime(
  env: BridgeRuntimeEnvironment = process.env,
  logger: BridgeEventLogger = CONSOLE_LOGGER,
): Promise<BridgeRuntime> {
  const binding = managedBindingFromEnvironment(env);
  const profileDir =
    !binding || binding.role === "personal-home"
      ? assertProfileMountIsSafe(env.BUDDY_PROFILE_DIR)
      : undefined;
  const queueDirectory = env.BUDDY_BRIDGE_QUEUE_DIR?.trim();
  if (!queueDirectory) {
    // `refusing to start:` is the classification, not decoration — it is what
    // routes this to exit 78 instead of a restart loop (scar R10).
    throw new Error(
      "refusing to start: the bridge requires a durable queue directory " +
        "(BUDDY_BRIDGE_QUEUE_DIR is not declared)",
    );
  }
  const zulip = zulipConfigFromEnv(env as Record<string, string | undefined>);
  const replySender = createZulipReplySender(zulip);
  // ONE rotation store for both triggers: the /reset command (EventBridge) and
  // the automatic exhaustion recovery (reply provider wrapper). Two stores
  // writing the same session header would rotate past each other.
  const sessionRotations = new SessionRotations(
    join(queueDirectory, "state", "session-rotations.json"),
  );
  const queue = new FileReplyQueue({
    directory: queueDirectory,
    // Wrapped so a wedged runtime session rotates instead of answering every
    // future turn with the same exhaustion error (see the regression in
    // runtime-adapter/session-recovery.ts).
    replyProvider: withSessionRecovery({
      provider: configuredReplyProvider(env, profileDir, logger, zulip, binding ?? undefined),
      // The SAME store the /reset command writes (wired to EventBridge below)
      // — one rotation state, two triggers.
      rotations: sessionRotations,
      buddyName: buddyDisplayName(env),
      log: (line) => logger.info(line),
    }),
    replySender,
    logger,
  });
  const lock = await acquireSingletonLock(join(queueDirectory, "bridge.lock"));
  await queue.start();
  const bridge = new EventBridge({
    api: createZulipEventsApi(zulip),
    inbox: queue,
    watermark: new DurableWatermark(join(queueDirectory, "state", "watermark.json")),
    bot: { userId: await getOwnUserId(zulip), email: zulip.botEmail },
    breaker: new TurnBreaker({ limitPerHour: turnsPerHour(env) }),
    logger,
    notify: replySender,
    buddyName: buddyDisplayName(env),
    bindingId: binding?.bindingId,
    routingPolicy: binding?.routingPolicy,
    sessionRotations,
    onRegistered: ({ registrations }) =>
      writePollerState(pollerStatePath(queueDirectory), registrations),
  });
  return { bridge, queue, stop: () => lock.release() };
}

/**
 * Which exit code a startup failure deserves.
 *
 * A configuration refusal will not fix itself, so it exits 78 and the unit
 * refuses to restart on it (scar R10). Anything else — a runtime that is not up
 * yet, a Zulip that is still starting — is transient, exits 1, and systemd is
 * right to retry it. Getting this backwards in either direction is a real cost:
 * exiting 78 on a transient fault means a Buddy that stays dead after a reboot
 * race; exiting 1 on a misconfiguration means the eleven-restarts-a-minute
 * `activating` that no monitor can read.
 */
export function startupExitCode(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return /^refusing to start:/.test(message) ||
    /is not set\.|is not a valid HTTP header name|DIFFERENT values for/.test(message)
    ? BRIDGE_EXIT_CONFIG_REFUSED
    : 1;
}

if (import.meta.main) {
  const controller = new AbortController();
  let runtime: BridgeRuntime;
  try {
    runtime = await buildRuntime();
  } catch (error) {
    // NO DEGRADED MODE. Under the webhook shape a misconfigured bridge could
    // still answer 503 and stay up, which was worth something because Zulip was
    // the one calling. Nothing calls now: a bridge that cannot poll is a Buddy
    // that is silently deaf, and a process that exits is a better answer than a
    // process that is up and useless.
    console.error(`[inbound] bridge cannot start: ${(error as Error).message}`);
    process.exit(startupExitCode(error));
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      controller.abort();
      void runtime.stop().finally(() => process.exit(0));
    });
  }
  console.log("[inbound] Buddy bridge polling the Zulip events API (no listener)");
  await runtime.bridge.run(controller.signal);
}
