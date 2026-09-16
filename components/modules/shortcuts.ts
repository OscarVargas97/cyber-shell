// Panel de shortcuts (Mod+K) - pedido de Oscar mientras aprende
// Hyprland/Wayland: lista TODOS los binds registrados, siempre
// actualizada porque se lee de `hyprctl binds -j` en vivo cada vez que
// se abre (no una copia separada que se puede desincronizar de
// hyprland.nix). Empieza oculto, layer TOP siempre que esta visible
// (por encima de las ventanas).
import { Window, Box, Label, Scrollable, Layer, Anchor, Exclusivity } from "./widget.ts"
import { execAsync } from "ags/process"
import Gtk from "gi://Gtk?version=3.0"

const MOD_BITS: Array<[number, string]> = [
    [64, "SUPER"], [8, "ALT"], [4, "CTRL"], [1, "SHIFT"],
]
const modmaskToStr = (mask: number): string =>
    MOD_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name).join(" + ")

let win: any = null
let list: any = null
let visible = false

const row = (text: string) => {
    const l = Label({ label: text, className: "shortcut-row" })
    l.set_halign(Gtk.Align.START)
    return l
}

const refresh = async () => {
    if (!list) return
    for (const child of list.get_children()) list.remove(child)
    try {
        const out = await execAsync(["hyprctl", "binds", "-j"])
        const binds = (JSON.parse(out) as any[]).filter((b) => !b.mouse)
        if (binds.length === 0) {
            list.add(row("(sin binds registrados)"))
        } else {
            for (const b of binds) {
                const mod = modmaskToStr(b.modmask || 0)
                const combo = [mod, b.key].filter(Boolean).join(" + ") || "(sin tecla)"
                const action = [b.dispatcher, b.arg].filter(Boolean).join(" ")
                list.add(row(`${combo.padEnd(24)} ${action}`))
            }
        }
    } catch (e) {
        list.add(row(`error leyendo hyprctl binds: ${e}`))
    }
    list.show_all()
}

export const ShortcutsWindow = () => {
    list = Box({ className: "shortcuts-list" })
    list.set_orientation(Gtk.Orientation.VERTICAL)

    const scroll = Scrollable({ child: list })
    scroll.set_size_request(620, 640)
    scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

    const title = Label({ label: "◤ SHORTCUTS (Mod+K para cerrar) ◢", className: "shortcuts-title" })
    title.set_halign(Gtk.Align.START)

    const inner = Box({ className: "shortcuts-wrap", children: [title, scroll] })
    inner.set_orientation(Gtk.Orientation.VERTICAL)
    inner.set_halign(Gtk.Align.CENTER)
    inner.set_valign(Gtk.Align.CENTER)

    win = Window({
        name: "shortcuts",
        className: "aug shortcuts",
        anchor: Anchor.TOP | Anchor.LEFT | Anchor.BOTTOM | Anchor.RIGHT,
        exclusivity: Exclusivity.IGNORE,
        layer: Layer.TOP,
        visible: false,
        child: inner,
    })
    return win
}

export const toggleShortcuts = () => {
    if (!win) return
    visible = !visible
    if (visible) { refresh(); win.show() } else { win.hide() }
}
