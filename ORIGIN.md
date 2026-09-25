# Origen

Fork de [ARCANGEL0/CyberArch-Shell](https://github.com/ARCANGEL0/CyberArch-Shell),
adaptado para NixOS + AGS v3. Todo el crédito del diseño original es de
su autor; el upstream no declara licencia.

Cambios respecto al original:
- Sacado `components/modules/markets.ts` (panel de mercados/cripto) y todas
  sus referencias en `core.ts`, `userbinds.ts`, `cmodal.ts`, `themesettings.ts`.
- `rofi` reemplazado por `wofi` como launcher (línea única en `core.ts`).
- Sacado `assets/wallpapers/` (~1.1GB de wallpapers/videos de ejemplo).
- Sacado `node_modules/` (symlinks rotos apuntando a rutas de Arch,
  `/usr/share/ags/js` etc. — no aplican en NixOS).
- Portado de la API vieja `astal` (Variable/Widget) a ags v3.1.
- Panel de shortcuts (Mod+K) que lee los binds de Hyprland en vivo,
  tooltips del dock, 3 planes de rendimiento (full/balanced/performance),
  hardening y fix de RAM del launcher.

Se usa como input `flake = false` desde
[workos](https://github.com/OscarVargas97/workos) (`home-manager/cyber-shell.nix`).
