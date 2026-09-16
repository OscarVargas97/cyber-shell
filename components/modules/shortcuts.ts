// Panel de shortcuts (Mod+K) - pedido de Oscar mientras aprende
// Hyprland/Wayland. Todo sale de fuentes en vivo, no de una lista a mano
// que se pueda desincronizar de la config real:
//   - binds de Hyprland: `hyprctl binds -j`, categorizados por la
//     descripción "Categoría: texto" que viaja en cada bindd/bindmd de
//     hyprland.nix (ver ahí).
//   - binds de la app enfocada ahora mismo (ej: kitty): se leen de su
//     archivo de config real en disco (APP_SOURCES) - si esa config
//     cambia, el panel lo refleja solo la próxima vez que se abre.
import { Window, Box, Label, Scrollable, Layer, Anchor, Exclusivity } from "./widget.ts"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=3.0"

const MOD_BITS: Array<[number, string]> = [
    [64, "SUPER"], [8, "ALT"], [4, "CTRL"], [1, "SHIFT"],
]
const modmaskToStr = (mask: number): string =>
    MOD_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name).join(" + ")

const CATEGORY_ORDER = [
    "Aplicaciones", "Ventanas", "Ventanas (mouse)", "Workspaces", "Sistema", "Capturas", "HUD",
]

type AppSource = {
    label: string
    classMatch: RegExp
    configPath: string
    parse: (text: string) => Array<[string, string]>
}

// Para sumar otra app: agregar acá su clase de ventana (hyprctl
// activewindow -j -> .class) y cómo sacarle los binds de su config real.
const APP_SOURCES: AppSource[] = [
    {
        label: "KITTY (ventana activa)",
        classMatch: /^kitty$/i,
        configPath: `${GLib.get_home_dir()}/.config/kitty/kitty.conf`,
        parse: (text) => {
            const rows: Array<[string, string]> = []
            for (const line of text.split("\n")) {
                const m = line.trim().match(/^map\s+(\S+)\s+(.+)$/)
                if (m) rows.push([m[1], m[2]])
            }
            return rows
        },
    },
]

let win: any = null
let list: any = null
let visible = false

const rowLabel = (text: string, className: string) => {
    const l = Label({ label: text, className })
    l.set_halign(Gtk.Align.START)
    return l
}

const addCategory = (list_: any, title: string, rows: Array<[string, string]>) => {
    if (rows.length === 0) return
    list_.add(rowLabel(title, "shortcut-cat"))
    for (const [combo, action] of rows) {
        list_.add(rowLabel(`${combo.padEnd(24)} ${action}`, "shortcut-row"))
    }
}

const refresh = async () => {
    if (!list) return
    for (const child of list.get_children()) list.remove(child)

    list.add(rowLabel(
        "$mod = SUPER (tecla Windows/Cmd), se combina con ALT · CTRL · SHIFT",
        "shortcuts-legend",
    ))

    try {
        const out = await execAsync(["hyprctl", "binds", "-j"])
        const binds = JSON.parse(out) as any[]
        const byCategory = new Map<string, Array<[string, string]>>()
        for (const b of binds) {
            const mod = modmaskToStr(b.modmask || 0)
            const combo = [mod, b.key].filter(Boolean).join(" + ") || "(sin tecla)"
            let category = b.mouse ? "Ventanas (mouse)" : "General"
            let label = [b.dispatcher, b.arg].filter(Boolean).join(" ")
            const desc: string = b.description || ""
            const sep = desc.indexOf(":")
            if (sep !== -1) {
                category = desc.slice(0, sep).trim()
                label = desc.slice(sep + 1).trim()
            } else if (desc) {
                label = desc
            }
            if (!byCategory.has(category)) byCategory.set(category, [])
            byCategory.get(category)!.push([combo, label])
        }
        for (const cat of CATEGORY_ORDER) addCategory(list, cat, byCategory.get(cat) || [])
        for (const [cat, rows] of byCategory) {
            if (!CATEGORY_ORDER.includes(cat)) addCategory(list, cat, rows)
        }
    } catch (e) {
        list.add(rowLabel(`error leyendo hyprctl binds: ${e}`, "shortcut-row"))
    }

    // Si la app enfocada ahora mismo tiene shortcuts propios conocidos
    // (ej: kitty), se agregan leyendo su config real - no Hyprland no
    // sabe nada de binds internos de otras apps.
    try {
        const activeOut = await execAsync(["hyprctl", "activewindow", "-j"])
        const active = JSON.parse(activeOut) as any
        const cls: string = active?.class || ""
        for (const app of APP_SOURCES) {
            if (!app.classMatch.test(cls)) continue
            try {
                const text = await execAsync(["cat", app.configPath])
                addCategory(list, app.label, app.parse(text))
            } catch {
                // config no encontrada en disco, se omite sin romper el panel
            }
        }
    } catch {
        // sin ventana activa (ej: recien logeado, foco en el HUD)
    }

    list.show_all()
}

export const ShortcutsWindow = () => {
    list = Box({ className: "shortcuts-list" })
    list.set_orientation(Gtk.Orientation.VERTICAL)

    const scroll = Scrollable({ child: list })
    scroll.set_size_request(660, 680)
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
