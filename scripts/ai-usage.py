#!/usr/bin/env python3
# Lee el token OAuth que Claude Code ya guarda en ~/.claude/.credentials.json
# (nunca se escribe ni se refresca acá - solo lectura, para no arriesgar la
# sesión real) y pega el mismo endpoint interno que usa el propio `claude`
# para mostrar "Session"/"Weekly" en su status: /api/oauth/usage. Mapeo
# verificado contra el provider de Claude en github.com/robinebers/openusage
# (MIT), que hace exactamente esto en macOS via Keychain.
import json
import os
import time
import urllib.error
import urllib.request

CREDS_PATH = os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude") + "/.credentials.json")
USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1"
# User-Agent de claude-cli: Anthropic decide con esto si el cliente es
# elegible para "reset grants" (cedar_ember) - sin este header vuelve null.
USER_AGENT = "claude-cli/2.1.280 (external, cli)"


def emit(obj):
    print(json.dumps(obj))


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
        import re
        m = re.search(r"\d+x", tier)
        if m:
            plan = f"{plan} {m.group(0)}"

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
    })


if __name__ == "__main__":
    main()
