/** The heading of the App; a pure function so it has a unit test. */
export function greeting(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "Ahoj" : `Ahoj, ${trimmed}`;
}
