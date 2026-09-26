#!/usr/bin/env python3
# Lee el token OAuth que Claude Code ya guarda en ~/.claude/.credentials.json
# (nunca se escribe ni se refresca acá - solo lectura, para no arriesgar la
# sesión real) y pega el mismo endpoint interno que usa el propio `claude`
# para mostrar "Session"/"Weekly" en su status: /api/oauth/usage. Mapeo
# verificado contra el provider de Claude en github.com/robinebers/openusage
# (MIT), que hace exactamente esto en macOS via Keychain.
#
# El gasto en USD (hoy/ayer/30 días) NO sale de ese endpoint: Anthropic no
# expone gasto diario vía el OAuth de Claude Code. openusage lo resuelve
# leyendo LOCALMENTE los logs de sesión que Claude Code ya escribe en
# ~/.claude/projects/**/*.jsonl (cada turno trae tokens de input/output/
# cache) y estimando el costo con la tabla de precios pública de LiteLLM
# (mismo mecanismo, ver docs/providers/claude.md de openusage). Replicamos
# eso acá: sin telemetría nueva, sin API key de billing.
import glob
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta

CREDS_PATH = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude") + "/.credentials.json")
USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1"
# User-Agent de claude-cli: Anthropic decide con esto si el cliente es
# elegible para "reset grants" (cedar_ember) - sin este header vuelve null.
USER_AGENT = "claude-cli/2.1.280 (external, cli)"

CACHE_DIR = os.path.expanduser("~/.cache/cyber-shell")
PRICING_CACHE_PATH = os.path.join(CACHE_DIR, "ai-usage-pricing.json")
SCAN_CACHE_PATH = os.path.join(CACHE_DIR, "ai-usage-scan.json")
# Precios de modelos Claude: catálogo público (MIT) de LiteLLM, la misma
# fuente que usa openusage para el gasto local.
PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
PRICING_TTL = 24 * 3600
DAYS_BACK = 30


def emit(obj):
    print(json.dumps(obj))


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # nombre de tmp único por proceso: dos corridas del script pueden
    # solaparse (onOpen + poll) y pisarse el mismo ".tmp" a mitad de escritura
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def fetch_pricing():
    """Tabla {modelo: {input, output, cache_write_5m, cache_write_1h, cache_read}}
    en USD por token, tomada de LiteLLM. Cachea 24h; sin red, devuelve el
    último cache aunque esté vencido antes que no mostrar nada."""
    cached = _read_json(PRICING_CACHE_PATH)
    if cached and time.time() - cached.get("fetched_at", 0) < PRICING_TTL:
        return cached["models"]

    try:
        req = urllib.request.Request(PRICING_URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = json.loads(resp.read().decode())
    except Exception:
        return cached["models"] if cached else None

    models = {}
    for name, spec in raw.items():
        if spec.get("litellm_provider") != "anthropic" or "input_cost_per_token" not in spec:
            continue
        models[name] = {
            "input": spec.get("input_cost_per_token") or 0,
            "output": spec.get("output_cost_per_token") or 0,
            "cache_write_5m": spec.get("cache_creation_input_token_cost") or 0,
            "cache_write_1h": spec.get("cache_creation_input_token_cost_above_1hr")
            or spec.get("cache_creation_input_token_cost") or 0,
            "cache_read": spec.get("cache_read_input_token_cost") or 0,
        }
    if not models:
        return cached["models"] if cached else None
    _write_json(PRICING_CACHE_PATH, {"fetched_at": time.time(), "models": models})
    return models


def resolve_model_price(pricing, model):
    if not model:
        return None
    if model in pricing:
        return pricing[model]
    bare = re.sub(r"-\d{8}$", "", model)  # variantes fechadas ("...-20251101") caen al alias sin fecha
    return pricing.get(bare)


def price_usage(spec, usage):
    inp = usage.get("input_tokens") or 0
    out = usage.get("output_tokens") or 0
    cache_read = usage.get("cache_read_input_tokens") or 0
    cc = usage.get("cache_creation") or {}
    c5 = cc.get("ephemeral_5m_input_tokens")
    c1h = cc.get("ephemeral_1h_input_tokens")
    if c5 is None and c1h is None:
        # logs viejos sin desglose de cache_creation: todo a la tarifa de 5m (default)
        c5, c1h = usage.get("cache_creation_input_tokens") or 0, 0
    return (
        inp * spec["input"] + out * spec["output"]
        + (c5 or 0) * spec["cache_write_5m"] + (c1h or 0) * spec["cache_write_1h"]
        + cache_read * spec["cache_read"]
    )


def claude_projects_dir():
    base = os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude")
    return os.path.join(os.path.expanduser(base), "projects")


def _scan_file(path, cached, pricing, since_ts):
    """Parsea, de forma incremental por offset de bytes, las líneas nuevas
    de un session log. Los logs de Claude Code son append-only, así que solo
    hace falta releer desde donde terminó la pasada anterior - evita
    reparsear sesiones activas de varios MB en cada refresh del modal."""
    st = os.stat(path)
    if cached and cached.get("size") == st.st_size and cached.get("mtime") == st.st_mtime:
        return cached["entries"], cached  # sin cambios, nada que reparsear

    if cached and cached.get("size", 0) <= st.st_size:
        offset, prior_entries = cached["offset"], cached["entries"]
    else:
        offset, prior_entries = 0, []  # truncado o reescrito: no hay que confiar en el offset viejo

    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    text = data.decode("utf-8", "ignore")
    complete = text if text.endswith("\n") else text[: text.rfind("\n") + 1]
    new_offset = offset + len(complete.encode("utf-8"))

    entries = list(prior_entries)
    for line in complete.splitlines():
        if '"usage"' not in line or '"type":"assistant"' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") != "assistant":
            continue
        msg = obj.get("message") or {}
        usage = msg.get("usage")
        ts = obj.get("timestamp")
        if not usage or not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            continue
        spec = resolve_model_price(pricing, msg.get("model"))
        usd = price_usage(spec, usage) if spec else None
        entries.append({
            "ts": dt.timestamp(),
            "day": dt.astimezone().strftime("%Y-%m-%d"),
            "usd": usd,
            "dedup": f"{msg.get('id')}|{obj.get('requestId')}",
        })
    # poda entradas que ya salieron de la ventana: el cache no puede crecer
    # sin límite en sesiones que llevan meses activas
    entries = [e for e in entries if e["ts"] >= since_ts]
    return entries, {"size": st.st_size, "mtime": st.st_mtime, "offset": new_offset, "entries": entries}


def compute_local_spend():
    """Gasto estimado (USD) de hoy/ayer/últimos 30 días, calculado 100%
    local a partir de los session logs de Claude Code - ver el comentario
    de cabecera del archivo. `available: False` cuando no hay logs o no se
    pudo traer la tabla de precios; nunca inventa un número."""
    pricing = fetch_pricing()
    if not pricing:
        return {"available": False, "reason": "no_pricing_data"}

    proj_dir = claude_projects_dir()
    if not os.path.isdir(proj_dir):
        return {"available": False, "reason": "no_logs"}

    now = datetime.now().astimezone()
    since_ts = (now - timedelta(days=DAYS_BACK, hours=24)).timestamp()  # margen por huso horario

    scan_cache = _read_json(SCAN_CACHE_PATH) or {}
    files_cache = scan_cache.get("files", {})
    new_files_cache = {}
    seen_dedup = set()
    day_totals = {}

    for path in glob.glob(os.path.join(proj_dir, "**", "*.jsonl"), recursive=True):
        try:
            if os.stat(path).st_mtime < since_ts:
                continue  # no tocado en la ventana: no puede aportar datos nuevos
            entries, new_entry = _scan_file(path, files_cache.get(path), pricing, since_ts)
        except OSError:
            continue
        new_files_cache[path] = new_entry
        for e in entries:
            if e["ts"] < since_ts or e["usd"] is None or e["dedup"] in seen_dedup:
                continue
            seen_dedup.add(e["dedup"])
            day_totals[e["day"]] = day_totals.get(e["day"], 0.0) + e["usd"]

    _write_json(SCAN_CACHE_PATH, {"files": new_files_cache})

    daily = [
        {"date": d, "usd": round(day_totals.get(d, 0.0), 4)}
        for d in (
            (now - timedelta(days=i)).strftime("%Y-%m-%d")
            for i in range(DAYS_BACK - 1, -1, -1)
        )
    ]
    today = now.strftime("%Y-%m-%d")
    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    return {
        "available": True,
        "today_usd": round(day_totals.get(today, 0.0), 4),
        "yesterday_usd": round(day_totals.get(yesterday, 0.0), 4),
        "last_30d_usd": round(sum(d["usd"] for d in daily), 4),
        "daily": daily,
    }


def main():
    try:
        with open(CREDS_PATH) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return emit({"ok": False, "error": "no_credentials"})

    oauth = data.get("claudeAiOauth") or {}
    token = oauth.get("accessToken")
    if not token:
        return emit({"ok": False, "error": "no_credentials"})

    scopes = oauth.get("scopes") or []
    if scopes and "user:profile" not in scopes:
        return emit({"ok": False, "error": "missing_profile_scope"})

    expires_at = oauth.get("expiresAt")
    if expires_at and expires_at / 1000 <= time.time():
        return emit({"ok": False, "error": "token_expired"})

    req = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {token.strip()}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return emit({"ok": False, "error": "token_expired"})
        if e.code == 429:
            retry = e.headers.get("retry-after")
            return emit({"ok": False, "error": "rate_limited", "retry_after": retry})
        return emit({"ok": False, "error": f"http_{e.code}"})
    except Exception:
        return emit({"ok": False, "error": "connection_failed"})

    def window(key):
        w = body.get(key) or {}
        return {"pct": w.get("utilization"), "resets_at": w.get("resets_at")}

    extra = body.get("extra_usage") or {}
    grants = ((body.get("cedar_ember") or {}).get("grants")) or []
    resets_available = sum(
        int(g.get("resets_left") or 0) for g in grants if g.get("usable_now")
    )

    plan = oauth.get("subscriptionType")
    tier = oauth.get("rateLimitTier") or ""
    if plan and "x" in tier:
        m = re.search(r"\d+x", tier)
        if m:
            plan = f"{plan} {m.group(0)}"

    try:
        local_spend = compute_local_spend()
    except Exception:
        # el gasto local es un extra sobre los datos de la cuenta - un log
        # corrupto o sin permisos no debería tirar abajo el resto del modal
        local_spend = {"available": False, "reason": "scan_failed"}

    emit({
        "ok": True,
        "plan": plan,
        "session": window("five_hour"),
        "weekly": window("seven_day"),
        "extra_usage": {
            "enabled": bool(extra.get("is_enabled")),
            "used_usd": (extra.get("used_credits") or 0) / 100 if extra.get("used_credits") is not None else None,
            "limit_usd": (extra.get("monthly_limit") or 0) / 100 if extra.get("monthly_limit") is not None else None,
        },
        "resets_available": resets_available,
        "local_spend": local_spend,
    })


if __name__ == "__main__":
    main()
