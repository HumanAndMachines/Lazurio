#!/usr/bin/env bun
// Lazurio Example test accounts for browser smoke tests (skill lazurio-example-smoke-test).
//
//   bun example-account.mjs signin <alena|bob> [--profile-name N]
//       Signs the agent's own Chrome profile in to GitHub (password + TOTP from the
//       Organization-local custody) and to Lazurio (dashboard.lazurio.ai), headless.
//   bun example-account.mjs open <alena|bob> [--profile-name N] [--url URL]
//       Opens that profile in a visible Chrome with a DevTools endpoint and prints
//       EXAMPLE_CDP_URL=... so the agent can drive it (Playwright connectOverCDP).
//   bun example-account.mjs totp <alena|bob>
//       Prints the current GitHub 2FA code (for an agent driving its own browser tool).
//
// Prints status and URLs only, never a password or the TOTP key.
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ACCOUNTS = {
  alena: { login: "lazurio-alena", first: "Alena", last: "Example", email: "alena@lazurio.ai" },
  bob: { login: "lazurio-bob", first: "Bob", last: "Example", email: "bob@lazurio.ai" },
};
const DASHBOARD = "https://dashboard.lazurio.ai/";
const ORG = process.env.LAZURIO_EXAMPLE_ORG_ROOT || join(homedir(), "Lazurio/organizations/LazurioExampleOrganization_GEN3");
const STATE = join(homedir(), ".local/share/lazurio/example-smoke");

const [command, who] = process.argv.slice(2);
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const account = ACCOUNTS[who];
if (!["signin", "open", "totp"].includes(command) || !account) {
  console.error("usage: example-account.mjs <signin|open|totp> <alena|bob> [--profile-name N] [--url URL]");
  process.exit(2);
}

const custody = join(ORG, "company/colleagues", account.login, "private/secrets/github", account.login, "login.json");
if (!existsSync(custody)) {
  console.error(`EXAMPLE_CREDENTIALS_MISSING ${custody}`);
  console.error("Ask the Operator to save them with scripts/save-credentials.py (a local form); never ask for them in chat.");
  process.exit(3);
}
const record = JSON.parse(readFileSync(custody, "utf8"));

function totp(secret, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

if (command === "totp") {
  console.log(totp(record.totp_secret));
  process.exit(0);
}

// Every agent signs in its own profile; the Operator's Dock profiles
// (~/.local/share/lazurio/example-chrome/<who>) are not for agents.
const profile = join(homedir(), ".local/share/lazurio/example-chrome/agents", `${who}-${flag("--profile-name") ?? "default"}`);
mkdirSync(profile, { recursive: true, mode: 0o700 });
try {
  const lock = readlinkSync(join(profile, "SingletonLock"));
  const pid = Number(lock.split("-").pop());
  if (pid && spawnSync("kill", ["-0", String(pid)]).status === 0) {
    console.error(`EXAMPLE_PROFILE_IN_USE ${profile}: another Chrome runs it; pass --profile-name <your-own>.`);
    process.exit(4);
  }
} catch {}

const chrome =
  process.env.EXAMPLE_CHROME_PATH ||
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!chrome) {
  console.error("EXAMPLE_CHROME_MISSING: set EXAMPLE_CHROME_PATH to a Chrome or Chromium binary.");
  process.exit(5);
}
// The real Keychain (no mock), so a profile signed in headless stays signed in when opened visibly.
const chromeArgs = ["--no-first-run", "--no-default-browser-check"];
const ignoreDefaultArgs = ["--use-mock-keychain", "--enable-automation", "--password-store=basic"];

async function playwright() {
  const pkg = join(STATE, "node_modules/playwright-core");
  if (!existsSync(pkg)) {
    mkdirSync(STATE, { recursive: true });
    const r = spawnSync("bun", ["add", "playwright-core@1.57.0", "--cwd", STATE], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("installing playwright-core failed");
  }
  return import(join(pkg, "index.mjs"));
}

if (command === "open") {
  const url = flag("--url") ?? DASHBOARD;
  const child = spawn(chrome, [`--user-data-dir=${profile}`, "--remote-debugging-port=0", ...chromeArgs, url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 50 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 200));
  const port = existsSync(portFile) ? readFileSync(portFile, "utf8").split("\n")[0] : "";
  console.log(`EXAMPLE_PROFILE=${profile}`);
  console.log(port ? `EXAMPLE_CDP_URL=http://127.0.0.1:${port}` : "EXAMPLE_CDP_URL= (Chrome did not report a port)");
  process.exit(port ? 0 : 6);
}

// signin
const { chromium } = await playwright();
const context = await chromium.launchPersistentContext(profile, {
  executablePath: chrome,
  headless: true,
  ignoreDefaultArgs,
  args: chromeArgs,
});
const page = context.pages()[0] ?? (await context.newPage());
const githubUser = async () => {
  await page.goto("https://github.com/", { waitUntil: "domcontentloaded" });
  return page.locator('meta[name="user-login"]').getAttribute("content").catch(() => null);
};

let user = await githubUser();
if (user !== account.login) {
  await page.goto("https://github.com/login", { waitUntil: "domcontentloaded" });
  await page.fill("#login_field", account.login);
  await page.fill("#password", record.password);
  await page.click('input[type="submit"][name="commit"]');
  await page.waitForLoadState("domcontentloaded");
  if (page.url().includes("/sessions/two-factor")) {
    if (30 - ((Date.now() / 1000) % 30) < 5) await page.waitForTimeout(6000);
    await page.locator('input[name="app_otp"], #app_totp, input[autocomplete="one-time-code"]').first().fill(totp(record.totp_secret));
    await page.waitForURL((u) => !u.pathname.startsWith("/sessions/two-factor"), { timeout: 20000 }).catch(() => {});
  }
  user = await githubUser();
}
console.log(`github: ${user === account.login ? `signed in as ${account.login}` : `NOT signed in (${page.url().replace(/\?.*/, "")})`}`);

await page.goto(DASHBOARD, { waitUntil: "networkidle" }).catch(() => {});
const signIn = page.getByText(/Continue with GitHub/i);
if (user === account.login && (await signIn.count())) {
  await signIn.first().click();
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    const u = new URL(page.url());
    if (u.host === "github.com" && u.pathname.startsWith("/login/oauth/authorize")) {
      const authorize = page.locator('button[name="authorize"][value="1"], #js-oauth-authorize-btn').first();
      if (await authorize.count()) await authorize.click();
    } else if (u.pathname.includes("/login-actions/required-action")) {
      // First Lazurio sign-in: the profile step (GitHub's display name may not validate, Auth#55).
      if (!(await page.locator("#email").inputValue().catch(() => ""))) await page.fill("#email", account.email);
      await page.fill("#firstName", account.first);
      await page.fill("#lastName", account.last);
      await page.locator('input[type="submit"], button[type="submit"]').first().click();
    } else if (u.host === "dashboard.lazurio.ai" && !(await signIn.count())) break;
  }
}
await page.waitForLoadState("networkidle").catch(() => {});
const signedIn = page.url().startsWith(DASHBOARD) && !(await signIn.count());
console.log(`lazurio: ${signedIn ? "signed in" : "NOT signed in"} (${page.url().replace(/\?.*/, "")})`);
console.log(`EXAMPLE_PROFILE=${profile}`);
await context.close();
process.exit(user === account.login && signedIn ? 0 : 1);
