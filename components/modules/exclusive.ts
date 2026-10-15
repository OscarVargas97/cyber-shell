// Los paneles grandes del HUD (pantalla completa, Layer.TOP y
// Keymode.EXCLUSIVE: atajos, actualizaciones, servicios) no se conocen
// entre sí, y hasta ahora ninguno cerraba a los demás. Con dos abiertos
// a la vez el compositor mapea las dos capas en el mismo nivel, así que
// una tapa a la otra - la que se creó después en core.ts queda encima -
// y como las dos piden el teclado en exclusiva, el Escape puede ir a la
// que no se ve. Se notó al sumar el panel de servicios: abrir
// actualizaciones parecía no hacer nada.
//
// El registro vive acá y no en core.ts para que cada panel siga siendo
// independiente: se anota al crearse y pide cerrar al resto al abrirse,
// sin importar cuántos haya ni en qué orden se creen.

type ExclusivePanel = { isOpen: () => boolean; close: () => void }

const panels = new Map<string, ExclusivePanel>()

export const registerExclusivePanel = (id: string, panel: ExclusivePanel) => { panels.set(id, panel) }

export const closeOtherPanels = (selfId: string) => {
    for (const [id, panel] of panels) {
        if (id === selfId) continue
        // Un panel roto no puede impedir que se abra otro: se ignora y se
        // sigue con el resto.
        try { if (panel.isOpen()) panel.close() } catch (e) { print("[exclusive] close", id, e) }
    }
}
