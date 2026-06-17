const SOURCE_KEYS = ['top100', 'news', 'macro', 'geopolitical', 'ai', 'cache'];

export function sanitizeBriefingDiagnosticReason(reason) {
  if (reason == null || reason === '') return null;
  let out = String(reason);
  out = out.replace(/([?&](?:key|api_key|auth_token|token|access_token)=)[^&\s"'<>]+/gi, '$1[redacted]');
  out = out.replace(/\bAIza[0-9A-Za-z_-]{12,}\b/g, '[redacted-google-key]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
  out = out.replace(/\b(UPSTASH_REDIS_REST_TOKEN|GEMINI_API_KEY|CRYPTOPANIC_TOKEN|SUPABASE_JWT_SECRET)\b[=:]\s*[^,\s;]+/gi, '$1=[redacted]');
  out = out.replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, 180) : null;
}

export function briefingSourceState(ok, reason = null, degraded = !ok) {
  return {
    ok: ok === true,
    degraded: degraded === true,
    reason: sanitizeBriefingDiagnosticReason(reason),
  };
}

export function createBriefingDiagnostics(initial = {}) {
  const sources = {};
  for (const key of SOURCE_KEYS) {
    sources[key] = briefingSourceState(true);
  }
  const incoming = initial && typeof initial === 'object' && initial.sources
    ? initial.sources
    : initial;
  for (const key of SOURCE_KEYS) {
    const value = incoming && incoming[key];
    if (!value || typeof value !== 'object') continue;
    sources[key] = briefingSourceState(value.ok === true, value.reason, value.degraded === true);
  }
  return { sources };
}

export function withBriefingDiagnostics(meta = {}, diagnostics = {}, overrides = {}) {
  const merged = createBriefingDiagnostics(diagnostics);
  for (const key of SOURCE_KEYS) {
    const value = overrides[key];
    if (!value || typeof value !== 'object') continue;
    merged.sources[key] = briefingSourceState(value.ok === true, value.reason, value.degraded === true);
  }
  return {
    ...meta,
    sources: merged.sources,
    diagnostics: {
      ...(meta && typeof meta.diagnostics === 'object' ? meta.diagnostics : {}),
      sources: merged.sources,
    },
  };
}
