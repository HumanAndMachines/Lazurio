# {{display_name}}

Modul `{{slug}}` Organizace `{{organization}}` bez App
(`tcp_port_policy: none`, `apps: []`). Launchpad ho ukáže v katalogu a nic
nespouští. Obsah (dokumenty, data, konfigurace) patří přímo do tohoto
repozitáře.

Když Modul později dostane App, vznikne v `app/v1/` podle Lazurio Module
Standardu: lease z poolu Organizace v `lazurio.module.json`, `apps[]` a
`default_app`, a `lazurio module setup` musí vrátit `current`.

## Ověření

```sh
lazurio module setup <cesta k Modulu> --root <Lazurio root> --json
```
