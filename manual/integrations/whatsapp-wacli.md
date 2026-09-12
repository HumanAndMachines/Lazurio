# Osobní WhatsApp přes wacli

Volitelná lokální CLI cesta, nikoli oficiální WhatsApp Business API ani
povinná součást instalace Lazuria. [wacli](https://github.com/openclaw/wacli)
je neoficiální klient; Principál musí přijmout riziko změn protokolu,
obnovování relace a dostupnosti historie. Lazurio neudržuje jeho fork.

## Instalace a custody

Použij upstream release pro daný systém, ověř jeho kontrolní součet a
zaznamenej skutečnou verzi. Pilot na macOS ověřil `0.18.1`; není to tvrzení
o nejnovější verzi ani automatický pokyn aktualizovat jiné Mašiny.
Příkazy a volby kontroluj proti `wacli --help` a `wacli auth --help`.

Store obsahuje relaci i osobní zprávy. Zvol explicitní ignorovanou cestu
podle [secret custody](../security/local-secret-custody.md), s privátními
právy. Neukládej jej do worktree, veřejného repa ani sdílených diagnostik.
Přihlašuj jen účet určený pro tuto Mašinu; stejné session soubory nekopíruj
na další stroje.

## Párování: zobraz QR jako skutečný obrázek

V macOS pilotu nešel spolehlivě naskenovat terminálový QR, zatímco čistý PNG
v Náhledu fungoval. Agent proto připraví **obrázek**, ne screenshot znaků
terminálu. QR musí vzniknout přesným zakódováním payloadu, nikdy generativní
úpravou obrázku.

1. Párovací příkaz `wacli --store <privatni-cesta> auth --qr-format text`
   spouštěj **jen přes lokální renderovací helper**, který zachytí stdout
   i stderr do privátních pipes a nikdy je nepřepošle do výstupu harnessu,
   logu či chatu. Payload zpracuje přímo v paměti. Nespouštěj tento příkaz
   přímo v logovaném agentním terminálu. Stejný proces ponech běžet po celou
   dobu souhlasu a prvního syncu; helper smí hlásit pouze bezpečný stav.
2. U verze ověřené v pilotu výstup obsahoval
   `https://wa.me/settings/linked_devices#<payload>`: do QR zakóduj jen
   `<payload>` za tímto přesným prefixem, bez dalších úprav a bez vypsání do
   chatu či logu. Pokud se formát změnil, ověř upstream; nehádej obsah QR.
3. Použij lokální QR encoder. Ověřený render byl Python `qrcode` s
   `box_size=10`, `border=4`, černými moduly a bílým pozadím. Zachovej celý
   světlý okraj, bez ořezu a rozmazaného škálování. Potřebnou závislost
   instaluj jen v rozsahu schváleného instalačního mandátu.
4. PNG ulož do dočasného privátního adresáře mimo Git a na macOS otevři
   v Náhledu. Jakmile proces vydá nový payload, obnov obrázek: starý QR
   expiruje. Neukládej ani nezobrazuj historii starých kódů.
5. Principál na telefonu otevře WhatsApp → Nastavení → Propojená zařízení
   → Propojit zařízení a naskenuje QR. Agent nevyžaduje heslo ani PIN v chatu.
6. Po úspěchu zavři náhled a odstraň přesně dočasný QR obrázek i případný
   soubor s payloadem; nesmaž přitom store nebo přihlášení.

Tento postup je návod pro asistované párování, ne nový trvale běžící
Lazurio bridge. Macový Náhled není požadavek na jiné operační systémy.

## Ověření a používání

Z nového procesu ověř `wacli --store <privatni-cesta> --json auth status`
a `wacli --store <privatni-cesta> --read-only --json chats list`.
Do důkazu zapisuj pouze úspěch/stav, ne telefonní čísla, jména ani zprávy.
Tím se prokáže uložená relace a čtení lokálního seznamu, nikoli úplná historie
nebo nepřetržitá synchronizace. Pro čerstvost ověř stav syncu podle upstreamu.

Odesílání vyžaduje mandát, ověřeného příjemce a konkrétní text. Samotné
párování neautorizuje testovací zprávu. Nástroj si agent volá přímo jako CLI;
Composio ani další MCP prostředník nejsou pro tuto cestu potřeba.

Při vyřazení odpoj propojené zařízení také ve WhatsAppu. Pouhé smazání
lokálních souborů není důkaz revokace na straně služby.
