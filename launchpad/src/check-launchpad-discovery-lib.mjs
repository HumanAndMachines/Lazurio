export function discoveryContractFailures({
  portOverlaps = [],
  moduleListenerDrifts = [],
  organizationIssues = [],
} = {}) {
  return [
    ...organizationIssues
      .filter((issue) => issue?.severity === "blocking")
      .map((issue) => `${issue.organization}/${issue.module ?? issue.path ?? "unknown-slot"}: ${issue.code} — ${issue.message}`),
    ...portOverlaps
      .filter((overlap) => overlap.conflict !== false)
      .map((overlap) => `port ${overlap.port}: ${overlap.classification}`),
    ...moduleListenerDrifts
      .map((drift) => `${drift.module_lease}: module listener drift`),
  ];
}
