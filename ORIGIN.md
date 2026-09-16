# Origen

Este repo parte de [ARCANGEL0/CyberArch-Shell](https://github.com/ARCANGEL0/CyberArch-Shell)
(sin licencia declarada en origen — este fork es para uso personal/privado
de Oscar, no para redistribución).

Cambios respecto al original:
- Sacado `components/modules/markets.ts` (panel de mercados/cripto) y todas
  sus referencias en `core.ts`, `userbinds.ts`, `cmodal.ts`, `themesettings.ts`.
- `rofi` reemplazado por `wofi` como launcher (línea única en `core.ts`).
- Sacado `assets/wallpapers/` (~1.1GB de wallpapers/videos de ejemplo) — se
  usa el wallpaper propio del setup en su lugar.
- Sacado `node_modules/` (symlinks rotos apuntando a rutas de Arch,
  `/usr/share/ags/js` etc. — no aplican en NixOS).

Adaptado para NixOS/Nix flakes en `OscarMynu/nixos-config`.
