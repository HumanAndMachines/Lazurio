import { writeFile } from "fs/promises";
import { compileOrganization, formatCompilerReport, OrganizationCompilerError } from "./index.mjs";
import { readCheckoutRepositoryObservation } from "./checkout-observation.mjs";

const args = parseArgs(Bun.argv.slice(2));
let report;
try {
  report = await compileOrganization({
    organizationRoot: args.organization,
    write: args.write,
    repositoryObservation:
      args.write
        ? null
        : readCheckoutRepositoryObservation(args.organization),
  });
} catch (error) {
  if (!(error instanceof OrganizationCompilerError)) throw error;
  console.error(error.message);
  for (const failure of error.details.failures ?? []) console.error(`FAIL: ${failure}`);
  for (const issue of error.details.ownership_issues ?? []) {
    console.error(
      `FAIL: ownership ${issue.path}: očekávána právě jedna klasifikace, matches=${JSON.stringify(issue.matches ?? [])}`,
    );
  }
  for (const warning of error.details.warnings ?? []) console.error(`WARN: ${warning}`);
  process.exit(1);
}

const text = formatCompilerReport(report);
console.log(text);

if (args.report) {
  await writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(values) {
  const result = {
    write: false,
    report: null,
    organization: null,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--write") {
      result.write = true;
      continue;
    }
    if (value === "--dry-run") {
      result.write = false;
      continue;
    }
    if (value === "--organization" || value === "--report") {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      result[value.slice(2)] = next;
      index += 1;
      continue;
    }
    if (value === "--workspace") {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      console.warn("--workspace je deprecated alias --organization (CAC-0016)");
      result.organization = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!result.organization) {
    throw new Error("Usage: bun packages/organization-compiler/src/compile-company.mjs --organization <OrganizationRoot> [--write] [--report <path>]");
  }

  return result;
}
