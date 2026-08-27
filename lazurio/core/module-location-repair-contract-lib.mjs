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
  foundPath = null,
  expectedPath = null,
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
- Nalezená cesta: ${foundPath ?? "ověří CLI"}
- Kanonická cesta: ${expectedPath ?? "ověří CLI z Organization manifestu"}
- Detail: ${diagnostic}
- Bezpečný ověřovací příkaz: ${command}

Postupuj prosím takto:
1. Pracuj v Lazurio rootu na této mašině. Nejdřív spusť přesně uvedený ověřovací příkaz bez \`--apply\`. Tento krok smí jen najít jednoznačný checkout, ověřit Git stav, lokální origin, manifestovaný cílový remote a kompatibilitu historie a vrátit plán s fingerprintem.
2. Pokud výsledek není \`ready\`, nic ručně nepřesouvej, neměň origin a nemaž žádná data. Vysvětli konkrétní blokaci a bezpečný další krok.
3. Pokud je výsledek \`ready\`, zkontroluj, že plán míří na správnou Organizaci, stabilní ID modulu, zdrojovou i cílovou cestu a nový GitHub remote. Potom spusť pouze CLI příkaz s \`--apply --expect <fingerprint>\`, který vrátil ověřovací krok. Nevymýšlej fingerprint ani vlastní pořadí Git operací.
4. CLI musí před změnou celý stav znovu ověřit pod update lockem. Když se fingerprint změnil, vrať se k ověřovacímu kroku; neobcházej guardy.
5. Po úspěšné opravě spusť \`lazurio update\` a ověř v Launchpadu, že modul i zdravé sousední moduly mají pravdivý stav.

Hranice úkolu: zachovej veškerá lokální Git data. Nedělej reset, rebase, merge, push, force, ruční mazání ani automatické rozhodnutí nad dirty, ahead/diverged, detached, probíhající Git operací, nejednoznačným checkoutem, cizím remotem nebo kolizí cílové cesty. V těchto stavech má CLI bezpečně skončit a rozhodnutí zůstává Agentovi a Principálovi.`,
  };
}

export function buildModuleSlotAgentReviewAction({
  organization,
  module,
  reason,
  path,
  detail,
} = {}) {
  const command = moduleLocationRepairCommand({ organization, module });
  if (!command || typeof reason !== "string" || typeof detail !== "string") return null;
  return {
    kind: "agent_review",
    label: "Vyřešit s Codexem",
    prompt: `Launchpad bezpečně izoloval pouze modul „${module}“ v Organizaci „${organization}“; ostatní zdravé moduly zůstávají použitelné.

Diagnostika Lazuria:
- Důvod: ${reason}
- Cesta modulu: ${path ?? "neuvedena"}
- Detail: ${detail}

Postupuj jako Task Agent fail-closed: ověř Organization manifesty a skutečný lokální checkout, zachovej všechna Git data a oprav přirozený source kontrakt v Organization PR. Nevytvářej duplicitní clone, nemaž adresář, nepřepisuj dirty práci a nehádej chybějící identitu, remote, Team ani oprávnění. Po bezpečné opravě spusť \`lazurio update\` a ověř, že tento modul přestal být blokovaný a zdravé sourozence změna neovlivnila. Příkaz \`${command}\` použij pouze tehdy, pokud diagnostika skutečně přejde na jednoznačný repository-location problém; jinak se řiď konkrétním blockerem a nic neaplikuj odhadem.`,
  };
}

export function buildSlotPathAgentReviewAction({
  organization,
  reason,
  path,
  detail,
} = {}) {
  if (
    !organizationSelectorPattern.test(String(organization ?? ""))
    || typeof path !== "string"
    || path.trim() === ""
    || typeof reason !== "string"
    || typeof detail !== "string"
  ) return null;
  return {
    kind: "agent_review",
    label: "Vyřešit s Codexem",
    prompt: `Launchpad bezpečně izoloval pouze deklarovaný slot „${path}“ v Organizaci „${organization}“; ostatní zdravé moduly zůstávají použitelné. Slot zatím nemá bezpečnou stabilní module identitu, proto nelze autorizovat automatickou relokaci.

Diagnostika Lazuria:
- Důvod: ${reason}
- Cesta slotu: ${path}
- Detail: ${detail}

Postupuj jako Task Agent fail-closed: oprav stabilní identitu a kanonickou cestu v přirozeném Organization source kontraktu. Nehádej module slug, nepřesouvej checkout, nevytvářej duplicitní clone, nemaž adresář a nepřepisuj dirty práci. Po reviewované opravě spusť \`lazurio update\` a ověř, že právě tento slot přestal být blokovaný a zdravé sourozence změna neovlivnila.`,
  };
}

export function buildOrganizationAgentReviewAction({
  organization,
  reason,
  path = null,
  detail,
} = {}) {
  if (
    !organizationSelectorPattern.test(String(organization ?? ""))
    || typeof reason !== "string"
    || typeof detail !== "string"
  ) return null;
  return {
    kind: "agent_review",
    label: "Vyřešit s Codexem",
    prompt: `Launchpad bezpečně zastavil podřízené moduly Organizace „${organization}“, protože její identitu, manifest nebo filesystem hranici nelze spolehlivě určit. Ostatní zdravé Organizace zůstávají použitelné.

Diagnostika Lazuria:
- Důvod: ${reason}
- Cesta Organizace: ${path ?? "neuvedena"}
- Detail: ${detail}

Postupuj jako Task Agent fail-closed: nejdřív ověř company.gen3.json, modules.manifest.json a skutečnou Organization boundary. Zachovej všechna lokální Git data a oprav přirozený source kontrakt v odpovídajícím Organization PR. Nehádej identitu, nepřesouvej cizí checkout, nevytvářej duplicitní clone, nemaž adresáře a nepřepisuj dirty práci. Jakmile je Organization kontrakt jednoznačný, spusť \`lazurio update\` a znovu ověř Launchpad; konkrétní module-location opravu řeš až z jeho vlastní jednoznačné diagnostiky.`,
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
        foundPath: path,
        expectedPath,
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
