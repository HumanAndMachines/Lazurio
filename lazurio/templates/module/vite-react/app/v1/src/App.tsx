import { greeting } from "./greeting.ts";

const TITLE = "{{display_name}}";
const MODULE = "{{slug}}";
const ORGANIZATION = "{{organization}}";

export function App() {
  return (
    <main>
      <h1>{greeting(TITLE)}</h1>
      <p>
        Modul {MODULE} Organizace {ORGANIZATION} běží podle Lazurio Module Standardu.
      </p>
    </main>
  );
}
