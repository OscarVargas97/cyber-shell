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
// El panel tiene dos vistas (Arriba/Abajo alterna entre ellas):
//   - SHORTCUTS: atajos de teclado (lo de arriba).
//   - COMANDOS: la CLI de cada herramienta del sistema, tipo página man -
//     un listado de subcomandos con su descripción, sacado en vivo de
//     `<comando> --help` (ver "Vista COMANDOS" más abajo).
import { Window, Box, Button, Label, Scrollable, Layer, Anchor, Exclusivity, Keymode, focusedMonitor } from "./widget.ts"
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

// ZSH: no hay forma de pedirle a zsh en vivo "qué binds tenés" (no expone
// nada como `hyprctl binds -j`), así que se parsea `bindkey` tal como
// está escrito en home-manager/zsh.nix - mismo criterio que HERMES arriba:
// leer el código real en vez de copiarlo a mano acá.
const ZSH_NIX_PATH = `${GLib.get_home_dir()}/Repos/Externos/workos/workos/home-manager/zsh.nix`

const ZSH_WIDGET_LABELS: Record<string, string> = {
    "sudo-command-line": 'Anteponer/quitar "sudo " a la línea de comando actual',
}

const humanizeZshKeySeq = (raw: string): string =>
    raw.replace(/\\e/g, "Esc ").replace(/\\C-/g, "Ctrl+").trim().replace(/\s+/g, " ")

const parseZshBindkeys = (text: string): Array<[string, string]> => {
    const rows: Array<[string, string]> = []
    for (const raw of text.split("\n")) {
        const line = raw.trim()
        if (/^bindkey\s+-e\s*$/.test(line)) {
            rows.push(["(bindkey -e)", "Modo de edición emacs/readline - habilita los atajos estándar heredados de zsh (Ctrl+A/E/R, Alt+., …), no declarados uno por uno en este archivo"])
            continue
        }
        const m = line.match(/^bindkey\s+"([^"]+)"\s+(\S+)/)
        if (m) {
            const label = ZSH_WIDGET_LABELS[m[2]] || m[2].replace(/-/g, " ")
            rows.push([humanizeZshKeySeq(m[1]), label])
        }
    }
    return rows
}

const collectZsh = async (): Promise<Array<[string, string]>> =>
    parseZshBindkeys(await readFile(ZSH_NIX_PATH))

const APP_SOURCES: AppSource[] = [
    { title: "KITTY", collect: collectKitty },
    { title: "HERDR", collect: collectHerdr },
    { title: "CLAUDE CODE", collect: collectClaudeCode },
    { title: "HERMES", collect: collectHermes },
    { title: "ZSH", collect: collectZsh },
]

// ---------------------------------------------------------------------
// Vista COMANDOS: páginas tipo "man" con la CLI de cada herramienta (no
// sus atajos de teclado). Mismo criterio que la vista de arriba: todo
// sale de `<comando> --help` corrido en vivo, nunca de una lista a mano
// que se pueda desincronizar - acá además con `2>&1` porque no todas las
// CLIs mandan su --help a stdout (la de `work` lo manda entero a stderr).
// Cada herramienta formatea su --help distinto (columnas alineadas con
// continuación, columnas alineadas simples, viñetas en el caso de nix...)
// así que hay un parser genérico por formato, reutilizado donde calza, en
// vez de un parser por herramienta.
const runHelp = (cmd: string) => execAsync(["bash", "-c", `${cmd} --help 2>&1`])

// Formato "alineado con continuación": una entrada nueva arranca con
// exactamente `indent` espacios seguidos de texto (los comandos de
// `work --help`, la sección "Commands:" de `claude --help`, los
// subcomandos dentro de "positional arguments" de `hermes --help`); si
// la descripción no entra en esa misma línea, sigue en líneas indentadas
// más todavía y se van concatenando.
const parseAlignedCommandList = (text: string, indent: number): Array<[string, string]> => {
    const prefix = " ".repeat(indent)
    const rows: Array<[string, string]> = []
    let current: [string, string] | null = null
    for (const raw of text.split("\n")) {
        if (raw.trim() === "") continue
        const isEntry = raw.startsWith(prefix) && raw[indent] !== undefined && raw[indent] !== " "
        if (isEntry) {
            if (current) rows.push(current)
            const rest = raw.slice(indent)
            const sep = rest.match(/\s{2,}/)
            current = sep
                ? [rest.slice(0, sep.index).trim(), rest.slice(sep.index! + sep[0].length).trim()]
                : [rest.trim(), ""]
        } else if (current) {
            current[1] = (current[1] ? current[1] + " " : "") + raw.trim()
        }
    }
    if (current) rows.push(current)
    return rows
}

// Formato "alineado simple": una fila por línea, sin continuación (los
// comandos de `git --help`, la sección "Available Commands:" de
// `podman --help`).
const parseSimpleCommandList = (text: string, indent: number): Array<[string, string]> => {
    const rows: Array<[string, string]> = []
    const re = new RegExp(`^ {${indent}}(\\S+)\\s{2,}(.+)$`)
    for (const raw of text.split("\n")) {
        const m = raw.match(re)
        if (m) rows.push([m[1], m[2].trim()])
    }
    return rows
}

// `work` es una función de zsh (home-manager/zsh.nix) que envuelve al
// binario real `work-cli` para poder hacer `cd` en `enter`/`clone` - no
// existe como ejecutable en el PATH, así que hay que pedirle --help al
// binario real, no a la función.
const collectWorkCommands = async (): Promise<Array<[string, string]>> =>
    parseAlignedCommandList(await runHelp("work-cli"), 2)

const collectClaudeCliCommands = async (): Promise<Array<[string, string]>> => {
    const text = await runHelp("claude")
    const idx = text.indexOf("\nCommands:\n")
    return idx === -1 ? [] : parseAlignedCommandList(text.slice(idx), 2)
}

const collectGitCommands = async (): Promise<Array<[string, string]>> =>
    parseSimpleCommandList(await runHelp("git"), 3)

// nix usa viñetas ("· nix build - …") en vez de columnas alineadas, y las
// usa también para sus opciones globales (sin el prefijo "nix ") - filtrar
// por ese prefijo alcanza para quedarse solo con los subcomandos.
const parseNixCommands = (text: string): Array<[string, string]> => {
    const rows: Array<[string, string]> = []
    let current: [string, string] | null = null
    for (const raw of text.split("\n")) {
        const trimmed = raw.trim()
        if (trimmed === "") { if (current) { rows.push(current); current = null }; continue }
        const m = trimmed.match(/^·\s+(nix[\w-]*(?:\s+[\w-]+)?)\s+-\s+(.+)$/)
        if (m) {
            if (current) rows.push(current)
            current = [m[1], m[2]]
        } else if (current) {
            current[1] += ` ${trimmed}`
        }
    }
    if (current) rows.push(current)
    return rows
}

const collectNixCommands = async (): Promise<Array<[string, string]>> =>
    parseNixCommands(await runHelp("nix"))

const collectPodmanCommands = async (): Promise<Array<[string, string]>> => {
    const text = await runHelp("podman")
    const start = text.indexOf("Available Commands:")
    if (start === -1) return []
    const end = text.indexOf("\nOptions:", start)
    return parseSimpleCommandList(end === -1 ? text.slice(start) : text.slice(start, end), 2)
}

// herdr no alinea su "Common commands:" en columnas de ancho fijo (una
// entrada larga como "herdr channel set <stable|preview>" empuja la
// descripción a un solo espacio de separación en vez de la columna
// completa), así que en vez de asumir un ancho cada línea se corta donde
// arranca la descripción en inglés (la primera mayúscula que sigue a
// "herdr ...").
const parseHerdrHelpCommands = (text: string): Array<[string, string]> => {
    const rows: Array<[string, string]> = []
    const re = /^\s+herdr(?:\s+([^\s].*?))?\s{1,}([A-ZÁÉÍÓÚ].*)$/
    for (const raw of text.split("\n")) {
        const m = raw.match(re)
        if (m) rows.push([`herdr ${m[1] || ""}`.trim(), m[2].trim()])
    }
    return rows
}

const collectHerdrCliCommands = async (): Promise<Array<[string, string]>> =>
    parseHerdrHelpCommands(await runHelp("herdr"))

const collectHermesCliCommands = async (): Promise<Array<[string, string]>> => {
    const text = await runHelp("hermes")
    const start = text.indexOf("positional arguments:")
    if (start === -1) return []
    const end = text.indexOf("\noptions:", start)
    return parseAlignedCommandList(end === -1 ? text.slice(start) : text.slice(start, end), 4)
}

const COMMAND_SOURCES: AppSource[] = [
    { title: "WORK", collect: collectWorkCommands },
    { title: "CLAUDE CODE", collect: collectClaudeCliCommands },
    { title: "GIT", collect: collectGitCommands },
    { title: "NIX", collect: collectNixCommands },
    { title: "PODMAN / DOCKER", collect: collectPodmanCommands },
    { title: "HERDR", collect: collectHerdrCliCommands },
    { title: "HERMES", collect: collectHermesCliCommands },
]

type Page = { title: string; rows: Array<[string, string]> }
type Mode = "SHORTCUTS" | "COMANDOS"
// Arriba/Abajo recorre este array (con solo 2 modos, alternar o "recorrer
// con wraparound" da lo mismo, pero así queda listo si algún día se suma
// un tercer modo).
const MODES: Mode[] = ["SHORTCUTS", "COMANDOS"]

let win: any = null
let list: any = null
let pageLabel: any = null
let modeLabel: any = null
let titleLabel: any = null
let visible = false
let mode: Mode = "SHORTCUTS"
const pagesByMode: Record<Mode, Page[]> = { SHORTCUTS: [], COMANDOS: [] }
const pageIdxByMode: Record<Mode, number> = { SHORTCUTS: 0, COMANDOS: 0 }

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

const collectShortcutPages = async (): Promise<Page[]> => {
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

const collectCommandPages = async (): Promise<Page[]> => {
    const out: Page[] = []
    for (const app of COMMAND_SOURCES) {
        try {
            const rows = await app.collect()
            if (rows.length) out.push({ title: app.title, rows })
        } catch (e) {
            print(`[shortcuts] COMANDOS ${app.title}:`, e)
        }
    }
    return out
}

const renderPage = () => {
    const pages = pagesByMode[mode]
    if (modeLabel) modeLabel.set_label(`▲▼ MODO: ${mode}`)
    if (!list || pages.length === 0) return
    for (const child of list.get_children()) list.remove(child)
    const pageIdx = pageIdxByMode[mode]
    const p = pages[pageIdx]
    for (const [combo, action] of p.rows) {
        list.add(keyValueRow(combo, action))
    }
    if (pageLabel) pageLabel.set_label(`◄  ${p.title}  (${pageIdx + 1}/${pages.length})  ►`)
    list.show_all()
}

const goToPage = (delta: number) => {
    const pages = pagesByMode[mode]
    if (pages.length === 0) return
    pageIdxByMode[mode] = (pageIdxByMode[mode] + delta + pages.length) % pages.length
    renderPage()
}

const switchMode = (delta: number) => {
    mode = MODES[(MODES.indexOf(mode) + delta + MODES.length) % MODES.length]
    renderPage()
}

const refresh = async () => {
    const [shortcutPages, commandPages] = await Promise.all([collectShortcutPages(), collectCommandPages()])
    pagesByMode.SHORTCUTS = shortcutPages
    pagesByMode.COMANDOS = commandPages
    pageIdxByMode.SHORTCUTS = 0
    pageIdxByMode.COMANDOS = 0
    mode = "SHORTCUTS"
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
        label: "Escape para cerrar · Arriba/Abajo (↑/↓) cambia de modo (SHORTCUTS ⇄ COMANDOS) · Izq/Der (←/→) cambia de página · $mod = SUPER, se combina con ALT · CTRL · SHIFT",
        className: "shortcuts-legend",
    })
    legend.set_halign(Gtk.Align.START)

    const modeUpBtn = Button({ label: "▲ Arriba", className: "shortcut-navbtn" })
    modeUpBtn.connect("clicked", () => switchMode(-1))
    const modeDownBtn = Button({ label: "▼ Abajo", className: "shortcut-navbtn" })
    modeDownBtn.connect("clicked", () => switchMode(1))
    modeLabel = Label({ label: "", className: "shortcut-pagelabel" })

    const modeNav = Box({ className: "shortcuts-nav", children: [modeUpBtn, modeLabel, modeDownBtn] })
    modeNav.set_orientation(Gtk.Orientation.HORIZONTAL)
    modeNav.set_halign(Gtk.Align.CENTER)

    const prevBtn = Button({ label: "◄ Izq", className: "shortcut-navbtn" })
    prevBtn.connect("clicked", () => goToPage(-1))
    const nextBtn = Button({ label: "Der ►", className: "shortcut-navbtn" })
    nextBtn.connect("clicked", () => goToPage(1))
    pageLabel = Label({ label: "", className: "shortcut-pagelabel" })

    const nav = Box({ className: "shortcuts-nav", children: [prevBtn, pageLabel, nextBtn] })
    nav.set_orientation(Gtk.Orientation.HORIZONTAL)
    nav.set_halign(Gtk.Align.CENTER)

    const inner = Box({ className: "shortcuts-wrap", children: [titleLabel, legend, modeNav, scroll, nav] })
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
        else if (k === Gdk.KEY_Up || k === Gdk.KEY_k) switchMode(-1)
        else if (k === Gdk.KEY_Down || k === Gdk.KEY_j) switchMode(1)
        else if (k === Gdk.KEY_Escape) closePanel()
        return true
    })
    return win
}

export const toggleShortcuts = () => {
    if (!win) return
    visible = !visible
    if (!visible) { closePanel(); return }
    // Singleton (una sola ventana, no una por monitor como el dock/sidepanel):
    // antes se creaba sin `gdkmonitor` y quedaba fija en el primer monitor
    // que devuelve get_monitors(), no en el que tenía el foco - bug real
    // confirmado en vivo con dos monitores. Se reubica en el monitor con
    // foco cada vez que se abre en vez de pasar a multi-instancia: es un
    // popup pesado (arma ~14 páginas en vivo) y solo hay uno visible por
    // definición (no tiene sentido una copia por monitor, a diferencia del
    // dock). Solo se espera focusedMonitor() (rápido, un solo hyprctl) antes
    // de mostrar - refresh() sigue disparándose en paralelo sin bloquear el
    // show(), así la ventana aparece al instante y las páginas se llenan
    // solas apenas están listas.
    ;(async () => {
        try { win.gdkmonitor = await focusedMonitor() } catch {}
        refresh(); win.show()
    })()
}
