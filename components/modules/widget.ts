import { Astal, Gtk } from "ags/gtk3"
import app from "ags/gtk3/app"
import Gdk from "gi://Gdk?version=3.0"
import { execAsync } from "ags/process"
export { Astal }
export const App = app

export const activeMonitor = () => {
 try {
 const d = Gdk.Display.get_default()
 const [, x, y] = d.get_default_seat().get_pointer().get_position()
 return d.get_monitor_at_point(x, y)
 } catch { return null }
}

export const monitorAtPoint = (x, y) => {
 try {
 const d = Gdk.Display.get_default()
 return d.get_monitor_at_point(x, y)
 } catch { return null }
}

// Monitor con foco real de Hyprland - distinto de activeMonitor(), que
// sigue al mouse. Para un popup que se abre con un bind (Super+Shift+S,
// apps-menu, notif-hud...) lo que importa es dónde está trabajando la
// persona (foco de teclado), no dónde quedó parado el cursor: con el
// mouse parado en el monitor externo mientras se trabaja por teclado en
// el laptop, activeMonitor() abría el popup en el monitor equivocado -
// bug real confirmado en vivo con dos monitores. Se resuelve el monitor
// "focused: true" de `hyprctl monitors -j` a coordenadas y de ahí a un
// Gdk.Monitor con el mismo monitorAtPoint() de arriba (Gdk no expone los
// monitores por nombre de conector, así que hay que pasar por un punto).
// Sin caché a propósito, mismo criterio que keyForAgsRequest en
// keymap.ts: la llamada es barata y sólo se hace al abrir un popup, nunca
// en un loop.
export const focusedMonitor = async () => {
 try {
 const mons = JSON.parse(await execAsync(["hyprctl", "monitors", "-j"])) as any[]
 const m = mons.find((x) => x && x.focused)
 if (!m) return null
 return monitorAtPoint(m.x + Math.floor(m.width / 2), m.y + Math.floor(m.height / 2))
 } catch { return null }
}
export const Anchor = Astal.WindowAnchor
export const Layer = Astal.Layer
export const Exclusivity = Astal.Exclusivity
export const Keymode = Astal.Keymode

// La vieja lib astal/gtk3 (ya no existe en ags v3.1) traducia props de
// conveniencia ("child", "children", "className") que no son propiedades
// GObject reales en las clases Astal.* - se aplican a mano aca. El resto
// de las props pasan directo al constructor (son propiedades GObject
// legitimas: vexpand, halign, label, etc).
const build = (Ctor: any, p: any = {}) => {
 const { child, children, className, ...rest } = p
 const w = new Ctor(rest)
 if (className) {
 for (const cls of String(className).split(/\s+/).filter(Boolean)) {
 w.get_style_context().add_class(cls)
 }
 }
 const kids = children ?? (child ? [child] : [])
 for (const k of kids) { try { w.add(k) } catch {} }
 // GTK3: un widget nuevo esta oculto salvo que se muestre a mano - la
 // vieja lib astal/gtk3 lo hacia visible por defecto, ags/gtk3 (Astal
 // GObject puro) no. Respeta "visible: false" explicito si vino en props.
 if (p.visible !== false) { try { w.show() } catch {} }
 return w
}

export const Box = (p?) => build(Astal.Box, p)
export const Button = (p?) => build(Astal.Button, p)
export const Label = (p?) => build(Astal.Label, p)
export const Icon = (p?) => build(Astal.Icon, p)
export const Window = (p?) => build(Astal.Window, { application: App, ...p })
export const EventBox = (p?) => build(Astal.EventBox, p)
export const Overlay = (p?) => build(Astal.Overlay, p)
export const Scrollable = (p?) => build(Astal.Scrollable, p)
export const Revealer = (p?) => build(Gtk.Revealer, p)
export const Entry = (p?) => build(Gtk.Entry, p)
export const Slider = (p?) => build(Astal.Slider, p)
export const DrawingArea = (p?) => build(Gtk.DrawingArea, p)
export const CenterBox = (p?) => build(Astal.CenterBox, p)
