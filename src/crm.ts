const CRM_PREFIX = '/api/formflow/crm';

function origin(): string {
  // Force production clickupbackend for this admin UI.
  return 'https://click.acquisition-central.com';
}

function authHeaders(base?: HeadersInit): Headers {
  const h = new Headers(base);
  const key = import.meta.env.VITE_FORMFLOW_CRM_API_KEY;
  if (key) h.set('x-formflow-crm-key', String(key));
  return h;
}

export async function crmJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const p = path.startsWith('/') ? path : `/${path}`;
  const url = `${origin()}${CRM_PREFIX}${p}`;
  const headers = authHeaders(init?.headers as HeadersInit);
  if (init?.body != null && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(text?.slice(0, 400) || res.statusText);
  }
  if (!res.ok) {
    const msg = json.error ?? json.message;
    throw new Error(typeof msg === 'string' ? msg : text?.slice(0, 400) || res.statusText);
  }
  if ('ok' in json && json.ok === false) {
    throw new Error(String(json.error || 'Request failed'));
  }
  return json as T;
}
