// Fuente única para "qué tecla dispara qué comando del HUD": lee
// `hyprctl binds -j` en vivo (mismo mecanismo que ya usa el panel de
// shortcuts, Mod+K) en vez de que cada popup hardcodee su propia letra.
// Sin esto, un cambio de bind en hyprland.nix (workos) requiere acordarse
// de tocar también el string en este repo - ya pasó, y el HUD quedó
// mostrando una tecla que no era la real.
import { execAsync } from "ags/process"

export const MOD_BITS: Array<[number, string]> = [
    [64, "SUPER"], [8, "ALT"], [4, "CTRL"], [1, "SHIFT"],
]
export const modmaskToStr = (mask: number): string =>
    MOD_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name).join(" + ")

type HyprBind = { modmask: number, key: string, dispatcher: string, arg: string, description: string }

// Sin caché a propósito: un bind cambia en hyprland.nix -> rebuild/reload
// -> hyprctl ya lo tiene, y este helper lo tiene que ver en la próxima
// consulta, no en el próximo reinicio del HUD. La llamada es barata y
// sólo se hace al abrir un popup o el panel de shortcuts, no en un loop.
export const getBinds = (): Promise<HyprBind[]> =>
    execAsync(["hyprctl", "binds", "-j"])
        .then((out: string) => JSON.parse(out) as HyprBind[])
        .catch((e: any) => { print("[keymap] hyprctl binds:", e); return [] as HyprBind[] })

// Para los keycaps compactos de los popups (20-24px, pensados para una
// sola letra): todo el HUD comparte SUPER como base, así que se omite del
// label - solo se muestra el resto de modificadores (si los hay) + la
// tecla. "?" si el comando no tiene ningún bind (mejor una señal visible
// de que falta mapear que una letra vieja/inventada).
export const keyForAgsRequest = async (command: string): Promise<string> => {
    const binds = await getBinds()
    const b = binds.find((x) => x.dispatcher === "exec" && (x.arg || "").includes(`ags request -i cyberpunk ${command}`))
    if (!b) return "?"
    const extraMods = MOD_BITS.filter(([bit, name]) => name !== "SUPER" && (b.modmask & bit) !== 0).map(([, name]) => name)
    return [...extraMods, b.key].filter(Boolean).join("+")
}
