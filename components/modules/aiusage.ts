// Helpers puros para el modal de uso de Claude Code (ver AiUsageCtrl en
// cmodal.ts, junto al resto de los controladores). Separado del resto de
// cmodal.ts solo por tamaño - createModal vive ahí y no puede importarse
// acá sin un ciclo.
export type UsageWindow = { pct: number | null; resets_at: string | null }
export type AiUsage = {
    ok: boolean
    error?: string
    plan?: string
    session?: UsageWindow
    weekly?: UsageWindow
    extra_usage?: { enabled: boolean; used_usd: number | null; limit_usd: number | null }
    resets_available?: number
}

export const AI_USAGE_ERR_TEXT: Record<string, string> = {
    no_credentials: "SIN SESIÓN · corré `claude` para iniciar sesión",
    missing_profile_scope: "RE-LOGIN NECESARIO · corré `claude` de nuevo",
    token_expired: "TOKEN VENCIDO · usá `claude` para refrescarlo",
    rate_limited: "ANTHROPIC LIMITÓ LOS PEDIDOS · reintentando más tarde",
    connection_failed: "SIN CONEXIÓN",
}

export const fmtAiUsageEta = (iso: string | null | undefined): string => {
    if (!iso) return ""
    const ms = new Date(iso).getTime() - Date.now()
    if (isNaN(ms) || ms <= 0) return "RESETEANDO…"
    const mins = Math.round(ms / 60000)
    const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60
    if (d > 0) return `RESETEA EN ${d}D ${h}H`
    if (h > 0) return `RESETEA EN ${h}H ${m}M`
    return `RESETEA EN ${m}M`
}
