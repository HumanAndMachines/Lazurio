export function githubRepositoryUrlIdentity(value) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^(?:(git)@github\.com:|https:\/\/github\.com\/|ssh:\/\/(git)@github\.com\/)([A-Za-z0-9](?:-?[A-Za-z0-9])*)\/([A-Za-z0-9][A-Za-z0-9._-]*_GEN3)(?:\.git)?\/?(?![\s\S])/i,
  );
  const sshUser = match?.[1] ?? match?.[2];
  if (
    !match ||
    (sshUser !== undefined && sshUser !== "git") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*_GEN3$/.test(match[4])
  ) {
    return null;
  }
  return `${match[3].toLowerCase()}/${match[4]}`;
}

export function githubRepositoryCoordinateIdentity(value) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^([A-Za-z0-9](?:-?[A-Za-z0-9])*)\/([A-Za-z0-9][A-Za-z0-9._-]*_GEN3)(?![\s\S])/,
  );
  if (!match) return null;
  return `${match[1].toLowerCase()}/${match[2]}`;
}
