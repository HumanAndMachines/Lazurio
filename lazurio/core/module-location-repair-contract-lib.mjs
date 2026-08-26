export const MODULE_LOCATION_REPAIR_ACTION_KIND = "repair_module_location";

const organizationSelectorPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const moduleSelectorPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function moduleLocationRepairCommand({ organization, module }) {
  if (!organizationSelectorPattern.test(String(organization ?? ""))) return null;
  if (!moduleSelectorPattern.test(String(module ?? ""))) return null;
  return `lazurio repair module-location --org ${organization} --module ${module}`;
}

export function buildModuleLocationRepairAction({
  organization,
  module,
  detail = null,
  reason = "repository_location_mismatch",
} = {}) {
  const command = moduleLocationRepairCommand({ organization, module });
  if (!command) return null;
  const diagnostic = typeof detail === "string" && detail.trim() !== ""
    ? detail.trim()
    : "Deklarované umístění nebo origin repozitáře neodpovídá lokálnímu checkoutu.";
  return {
    kind: MODULE_LOCATION_REPAIR_ACTION_KIND,
    label: "Vyřešit s Codexem",
    command,
    prompt: `V Launchpadu je izolovaný modul „${module}“ v Organizaci „${organization}“, protože jeho lokální checkout po přejmenování nebo přesunu repozitáře neodpovídá deklaraci.

Diagnostika Lazuria:
- Důvod: ${reason}
- Detail: ${diagnostic}
- Bezpečný ověřovací příkaz: ${command}

Postupuj prosím takto:
1. Pracuj v Lazurio rootu na této mašině. Nejdřív spusť přesně uvedený ověřovací příkaz bez \`--apply\`. Tento krok smí jen najít jednoznačný checkout, ověřit Git stav, oba remotes a jejich historii a vrátit plán s fingerprintem.
2. Pokud výsledek není \`ready\`, nic ručně nepřesouvej, neměň origin a nemaž žádná data. Vysvětli konkrétní blokaci a bezpečný další krok.
3. Pokud je výsledek \`ready\`, zkontroluj, že plán míří na správnou Organizaci, stabilní ID modulu, zdrojovou i cílovou cestu a nový GitHub remote. Potom spusť pouze CLI příkaz s \`--apply --expect <fingerprint>\`, který vrátil ověřovací krok. Nevymýšlej fingerprint ani vlastní pořadí Git operací.
4. CLI musí před změnou celý stav znovu ověřit pod update lockem. Když se fingerprint změnil, vrať se k ověřovacímu kroku; neobcházej guardy.
5. Po úspěšné opravě spusť \`lazurio update\` a ověř v Launchpadu, že modul i zdravé sousední moduly mají pravdivý stav.

Hranice úkolu: zachovej veškerá lokální Git data. Nedělej reset, rebase, merge, push, force, ruční mazání ani automatické rozhodnutí nad dirty, ahead/diverged, detached, probíhající Git operací, nejednoznačným checkoutem, cizím remotem nebo kolizí cílové cesty. V těchto stavech má CLI bezpečně skončit a rozhodnutí zůstává Agentovi a Principálovi.`,
  };
}

export function buildRepositoryLocationIssue({
  organization,
  organizationPath,
  module,
  path,
  expectedPath = null,
  message,
  sources = [],
  repairable = true,
} = {}) {
  const nextAction = repairable
    ? buildModuleLocationRepairAction({
        organization,
        module,
        detail: message,
        reason: "repository_location_mismatch",
      })
    : null;
  return {
    schema_version: "lazurio.organization_issue.v1",
    severity: "blocking",
    scope: "module_slot",
    status: "quarantined",
    code: "repository_location_mismatch",
    organization,
    organization_path: organizationPath,
    module,
    path,
    expected_path: expectedPath,
    message,
    sources: [...new Set(sources)],
    next_action: nextAction,
  };
}
