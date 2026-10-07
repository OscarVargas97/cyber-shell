// Panel de servicios de fondo: ver de un vistazo qué corre detrás de la
// sesión (slk, syncs, bootstraps) y poder detenerlo, darlo de baja o
// reactivarlo sin acordarse de ningún comando de systemd.
//
// No hay lista de servicios acá: `workos-services list` los descubre
// preguntándole a systemd cuáles llevan la marca de WorkOS en su
// Documentation, así que un servicio nuevo aparece en este panel sin
// tocar este archivo (mismo criterio que updates.ts con los forks).
//
// La baja es persistente de verdad: Home Manager repone las unidades en
// cada rebuild, así que `systemctl --user disable` no alcanzaría; el CLI
// la anota en un archivo de estado que las unidades consultan al arrancar.
import { Window, Box, Button, Label, Scrollable, EventBox, Anchor, Layer, Exclusivity, Keymode, focusedMonitor } from "./widget.ts"
import Gtk from "gi://Gtk?version=3.0"
import Gdk from "gi://Gdk?version=3.0"
import { execAsync } from "ags/process"
import { interval, timeout } from "ags/time"
import GLib from "gi://GLib"
import { showToast } from "./toast.ts"

const RECHECK_MS = 30000 // 30s - es un systemctl local, barato

type Servicio = {
    id: string
    nombre: string
    descripcion: string
    active: string
    sub: string
    result: string
    tipo: string
    deBaja: boolean
}

let current: Servicio[] = []
let fallidosAvisados = new Set<string>()
const badges: Array<{ evt: any; label: any }> = []

const cli = (args: string[]) => execAsync(["workos-services", ...args])

export const refreshServices = async (): Promise<Servicio[]> => {
    try {
        current = JSON.parse(await cli(["list"]))
    } catch (e) {
        print("[services] list:", e)
        current = []
    }
    renderList()
    return current
}

// Estado mostrado. Un oneshot que terminó bien queda `inactive`, igual que
// uno detenido a mano: sin mirar el Type, los syncs de login se verían
// siempre como "detenidos" y el panel mentiría.
const estadoDe = (s: Servicio): { texto: string; clase: string } => {
    if (s.deBaja) return { texto: "DE BAJA", clase: "off" }
    if (s.active === "failed") return { texto: "FALLÓ", clase: "bad" }
    if (s.active === "activating") return { texto: "ARRANCANDO", clase: "warn" }
    if (s.active === "active") return { texto: "ACTIVO", clase: "ok" }
    if (s.tipo === "oneshot" && s.result === "success") return { texto: "COMPLETÓ", clase: "ok" }
    return { texto: "DETENIDO", clase: "off" }
}

const accion = async (args: string[], aviso: string) => {
    try {
        await cli(args)
        showToast(aviso)
    } catch (e) {
        print("[services]", args.join(" "), e)
        showToast(`${args[1]?.toUpperCase() ?? "SERVICIO"}: FALLÓ LA ACCIÓN`)
    }
    await refreshServices()
}

// El journal no cabe en el panel: se abre en una terminal. $TERMINAL
// primero para no hardcodear la terminal de nadie; kitty como fallback
// porque es la que trae este sistema.
const verLogs = (s: Servicio) => {
    const term = GLib.getenv("TERMINAL") || "kitty"
    execAsync(["sh", "-c", `${term} -e sh -c 'workos-services logs ${s.nombre}; read -r _'`])
        .catch((e) => {
            print("[services] logs:", e)
            showToast("NO SE PUDO ABRIR LA TERMINAL")
        })
}

let panelWin: any = null, listBox: any = null

const botonera = (s: Servicio): any[] => {
    const botones: any[] = []
    const mk = (label: string, clase: string, fn: () => void) => {
        const b = Button({ label, className: `services-btn ${clase}` })
        b.connect("clicked", () => { b.set_sensitive(false); fn() })
        return b
    }

    if (s.deBaja) {
        botones.push(mk("REACTIVAR", "good", () => accion(["enable", s.nombre], `${s.nombre.toUpperCase()}: REACTIVADO`)))
    } else {
        if (s.active === "active" || s.active === "activating") {
            botones.push(mk("DETENER", "", () => accion(["stop", s.id], `${s.nombre.toUpperCase()}: DETENIDO`)))
        } else {
            botones.push(mk("ARRANCAR", "good", () => accion(["start", s.id], `${s.nombre.toUpperCase()}: ARRANCADO`)))
        }
        botones.push(mk("DAR DE BAJA", "danger", () => accion(["disable", s.nombre], `${s.nombre.toUpperCase()}: DADO DE BAJA`)))
    }
    botones.push(mk("LOGS", "", () => { verLogs(s); timeout(300, () => refreshServices()) }))
    return botones
}

const rowFor = (s: Servicio): any => {
    const est = estadoDe(s)

    const chip = Label({ label: est.texto, className: `services-chip ${est.clase}` })
    chip.set_halign(Gtk.Align.START)
    chip.set_valign(Gtk.Align.CENTER)

    const title = Label({ label: s.nombre, className: "services-row-title" })
    title.set_halign(Gtk.Align.START)
    // La descripción viene de la propia unidad: explica para qué está el
    // servicio sin tener que duplicarla acá.
    const detail = Label({ label: s.descripcion || s.id, className: "services-row-detail" })
    detail.set_halign(Gtk.Align.START)
    detail.set_line_wrap(true)
    detail.set_max_width_chars(46)

    const texts = Box({ className: "services-row-texts", children: [title, detail] })
    texts.set_orientation(Gtk.Orientation.VERTICAL)
    texts.set_hexpand(true)

    const acciones = Box({ className: "services-row-actions", children: botonera(s) })
    acciones.set_orientation(Gtk.Orientation.HORIZONTAL)
    acciones.set_valign(Gtk.Align.CENTER)

    const row = Box({ className: "services-row", children: [chip, texts, acciones] })
    row.set_orientation(Gtk.Orientation.HORIZONTAL)
    return row
}

const renderList = () => {
    if (!listBox) return
    for (const child of listBox.get_children()) listBox.remove(child)
    if (current.length === 0) {
        listBox.add(Label({ label: "No hay servicios de WorkOS declarados.", className: "services-empty" }))
    } else {
        for (const s of current) listBox.add(rowFor(s))
    }
    listBox.show_all()
    updateBadge()
}

const updateBadge = () => {
    const rotos = current.filter((s) => s.active === "failed").length
    for (const b of badges) {
        try { b.label.set_label(`⚙ ${rotos}`); b.evt.visible = rotos > 0 } catch { }
    }
}

export const toggleServicesPanel = () => {
    if (!panelWin) return
    if (panelWin.visible) { panelWin.visible = false; return }
    // Mismo singleton reubicable que UpdatesPanel: sin fijar gdkmonitor en
    // cada apertura, queda clavado en el primer monitor y no en el que
    // tiene el foco.
    ;(async () => {
        try { panelWin.gdkmonitor = await focusedMonitor() } catch { }
        refreshServices()
        panelWin.visible = true
    })()
}

export const closeServicesPanel = () => { if (panelWin) panelWin.visible = false }

// Badge chico: solo aparece si algún servicio falló. En estado normal no
// ocupa nada del HUD - el panel se abre por atajo.
export const ServicesBadge = (_mon: any) => {
    const label = Label({ label: "", className: "services-badge-label" })
    const box = Box({ className: "services-badge", children: [label] })
    const evt = EventBox({ child: box })
    evt.visible = false
    evt.connect("button-press-event", () => { toggleServicesPanel(); return true })
    badges.push({ evt, label })
    return evt
}

export const ServicesPanel = () => {
    listBox = Box({ className: "services-list" })
    listBox.set_orientation(Gtk.Orientation.VERTICAL)

    const scroll = Scrollable({ child: listBox })
    scroll.set_size_request(640, 400)
    scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

    const title = Label({ label: "◤ SERVICIOS DE FONDO ◢", className: "services-title" })
    title.set_halign(Gtk.Align.START)
    const legend = Label({
        label: "DETENER es hasta el próximo login · DAR DE BAJA no vuelve hasta reactivarlo · Escape para cerrar",
        className: "services-legend",
    })
    legend.set_halign(Gtk.Align.START)

    const inner = Box({ className: "services-wrap", children: [title, legend, scroll] })
    inner.set_orientation(Gtk.Orientation.VERTICAL)
    inner.set_halign(Gtk.Align.CENTER)
    inner.set_valign(Gtk.Align.CENTER)

    panelWin = Window({
        name: "services", className: "aug services",
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
        if (k === Gdk.KEY_Escape) closeServicesPanel()
        return true
    })

    renderList()
    // Avisa una sola vez por servicio caído: el re-chequeo corre cada 30s y
    // un toast repetido cada media vuelta sería ruido, no información.
    const recheck = () => refreshServices().then(() => {
        for (const s of current) {
            if (s.active === "failed" && !fallidosAvisados.has(s.id)) {
                fallidosAvisados.add(s.id)
                if (!panelWin.visible) showToast(`${s.nombre.toUpperCase()}: SERVICIO CAÍDO`)
            }
            if (s.active !== "failed") fallidosAvisados.delete(s.id)
        }
    })
    timeout(5000, recheck)
    interval(RECHECK_MS, recheck)
    return panelWin
}
