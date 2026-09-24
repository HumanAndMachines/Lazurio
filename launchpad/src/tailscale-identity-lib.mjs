// One answer to "which tailnet is this computer on", shared by the Machine's
// SSH access step and the laptop's Network/Connections steps so the hand-over
// between them compares like with like.
//
// The identity is the control server tailscaled is logged into
// (`tailscale debug prefs` → ControlURL): the same URL an Organization
// declares as its Headscale login server, and the same on every node of the
// tailnet. `tailscale status --json` → CurrentTailnet.Name is only the
// fallback when prefs are unavailable — Headscale reports the login server
// host there today, but the name is presentational and may differ.

const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const tailnetPattern = /^[A-Za-z0-9._@+-]{1,253}$/;
const tailnetIpv4Pattern = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

// A control/login server is an https origin with a DNS host and nothing else.
export function validControlUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" || !hostnamePattern.test(url.hostname)) return null;
  return url.origin;
}

function text(output) {
  return typeof output === "string" ? output : String(output?.stdout ?? "");
}

// `run(program, args, options)` may resolve to the stdout string or to a
// `{ stdout }` result; both process runners in Launchpad are accepted.
export async function readTailscaleIdentity(run, tailscale = "tailscale") {
  const empty = { backend_state: null, tailnet: null, control_url: null, ipv4: null, auth_url: null, host_name: null };
  const json = (program, args) => Promise.resolve()
    .then(() => run(program, args, { timeoutMs: 10_000 }))
    .then((output) => JSON.parse(text(output)))
    .catch(() => null);
  const [status, prefs] = await Promise.all([json(tailscale, ["status", "--json"]), json(tailscale, ["debug", "prefs"])]);
  if (!status || typeof status !== "object") return empty;
  const controlUrl = validControlUrl(prefs?.ControlURL);
  const name = status?.CurrentTailnet?.Name;
  return {
    backend_state: typeof status.BackendState === "string" ? status.BackendState : null,
    tailnet: controlUrl ? new URL(controlUrl).hostname : tailnetPattern.test(name ?? "") ? name : null,
    control_url: controlUrl,
    ipv4: (status.Self?.TailscaleIPs ?? []).find((value) => tailnetIpv4Pattern.test(value)) ?? null,
    auth_url: typeof status.AuthURL === "string" ? status.AuthURL : null,
    host_name: typeof status.Self?.HostName === "string" ? status.Self.HostName : null,
  };
}
