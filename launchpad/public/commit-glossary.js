// Locale-neutral glossary for reliable commit metadata (CAC-0095).
//
// **Proč slovník a ne překladač.** Launchpad běží lokálně a offline, žádný
// jazykový model v něm není. Obecnou anglickou větu proto přeložit neumí.
// Co ale umí: commit messages v tomhle workspace mají skoro vždy tvar
// `Oblast: sloveso objekt` („Website: Improve mobile product carousel")
// a sloveso je z malé uzavřené množiny.
//
// **Překládá se sloveso, ne objekt — a je to měřené rozhodnutí.**
// Slovník celých frází („official logo usage" → „pravidel pro používání
// loga") jsme zkusili a na 410 skutečných commitech tohohle workspace trefil
// 9 z nich. Objekty jsou totiž skoro vždy vlastní jména produktů, značek
// a zákazníků („Example Organization mobile app guidance", „Example Customer portable
// lamps supplier baseline"), a ta se nepřekládají ani přeložit nemají.
// Sloveso naproti tomu sedí u 215 ze 410 — a nese to podstatné: *co se
// stalo*. Ukazuje se proto jako štítek nad původní větou autora, ne jako
// polovičatě přeložená věta.

// Sloveso → české slovesné podstatné jméno. Podstatné jméno schválně:
// vyhne se shodě v rodě („přidal" vs „přidala") u actora, kterého stejně
// jmenuje řádek nad shrnutím.
export const VERBS = {
  add: "addition", adds: "addition", added: "addition",
  introduce: "introduction", establish: "introduction",
  create: "creation",
  register: "registration",
  remove: "removal", removed: "removal", delete: "removal", drop: "removal",
  fix: "fix", fixes: "fix", fixed: "fix", repair: "fix",
  update: "update", refresh: "update",
  upgrade: "upgrade",
  improve: "improvement", refine: "improvement", enhance: "improvement", polish: "improvement",
  standardize: "standardization", normalize: "standardization", unify: "standardization", align: "standardization",
  codify: "recording", record: "recording", document: "recording",
  clarify: "clarification",
  rename: "renaming",
  separate: "separation",
  split: "split",
  restore: "restoration",
  stabilize: "hardening", harden: "hardening",
  bound: "scoping", scope: "scoping", limit: "scoping",
  install: "installation",
  adjust: "adjustment",
  mark: "marking",
  archive: "archiving",
  expand: "expansion",
  apply: "application",
  propose: "proposal", draft: "proposal",
  reconcile: "reconciliation",
  rotate: "rotation",
  migrate: "migration",
  prepare: "preparation",
};

// Název složky → lidské téma. Většina složek v tomhle workspace je pojmenovaná
// srozumitelně a často rovnou česky (`logo`, `diagramy`, `socialni-site`),
// takže se jen rozdělí pomlčky a doplní diakritika u těch, kde chybí. Anglické
// technické názvy dostanou český protějšek. Co tu není, se ukáže tak, jak se
// složka jmenuje — na rozdíl od anglické věty je to pořád srozumitelné slovo.
export const TOPIC_LABELS = {
  "socialni-site": "socialMedia",
  pozicovani: "positioning",
  diagramy: "diagramy",
  logo: "logo",
  brand: "brand",
  colors: "colors",
  fonts: "fonts",
  typografie: "typography",
  tokens: "tokens",
  hlas: "voiceTone",
  stav: "status",
  invoices: "invoices",
  deals: "deals",
  warehouse: "warehouse",
  knowledgebase: "knowledgebase",
  website: "website",
  workflows: "workflows",
  migrations: "migrations",
  decisions: "decisions",
};
