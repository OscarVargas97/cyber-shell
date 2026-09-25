// Panel de shortcuts (Mod+K) - para aprender
// Hyprland/Wayland. Todo sale de fuentes en vivo, no de una lista a mano
// que se pueda desincronizar de la config real:
//   - binds de Hyprland: `hyprctl binds -j`, categorizados por la
//     descripción "Categoría: texto" que viaja en cada bindd/bindmd de
//     hyprland.nix (ver ahí).
//   - binds de la app enfocada ahora mismo (ej: kitty): se leen de su
//     archivo de config real en disco (APP_SOURCES) - si esa config
//     cambia, el panel lo refleja solo la próxima vez que se abre.
// Con ~55 binds ya no entra cómodo en una sola lista scrolleable - una
// página por categoría, navegable con Izq/Der (o clickeando las flechas).
import { Window, Box, Button, Label, Scrollable, Layer, Anchor, Exclusivity, Keymode } from "./widget.ts"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=3.0"
import Gdk from "gi://Gdk?version=3.0"
import { modmaskToStr } from "./keymap.ts"

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

type Page = { title: string; rows: Array<[string, string]> }

let win: any = null
let list: any = null
let pageLabel: any = null
let visible = false
let pages: Page[] = []
let pageIdx = 0

const rowLabel = (text: string, className: string) => {
    const l = Label({ label: text, className })
    l.set_halign(Gtk.Align.START)
    return l
}

const collectPages = async (): Promise<Page[]> => {
    const out: Page[] = []
    const push = (title: string, rows: Array<[string, string]>) => { if (rows.length) out.push({ title, rows }) }

    try {
        const binds = JSON.parse(await execAsync(["hyprctl", "binds", "-j"])) as any[]
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
        for (const cat of CATEGORY_ORDER) push(cat, byCategory.get(cat) || [])
        for (const [cat, rows] of byCategory) {
            if (!CATEGORY_ORDER.includes(cat)) push(cat, rows)
        }
    } catch (e) {
        push("Error", [["", `leyendo hyprctl binds: ${e}`]])
    }

    // Si la app enfocada ahora mismo tiene shortcuts propios conocidos
    // (ej: kitty), se agrega su propia página leyendo su config real -
    // Hyprland no sabe nada de binds internos de otras apps.
    try {
        const active = JSON.parse(await execAsync(["hyprctl", "activewindow", "-j"])) as any
        const cls: string = active?.class || ""
        for (const app of APP_SOURCES) {
            if (!app.classMatch.test(cls)) continue
            try {
                const text = await execAsync(["cat", app.configPath])
                push(app.label, app.parse(text))
            } catch {
                // config no encontrada en disco, se omite sin romper el panel
            }
        }
    } catch {
        // sin ventana activa (ej: recien logeado, foco en el HUD)
    }

    return out
}

const renderPage = () => {
    if (!list || pages.length === 0) return
    for (const child of list.get_children()) list.remove(child)
    const p = pages[pageIdx]
    for (const [combo, action] of p.rows) {
        list.add(rowLabel(`${combo.padEnd(24)} ${action}`, "shortcut-row"))
    }
    if (pageLabel) pageLabel.set_label(`◄  ${p.title}  (${pageIdx + 1}/${pages.length})  ►`)
    list.show_all()
}

const goToPage = (delta: number) => {
    if (pages.length === 0) return
    pageIdx = (pageIdx + delta + pages.length) % pages.length
    renderPage()
}

const refresh = async () => {
    pages = await collectPages()
    pageIdx = 0
    renderPage()
}

const closePanel = () => {
    visible = false
    win?.hide()
}

export const ShortcutsWindow = () => {
    list = Box({ className: "shortcuts-list" })
    list.set_orientation(Gtk.Orientation.VERTICAL)

    const scroll = Scrollable({ child: list })
    scroll.set_size_request(660, 560)
    scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

    const title = Label({ label: "◤ SHORTCUTS (Mod+K para cerrar) ◢", className: "shortcuts-title" })
    title.set_halign(Gtk.Align.START)

    const legend = Label({
        label: "$mod = SUPER (tecla Windows/Cmd), se combina con ALT · CTRL · SHIFT",
        className: "shortcuts-legend",
    })
    legend.set_halign(Gtk.Align.START)

    const prevBtn = Button({ label: "◄ Izq", className: "shortcut-navbtn" })
    prevBtn.connect("clicked", () => goToPage(-1))
    const nextBtn = Button({ label: "Der ►", className: "shortcut-navbtn" })
    nextBtn.connect("clicked", () => goToPage(1))
    pageLabel = Label({ label: "", className: "shortcut-pagelabel" })

    const nav = Box({ className: "shortcuts-nav", children: [prevBtn, pageLabel, nextBtn] })
    nav.set_orientation(Gtk.Orientation.HORIZONTAL)
    nav.set_halign(Gtk.Align.CENTER)

    const inner = Box({ className: "shortcuts-wrap", children: [title, legend, scroll, nav] })
    inner.set_orientation(Gtk.Orientation.VERTICAL)
    inner.set_halign(Gtk.Align.CENTER)
    inner.set_valign(Gtk.Align.CENTER)

    win = Window({
        name: "shortcuts",
        className: "aug shortcuts",
        anchor: Anchor.TOP | Anchor.LEFT | Anchor.BOTTOM | Anchor.RIGHT,
        exclusivity: Exclusivity.IGNORE,
        layer: Layer.TOP,
        // Pide teclado mientras está visible (se libera solo al ocultarse)
        // - sin esto, Izq/Der/Escape no le llegan nunca a esta ventana.
        keymode: Keymode.EXCLUSIVE,
        visible: false,
        child: inner,
    })
    win.connect("key-press-event", (_w: any, e: any) => {
        let k = 0
        try { const r = e.get_keyval?.(); k = r ? r[1] : e.keyval } catch {}
        if (k === Gdk.KEY_Left || k === Gdk.KEY_h) goToPage(-1)
        else if (k === Gdk.KEY_Right || k === Gdk.KEY_l) goToPage(1)
        else if (k === Gdk.KEY_Escape) closePanel()
        return true
    })
    return win
}

export const toggleShortcuts = () => {
    if (!win) return
    visible = !visible
    if (visible) { refresh(); win.show() } else { closePanel() }
}
