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
import { Window, Box, Button, Label, Scrollable, EventBox, Anchor, Layer, Exclusivity, Keymode } from "./widget.ts"
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
type DriftItem = ForkDrift | ToolDrift

let current: { forks: ForkDrift[]; tools: ToolDrift[] } = { forks: [], tools: [] }

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

    const btn = Button({ label: item.kind === "fork" ? "VER CAMBIOS" : "ACTUALIZAR", className: "updates-btn" })
    btn.connect("clicked", () => {
        btn.set_sensitive(false)
        if (item.kind === "fork") openForkCompare(item.id)
        else applyToolUpdate(item.id)
    })

    const row = Box({ className: "updates-row", children: [texts, btn] })
    row.set_orientation(Gtk.Orientation.HORIZONTAL)
    return row
}

const renderList = () => {
    if (!listBox) return
    for (const child of listBox.get_children()) listBox.remove(child)
    const all: DriftItem[] = [...current.forks, ...current.tools]
    if (all.length === 0) {
        listBox.add(Label({ label: "Todo al día - sin forks ni herramientas pendientes.", className: "updates-empty" }))
    } else {
        for (const item of all) listBox.add(rowFor(item))
    }
    listBox.show_all()
    updateBadge()
}

const updateBadge = () => {
    const n = current.forks.length + current.tools.length
    for (const b of badges) {
        try { b.label.set_label(`⟳ ${n}`); b.evt.visible = n > 0 } catch { }
    }
}

export const refreshUpdates = async () => {
    const [forks, tools] = await Promise.all([scanForkDrift(), scanToolDrift()])
    current = { forks, tools }
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
    refreshUpdates()
    panelWin.visible = true
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
    const legend = Label({ label: "Forks vs su upstream real, y herramientas del sistema vs flake.lock · Escape para cerrar", className: "updates-legend" })
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
        const n = current.forks.length + current.tools.length
        if (n > 0 && !panelWin.visible) showToast(`${n} ACTUALIZACION${n === 1 ? "" : "ES"} PENDIENTE${n === 1 ? "" : "S"}`)
    })
    timeout(4000, recheckAndToast)
    interval(RECHECK_MS, recheckAndToast)
    return panelWin
}
