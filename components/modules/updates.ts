// Reemplaza al viejo aurbar.ts (pacman/checkupdates/paru/yay - Arch, no
// aplican en NixOS). Dos fuentes de drift, ambas resueltas contra el
// origen real, nunca con una lista a mano que se pueda desincronizar:
//
//   - Forks: para cada repo tuyo (los de ~/.config/work-os/projects.conf,
//     los de ~/Repos/Externos/ y workos/workos-private), le preguntamos a
//     GitHub si es un fork (`gh repo view --json isFork,parent`) y
//     comparamos el último commit de su upstream real contra el último
//     que revisaste. 100% automático: un fork nuevo entra solo (ej. herdr,
//     que no estaba en projects.conf), sin tocar este archivo.
//   - Herramientas: los inputs directos de flake.nix de workos y
//     workos-private (nixpkgs, home-manager, disko, ags, cyberShell, y
//     workos visto desde workos-private) vía `nix flake metadata`,
//     comparados contra el último commit real de cada uno.
//   - Pines a mano: lo que un .nix fija por versión/tag + hash
//     (fetchFromGitHub, o un fetchurl a un binario de release), contra el
//     último release del repo. No son inputs del flake, así que
//     `nix flake update` no los mueve y el escaneo de herramientas no los
//     ve - pero son los únicos que piden trabajo a mano (editar la
//     versión y recalcular el hash), así que son los que más conviene
//     tener a la vista.
import { Window, Box, Button, Label, Scrollable, EventBox, Anchor, Layer, Exclusivity, Keymode, focusedMonitor } from "./widget.ts"
import Gtk from "gi://Gtk?version=3.0"
import Gdk from "gi://Gdk?version=3.0"
import { execAsync } from "ags/process"
import { interval, timeout } from "ags/time"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { showToast } from "./toast.ts"

const HOME = GLib.get_home_dir()
const CFG_DIR = `${GLib.get_user_config_dir()}/work-os`
const STATE_FILE = `${CFG_DIR}/updates-state.json`
const PROJECTS_CONF = `${CFG_DIR}/projects.conf`
const EXTERNOS_DIR = `${HOME}/Repos/Externos`
const WORKOS_DIR = `${EXTERNOS_DIR}/workos/workos`
const WORKOS_PRIVATE_DIR = `${EXTERNOS_DIR}/workos/workos-private`
const RECHECK_MS = 21600000 // 6h - son llamadas a gh/nix por red, sin apuro

type ForkDrift = { kind: "fork"; id: string; title: string; detail: string; compareUrl: string; latestSha: string }
type ToolDrift = { kind: "tool"; id: string; title: string; detail: string; repoDir: string; inputName: string; isPrivateLock: boolean }
type PinDrift = { kind: "pin"; id: string; title: string; detail: string; releaseUrl: string }
type DriftItem = ForkDrift | ToolDrift | PinDrift

let current: { forks: ForkDrift[]; tools: ToolDrift[]; pins: PinDrift[] } = { forks: [], tools: [], pins: [] }

const readTextFile = (path: string): string => {
    try {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return ""
        const [ok, bytes] = GLib.file_get_contents(path)
        return ok ? new TextDecoder().decode(bytes) : ""
    } catch { return "" }
}

const loadState = (): any => { try { return JSON.parse(readTextFile(STATE_FILE) || "{}") } catch { return {} } }
const saveState = (state: any) => {
    try { GLib.mkdir_with_parents(CFG_DIR, 0o755); GLib.file_set_contents(STATE_FILE, JSON.stringify(state, null, 2)) }
    catch (e) { print("[updates] saveState:", e) }
}

// Mismo formato que ya usa `work`: nombre=/ruta[=empresa]. Cubre los
// repos de trabajo (empresas), que por su anidado irregular
// (~/Repos/<Empresa>/<Proyecto>/<repo>) no se pueden listar a ciegas.
const readProjectPaths = (): string[] => {
    const out: string[] = []
    for (const line of readTextFile(PROJECTS_CONF).split("\n")) {
        const l = line.trim()
        if (!l || l.startsWith("#")) continue
        const parts = l.split("=")
        if (parts[1]) out.push(parts[1])
    }
    return out
}

// projects.conf es para atajos de `work enter`, no un registro completo -
// herramientas/forks personales (ej. herdr) suelen no estar ahí. Como
// ~/Repos/Externos/ es siempre un solo nivel (convención de este sistema,
// ver CLAUDE.md), un listado directo alcanza para no perderlos.
const listExternosRepos = (): string[] => {
    const out: string[] = []
    try {
        const dir = Gio.File.new_for_path(EXTERNOS_DIR)
        const en = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null)
        let info
        while ((info = en.next_file(null))) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue
            const p = `${EXTERNOS_DIR}/${info.get_name()}`
            if (GLib.file_test(`${p}/.git`, GLib.FileTest.EXISTS)) out.push(p)
        }
    } catch (e) { print("[updates] listExternosRepos:", e) }
    return out
}

const ghJson = async (args: string[]): Promise<any | null> => {
    try { return JSON.parse(await execAsync(["gh", ...args])) } catch { return null }
}

const originOwnerRepo = async (path: string): Promise<[string, string] | null> => {
    try {
        const raw = (await execAsync(["git", "-C", path, "remote", "get-url", "origin"])).trim()
        // git@<host>:owner/repo(.git) o https://<host>/owner/repo(.git) -
        // no asumimos "github.com" literal: un alias de ~/.ssh/config (ej.
        // "github-personal") también puede apuntar a GitHub. Si el host
        // real no es GitHub, el `gh repo view` de más abajo simplemente
        // no encuentra nada y se descarta solo.
        const m = raw.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
        return m ? [m[1], m[2]] : null
    } catch { return null }
}

const latestCommit = (owner: string, repo: string, branch: string) =>
    ghJson(["api", `repos/${owner}/${repo}/commits/${branch}`]).then((j) => j?.sha as string | undefined)

const scanForkDrift = async (): Promise<ForkDrift[]> => {
    const paths = Array.from(new Set([...readProjectPaths(), ...listExternosRepos(), WORKOS_DIR, WORKOS_PRIVATE_DIR]))
    const state = loadState()
    state.forks = state.forks || {}
    const items: ForkDrift[] = []
    for (const path of paths) {
        const or = await originOwnerRepo(path)
        if (!or) continue
        const [owner, repo] = or
        const info = await ghJson(["repo", "view", `${owner}/${repo}`, "--json", "isFork,parent,defaultBranchRef"])
        if (!info?.isFork || !info.parent) continue
        const branch = info.defaultBranchRef?.name || "HEAD"
        const latest = await latestCommit(info.parent.owner.login, info.parent.name, branch)
        if (!latest) continue
        const key = `${owner}/${repo}`
        const seen = state.forks[key]?.lastSeenSha
        if (!seen) {
            // primera vez que vemos este fork: guardamos el HEAD actual de
            // upstream como base sin avisar (si avisáramos ya, sería sobre
            // años de historia divergida, no sobre algo nuevo y accionable).
            state.forks[key] = { lastSeenSha: latest }
            continue
        }
        if (seen !== latest) {
            items.push({
                kind: "fork", id: `fork:${key}`, title: repo,
                detail: `${info.parent.owner.login}/${info.parent.name} avanzó desde ${seen.slice(0, 7)}`,
                compareUrl: `https://github.com/${info.parent.owner.login}/${info.parent.name}/compare/${seen}...${latest}`,
                latestSha: latest,
            })
        }
    }
    saveState(state)
    return items
}

type FlakeInput = { name: string; owner: string; repo: string; rev: string; ref: string | null }

const flakeDirectInputs = async (dir: string): Promise<FlakeInput[]> => {
    try {
        const meta = JSON.parse(await execAsync([
            "nix", "--extra-experimental-features", "nix-command flakes",
            "flake", "metadata", "--json", `path:${dir}`,
        ]))
        const nodes = meta.locks.nodes
        const rootInputs = nodes[meta.locks.root]?.inputs || {}
        const out: FlakeInput[] = []
        for (const [name, ref] of Object.entries(rootInputs)) {
            const key = Array.isArray(ref) ? ref[ref.length - 1] : (ref as string)
            const node = nodes[key]
            const locked = node?.locked
            if (locked?.type === "github" && locked.owner && locked.repo && locked.rev) {
                // El branch/tag pineado vive en "original" - "locked" casi
                // nunca trae ref (queda implícito en el rev+narHash), así
                // que comparar contra locked.ref termina comparando contra
                // el branch default del repo (ej. master de nixpkgs) en vez
                // del que este flake realmente sigue (ej. nixos-unstable).
                out.push({ name, owner: locked.owner, repo: locked.repo, rev: locked.rev, ref: node?.original?.ref || null })
            }
        }
        return out
    } catch (e) { print("[updates] flake metadata:", dir, e); return [] }
}

const scanToolDrift = async (): Promise<ToolDrift[]> => {
    const items: ToolDrift[] = []
    for (const dir of [WORKOS_DIR, WORKOS_PRIVATE_DIR]) {
        for (const inp of await flakeDirectInputs(dir)) {
            const defBranch = inp.ref || (await ghJson(["repo", "view", `${inp.owner}/${inp.repo}`, "--json", "defaultBranchRef"]))?.defaultBranchRef?.name || "HEAD"
            const latest = await latestCommit(inp.owner, inp.repo, defBranch)
            if (!latest || latest === inp.rev) continue
            items.push({
                kind: "tool", id: `tool:${dir}#${inp.name}`, title: inp.name,
                detail: `${inp.rev.slice(0, 7)} → ${latest.slice(0, 7)}  (${inp.owner}/${inp.repo}@${defBranch})`,
                repoDir: dir, inputName: inp.name, isPrivateLock: dir === WORKOS_PRIVATE_DIR,
            })
        }
    }
    return items
}

// ---- pines a mano (version+hash en un .nix) ----

type NixPin = { owner: string; repo: string; tag: string; file: string }

// Ventana de texto después de "fetchFromGitHub" donde buscar owner/repo/rev.
// No parseamos el bloque entre llaves a propósito: un rev interpolado
// ("v${finalAttrs.version}") trae su propia "}" y cortaría el match.
const PIN_WINDOW = 400

const nixField = (text: string, key: string): string | null => {
    const m = text.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`))
    return m ? m[1] : null
}

// Resuelve "v${finalAttrs.version}" contra el `version = "0.22.0";` del
// mismo archivo. Solo interpolaciones de una variable declarada ahí: si
// algo queda sin resolver devolvemos null y el pin se ignora, que es
// mejor que informar una versión inventada.
const resolveNixStr = (raw: string, text: string): string | null => {
    let out = raw
    for (let i = 0; i < 5 && out.includes("${"); i++) {
        out = out.replace(/\$\{([^}]+)\}/g, (_m: string, expr: string) => {
            const name = (expr.trim().split(".").pop() || "").trim()
            if (!/^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name)) return "\u0000"
            return nixField(text, name) ?? "\u0000"
        })
    }
    return out.includes("\u0000") || out.includes("${") ? null : out
}

const pinsInNix = (text: string, file: string): NixPin[] => {
    const out: NixPin[] = []
    let idx = -1
    while ((idx = text.indexOf("fetchFromGitHub", idx + 1)) !== -1) {
        const chunk = text.slice(idx, idx + PIN_WINDOW)
        // Solo la llamada real: el mismo nombre aparece en la lista de
        // argumentos del archivo ({ lib, buildGoModule, fetchFromGitHub, ... }),
        // y desde ahí la ventana alcanzaría a leer el bloque de más abajo
        // y lo contaría dos veces.
        if (!/^fetchFromGitHub\s*\{/.test(chunk)) continue
        const owner = nixField(chunk, "owner"), repo = nixField(chunk, "repo"), rev = nixField(chunk, "rev")
        if (!owner || !repo || !rev) continue
        const tag = resolveNixStr(rev, text)
        // Un rev que es un commit pelado no tiene release contra qué
        // compararse: eso es un pin por commit, no por versión.
        if (!tag || /^[0-9a-f]{40}$/.test(tag)) continue
        out.push({ owner, repo, tag, file })
    }
    // fetchurl a un binario publicado: .../OWNER/REPO/releases/download/<tag>/<archivo>
    const reUrl = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/download\/([^/"]+)\//g
    let m: RegExpExecArray | null
    while ((m = reUrl.exec(text)) !== null) {
        const tag = resolveNixStr(m[3], text)
        if (tag) out.push({ owner: m[1], repo: m[2], tag, file })
    }
    return out
}

const latestRelease = async (owner: string, repo: string): Promise<{ tag: string; url: string } | null> => {
    const rel = await ghJson(["api", `repos/${owner}/${repo}/releases/latest`])
    if (rel?.tag_name) return { tag: rel.tag_name, url: rel.html_url || `https://github.com/${owner}/${repo}/releases/latest` }
    // Un repo puede pinearse por tag sin publicar releases: ahí el tag
    // más nuevo es lo único que hay para comparar.
    const tags = await ghJson(["api", `repos/${owner}/${repo}/tags`])
    const t = Array.isArray(tags) && tags[0]?.name
    return t ? { tag: t, url: `https://github.com/${owner}/${repo}/releases/tag/${t}` } : null
}

// "v0.22.0" y "0.22.0" son el mismo pin escrito distinto según si la "v"
// quedó dentro de la variable o afuera.
const sameVersion = (a: string, b: string) => a.replace(/^v/, "") === b.replace(/^v/, "")

const scanPinDrift = async (): Promise<PinDrift[]> => {
    const pins = new Map<string, NixPin>()
    for (const dir of [WORKOS_DIR, WORKOS_PRIVATE_DIR]) {
        let files: string[] = []
        try {
            files = (await execAsync(["find", dir, "-name", "*.nix", "-not", "-path", "*/.git/*"])).split("\n").filter(Boolean)
        } catch (e) { print("[updates] find .nix:", dir, e); continue }
        const repoName = dir.split("/").filter(Boolean).pop()
        for (const f of files) {
            const rel = f.startsWith(`${dir}/`) ? f.slice(dir.length + 1) : f
            // Un mismo paquete puede estar pineado en más de un archivo o
            // repo: una fila por repo+versión alcanza.
            for (const p of pinsInNix(readTextFile(f), `${repoName}/${rel}`)) pins.set(`${p.owner}/${p.repo}@${p.tag}`, p)
        }
    }
    const items: PinDrift[] = []
    for (const p of pins.values()) {
        const latest = await latestRelease(p.owner, p.repo)
        if (!latest || sameVersion(latest.tag, p.tag)) continue
        items.push({
            kind: "pin", id: `pin:${p.owner}/${p.repo}@${p.tag}`, title: p.repo,
            detail: `${p.tag} → ${latest.tag}  (${p.owner}/${p.repo}, ${p.file})`,
            releaseUrl: latest.url,
        })
    }
    return items
}

// ---- UI ----

let panelWin: any = null, listBox: any = null
const badges: Array<{ evt: any; label: any }> = []

const rowFor = (item: DriftItem): any => {
    const title = Label({ label: item.title, className: "updates-row-title" })
    title.set_halign(Gtk.Align.START)
    const detail = Label({ label: item.detail, className: "updates-row-detail" })
    detail.set_halign(Gtk.Align.START)
    detail.set_line_wrap(true)
    const texts = Box({ className: "updates-row-texts", children: [title, detail] })
    texts.set_orientation(Gtk.Orientation.VERTICAL)
    texts.set_hexpand(true)

    // Un pin no se puede aplicar solo (hay que editar la versión del .nix
    // y recalcular el hash), así que el botón lleva al release y la
    // decisión queda en la persona.
    const btnLabel = item.kind === "fork" ? "VER CAMBIOS" : item.kind === "pin" ? "VER RELEASE" : "ACTUALIZAR"
    const btn = Button({ label: btnLabel, className: "updates-btn" })
    btn.connect("clicked", () => {
        btn.set_sensitive(false)
        if (item.kind === "fork") openForkCompare(item.id)
        else if (item.kind === "pin") openPinRelease(item.id)
        else applyToolUpdate(item.id)
    })

    const row = Box({ className: "updates-row", children: [texts, btn] })
    row.set_orientation(Gtk.Orientation.HORIZONTAL)
    return row
}

const renderList = () => {
    if (!listBox) return
    for (const child of listBox.get_children()) listBox.remove(child)
    const all: DriftItem[] = [...current.forks, ...current.tools, ...current.pins]
    if (all.length === 0) {
        listBox.add(Label({ label: "Todo al día - sin forks, herramientas ni pines pendientes.", className: "updates-empty" }))
    } else {
        for (const item of all) listBox.add(rowFor(item))
    }
    listBox.show_all()
    updateBadge()
}

const pendingCount = () => current.forks.length + current.tools.length + current.pins.length

const updateBadge = () => {
    const n = pendingCount()
    for (const b of badges) {
        try { b.label.set_label(`⟳ ${n}`); b.evt.visible = n > 0 } catch { }
    }
}

export const refreshUpdates = async () => {
    const [forks, tools, pins] = await Promise.all([scanForkDrift(), scanToolDrift(), scanPinDrift()])
    current = { forks, tools, pins }
    renderList()
    return current
}

export const openForkCompare = async (id: string) => {
    const item = current.forks.find((i) => i.id === id)
    if (!item) return
    try { await execAsync(["xdg-open", item.compareUrl]) } catch (e) { print("[updates] xdg-open:", e) }
    const state = loadState()
    state.forks = state.forks || {}
    state.forks[item.id.slice("fork:".length)] = { lastSeenSha: item.latestSha }
    saveState(state)
    await refreshUpdates()
}

// Sin estado de "ya lo vi", a diferencia de los forks: el pin sigue
// pendiente hasta que el .nix cambie de versión, y esconderlo antes
// sería perder justo el aviso que no da ninguna otra herramienta.
export const openPinRelease = async (id: string) => {
    const item = current.pins.find((i) => i.id === id)
    if (!item) return
    try { await execAsync(["xdg-open", item.releaseUrl]) } catch (e) { print("[updates] xdg-open:", e) }
}

export const applyToolUpdate = async (id: string) => {
    const item = current.tools.find((i) => i.id === id)
    if (!item) return
    try {
        if (item.isPrivateLock) {
            // Ya hace exactamente esto: bump + valida evaluando todos los
            // hosts - no reinventarlo.
            await execAsync(["bash", `${item.repoDir}/scripts/check.sh`, "--lock"])
        } else {
            await execAsync([
                "nix", "--extra-experimental-features", "nix-command flakes",
                "flake", "update", item.inputName, "--flake", `path:${item.repoDir}`,
            ])
            await execAsync(["nix", "--extra-experimental-features", "nix-command flakes", "flake", "check", `path:${item.repoDir}`])
        }
        await execAsync(["git", "-C", item.repoDir, "add", "flake.lock"])
        await execAsync(["git", "-C", item.repoDir, "commit", "-m", `chore: bump ${item.inputName}`])
        showToast(`${item.inputName.toUpperCase()} ACTUALIZADO (falta push)`)
    } catch (e) {
        print("[updates] applyToolUpdate:", item.inputName, e)
        showToast(`${item.inputName.toUpperCase()}: FALLÓ EL UPDATE`)
    }
    await refreshUpdates()
}

export const toggleUpdatesPanel = () => {
    if (!panelWin) return
    if (panelWin.visible) { panelWin.visible = false; return }
    // Singleton igual que ShortcutsWindow (ver el comentario ahí): sin
    // `gdkmonitor` quedaba fijo en el primer monitor de get_monitors(),
    // no en el que tiene el foco - se reubica en cada apertura.
    ;(async () => {
        try { panelWin.gdkmonitor = await focusedMonitor() } catch {}
        refreshUpdates()
        panelWin.visible = true
    })()
}

export const closeUpdatesPanel = () => { if (panelWin) panelWin.visible = false }

// Badge chico y persistente (Layer.BOTTOM, montado como el resto del dock
// vía `surface()` en core.ts) - a diferencia del viejo aurbar.ts, nunca
// tapa otras apps: solo un contador que abre el panel al clickear.
export const UpdatesBadge = (_mon: any) => {
    const label = Label({ label: "", className: "updates-badge-label" })
    const box = Box({ className: "updates-badge", children: [label] })
    const evt = EventBox({ child: box })
    evt.visible = false
    evt.connect("button-press-event", () => { toggleUpdatesPanel(); return true })
    badges.push({ evt, label })
    return evt
}

// Panel de detalle a demanda (Layer.TOP, igual que ShortcutsWindow) - ya
// no queda nada en OVERLAY de forma persistente, que era la queja
// original (tapaba todo mientras durara el aviso, y el aviso volvía en
// cada re-chequeo).
export const UpdatesPanel = () => {
    listBox = Box({ className: "updates-list" })
    listBox.set_orientation(Gtk.Orientation.VERTICAL)

    const scroll = Scrollable({ child: listBox })
    scroll.set_size_request(520, 380)
    scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

    const title = Label({ label: "◤ ACTUALIZACIONES ◢", className: "updates-title" })
    title.set_halign(Gtk.Align.START)
    const legend = Label({ label: "Forks vs su upstream real, herramientas vs flake.lock y pines a mano vs su último release · Escape para cerrar", className: "updates-legend" })
    legend.set_halign(Gtk.Align.START)

    const inner = Box({ className: "updates-wrap", children: [title, legend, scroll] })
    inner.set_orientation(Gtk.Orientation.VERTICAL)
    inner.set_halign(Gtk.Align.CENTER)
    inner.set_valign(Gtk.Align.CENTER)

    panelWin = Window({
        name: "updates", className: "aug updates",
        anchor: Anchor.TOP | Anchor.LEFT | Anchor.BOTTOM | Anchor.RIGHT,
        exclusivity: Exclusivity.IGNORE,
        layer: Layer.TOP,
        keymode: Keymode.EXCLUSIVE,
        visible: false,
        child: inner,
    })
    panelWin.connect("key-press-event", (_w: any, e: any) => {
        let k = 0
        try { const r = e.get_keyval?.(); k = r ? r[1] : e.keyval } catch { }
        if (k === Gdk.KEY_Escape) closeUpdatesPanel()
        return true
    })

    renderList()
    const recheckAndToast = () => refreshUpdates().then(() => {
        const n = pendingCount()
        if (n > 0 && !panelWin.visible) showToast(`${n} ACTUALIZACION${n === 1 ? "" : "ES"} PENDIENTE${n === 1 ? "" : "S"}`)
    })
    timeout(4000, recheckAndToast)
    interval(RECHECK_MS, recheckAndToast)
    return panelWin
}
