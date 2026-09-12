const GUIDE_BASE_URL = "https://documentation.lazurio.ai";
const GUIDE_CAMPAIGN = "utm_source=launchpad&utm_medium=product&utm_campaign=guide";

export function guideDocumentationUrl(locale) {
  const language = locale === "en" ? "en" : "cs";
  return `${GUIDE_BASE_URL}/${language}/guide/?${GUIDE_CAMPAIGN}`;
}
