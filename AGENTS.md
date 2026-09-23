# AGENTS.md — cyber-shell

Contexto para agentes de IA. Guía para humanos: [`README.md`](./README.md).

## Qué es

HUD/barra de escritorio para Hyprland en TypeScript sobre **AGS v3 /
Astal (GTK3)**. Fork de ARCANGEL0/CyberArch-Shell adaptado a NixOS;
cambios documentados en [`ORIGIN.md`](./ORIGIN.md).

No es un paquete Nix ni tiene `flake.nix`: lo consume
[workos](https://github.com/OscarVargas97/workos) como input
`cyberShell` con `flake = false`, y `workos/home-manager/cyber-shell.nix`:

- arma el wrapper `cyber-shell` = `ags run --gtk 3 <este repo>/core.ts`,
  con `GI_TYPELIB_PATH` para AstalNotifd/Mpris/Wp y el schema de notifd;
- instala `assets/fonts` en `~/.local/share/fonts/cyberarch`;
- agrega `ags`, `sassc`, `python3` y Nerd Fonts al PATH.

Hyprland lo arranca; los binds de `workos/home-manager/hyprland.nix`
le hablan por `ags request -i cyberpunk <comando>` (ej. `perf full`,
`shortcuts`, `notif-dismiss`).

## Mapa

| Ruta | Qué es |
|---|---|
| `core.ts` | Entrada: ventanas, paneles, handler de `ags request` |
| `components/modules/config.ts` | Config en runtime y los 3 planes de rendimiento |
| `components/modules/{dock,appsmenu,shortcuts,notifmessages,cmodal,sidepanel}.ts` | Widgets/paneles |
| `components/style/` | SCSS → CSS con `sassc` |
| `config/city.json` | Ubicación del clima (default del upstream) |
| `install.sh`, `updater.sh`, `components/login/` | Del upstream para Arch — **no se usan en NixOS** |

## Reglas

1. Sin datos personales (nombres, ubicación real, cuentas) en código,
   comentarios ni config: es un repo público.
2. API de AGS v3 / Gnim, no la vieja `astal` (Variable/Widget) del upstream.
3. Cambios de binds: los atajos viven en `workos/home-manager/hyprland.nix`;
   acá solo el comando que responde a `ags request`.
4. Cuidar el consumo: los loops de redibujado respetan el plan de
   rendimiento de `config.ts`; nada de timers sin límite.

## Probar un cambio

- En vivo, en una sesión de workos: `pkill -f "ags run"; CYBER_SHELL_DIR=$PWD cyber-shell &`
- Como lo instala Nix, desde el repo privado:
  `sudo nixos-rebuild test --flake .#$(hostname) --override-input workos/cyberShell git+file://$PWD`
- Publicar: commit + push acá; después
  en `workos`: `nix flake update cyberShell`, commit + push; en el repo
  privado: `scripts/check.sh --lock`, commit y `rebuild`.
