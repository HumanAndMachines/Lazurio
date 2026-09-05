import { expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";

const publicRoot = join(import.meta.dirname, "..", "public");
const schemasRoot = join(import.meta.dirname, "..", "..", "lazurio", "schemas");

test("Launchpad renderuje personalspace jako vlastní sekci v hlavní ploše (ne rail) přes oddělenou lane", async () => {
  const [html, appJs, appStateJs] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
    readFile(join(publicRoot, "app-state.js"), "utf8"),
  ]);

  // Personalspace už NENÍ nacpaný v úzkém railu — je to vlastní vizuálně
  // odlišená sekce v hlavní ploše (nad workspace/productionspace).
  expect(html).not.toContain('id="personalspaceRail"');
  expect(appJs).toContain("function personalspaceSectionNode");
  expect(appJs).toContain('"app-section app-section-personalspace"');
  expect(appJs).toContain('id = "personalspaceSectionBody"');
  // Header selector (Osobní / Organizace) filtruje hlavní plochu na daný prostor.
  expect(appJs).toContain("function renderSpaceSwitcher");
  expect(appJs).toContain('state.filters.scope = "personal"');
  expect(appJs).toContain('scope: "org"');
  expect(appJs).toContain("function personalspaceScopeAvailable");
  expect(appJs).toContain("if (state.personalspace) {");
  expect(appJs).toContain("data.ok === true");
  // Personalspace se čte z vlastního endpointu, ne z /api/apps.
  expect(appJs).toContain('fetchJson("/api/personalspace")');
  // Transportní selhání nesmí shodit org povrch. Úspěšný HTTP payload je ale
  // autorita i při ok:false, aby se odebraný soukromý prostor nevracel ze stale
  // klientské cache.
  expect(appJs).toContain("fetchPersonalspaceSafe()");
  expect(appStateJs).toContain("export function replacePersonalspaceResponse");
  expect(appJs).toContain("replacePersonalspaceResponse(state.personalspace, personalspaceResponse.data)");
  expect(appJs).not.toContain("mergePersonalspaceResponse");
  expect(appJs).toContain("if (personalspaceResponse.ok)");
  expect(appJs).toContain("state.personalspaceError = personalspaceResponse.error");
  expect(appJs).toContain("state.personalspaceError = personalspaceResponse.error");
  // Renderer jde z odděleného personalspace modulu.
  expect(appJs).toContain("renderPersonalspace");
  // Hero musí počítat stav aktivního osobního prostoru z jeho aplikací; prázdný
  // org filtr nesmí falešně tvrdit, že je vše připravené.
  expect(appJs).toContain("renderHero(heroApps, spaceHealth)");
  expect(appJs).toContain("function activeSpaceApps");
  expect(appJs).toContain("function heroDiagnostics");
  expect(appJs).toContain("state.personalspace?.spaces");
  expect(appJs).toContain("state.personalspace?.failures");
  expect(appJs).toContain("state.personalspace?.warnings");
  // Sdílený rail filtrů už neexistuje. V osobním scope se skrývá jen toolbar
  // aplikací; attention CTA proto vede přímo na osobní karty s warning panely.
  expect(appJs).toContain("function renderScopeControls");
  expect(appJs).toContain('elements.hero.classList.toggle("hidden", personal || guide)');
  expect(html).toContain('id="personalPrivacyBadge"');
  expect(appJs).toContain('elements.personalPrivacyBadge?.toggleAttribute("hidden", !personal || guide)');
  expect(appJs).not.toContain("filterRail");
  expect(appJs).toContain('elements.appsToolbar.classList.toggle("hidden", personal || guide)');
  expect(appJs).toContain('elements.drawerToggle.classList.toggle("hidden", personal || guide)');
  expect(appJs).toContain('elements.recentChangesSidebar.classList.toggle("hidden", personal || guide)');
  expect(appJs).toContain('if (state.filters.scope === "personal")');
  expect(appJs).toContain('Boolean(state.personalspace)');
});

test("personalspace.js renderuje Principálův prostor, lokalizovaný privacy badge a runtime akce oddělenou lane", async () => {
  const js = await readFile(join(publicRoot, "personalspace.js"), "utf8");

  expect(js).toContain("export function renderPersonalspace");
  expect(js).toContain("function spaceBlock");
  expect(js).toContain("function personalAppCard");
  // Dlaždice jdou do stejné `.apps-grid` mřížky jako workspace sekce.
  expect(js).toContain("apps-grid personalspace-apps-grid");
  // Runtime propouští pouze Principálův prostor.
  expect(js).toContain("is_owner_primary");
  expect(js).not.toContain("personalspace-owner-badge");
  // Soukromí je lokalizované a jako stav s ikonou i slovem.
  expect(js).toContain("personalspace-private-badge");
  expect(js).toContain('statusBadge(t("common.private")');
  expect(js).toContain('private: \'<path d="M7 11h10v9H7z"');
  // Runtime akce přes oddělenou personalspace lane: one-click open (start &
  // otevři) klikem na dlaždici + zastavit/restart pod ⋯ menu.
  expect(js).toContain("/api/personalspace/apps/");
  expect(js).toContain("function openPersonalApp");
  expect(js).toContain("personalRuntimeMutationOptions()");
  expect(js).toContain('body: JSON.stringify({ source: { type: "main" } })');
  expect(js).toContain('from "./reserved-tab-status.js"');
  expect(js).toContain("writeReservedTabStatus(reservedTab");
  expect(js).toContain("function waitForPersonalRuntime");
  expect(js).toContain("/health");
  expect(js).toContain('t("personal.urlMissing")');
  expect(js).toContain("function classifyPersonalOpenError");
  expect(js).toContain('"eaddrinuse"');
  expect(js).toContain('"stop"');
  expect(js).toContain('"restart"');
  // missing_access / planned_slot sloty z historického multi-space UI.
  expect(js).toContain("missing_access");
  expect(js).toContain("planned_slot");
});

test("Personalspace je owner-first, Buddy je volitelný a technické údaje jsou až po rozbalení", async () => {
  const [js, css] = await Promise.all([
    readFile(join(publicRoot, "personalspace.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
  ]);

  expect(js).toContain("function buddyCard");
  expect(js).toContain("function recurringTasksCard");
  expect(js).toContain("function telegramIcon");
  expect(js).toContain('t("buddy.recurringTasks")');
  expect(js).toContain('t("buddy.usesApp")');
  expect(js).toContain('t("buddy.configured")');
  expect(js).toContain("function noBuddyCard");
  expect(js).toContain('t("personal.ready.title")');
  expect(js).toContain('t("personal.ready.message")');
  expect(js).toContain('t("personal.notCreated.title")');
  expect(js).toContain('t("personal.memory.title")');
  expect(js).toContain('statusBadge(t("common.configured"), "buddy-application-state", "success")');
  expect(js).not.toContain("image.src = avatarUrl");
  expect(js).toContain('t("personal.apps.title")');
  expect(js).toContain('t("common.technicalInformation")');
  expect(js).toContain("function safeExternalUrl");
  expect(js).toContain("technicalOpen: new Set()");
  expect(js).toContain("function bindTechnicalDetails");
  expect(js).toContain("details.open = state.technicalOpen.has(spaceKey)");
  expect(js).toContain('t("personal.apps.title")');
  expect(js).toContain("function personalspaceErrorState");
  expect(js).toContain('t("personal.loadFailed.title")');
  expect(js).not.toContain('textContent = "Demo Buddy"');
  expect(css).toContain(".personalspace-overview");
  expect(css).toContain(".privacy-pill");
  expect(css).toContain(".buddy-card");
  expect(css).toContain(".buddy-routines");
  expect(css).toContain(".personalspace-technical");
  expect(css).toContain("@media (max-width: 680px)");
  expect(css).toContain(".layout.is-personal .problems-panel:not(.hidden)");
  expect(js).not.toContain("gbrainBrowsable");
  expect(js).toContain("if (!activeSpaceNames.has(spaceName)) state.gbrain.delete(spaceName)");
  const buddyCardStart = js.indexOf("function buddyCard");
  const buddyCardEnd = js.indexOf("function recurringTasksCard", buddyCardStart);
  const buddyCardSource = js.slice(buddyCardStart, buddyCardEnd);
  expect(buddyCardSource).not.toContain("/api/personalspace/apps/");
  expect(buddyCardSource).not.toContain('method: "POST"');
  expect(buddyCardSource).not.toContain('"start"');
  expect(buddyCardSource).not.toContain('"stop"');
  expect(buddyCardSource).not.toContain('"restart"');
});

test("personalspace.js má gbrain sekci: Obsidian deep link + read-only browser (strom/note/fulltext)", async () => {
  const js = await readFile(join(publicRoot, "personalspace.js"), "utf8");

  // Obsidian deep link.
  expect(js).toContain('t("gbrain.openObsidian")');
  expect(js).toContain("obsidian://open");
  expect(js).toContain("function obsidianDeepLink");
  // Fallback text pro nezaregistrovaný vault.
  expect(js).toContain('t("gbrain.pathHint"');
  // Read-only browser: strom, náhled zápisu, fulltext.
  expect(js).toContain("/gbrain/tree");
  expect(js).toContain("/gbrain/note");
  expect(js).toContain("/gbrain/search");
  expect(js).toContain("function renderMarkdown");
  // gbrain se defaultně nesdílí — UI to říká.
  expect(js).toContain('t("gbrain.private")');
});

test("personalspace.js markdown render neinjektuje raw HTML z obsahu vaultu", async () => {
  const js = await readFile(join(publicRoot, "personalspace.js"), "utf8");
  // Obsah se nejdřív escapuje (žádný raw HTML z vaultu do DOM).
  expect(js).toContain('.replace(/&/g, "&amp;")');
  expect(js).toContain('.replace(/</g, "&lt;")');
  // Odkazy z obsahu se renderují jen jako text (žádné klikací URL z vaultu).
  expect(js).toContain("žádné klikací odkazy z obsahu vaultu");
});

test("styles.css nese personalspace section + private treatment + drawer styly", async () => {
  const css = await readFile(join(publicRoot, "styles.css"), "utf8");
  // Vlastní vizuálně odlišená sekce v hlavní ploše (private treatment).
  expect(css).toContain(".app-section-personalspace");
  expect(css).toContain(".personalspace-space-block");
  expect(css).toContain(".personalspace-private-badge");
  expect(css).not.toContain(".personalspace-owner-badge");
  expect(css).toContain(".personalspace-gbrain");
  expect(css).toContain(".personalspace-gbrain-browser");
  // Osobní logo v header selectoru + skládací drawer pravých panelů (3-col layout).
  expect(css).toContain(".space-logo-personal");
  expect(css).toContain(".detail-drawer");
});

test("kanonická Personalspace schema kopie zůstává base kontraktem s privátními consts", async () => {
  const schema = JSON.parse(await readFile(join(schemasRoot, "personal.gen3.schema.json"), "utf8"));
  expect(schema.$comment).toBeUndefined();
  expect(schema.$id).toBe("https://rozjedeme.ai/schemas/personal.gen3.schema.json");
  expect(schema.required).toContain("schema_version");
  expect(schema.properties.schema_version.const).toBe("humanandmachines.personal.gen3.v1");
  // Tvrdá privátní hranice v kontraktu.
  expect(schema.properties.privacy.properties.shared_outputs.const).toBe("metadata-only");
  expect(schema.properties.repository.properties.visibility.const).toBe("private");
  expect(schema.properties.gbrain.properties.default_shared.const).toBe(false);
  expect(schema.properties.shared_spaces.maxItems).toBe(0);
  expect(schema.properties.gbrain.properties.agent_access.const).toBe("mcp-only");
  expect(schema.properties.buddy.properties.display_name).toBeUndefined();
  expect(schema.properties.buddy.properties.runtime.required).toContain("deployment_target");
  expect(schema.properties.buddy.properties.runtime.required).toContain("local_execution");
  expect(schema.properties.buddy.properties.runtime.properties.deployment_target.const)
    .toBe("owner-dedicated-personalspace-vps");
  expect(schema.properties.buddy.properties.runtime.properties.local_execution.const).toBe("forbidden");
  // Identity invariant stavební kameny (patterny na repo/mount).
  expect(schema.properties.repository.properties.github_repo.pattern).toContain("_GEN3");
  expect(schema.properties.repository.properties.mount_path.pattern).toContain("personalspace/");
});

test("Buddy presentation overlay je oddělený neautoritativní draft", async () => {
  const schema = JSON.parse(await readFile(join(schemasRoot, "personal-buddy-presentation.draft.schema.json"), "utf8"));
  expect(schema.$comment).toContain("Nesmí rozhodovat o validitě personal.gen3.json");
  expect(schema.$id).toContain("personal-buddy-presentation.draft.schema.json");
  expect(schema.properties.application.properties.type.enum).toContain("telegram");
  const mapShape = schema.properties.recurring_tasks.anyOf.find((shape) => shape.type === "object");
  const arrayShape = schema.properties.recurring_tasks.anyOf.find((shape) => shape.type === "array");
  expect(mapShape.additionalProperties.required).toContain("schedule_label");
  expect(mapShape.propertyNames.pattern).toContain("[a-z0-9]");
  expect(arrayShape.items.required).toContain("id");
});

test("Personalspace dlaždice je GEN2-minimal (port GEN2-minimal karty): tile-first, jeden chip, ⋯ menu, warning panel", async () => {
  const [js, css, server] = await Promise.all([
    readFile(join(publicRoot, "personalspace.js"), "utf8"),
    readFile(join(publicRoot, "styles.css"), "utf8"),
    readFile(join(import.meta.dirname, "server.mjs"), "utf8"),
  ]);

  // Žádná velká trvalá tlačítka ani sekundární akční řádek — dlaždice se otevírá
  // klikem na plochu (one-click open chain přes personalspace lane).
  expect(js).not.toContain("function primaryActionNode");
  expect(js).not.toContain("function secondaryActionNodes");
  expect(js).not.toContain("personalspace-app-actions");
  expect(js).toContain("function openPersonalApp");
  expect(js).toContain("function shouldOpenFromCardSurface");
  expect(js).toContain("function isOpenable");
  expect(js).toContain("openingMessages");
  expect(js).toContain('t("personal.healthTimeout")');

  // Personalspace je také rozcestník: běžný runtime stav na dlaždici nepíšeme;
  // trvalý „Připraveno" chip (dependencyChip) je rovněž pryč.
  expect(js).not.toContain("function dependencyChip");
  const personalCard = js.slice(js.indexOf("function personalAppCard"), js.indexOf("function personalCardWarningModel"));
  expect(personalCard).not.toContain("runtimeChip(app)");

  // Sofistikovaný warning panel se ukáže jen když je co řešit (null jinak);
  // reuse .card-warning* patternů z GEN2-minimal karty.
  expect(js).toContain("function personalCardWarningModel");
  expect(js).toContain("function cardWarningNode");
  expect(js).toContain("if (warning) card.append(cardWarningNode(app, warning))");
  expect(js).toContain("appTone(app, warning)");
  // Stejný recovery model jako Organization: přímý Install/Repair jen s
  // capability, jinak konkrétní Codex handoff. Boundary blokuje i healthy URL.
  expect(js).toContain('import { runtimeRecoveryForApp } from "./runtime-recovery.js"');
  expect(js).toContain("function personalRuntimeRecovery");
  expect(js).toContain("runtimeRecoveryForApp(app)");
  expect(js).toContain("openCodexRuntimeIssueDialog(app, recovery)");
  expect(js).toContain('["install", "repair"].includes(recovery.action)');
  const openable = js.slice(js.indexOf("function isOpenable"), js.indexOf("function personalAppDescription"));
  expect(openable).toContain("personalRuntimeRecovery(app)");
  const tone = js.slice(js.indexOf("function appTone"), js.indexOf("function runtimeChip"));
  expect(tone.indexOf('warning?.tone === "danger"')).toBeLessThan(tone.indexOf('app.runtime_status === "healthy"'));

  // Sekundární akce (zastavit/restart/logy) žijí pod ⋯ menu, které se ukáže jen
  // když má obsah — reuse .app-version-menu / .app-menu-action z GEN2-minimal karty.
  expect(js).toContain("function personalMenuNode");
  expect(js).toContain("function personalMenuActions");
  expect(js).toContain("function menuActionRow");
  expect(js).toContain('trigger.className = `app-more-button');
  expect(js).toContain('trigger.setAttribute("aria-expanded", String(isOpen))');
  expect(js).toContain('trigger.dataset.menuFocusKey = app.id');
  expect(js).toContain("focusMenuTriggerAfterRender(document, app.id)");
  expect(js).toContain('if (menu?.panel) card.append(menu.panel)');
  expect(js).toContain('button.className = "app-menu-action";');
  const personalMenuActions = js.slice(js.indexOf("function personalMenuActions"), js.indexOf("function menuActionRow"));
  expect(personalMenuActions).toContain('["healthy", "unhealthy"].includes(app.runtime_status)');
  expect(personalMenuActions).toContain('label: t("common.logs")');
  expect(js).toContain("openCodexRuntimeIssueDialog(app, recovery)");

  // Ikona aplikace zůstává; duplicitní ↗ cue už karta nepotřebuje.
  expect(js).toContain("function personalAppIconNode");
  expect(js).not.toContain('cue.className = "app-open-cue";');

  // Lokalizovaný badge s ikonou zůstává — privátní hranice se nikdy nesmí splést s firemní.
  expect(js).toContain('statusBadge(t("common.private")');

  // CSS: nové dlaždicové třídy + reuse sdílených warning/menu tříd z GEN2-minimal karty.
  expect(css).toContain(".personalspace-app.is-openable");
  expect(css).toContain(".personalspace-app-icon");
  expect(css).toContain(".personalspace-app-title-row");
  expect(css).toContain(".personalspace-app-desc");
  expect(css).toContain(".personalspace-app-top-actions");
  expect(css).not.toContain(".app-open-cue");
  expect(css).toContain(".card-warning");
  expect(css).toContain(".app-menu-action");

  // Server: personalspace lane má /open chain (ensure install → start → wait
  // healthy → URL) oddělený od firemního manageru.
  expect(server).toContain("personalspaceRuntimeManager.open(route.appId, runtimeOptions)");
  expect(server).toContain('route.action === "health" && (request.method === "GET" || request.method === "POST")');
  expect(server).toContain("restart|logs|open");
});
