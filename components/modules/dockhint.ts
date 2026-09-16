// Leyenda fija junto al dock (pedido de Oscar): los badges de una sola
// letra en dock.ts (drawBadgeBox) no dicen con qué modificador van -
// todos los toggles del dock usan SUPER+SHIFT+letra (ver hyprland.nix),
// pero eso no se ve a simple vista en un cuadradito pensado para un solo
// carácter. En vez de meter el combo completo adentro de cada badge (se
// vería roto, el cuadradito es chico a propósito), un solo texto fijo
// al lado de todo el dock.
import { Label } from "./widget.ts"

export const DockHint = () => {
    const l = Label({ label: "Dock: SUPER+SHIFT + letra", className: "dockhint-label" })
    return l
}
