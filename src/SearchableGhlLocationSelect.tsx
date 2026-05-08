import { useEffect, useRef, useState } from 'react';
import { crmJson } from './crm';

export type GhlCatalogRow = {
  ghl_subaccount_location_id_string: string;
  location_display_name_for_admin_ui: string;
  location_phone_preview_string?: string | null;
};

const inputClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20';

type Props = {
  value: string;
  onChange: (locationId: string) => void;
  placeholder?: string;
};

export function SearchableGhlLocationSelect({ value, onChange, placeholder }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<GhlCatalogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void (async () => {
        setLoading(true);
        try {
          const r = await crmJson<{ ok: boolean; data: GhlCatalogRow[] }>(
            `/phone-routing/admin/ghl-subaccount-locations-catalog-for-phone-routing-ui?q=${encodeURIComponent(q)}`,
          );
          setRows(r.data || []);
        } catch {
          setRows([]);
        } finally {
          setLoading(false);
        }
      })();
    }, 220);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={wrapRef} className="relative space-y-1">
      {value ? (
        <div className="flex items-center justify-between gap-2 rounded-md bg-slate-100 px-2 py-1.5 text-xs font-mono text-slate-700">
          <span className="truncate">{value}</span>
          <button type="button" className="shrink-0 text-indigo-600 hover:underline" onClick={() => onChange('')}>
            Clear
          </button>
        </div>
      ) : null}
      <input
        className={inputClass}
        placeholder={placeholder || 'Search GHL locations by name or ID…'}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <div className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {loading ? (
            <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">No matches</div>
          ) : (
            rows.map((r) => (
              <button
                key={r.ghl_subaccount_location_id_string}
                type="button"
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-slate-50"
                onClick={() => {
                  onChange(r.ghl_subaccount_location_id_string);
                  setQ('');
                  setOpen(false);
                }}
              >
                <span className="font-medium text-slate-900">{r.location_display_name_for_admin_ui}</span>
                <span className="font-mono text-[11px] text-slate-500">{r.ghl_subaccount_location_id_string}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
