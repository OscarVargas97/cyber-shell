// Panel de shortcuts (HUD: abre con el bind real de "shortcuts" en
// hyprland.nix, hoy $mod SHIFT+S - ver título del panel, que lo lee en
// vivo de hyprctl en vez de tener la tecla escrita a mano acá, que fue
// justo el bug que motivó esto: la S reemplazó a la K hace tiempo y este
// archivo se quedó diciendo "Mod+K").
// Todo sale de fuentes en vivo, no de una lista a mano que se pueda
// desincronizar de la config real:
//   - binds de Hyprland: `hyprctl binds -j`, categorizados por la
//     descripción "Categoría: texto" que viaja en cada bindd/bindmd de
//     hyprland.nix (ver ahí).
//   - binds de otras apps del sistema (kitty, herdr, Claude Code, Hermes):
//     se leen de su config/código real en disco (APP_SOURCES) - si esa
//     fuente cambia, el panel la refleja sola la próxima vez que se abre,
//     nunca hace falta tocar este archivo a mano.
// Con ~90 binds ya no entra cómodo en una sola lista scrolleable - una
// página por categoría/app, navegable con Izq/Der (o clickeando las flechas).
import { Window, Box, Button, Label, Scrollable, Layer, Anchor, Exclusivity, Keymode } from "./widget.ts"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=3.0"
import Gdk from "gi://Gdk?version=3.0"
import Pango from "gi://Pango?version=1.0"
import { modmaskToStr, keyForAgsRequest } from "./keymap.ts"

const CATEGORY_ORDER = [
    "Aplicaciones", "Ventanas", "Ventanas (mouse)", "Workspaces", "Sistema", "Capturas", "HUD",
]

// Ancho fijo (en caracteres) de la columna de tecla/combo - lo que rompía
// la alineación antes era rellenar el texto con espacios sobre una fuente
// que no es monoespaciada de verdad para Pango (padEnd asume 1 espacio =
// 1 char de ancho, falso salvo con una fuente monoespaciada real). Acá en
// cambio son dos Label en un Box: la columna de tecla tiene ancho fijo de
// verdad (width_chars) y trunca con "…" si no entra, la de descripción
// hace wrap - así la altura de cada fila coincide siempre con su vecina.
const KEY_COL_CHARS = 26

type AppSource = {
    title: string
    collect: () => Promise<Array<[string, string]>>
}

const readFile = (path: string) => execAsync(["cat", path])

// KITTY: se lee su config real (`map <tecla> <acción>`) - kitty no expone
// esto por un comando, así que se parsea el archivo tal cual está hoy en
// disco, no una copia.
const collectKitty = async (): Promise<Array<[string, string]>> => {
    const text = await readFile(`${GLib.get_home_dir()}/.config/kitty/kitty.conf`)
    const rows: Array<[string, string]> = []
    for (const line of text.split("\n")) {
        const m = line.trim().match(/^map\s+(\S+)\s+(.+)$/)
        if (m) rows.push([m[1], m[2]])
    }
    return rows
}

// HERDR: `herdr --default-config` imprime, comentados, todos los binds de
// fábrica reales del binario instalado (no un doc separado) - se leen esos
// y se pisan con los que la persona haya puesto de verdad en
// ~/.config/herdr/config.toml, así el panel siempre muestra lo que herdr
// va a usar, no un snapshot viejo.
const parseHerdrDefaults = (text: string): Map<string, string> => {
    const out = new Map<string, string>()
    const start = text.indexOf("[keys]")
    const end = text.indexOf("\n[server]", start)
    const block = start === -1 ? "" : text.slice(start, end === -1 ? undefined : end)
    let inCommandExample = false
    for (const raw of block.split("\n")) {
        const line = raw.trim()
        if (line === "# [[keys.command]]") { inCommandExample = true; continue }
        if (inCommandExample) { if (line === "") inCommandExample = false; continue }
        const m = line.match(/^#\s*([\w.]+)\s*=\s*"([^"]*)"/)
        if (m && m[2] !== "") out.set(m[1], m[2])
    }
    return out
}

const parseHerdrOverrides = (text: string): Map<string, string> => {
    const out = new Map<string, string>()
    const start = text.indexOf("[keys]")
    if (start === -1) return out
    const nextSection = text.slice(start + 1).search(/\n\[[a-zA-Z]/)
    const block = nextSection === -1 ? text.slice(start) : text.slice(start, start + 1 + nextSection)
    for (const raw of block.split("\n")) {
        const line = raw.trim()
        if (!line || line.startsWith("#")) continue
        const m = line.match(/^([\w.]+)\s*=\s*"([^"]*)"/)
        if (m) out.set(m[1], m[2])
    }
    return out
}

const collectHerdr = async (): Promise<Array<[string, string]>> => {
    const defaults = parseHerdrDefaults(await execAsync(["herdr", "--default-config"]))
    try {
        const overrides = parseHerdrOverrides(await readFile(`${GLib.get_home_dir()}/.config/herdr/config.toml`))
        for (const [k, v] of overrides) defaults.set(k, v)
    } catch {
        // sin config.toml propio (o sin sección [keys]) - quedan los defaults
    }
    const rows: Array<[string, string]> = []
    const prefix = defaults.get("prefix") || "ctrl+b"
    rows.push([prefix, "Tecla de prefijo (mantener antes de las acciones \"prefix+…\")"])
    for (const [action, combo] of defaults) {
        if (action === "prefix" || combo === "") continue
        const label = action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
        rows.push([combo, label])
    }
    return rows
}

// CLAUDE CODE: no expone los binds por archivo ni por comando - esta tabla
// sale de los defaults documentados por la skill keybindings-help
// (code.claude.com/docs/en/keybindings). Lo que sí es 100% en vivo es la
// personalización real de la persona: si existe ~/.claude/keybindings.json
// se lee y se agrega aparte, sin tocar esta lista base.
const CLAUDE_CODE_DEFAULTS: Array<[string, string]> = [
    ["ctrl+c", "Global: interrumpir"],
    ["ctrl+d", "Global: salir"],
    ["ctrl+t", "Global: mostrar/ocultar lista de tareas"],
    ["ctrl+o", "Global: mostrar/ocultar transcript"],
    ["ctrl+shift+b", "Global: mostrar/ocultar resumen (brief)"],
    ["ctrl+]", "Global: abrir artifact"],
    ["ctrl+r", "Global: buscar en historial de comandos"],
    ["up / down", "Chat: mensaje anterior/siguiente del historial"],
    ["escape", "Chat: cancelar"],
    ["ctrl+x ctrl+k", "Chat: matar agentes en curso"],
    ["shift+tab", "Chat: cambiar de modo"],
    ["meta+p", "Chat: selector de modelo"],
    ["meta+o", "Chat: fast mode"],
    ["meta+t", "Chat: mostrar/ocultar thinking"],
    ["meta+w", "Chat: toggle workflow keyword"],
    ["enter", "Chat: enviar"],
    ["ctrl+j", "Chat: nueva línea"],
    ["ctrl+_ / ctrl+-", "Chat: deshacer"],
    ["ctrl+x ctrl+e / ctrl+g", "Chat: abrir en editor externo"],
    ["ctrl+s", "Chat: guardar prompt (stash)"],
    ["ctrl+v", "Chat: pegar imagen"],
    ["ctrl+l", "Chat: limpiar input"],
    ["cmd+k", "Chat: limpiar pantalla"],
    ["space", "Chat: push-to-talk (voz)"],
    ["tab", "Autocomplete: aceptar"],
    ["escape", "Autocomplete: descartar"],
    ["up / down", "Autocomplete: navegar"],
    ["y / enter", "Confirmation: sí"],
    ["escape / n", "Confirmation: no"],
    ["tab", "Confirmation: siguiente campo"],
    ["space", "Confirmation: marcar/desmarcar"],
    ["ctrl+e", "Confirmation: mostrar explicación"],
    ["ctrl+e", "Transcript: mostrar todo"],
    ["ctrl+c / escape / q", "Transcript: salir"],
    ["ctrl+r", "HistorySearch: siguiente resultado"],
    ["escape / tab", "HistorySearch: aceptar"],
    ["ctrl+c", "HistorySearch: cancelar"],
    ["enter", "HistorySearch: ejecutar"],
    ["ctrl+s", "HistorySearch: cambiar alcance"],
    ["ctrl+x ctrl+b / ctrl+b", "Task: mandar a segundo plano"],
    ["escape", "Help: cerrar ayuda"],
    ["tab / right", "Tabs: siguiente pestaña"],
    ["shift+tab / left", "Tabs: pestaña anterior"],
    ["left / right", "Attachments: navegar imágenes"],
    ["backspace / delete", "Attachments: quitar"],
    ["up / down / ctrl+p / ctrl+n", "Footer: navegar"],
    ["enter", "Footer: abrir seleccionado"],
    ["x", "Footer: cerrar"],
    ["up / down / j / k", "MessageSelector (rewind): navegar"],
    ["enter", "MessageSelector (rewind): seleccionar"],
]

const collectClaudeCode = async (): Promise<Array<[string, string]>> => {
    const rows: Array<[string, string]> = [...CLAUDE_CODE_DEFAULTS]
    try {
        const raw = await readFile(`${GLib.get_home_dir()}/.claude/keybindings.json`)
        const parsed = JSON.parse(raw) as { bindings?: Array<{ context: string; bindings: Record<string, string | null> }> }
        const custom: Array<[string, string]> = []
        for (const group of parsed.bindings || []) {
            for (const [key, action] of Object.entries(group.bindings || {})) {
                custom.push([key, `${group.context}: ${action === null ? "(deshabilitada)" : action} · personalizado`])
            }
        }
        if (custom.length) {
            rows.push(["──────────", "~/.claude/keybindings.json"])
            rows.push(...custom)
        }
    } catch {
        // sin personalizaciones - quedan solo los defaults documentados
    }
    return rows
}

// HERMES: tampoco expone los binds de su TUI por comando, pero al ser
// Python instalado en $HOME/.hermes se puede leer directo el código que
// los registra (kb.add(...)) en vez de copiarlos a mano - si Hermes cambia
// una tecla en una actualización, este parseo la sigue.
const HERMES_HANDLER_LABELS: Record<string, string> = {
    _tui_insert_newline: "Nueva línea sin enviar",
    _tui_history_up: "Historial: mensaje anterior",
    _tui_history_down: "Historial: mensaje siguiente",
    _tui_handle_ctrl_l: "Limpiar pantalla",
    _tui_handle_ctrl_c: "Cancelar",
    _tui_handle_ctrl_q: "Salir",
    _tui_handle_ctrl_d: "Salir (EOF)",
    _tui_handle_escape_modal: "Cerrar modal",
    _tui_handle_double_escape: "Doble Esc: limpiar prompt",
    _tui_handle_ctrl_z: "Suspender",
    _tui_handle_voice_record: "Grabar voz (push-to-talk)",
    _tui_handle_paste: "Pegar (bracketed paste)",
    _tui_handle_ctrl_v: "Pegar imagen",
    _tui_handle_alt_v: "Pegar imagen (alt)",
    _tui_handle_ctrl_r: "Buscar en el historial",
    _tui_handle_open_in_editor: "Abrir prompt en editor externo",
    _tui_handle_prompt_stash: "Guardar prompt (stash)",
    _tui_handle_tab: "Autocompletar / siguiente campo",
}

// Búsqueda ingenua con una sola regex (buscar el próximo ")(self." y listo)
// mezclaba llamadas cuando el filtro de un kb.add() tiene sus propios
// paréntesis (filter=Condition(lambda: ...)) o cuando un binding envuelve a
// otro (kb.add('c-g', …)(kb.add('escape', 'g', …)(handler)), el caso real
// del atajo de editor externo en este archivo) - el resultado era una fila
// con teclas de varios binds distintos pegadas entre sí. Este parser
// respeta el balance real de paréntesis (sin contar los que caen dentro de
// strings) para encontrar el cierre correcto de cada llamada, y baja
// recursivamente por los wrappers anidados.
const findMatchingParen = (text: string, openIdx: number): number => {
    let depth = 0
    let inStr: string | null = null
    for (let i = openIdx; i < text.length; i++) {
        const c = text[i]
        if (inStr) {
            if (c === "\\") { i++; continue }
            if (c === inStr) inStr = null
            continue
        }
        if (c === "'" || c === '"') { inStr = c; continue }
        if (c === "(") depth++
        else if (c === ")") { depth--; if (depth === 0) return i }
    }
    return -1
}

const extractQuoted = (str: string): string[] =>
    [...str.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)].map((m) => (m[1] ?? m[2]) as string)

const parseHermesKeyHandlerPairs = (text: string): Array<[string, string]> => {
    const rows: Array<[string, string]> = []
    const re = /kb\.add\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
        const openIdx = m.index + "kb.add".length
        const closeIdx = findMatchingParen(text, openIdx)
        if (closeIdx === -1) continue
        const args = text.slice(openIdx + 1, closeIdx)
        let j = closeIdx + 1
        while (/\s/.test(text[j])) j++
        if (text[j] !== "(") continue
        const handlerClose = findMatchingParen(text, j)
        if (handlerClose === -1) continue
        const handlerBody = text.slice(j + 1, handlerClose).trim()
        const keys = extractQuoted(args)
        const direct = handlerBody.match(/^self\.(_tui_[A-Za-z0-9_]+)$/)
        if (direct) {
            if (keys.length) rows.push([keys.join(" "), direct[1]])
            continue
        }
        if (handlerBody.startsWith("kb.add(")) {
            for (const [innerCombo, innerHandler] of parseHermesKeyHandlerPairs(handlerBody)) {
                if (keys.length) rows.push([keys.join(" "), innerHandler])
                rows.push([innerCombo, innerHandler])
            }
        }
    }
    return rows
}

const parseHermesKeys = (text: string): Array<[string, string]> => {
    const seen = new Set<string>()
    const rows: Array<[string, string]> = []
    for (const [combo, handler] of parseHermesKeyHandlerPairs(text)) {
        const dedupeKey = `${combo} ${handler}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        const label = HERMES_HANDLER_LABELS[handler] || handler.replace(/^_tui_(handle_)?/, "").replace(/_/g, " ")
        rows.push([combo, label])
    }
    return rows
}

const collectHermes = async (): Promise<Array<[string, string]>> => {
    const text = await readFile(`${GLib.get_home_dir()}/.hermes/hermes-agent/hermes_cli/cli_tui_mixin.py`)
    return parseHermesKeys(text)
}

const APP_SOURCES: AppSource[] = [
    { title: "KITTY", collect: collectKitty },
    { title: "HERDR", collect: collectHerdr },
    { title: "CLAUDE CODE", collect: collectClaudeCode },
    { title: "HERMES", collect: collectHermes },
]

type Page = { title: string; rows: Array<[string, string]> }

let win: any = null
let list: any = null
let pageLabel: any = null
let titleLabel: any = null
let visible = false
let pages: Page[] = []
let pageIdx = 0

const keyValueRow = (combo: string, action: string) => {
    const keyLabel = Label({ label: combo, className: "shortcut-key" })
    keyLabel.set_halign(Gtk.Align.START)
    keyLabel.set_xalign(0)
    keyLabel.set_width_chars(KEY_COL_CHARS)
    keyLabel.set_max_width_chars(KEY_COL_CHARS)
    keyLabel.set_ellipsize(Pango.EllipsizeMode.END)
    keyLabel.set_single_line_mode(true)

    const actionLabel = Label({ label: action, className: "shortcut-action" })
    actionLabel.set_halign(Gtk.Align.START)
    actionLabel.set_xalign(0)
    actionLabel.set_line_wrap(true)
    actionLabel.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
    actionLabel.set_hexpand(true)

    const row = Box({ className: "shortcut-row", children: [keyLabel, actionLabel] })
    row.set_orientation(Gtk.Orientation.HORIZONTAL)
    row.set_spacing(10)
    return row
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

    // Páginas fijas del resto del sistema - siempre presentes (no solo
    // cuando esa app está enfocada), cada una intenta su propia fuente y
    // se omite sola si no puede leerla (app no instalada en esta máquina,
    // etc.) sin romper el resto del panel.
    for (const app of APP_SOURCES) {
        try {
            push(app.title, await app.collect())
        } catch (e) {
            print(`[shortcuts] ${app.title}:`, e)
        }
    }

    return out
}

const renderPage = () => {
    if (!list || pages.length === 0) return
    for (const child of list.get_children()) list.remove(child)
    const p = pages[pageIdx]
    for (const [combo, action] of p.rows) {
        list.add(keyValueRow(combo, action))
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
    if (titleLabel) {
        const openKey = await keyForAgsRequest("shortcuts")
        titleLabel.set_label(`◤ SHORTCUTS (SUPER + ${openKey} para abrir/cerrar) ◢`)
    }
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

    titleLabel = Label({ label: "◤ SHORTCUTS ◢", className: "shortcuts-title" })
    titleLabel.set_halign(Gtk.Align.START)

    const legend = Label({
        label: "Escape para cerrar · Izq/Der (←/→) para cambiar de página · $mod = SUPER, se combina con ALT · CTRL · SHIFT",
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

    const inner = Box({ className: "shortcuts-wrap", children: [titleLabel, legend, scroll, nav] })
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
