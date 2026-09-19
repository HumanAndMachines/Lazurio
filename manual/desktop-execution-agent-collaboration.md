# Desktop execution agent collaboration

Tento manuálový záznam je součást základního balíku Konglomerátu. Popisuje,
jak mají Buddy a workspace-local AI kolegové spolupracovat s viditelnými
Claude/Codex Desktop App agenty.

Tento manuál drží zařazení do onboardingu a nepřekročitelné invarianty;
konkrétní postup volí delegující Kolega podle nich.

## Princip

Desktop execution agent není autonomní kolega ani finální autorita. Je to
viditelný exekuční parťák v konkrétním Desktop threadu. Autonomní kolega, který
práci delegoval, zůstává odpovědný za brief, ověření, reviewer routing a
closeout.

## Základní balík

Každý Buddy/AI kolega v Konglomerátu má mít tento pattern k dispozici při
onboardingu. Konkrétní profily mohou mít vlastní Claude/Codex skill, ale nesmí
porušit tyto invarianty:

- viditelný Desktop thread je auditní stopa delegace;
- shell/CLI je pro QA a source-of-truth ověření, ne skrytá náhrada práce;
- self-report není důkaz;
- reviewer dostává jen net-new reviewable diff;
- superseded PR se zavírá s důkazem, ne review requestem.
