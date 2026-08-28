const SESSION_EXPIRED_CODE = "hosted_session_expired";

function sessionExpiredError() {
  const error = new Error("Přihlášení vypršelo. Obnovuji relaci…");
  error.code = SESSION_EXPIRED_CODE;
  return error;
}

export function createSessionAwareFetch({ fetchImpl, recoverSession }) {
  let recoveryStarted = false;

  return async function sessionAwareFetch(input, init = {}) {
    // Launchpad API routes never redirect during normal operation. The hosted
    // gateway uses a cross-origin redirect only when the OAuth session must be
    // resumed; manual mode exposes that response as `opaqueredirect` without
    // letting fetch follow it into a CORS failure.
    const response = await fetchImpl(input, { ...init, redirect: "manual" });
    if (response.type !== "opaqueredirect") return response;

    if (!recoveryStarted) {
      recoveryStarted = true;
      recoverSession();
    }
    throw sessionExpiredError();
  };
}

export const launchpadFetch = createSessionAwareFetch({
  fetchImpl: (...args) => globalThis.fetch(...args),
  recoverSession: () => globalThis.location.reload(),
});
