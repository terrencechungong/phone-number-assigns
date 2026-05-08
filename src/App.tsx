import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { crmJson } from './crm';
import { SearchableGhlLocationSelect, type GhlCatalogRow } from './SearchableGhlLocationSelect';

type Tab = 'sources' | 'inventory' | 'assign';

type SourceRow = {
  id: string;
  ghl_subaccount_location_id_string_that_phone_numbers_belong_to: string;
  optional_human_readable_label_for_admin_ui_only?: string | null;
  row_disabled_boolean?: boolean;
};

type InvRow = {
  id: string;
  e164_phone_number_string_normalized_digits_only: string;
  ghl_subaccount_location_id_string_for_which_subaccount_this_number_was_provisioned: string;
  optional_inventory_display_name_for_admin_ui_only?: string | null;
  client_hub_phone_inventory_line_usage_intent_enum?: string;
};

type AsgRow = {
  id: string;
  e164_phone_number_string_normalized_digits_only: string;
  ffcrm_client_hub_clients_collection_row_id_string: string;
  ghl_subaccount_location_id_string_must_equal_inventory_and_client_for_validation: string;
  client_hub_phone_assignment_line_usage_intent_enum?: string;
};

type PickerOption = {
  picker_row_kind_enum: string;
  mongo_inventory_row_id_string: string | null;
  e164_phone_number_string_normalized_digits_only: string;
  ghl_subaccount_location_id_string: string;
  client_hub_phone_inventory_line_usage_intent_enum?: string;
  client_hub_phone_inventory_line_usage_intent_for_autocreate_when_row_created_via_picker_enum?: string;
  display_label_for_picklist_ui_only: string;
};

const INTENT_OPTIONS = ['remarketing', 'lead'] as const;

/** Map DB / legacy intents to the two SMB line slots for `<select value=…>`. */
function lineIntentForSelect(raw: string | null | undefined): (typeof INTENT_OPTIONS)[number] {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (v === 'lead' || v === 'lead_response') return 'lead';
  return 'remarketing';
}

function lineIntentLabelForUi(raw: string | null | undefined): string {
  if (raw == null || String(raw).trim() === '') return '—';
  return lineIntentForSelect(raw) === 'lead' ? 'Lead' : 'Remarketing';
}

/** Parse intent from API-built picker label when enum fields are missing (e.g. older responses or empty strings). */
function parseLineIntentFromPickerDisplayLabel(label: string): (typeof INTENT_OPTIONS)[number] | null {
  const s = String(label || '');
  // Inventory rows: "… · lead · …" / "… · remarketing · …" (also legacy lead_response etc.)
  const invMatch = s.match(/\s·\s(lead_response|lead|remarketing|general_inbound|other)\s·\s/i);
  if (invMatch) return lineIntentForSelect(invMatch[1]);
  // Live (filtered): "live GHL → remarketing · …"
  const liveArrow = s.match(/live GHL\s*→\s*(lead_response|lead|remarketing|general_inbound|other)/i);
  if (liveArrow) return lineIntentForSelect(liveArrow[1]);
  if (/auto-adds as remarketing/i.test(s)) return 'remarketing';
  return null;
}

function firstNonEmptyPickerIntentField(opt: PickerOption): string | undefined {
  const a = opt.client_hub_phone_inventory_line_usage_intent_enum;
  const b = opt.client_hub_phone_inventory_line_usage_intent_for_autocreate_when_row_created_via_picker_enum;
  if (a != null && String(a).trim() !== '') return String(a).trim();
  if (b != null && String(b).trim() !== '') return String(b).trim();
  return undefined;
}

/** Intent for POST / display — enum fields, else parsed label (same source the server puts in display_label). */
function assignmentIntentFromPickerOption(opt: PickerOption): (typeof INTENT_OPTIONS)[number] {
  const raw = firstNonEmptyPickerIntentField(opt);
  const fromField = raw !== undefined ? lineIntentForSelect(raw) : null;
  const fromLabel = parseLineIntentFromPickerDisplayLabel(opt.display_label_for_picklist_ui_only ?? '');
  if (fromField === 'lead' || fromLabel === 'lead') return 'lead';
  return 'remarketing';
}

/** Picker rows from live GHL only — not yet in manual inventory (add-inventory flow). */
const PICKER_KIND_LIVE_GHL = 'from_live_ghl_phone_system_api_not_yet_in_manual_inventory_table';

function hubClientRecordHint(ffcrmClientHubRowId: string): string {
  const s = String(ffcrmClientHubRowId || '').trim();
  if (!s) return '—';
  if (s.startsWith('ghl-subaccount:')) return 'No Client Hub Mongo row — linked by GHL location only';
  return s.length > 14 ? `${s.slice(0, 10)}…${s.slice(-4)}` : s;
}

function formatE164(digits: string) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return d ? `+${d}` : '—';
}

function normE164Digits(digits: string) {
  return String(digits || '').replace(/\D/g, '');
}

function locationDisplayName(locationId: string, sources: SourceRow[], catalog: GhlCatalogRow[]) {
  const sid = String(locationId || '').trim();
  if (!sid) return '—';
  const src = sources.find((s) => s.ghl_subaccount_location_id_string_that_phone_numbers_belong_to === sid);
  const label = src?.optional_human_readable_label_for_admin_ui_only?.trim();
  if (label) return label;
  const c = catalog.find((x) => x.ghl_subaccount_location_id_string === sid);
  const catName = c?.location_display_name_for_admin_ui?.trim();
  if (catName) return catName;
  return '—';
}

/** Step 3 dropdown: line intent + E.164 only. */
function formatAssignPickerOptionLabel(opt: PickerOption) {
  const canon = assignmentIntentFromPickerOption(opt);
  const intentLoud = canon === 'lead' ? 'LEAD' : 'REMARKETING';
  const phone = formatE164(opt.e164_phone_number_string_normalized_digits_only);
  return `[LINE INTENT: ${intentLoud}] · ${phone}`;
}

type UnifiedInventoryTableRow =
  | { key: string; tier: 0; kind: 'assigned'; asg: AsgRow; invRow?: InvRow }
  | { key: string; tier: 1; kind: 'inventory_unassigned'; inv: InvRow }
  | { key: string; tier: 2; kind: 'live_ghl'; pick: PickerOption };

function buildUnifiedInventoryRows(
  asg: AsgRow[],
  inv: InvRow[],
  overviewPickers: PickerOption[],
): UnifiedInventoryTableRow[] {
  const norm = normE164Digits;
  const assignedDigits = new Set(asg.map((a) => norm(a.e164_phone_number_string_normalized_digits_only)));

  const assigned: UnifiedInventoryTableRow[] = asg.map((a) => {
    const e = norm(a.e164_phone_number_string_normalized_digits_only);
    const invRow = inv.find((i) => norm(i.e164_phone_number_string_normalized_digits_only) === e);
    return { key: `asg-${a.id}`, tier: 0, kind: 'assigned', asg: a, invRow };
  });
  assigned.sort((x, y) =>
    norm(x.asg.e164_phone_number_string_normalized_digits_only).localeCompare(
      norm(y.asg.e164_phone_number_string_normalized_digits_only),
    ),
  );

  const invUn: UnifiedInventoryTableRow[] = inv
    .filter((i) => !assignedDigits.has(norm(i.e164_phone_number_string_normalized_digits_only)))
    .map((i) => ({ key: `inv-${i.id}`, tier: 1, kind: 'inventory_unassigned', inv: i }));
  invUn.sort((x, y) =>
    norm(x.inv.e164_phone_number_string_normalized_digits_only).localeCompare(
      norm(y.inv.e164_phone_number_string_normalized_digits_only),
    ),
  );

  const invLocKeys = new Set(
    inv.map(
      (i) =>
        `${norm(i.e164_phone_number_string_normalized_digits_only)}::${String(i.ghl_subaccount_location_id_string_for_which_subaccount_this_number_was_provisioned || '').trim()}`,
    ),
  );

  const live: UnifiedInventoryTableRow[] = [];
  for (const o of overviewPickers) {
    if (o.picker_row_kind_enum !== PICKER_KIND_LIVE_GHL) continue;
    const e = norm(o.e164_phone_number_string_normalized_digits_only);
    const loc = String(o.ghl_subaccount_location_id_string || '').trim();
    if (!e || !loc) continue;
    if (assignedDigits.has(e)) continue;
    if (invLocKeys.has(`${e}::${loc}`)) continue;
    if (inv.some((i) => norm(i.e164_phone_number_string_normalized_digits_only) === e)) continue;
    live.push({ key: `live-${e}-${loc}`, tier: 2, kind: 'live_ghl', pick: o });
  }
  live.sort((x, y) => {
    const a = x.pick.ghl_subaccount_location_id_string.localeCompare(y.pick.ghl_subaccount_location_id_string);
    if (a !== 0) return a;
    return norm(x.pick.e164_phone_number_string_normalized_digits_only).localeCompare(
      norm(y.pick.e164_phone_number_string_normalized_digits_only),
    );
  });

  return [...assigned, ...invUn, ...live];
}

function NavBtn({
  active,
  icon,
  label,
  desc,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition ${
        active
          ? 'bg-white/10 text-white shadow-inner ring-1 ring-white/20'
          : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      }`}
    >
      <span className="mt-0.5 shrink-0 opacity-90">{icon}</span>
      <span>
        <span className="block text-sm font-medium leading-tight">{label}</span>
        <span className="mt-0.5 block text-xs font-normal text-slate-500">{desc}</span>
      </span>
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-slate-400">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20';

const btnPrimary =
  'inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50';

const btnDanger = 'rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100';

const btnSecondary =
  'inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50';

const cellSelectClass =
  'w-full min-w-[7.5rem] max-w-[11rem] rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-900';

const cellInputClass =
  'w-full min-w-[6rem] max-w-[10rem] rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-900';

export function App() {
  const [tab, setTab] = useState<Tab>('sources');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [sourceCatalogRows, setSourceCatalogRows] = useState<GhlCatalogRow[]>([]);
  const [sourceCatalogLoading, setSourceCatalogLoading] = useState(false);
  const [inv, setInv] = useState<InvRow[]>([]);
  const [asg, setAsg] = useState<AsgRow[]>([]);

  const loadSources = useCallback(async () => {
    const r = await crmJson<{ ok: boolean; data: SourceRow[] }>(
      '/phone-routing/admin/configured-ghl-subaccount-source-location-rows',
    );
    setSources(r.data || []);
  }, []);

  const loadSourceCatalog = useCallback(async () => {
    setSourceCatalogLoading(true);
    try {
      const r = await crmJson<{ ok: boolean; data: GhlCatalogRow[] }>(
        '/phone-routing/admin/ghl-subaccount-locations-catalog-for-phone-routing-ui',
      );
      setSourceCatalogRows(r.data || []);
    } catch {
      setSourceCatalogRows([]);
    } finally {
      setSourceCatalogLoading(false);
    }
  }, []);

  const loadInv = useCallback(async () => {
    const r = await crmJson<{ ok: boolean; data: InvRow[] }>(
      '/phone-routing/admin/manual-inventory-e164-phone-per-subaccount-location-rows',
    );
    setInv(r.data || []);
  }, []);

  const loadAsg = useCallback(async () => {
    const r = await crmJson<{ ok: boolean; data: AsgRow[] }>('/phone-routing/admin/assignment-link-rows');
    setAsg(r.data || []);
  }, []);

  const loadOverviewPickers = useCallback(async () => {
    try {
      const lists = await Promise.all(
        INTENT_OPTIONS.map((intent) =>
          crmJson<{ ok: boolean; data: PickerOption[] }>(
            `/phone-routing/admin/phone-assignment-picker-eligible-unassigned-phone-option-rows?assignment_line_intent_enum_filter=${encodeURIComponent(intent)}`,
          ).then((r) => r.data || []),
        ),
      );
      const seen = new Set<string>();
      const merged: PickerOption[] = [];
      for (const list of lists) {
        for (const o of list) {
          const k = `${normE164Digits(o.e164_phone_number_string_normalized_digits_only)}::${o.ghl_subaccount_location_id_string}`;
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(o);
        }
      }
      setOverviewPickerOptions(merged);
    } catch {
      setOverviewPickerOptions([]);
    }
  }, []);

  const refresh = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      await Promise.all([loadSources(), loadInv(), loadAsg(), loadSourceCatalog(), loadOverviewPickers()]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [loadAsg, loadInv, loadOverviewPickers, loadSourceCatalog, loadSources]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [newLoc, setNewLoc] = useState('');
  const [newLocLabel, setNewLocLabel] = useState('');
  const [overviewPickerOptions, setOverviewPickerOptions] = useState<PickerOption[]>([]);
  const [addingLiveKey, setAddingLiveKey] = useState<string | null>(null);
  const [liveDrafts, setLiveDrafts] = useState<Record<string, { intent: string; label: string }>>({});
  const [inventoryDrafts, setInventoryDrafts] = useState<Record<string, { intent: string; label: string }>>({});
  const [savingInventoryId, setSavingInventoryId] = useState<string | null>(null);
  const [syncPullLoc, setSyncPullLoc] = useState('');
  const [syncPullIntent, setSyncPullIntent] = useState<string>('remarketing');
  const [asgClientSubaccountLocationId, setAsgClientSubaccountLocationId] = useState('');
  const [pickerOptions, setPickerOptions] = useState<PickerOption[]>([]);
  const [pickIdx, setPickIdx] = useState<number>(-1);
  const [pickerLoading, setPickerLoading] = useState(false);

  const loadPicker = useCallback(async () => {
    setPickerLoading(true);
    try {
      const r = await crmJson<{ ok: boolean; data: PickerOption[] }>(
        `/phone-routing/admin/phone-assignment-picker-eligible-unassigned-phone-option-rows?assignment_line_intent_enum_filter=${encodeURIComponent('all')}&include_all_line_intents=true`,
      );
      setPickerOptions(r.data || []);
      setPickIdx(-1);
    } catch {
      setPickerOptions([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'assign' || loading) return;
    void loadPicker();
  }, [tab, loading, loadPicker]);

  const configuredSourceLocationIds = useMemo(
    () =>
      new Set(
        sources
          .filter((s) => !s.row_disabled_boolean)
          .map((s) => s.ghl_subaccount_location_id_string_that_phone_numbers_belong_to),
      ),
    [sources],
  );

  /** Numbers are keyed by *source* subaccounts in inventory; client subaccount is chosen separately — list all unassigned options. */
  const asgEligiblePickerRows = useMemo(() => {
    const intentOrder = (opt: PickerOption) => (assignmentIntentFromPickerOption(opt) === 'lead' ? 0 : 1);
    return [...pickerOptions].sort((a, b) => {
      const io = intentOrder(a) - intentOrder(b);
      if (io !== 0) return io;
      return normE164Digits(a.e164_phone_number_string_normalized_digits_only).localeCompare(
        normE164Digits(b.e164_phone_number_string_normalized_digits_only),
      );
    });
  }, [pickerOptions]);

  const invByNormE164 = useMemo(() => {
    const m = new Map<string, InvRow>();
    for (const row of inv) {
      const k = normE164Digits(row.e164_phone_number_string_normalized_digits_only);
      if (k && !m.has(k)) m.set(k, row);
    }
    return m;
  }, [inv]);

  const unifiedInventoryRows = useMemo(
    () => buildUnifiedInventoryRows(asg, inv, overviewPickerOptions),
    [asg, inv, overviewPickerOptions],
  );

  const tabTitle =
    tab === 'sources' ? 'GHL subaccount sources' : tab === 'inventory' ? 'Number inventory' : 'Assignments';

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-800/80 bg-gradient-to-b from-slate-900 to-slate-950 text-slate-300">
        <div className="border-b border-white/10 px-5 py-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500 text-lg font-bold text-white shadow-lg shadow-indigo-900/40">
              PH
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight text-white">Phone Routing</p>
              <p className="text-[11px] text-slate-500">Client Hub admin</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Configure</p>
          <NavBtn
            active={tab === 'sources'}
            onClick={() => setTab('sources')}
            label="Subaccount sources"
            desc="Step 1: locations you manage"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                />
              </svg>
            }
          />
          <NavBtn
            active={tab === 'inventory'}
            onClick={() => setTab('inventory')}
            label="Number inventory"
            desc="Step 2: select usable numbers"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z"
                />
              </svg>
            }
          />
          <NavBtn
            active={tab === 'assign'}
            onClick={() => setTab('assign')}
            label="Assignments"
            desc="Step 3: link number to client"
            icon={
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.621l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
                />
              </svg>
            }
          />
        </nav>
        <div className="border-t border-white/10 p-4">
          <p className="text-[10px] leading-relaxed text-slate-600">
            Same CRM API as Formflow Buddy. Env: <span className="font-mono text-slate-500">VITE_FORMFLOW_CRM_API_KEY</span>
          </p>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col pl-64">
        <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/80 backdrop-blur-md">
          <div className="flex h-14 items-center justify-between px-8">
            <div>
              <h1 className="text-sm font-semibold text-slate-900">{tabTitle}</h1>
              <p className="text-xs text-slate-500">Step-by-step setup for Client Hub phone/SMS routing</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {loading ? 'Syncing…' : 'Connected'}
              </div>
              <button type="button" className={btnPrimary} onClick={() => void refresh()} disabled={loading}>
                {loading ? 'Refreshing…' : 'Refresh data'}
              </button>
            </div>
          </div>
        </header>

        <main className="flex-1 px-8 py-8">
          <div className="mx-auto max-w-4xl space-y-6">
            <section className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-indigo-900">How this tool works</h2>
              <p className="mt-1 text-xs text-indigo-800">
                Use this in order so routing is valid and predictable.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-indigo-200 bg-white p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Step 1</p>
                  <p className="mt-1 text-sm font-medium text-slate-900">Add source locations</p>
                  <p className="mt-1 text-xs text-slate-600">
                    Pick each GHL subaccount location that owns numbers you control.
                  </p>
                </div>
                <div className="rounded-xl border border-indigo-200 bg-white p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Step 2</p>
                  <p className="mt-1 text-sm font-medium text-slate-900">Tag numbers in inventory</p>
                  <p className="mt-1 text-xs text-slate-600">
                    Each line is Lead or Remarketing here. That tag drives Step 3 — you don’t re-pick line type when assigning.
                  </p>
                </div>
                <div className="rounded-xl border border-indigo-200 bg-white p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Step 3</p>
                  <p className="mt-1 text-sm font-medium text-slate-900">Assign to Client Hub</p>
                  <p className="mt-1 text-xs text-slate-600">
                    Pick the client subaccount and the inventory number; routing fields on the client row update automatically.
                  </p>
                </div>
              </div>
            </section>

            {/* KPI strip */}
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                { label: 'Source locations', value: sources.length, bar: 'bg-indigo-500' },
                { label: 'Inventory numbers', value: inv.length, bar: 'bg-sky-500' },
                { label: 'Active assignments', value: asg.length, bar: 'bg-emerald-500' },
              ].map((k) => (
                <div
                  key={k.label}
                  className="flex gap-4 overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card"
                >
                  <div className={`w-1 shrink-0 rounded-full ${k.bar}`} />
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{k.label}</p>
                    <p className="mt-1 text-3xl font-bold tabular-nums tracking-tight text-slate-900">{k.value}</p>
                  </div>
                </div>
              ))}
            </div>

            {err && (
              <div
                role="alert"
                className="flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 shadow-sm"
              >
                <p className="font-medium">{err}</p>
                <button type="button" className="shrink-0 text-red-600 underline text-xs" onClick={() => setErr(null)}>
                  Dismiss
                </button>
              </div>
            )}

            {tab === 'sources' && (
              <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card">
                <div className="border-b border-slate-100 bg-slate-50/80 px-6 py-4">
                  <h2 className="text-base font-semibold text-slate-900">Subaccount sources (Step 1)</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Collection <code className="rounded bg-slate-200/80 px-1 py-0.5 font-mono text-[10px]">ffcrm_phone_routing_admin_configured_ghl_subaccount_source_location_rows</code>
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Add each GHL location whose phone numbers you want available in this routing system.
                  </p>
                </div>
                <div className="grid gap-4 border-b border-slate-100 p-6 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Field label="GHL location" hint="Dropdown of all GHL subaccounts/locations from your agency">
                      <select
                        className={inputClass}
                        value={newLoc}
                        onChange={(e) => setNewLoc(e.target.value)}
                        disabled={sourceCatalogLoading}
                      >
                        <option value="">
                          {sourceCatalogLoading ? 'Loading subaccounts…' : 'Select subaccount location…'}
                        </option>
                        {sourceCatalogRows.map((r) => (
                          <option key={r.ghl_subaccount_location_id_string} value={r.ghl_subaccount_location_id_string}>
                            {r.location_display_name_for_admin_ui} ({r.ghl_subaccount_location_id_string})
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Display label" hint="Optional friendly name in lists">
                    <input
                      className={inputClass}
                      placeholder="e.g. ACME — main subaccount"
                      value={newLocLabel}
                      onChange={(e) => setNewLocLabel(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="flex justify-end border-b border-slate-100 px-6 py-3">
                  <button
                    type="button"
                    className={btnPrimary}
                    onClick={async () => {
                      try {
                        await crmJson('/phone-routing/admin/configured-ghl-subaccount-source-location-rows', {
                          method: 'POST',
                          body: JSON.stringify({
                            ghl_subaccount_location_id_string_that_phone_numbers_belong_to: newLoc.trim(),
                            optional_human_readable_label_for_admin_ui_only: newLocLabel.trim() || null,
                          }),
                        });
                        setNewLoc('');
                        setNewLocLabel('');
                        await loadSources();
                      } catch (e: unknown) {
                        setErr(e instanceof Error ? e.message : String(e));
                      }
                    }}
                  >
                    Add source
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <th className="px-6 py-3">Location ID</th>
                        <th className="px-6 py-3">Label</th>
                        <th className="px-6 py-3">Status</th>
                        <th className="px-6 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {sources.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-6 py-12 text-center text-sm text-slate-500">
                            No sources yet. Add a GHL subaccount location above.
                          </td>
                        </tr>
                      ) : (
                        sources.map((s) => (
                          <tr key={s.id} className="hover:bg-slate-50/80">
                            <td className="max-w-xs truncate px-6 py-3 font-mono text-xs text-slate-800">
                              {s.ghl_subaccount_location_id_string_that_phone_numbers_belong_to}
                            </td>
                            <td className="px-6 py-3 text-slate-700">{s.optional_human_readable_label_for_admin_ui_only || '—'}</td>
                            <td className="px-6 py-3">
                              {s.row_disabled_boolean ? (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                                  Disabled
                                </span>
                              ) : (
                                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                                  Active
                                </span>
                              )}
                            </td>
                            <td className="px-6 py-3 text-right">
                              <button
                                type="button"
                                className={btnDanger}
                                onClick={async () => {
                                  if (!confirm('Delete this source row?')) return;
                                  try {
                                    await crmJson(`/phone-routing/admin/configured-ghl-subaccount-source-location-rows/${s.id}`, {
                                      method: 'DELETE',
                                    });
                                    await loadSources();
                                  } catch (e: unknown) {
                                    setErr(e instanceof Error ? e.message : String(e));
                                  }
                                }}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {tab === 'inventory' && (
              <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card">
                <div className="border-b border-slate-100 bg-slate-50/80 px-6 py-4">
                  <h2 className="text-base font-semibold text-slate-900">Number inventory (Step 2)</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Mongo <code className="rounded bg-slate-200/80 px-1 py-0.5 font-mono text-[10px]">ffcrm_phone_routing_manual_inventory_e164_phone_per_subaccount_location_rows</code> plus live GHL lines not yet in inventory.
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    <strong>Assigned</strong> rows first, then <strong>in inventory</strong> (set line intent + label in the row, then <em>Save</em>), then <strong>live GHL only</strong> (pick intent, optional label, <em>Add to inventory</em>).
                  </p>
                  <p className="mt-2 text-xs text-slate-700 rounded-lg border border-indigo-100 bg-indigo-50/50 px-3 py-2 leading-relaxed">
                    <strong className="text-indigo-950">Agency vs client lines:</strong> Lead / Remarketing here are for{' '}
                    <strong>client (SMB) subaccount</strong> SMS routing. Business-owner notification texts still go out from
                    your <strong>agency</strong> subaccount in GHL — that is configured elsewhere, not in this table.
                  </p>
                </div>
                <div className="space-y-4 border-b border-slate-100 bg-slate-50/50 p-6">
                  <p className="text-sm font-semibold text-slate-800">Sync from GHL</p>
                  <p className="text-xs text-slate-500">
                    Upserts inventory from the live phone-system API for one configured source. Run this if the table below is empty or out of date.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <Field label="GHL location" hint="Must be a configured source (Step 1)">
                        <SearchableGhlLocationSelect value={syncPullLoc} onChange={setSyncPullLoc} />
                      </Field>
                      {syncPullLoc.trim() && !configuredSourceLocationIds.has(syncPullLoc.trim()) ? (
                        <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                          Add this location on the Sources tab first.
                        </p>
                      ) : null}
                    </div>
                    <Field label="Line intent for synced rows">
                      <select className={inputClass} value={syncPullIntent} onChange={(e) => setSyncPullIntent(e.target.value)}>
                        {INTENT_OPTIONS.map((x) => (
                          <option key={x} value={x}>
                            {x.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div className="flex items-end">
                      <button
                        type="button"
                        className={btnPrimary}
                        disabled={!syncPullLoc.trim() || !configuredSourceLocationIds.has(syncPullLoc.trim())}
                        onClick={async () => {
                          try {
                            await crmJson(
                              '/phone-routing/admin/sync-manual-inventory-from-live-ghl-owned-phone-numbers-for-one-location',
                              {
                                method: 'POST',
                                body: JSON.stringify({
                                  ghl_subaccount_location_id_string: syncPullLoc.trim(),
                                  client_hub_phone_inventory_line_usage_intent_enum: syncPullIntent,
                                }),
                              },
                            );
                            await loadInv();
                            await loadOverviewPickers();
                            if (tab === 'assign') await loadPicker();
                          } catch (e: unknown) {
                            setErr(e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        Sync numbers from GHL
                      </button>
                    </div>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[960px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        <th className="px-4 py-3 w-36">Status</th>
                        <th className="px-4 py-3">Number</th>
                        <th className="px-4 py-3">Line intent</th>
                        <th className="px-4 py-3 min-w-[200px]">Subaccount (number lives here)</th>
                        <th className="px-4 py-3 min-w-[160px]">Location display name</th>
                        <th className="px-4 py-3 min-w-[200px]">Assigned routing / client</th>
                        <th className="px-4 py-3">Row label</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {loading ? (
                        <tr>
                          <td colSpan={8} className="px-6 py-12 text-center text-sm text-slate-500">
                            Loading…
                          </td>
                        </tr>
                      ) : unifiedInventoryRows.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-6 py-12 text-center text-sm text-slate-500">
                            No numbers yet. Add sources (Step 1), then Sync from GHL above, or check API/OAuth for those locations.
                          </td>
                        </tr>
                      ) : (
                        unifiedInventoryRows.map((row) => {
                          if (row.kind === 'assigned') {
                            const { asg: a, invRow } = row;
                            const srcId =
                              invRow?.ghl_subaccount_location_id_string_for_which_subaccount_this_number_was_provisioned ||
                              '—';
                            const routeId = a.ghl_subaccount_location_id_string_must_equal_inventory_and_client_for_validation;
                            return (
                              <tr key={row.key} className="bg-indigo-50/40 hover:bg-indigo-50/60">
                                <td className="px-4 py-3">
                                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-900">
                                    Assigned
                                  </span>
                                </td>
                                <td className="px-4 py-3 font-mono text-sm font-semibold text-slate-900">
                                  {formatE164(a.e164_phone_number_string_normalized_digits_only)}
                                </td>
                                <td className="px-4 py-3 text-xs text-slate-700">
                                  {lineIntentLabelForUi(a.client_hub_phone_assignment_line_usage_intent_enum)}
                                </td>
                                <td className="px-4 py-3 font-mono text-[11px] text-slate-700 break-all">{srcId}</td>
                                <td className="px-4 py-3 text-xs text-slate-700">
                                  {srcId !== '—' ? locationDisplayName(String(srcId), sources, sourceCatalogRows) : '—'}
                                </td>
                                <td className="px-4 py-3 text-xs">
                                  <div className="font-mono text-[11px] text-slate-800 break-all">{routeId}</div>
                                  <div className="text-muted-foreground mt-0.5">
                                    {locationDisplayName(routeId, sources, sourceCatalogRows)} · client{' '}
                                    <span className="font-mono">{a.ffcrm_client_hub_clients_collection_row_id_string.slice(0, 18)}…</span>
                                  </div>
                                </td>
                                <td className="px-4 py-3 text-xs text-slate-600">
                                  {invRow?.optional_inventory_display_name_for_admin_ui_only || '—'}
                                </td>
                                <td className="px-4 py-3 text-right text-xs text-slate-400">Assignments tab</td>
                              </tr>
                            );
                          }
                          if (row.kind === 'inventory_unassigned') {
                            const r = row.inv;
                            const locId = r.ghl_subaccount_location_id_string_for_which_subaccount_this_number_was_provisioned;
                            const d = inventoryDrafts[r.id];
                            const intentVal = lineIntentForSelect(
                              d?.intent ?? r.client_hub_phone_inventory_line_usage_intent_enum ?? 'remarketing',
                            );
                            const labelVal =
                              d?.label ?? (r.optional_inventory_display_name_for_admin_ui_only || '');
                            return (
                              <tr key={row.key} className="hover:bg-slate-50/80">
                                <td className="px-4 py-3">
                                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                                    In inventory
                                  </span>
                                </td>
                                <td className="px-4 py-3 font-mono text-sm font-semibold text-slate-900">
                                  {formatE164(r.e164_phone_number_string_normalized_digits_only)}
                                </td>
                                <td className="px-4 py-3 align-top">
                                  <select
                                    className={cellSelectClass}
                                    value={intentVal}
                                    onChange={(e) => {
                                      const intent = e.target.value;
                                      setInventoryDrafts((p) => ({
                                        ...p,
                                        [r.id]: {
                                          intent,
                                          label: p[r.id]?.label ?? (r.optional_inventory_display_name_for_admin_ui_only || ''),
                                        },
                                      }));
                                    }}
                                  >
                                    {INTENT_OPTIONS.map((x) => (
                                      <option key={x} value={x}>
                                        {x.replace(/_/g, ' ')}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td className="px-4 py-3 font-mono text-[11px] text-slate-700 break-all">{locId}</td>
                                <td className="px-4 py-3 text-xs text-slate-700">
                                  {locationDisplayName(locId, sources, sourceCatalogRows)}
                                </td>
                                <td className="px-4 py-3 text-xs text-slate-500">—</td>
                                <td className="px-4 py-3 align-top">
                                  <input
                                    className={cellInputClass}
                                    placeholder="Label"
                                    value={labelVal}
                                    onChange={(e) => {
                                      const label = e.target.value;
                                      setInventoryDrafts((p) => ({
                                        ...p,
                                        [r.id]: {
                                          intent: lineIntentForSelect(
                                            p[r.id]?.intent ??
                                              r.client_hub_phone_inventory_line_usage_intent_enum ??
                                              'remarketing',
                                          ),
                                          label,
                                        },
                                      }));
                                    }}
                                  />
                                </td>
                                <td className="px-4 py-3 text-right align-top">
                                  <div className="flex flex-col items-end gap-1.5">
                                    <button
                                      type="button"
                                      className={btnSecondary}
                                      disabled={savingInventoryId === r.id}
                                      onClick={async () => {
                                        setSavingInventoryId(r.id);
                                        try {
                                          await crmJson(
                                            `/phone-routing/admin/manual-inventory-e164-phone-per-subaccount-location-rows/${r.id}`,
                                            {
                                              method: 'PATCH',
                                              body: JSON.stringify({
                                                client_hub_phone_inventory_line_usage_intent_enum: intentVal,
                                                optional_inventory_display_name_for_admin_ui_only: labelVal.trim() || null,
                                              }),
                                            },
                                          );
                                          setInventoryDrafts((p) => {
                                            const n = { ...p };
                                            delete n[r.id];
                                            return n;
                                          });
                                          await loadInv();
                                          await loadOverviewPickers();
                                          if (tab === 'assign') await loadPicker();
                                        } catch (e: unknown) {
                                          setErr(e instanceof Error ? e.message : String(e));
                                        } finally {
                                          setSavingInventoryId(null);
                                        }
                                      }}
                                    >
                                      {savingInventoryId === r.id ? 'Saving…' : 'Save'}
                                    </button>
                                    <button
                                      type="button"
                                      className={btnDanger}
                                      onClick={async () => {
                                        if (!confirm('Delete this inventory row?')) return;
                                        try {
                                          await crmJson(
                                            `/phone-routing/admin/manual-inventory-e164-phone-per-subaccount-location-rows/${r.id}`,
                                            { method: 'DELETE' },
                                          );
                                          setInventoryDrafts((p) => {
                                            const n = { ...p };
                                            delete n[r.id];
                                            return n;
                                          });
                                          await loadInv();
                                          await loadOverviewPickers();
                                          if (tab === 'assign') await loadPicker();
                                        } catch (e: unknown) {
                                          setErr(e instanceof Error ? e.message : String(e));
                                        }
                                      }}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          }
                          const pick = row.pick;
                          const locId = pick.ghl_subaccount_location_id_string;
                          const addKey = row.key;
                          const ld = liveDrafts[addKey];
                          const liveIntent = lineIntentForSelect(
                            ld?.intent ??
                              pick.client_hub_phone_inventory_line_usage_intent_for_autocreate_when_row_created_via_picker_enum,
                          );
                          const liveLabel = ld?.label ?? '';
                          return (
                            <tr key={row.key} className="bg-amber-50/30 hover:bg-amber-50/50">
                              <td className="px-4 py-3">
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                                  Live GHL only
                                </span>
                              </td>
                              <td className="px-4 py-3 font-mono text-sm font-semibold text-slate-900">
                                {formatE164(pick.e164_phone_number_string_normalized_digits_only)}
                              </td>
                              <td className="px-4 py-3 align-top">
                                <select
                                  className={cellSelectClass}
                                  value={liveIntent}
                                  onChange={(e) => {
                                    const intent = e.target.value;
                                    setLiveDrafts((p) => ({
                                      ...p,
                                      [addKey]: { intent, label: p[addKey]?.label ?? '' },
                                    }));
                                  }}
                                >
                                  {INTENT_OPTIONS.map((x) => (
                                    <option key={x} value={x}>
                                      {x.replace(/_/g, ' ')}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="px-4 py-3 font-mono text-[11px] text-slate-700 break-all">{locId}</td>
                              <td className="px-4 py-3 text-xs text-slate-700">
                                {locationDisplayName(locId, sources, sourceCatalogRows)}
                              </td>
                              <td className="px-4 py-3 text-xs text-slate-500">—</td>
                              <td className="px-4 py-3 align-top">
                                <input
                                  className={cellInputClass}
                                  placeholder="Label (optional)"
                                  value={liveLabel}
                                  onChange={(e) => {
                                    const label = e.target.value;
                                    setLiveDrafts((p) => ({
                                      ...p,
                                      [addKey]: {
                                        intent: lineIntentForSelect(
                                          p[addKey]?.intent ??
                                            pick.client_hub_phone_inventory_line_usage_intent_for_autocreate_when_row_created_via_picker_enum,
                                        ),
                                        label,
                                      },
                                    }));
                                  }}
                                />
                              </td>
                              <td className="px-4 py-3 text-right align-top">
                                <button
                                  type="button"
                                  className={btnPrimary}
                                  disabled={
                                    addingLiveKey === addKey || !configuredSourceLocationIds.has(String(locId).trim())
                                  }
                                  onClick={async () => {
                                    setAddingLiveKey(addKey);
                                    try {
                                      await crmJson('/phone-routing/admin/manual-inventory-e164-phone-per-subaccount-location-rows', {
                                        method: 'POST',
                                        body: JSON.stringify({
                                          ghl_subaccount_location_id_string_for_which_subaccount_this_number_was_provisioned:
                                            locId.trim(),
                                          e164_phone_number_string_normalized_digits_only:
                                            pick.e164_phone_number_string_normalized_digits_only,
                                          optional_inventory_display_name_for_admin_ui_only: liveLabel.trim() || null,
                                          client_hub_phone_inventory_line_usage_intent_enum: liveIntent,
                                        }),
                                      });
                                      setLiveDrafts((p) => {
                                        const n = { ...p };
                                        delete n[addKey];
                                        return n;
                                      });
                                      await loadInv();
                                      await loadOverviewPickers();
                                      if (tab === 'assign') await loadPicker();
                                    } catch (e: unknown) {
                                      setErr(e instanceof Error ? e.message : String(e));
                                    } finally {
                                      setAddingLiveKey(null);
                                    }
                                  }}
                                >
                                  {addingLiveKey === addKey ? 'Adding…' : 'Add to inventory'}
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {tab === 'assign' && (
              <section className="space-y-6">
                <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card">
                  <div className="border-b border-slate-100 bg-slate-50/80 px-6 py-4">
                    <h2 className="text-base font-semibold text-slate-900">Assign a number to a client (Step 3)</h2>
                    <p className="mt-2 text-xs text-slate-600 leading-relaxed">
                      <strong className="text-slate-800">Lead vs Remarketing</strong> is chosen in{' '}
                      <strong>Step 2</strong> when each number is in inventory (the dropdown label shows which line it is).
                      Here you only pick <em>which client subaccount</em> gets that number.
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Saves to{' '}
                      <code className="rounded bg-slate-200/80 px-1 font-mono text-[10px]">
                        ffcrm_phone_routing_assignment_link_e164_phone_to_ffcrm_client_hub_client_row
                      </code>{' '}
                      and sets{' '}
                      <code className="rounded bg-slate-200/80 px-1 font-mono text-[10px]">
                        client_hub_primary_ghl_location_id_for_phone_and_sms_routing
                      </code>{' '}
                      on the client. One number per line type per client; each number can only belong to one client.
                    </p>
                    <p className="mt-3 text-xs text-slate-700 rounded-lg border border-slate-200 bg-slate-50/90 px-3 py-2 leading-relaxed">
                      <strong className="text-slate-900">Owner / internal notification SMS</strong> is sent from your{' '}
                      <strong>agency</strong> GHL subaccount — not from these Lead / Remarketing client lines. This tool
                      only maps which client subaccount receives routed SMB SMS.
                    </p>
                  </div>
                  <div className="space-y-4 p-6">
                    <Field
                      label="Client subaccount"
                      hint="GHL location ID for this client — who owns the assignment"
                    >
                      <SearchableGhlLocationSelect
                        value={asgClientSubaccountLocationId}
                        onChange={(v) => {
                          setAsgClientSubaccountLocationId(v);
                          setPickIdx(-1);
                        }}
                        placeholder="Search by name or location ID…"
                      />
                    </Field>
                    <Field
                      label="Number to assign"
                      hint={
                        pickerLoading
                          ? 'Loading eligible numbers…'
                          : 'Each option is only line intent + phone number. Details live in Step 2 (inventory).'
                      }
                    >
                      <>
                        <select
                          className={inputClass}
                          disabled={!asgClientSubaccountLocationId.trim()}
                          value={pickIdx < 0 ? '' : String(pickIdx)}
                          onChange={(e) => {
                            const v = e.target.value;
                            setPickIdx(v === '' ? -1 : Number(v));
                          }}
                        >
                          <option value="">
                            {pickerLoading
                              ? 'Loading…'
                              : asgClientSubaccountLocationId.trim()
                                ? 'Choose a number…'
                                : 'Choose client subaccount first…'}
                          </option>
                          {asgEligiblePickerRows.map((o, i) => (
                            <option
                              key={`${o.e164_phone_number_string_normalized_digits_only}-${o.ghl_subaccount_location_id_string}-${i}`}
                              value={String(i)}
                            >
                              {formatAssignPickerOptionLabel(o)}
                            </option>
                          ))}
                        </select>
                        {pickIdx >= 0 && asgEligiblePickerRows[pickIdx] ? (
                          <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/80 px-4 py-3">
                            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-700">
                              Selected
                            </p>
                            <p className="mt-1 font-mono text-base font-semibold text-slate-900">
                              {formatAssignPickerOptionLabel(asgEligiblePickerRows[pickIdx])}
                            </p>
                          </div>
                        ) : null}
                      </>
                    </Field>
                  </div>
                  <div className="flex justify-end border-t border-slate-100 px-6 py-4">
                    <button
                      type="button"
                      className={btnPrimary}
                      disabled={
                        !asgClientSubaccountLocationId.trim() ||
                        pickIdx < 0 ||
                        pickIdx >= asgEligiblePickerRows.length
                      }
                      onClick={async () => {
                        const opt = asgEligiblePickerRows[pickIdx];
                        if (!opt || !asgClientSubaccountLocationId.trim()) return;
                        const isLive =
                          opt.picker_row_kind_enum === 'from_live_ghl_phone_system_api_not_yet_in_manual_inventory_table';
                        const lineIntent = assignmentIntentFromPickerOption(opt);
                        try {
                          await crmJson('/phone-routing/admin/assignment-link-rows', {
                            method: 'POST',
                            body: JSON.stringify({
                              client_hub_phone_assignment_line_usage_intent_enum: lineIntent,
                              ffcrm_client_hub_client_identity_ghl_location_id_string:
                                asgClientSubaccountLocationId.trim(),
                              e164_phone_number_string_normalized_digits_only: opt.e164_phone_number_string_normalized_digits_only,
                              ghl_manual_inventory_subaccount_location_id_string: opt.ghl_subaccount_location_id_string,
                              ghl_routing_subaccount_location_id_string: asgClientSubaccountLocationId.trim(),
                              picker_row_kind_enum: opt.picker_row_kind_enum,
                              auto_create_manual_inventory_when_pick_kind_is_live_ghl_boolean: isLive,
                            }),
                          });
                          setPickIdx(-1);
                          await loadAsg();
                          await loadInv();
                          await loadPicker();
                          setPickIdx(-1);
                        } catch (e: unknown) {
                          setErr(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    >
                      Save — link number to client
                    </button>
                  </div>
                </div>

                <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card">
                  <div className="border-b border-slate-100 px-6 py-4">
                    <h2 className="text-base font-semibold text-slate-900">Current assignments</h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 bg-slate-50/50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          <th className="px-6 py-3 min-w-[200px]">Client routing (GHL)</th>
                          <th className="px-6 py-3">Line</th>
                          <th className="px-6 py-3">Number</th>
                          <th className="px-6 py-3 min-w-[180px]">Number pool (source)</th>
                          <th className="px-6 py-3 min-w-[140px]">Hub record</th>
                          <th className="px-6 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {asg.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="px-6 py-12 text-center text-sm text-slate-500">
                              No assignments yet.
                            </td>
                          </tr>
                        ) : (
                          asg.map((a) => (
                            <tr key={a.id} className="hover:bg-slate-50/80">
                              <td className="px-6 py-3 text-xs text-slate-800">
                                <div className="font-medium text-slate-900">
                                  {locationDisplayName(
                                    a.ghl_subaccount_location_id_string_must_equal_inventory_and_client_for_validation,
                                    sources,
                                    sourceCatalogRows,
                                  )}
                                </div>
                                <div
                                  className="mt-0.5 font-mono text-[11px] text-slate-500 break-all"
                                  title={a.ghl_subaccount_location_id_string_must_equal_inventory_and_client_for_validation}
                                >
                                  {a.ghl_subaccount_location_id_string_must_equal_inventory_and_client_for_validation}
                                </div>
                              </td>
                              <td className="px-6 py-3 text-xs text-slate-600">
                                {lineIntentLabelForUi(a.client_hub_phone_assignment_line_usage_intent_enum)}
                              </td>
                              <td className="px-6 py-3 font-mono text-sm font-semibold text-slate-900">
                                {formatE164(a.e164_phone_number_string_normalized_digits_only)}
                              </td>
                              <td className="px-6 py-3 text-xs text-slate-800">
                                {(() => {
                                  const poolId =
                                    invByNormE164.get(
                                      normE164Digits(a.e164_phone_number_string_normalized_digits_only),
                                    )?.ghl_subaccount_location_id_string_for_which_subaccount_this_number_was_provisioned ||
                                    '';
                                  if (!poolId)
                                    return <span className="text-slate-400">—</span>;
                                  return (
                                    <>
                                      <div className="font-medium text-slate-900">
                                        {locationDisplayName(poolId, sources, sourceCatalogRows)}
                                      </div>
                                      <div className="mt-0.5 font-mono text-[11px] text-slate-500 break-all" title={poolId}>
                                        {poolId}
                                      </div>
                                    </>
                                  );
                                })()}
                              </td>
                              <td
                                className="px-6 py-3 text-xs text-slate-600 max-w-[180px]"
                                title={a.ffcrm_client_hub_clients_collection_row_id_string}
                              >
                                {hubClientRecordHint(a.ffcrm_client_hub_clients_collection_row_id_string)}
                              </td>
                              <td className="px-6 py-3 text-right">
                                <button
                                  type="button"
                                  className={btnDanger}
                                  onClick={async () => {
                                    if (!confirm('Remove this assignment?')) return;
                                    try {
                                      await crmJson(`/phone-routing/admin/assignment-link-rows/${a.id}`, { method: 'DELETE' });
                                      await loadAsg();
                                    } catch (e: unknown) {
                                      setErr(e instanceof Error ? e.message : String(e));
                                    }
                                  }}
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
