/**
 * Vertriebs-CRM: /crm — Kanban, Tabelle, Export, Firmen, Audit, Detail-Formular, Theme
 */
(function () {
  const STAGE_ORDER = [
    'zu_recherchieren', 'recherche_begonnen', 'anrufversuch', 'infos_vollmacht_versendet', 'vollmacht_erhalten',
    'vororttermin', 'netzpruefung_positiv', 'verworfen',
  ];
  const THEME_KEY = 'noe_crm_theme';
  const SORT_KEY = 'noe_crm_sort';
  const TABLE_SORT_KEY = 'noe_crm_table_sort';
  const TABLE_COLS_KEY = 'noe_crm_table_colw';
  /** Gespeicherte Größe der Kartenvorschau im Lead-Detail (Höhe px, Breite % vom Dialog) */
  const CRM_MAP_PREVIEW_LS = 'noe_crm_detail_map_preview_v1';

  const TABLE_COLUMNS = [
    { id: 'nr', label: 'Nr', defW: 52, sort: 'num' },
    { id: 'name', label: 'Name', defW: 160, sort: 'str' },
    { id: 'stage', label: 'Stufe', defW: 120, sort: 'stage' },
    { id: 'account', label: 'Firma', defW: 100, sort: 'str' },
    { id: 'contact', label: 'Ansprechp.', defW: 120, sort: 'str' },
    { id: 'phone', label: 'Telefon', defW: 100, sort: 'str' },
    { id: 'email', label: 'E-Mail', defW: 150, sort: 'str' },
    { id: 'address', label: 'Adresse', defW: 180, sort: 'str' },
    { id: 'dist', label: 'Trafo m', defW: 64, sort: 'num' },
    { id: 'm2', label: 'm²', defW: 56, sort: 'num' },
    { id: 'kwp', label: 'kWp', defW: 56, sort: 'num' },
    { id: 'vm', label: 'Vollmacht', defW: 72, sort: 'bool' },
    { id: 'updated', label: 'Geändert', defW: 88, sort: 'str' },
  ];

  function api(u, o) {
    return fetch(u, Object.assign({ credentials: 'same-origin' }, o || {}));
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** `YYYY-MM-DD` als lokales Kalenderdatum (nicht `new Date(str)` — kann UTC sein und um einen Tag verrutschen). */
  function parseIsoDateLocal(raw) {
    const s = String(raw || '').trim().slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = +m[1];
    const mo = +m[2] - 1;
    const day = +m[3];
    const dt = new Date(y, mo, day);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== day) return null;
    return dt;
  }

  function fmtIsoLocal(dt) {
    if (!dt || isNaN(dt.getTime())) return '';
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  function isoFromParts(y, monthIndex, day) {
    return `${y}-${pad2(monthIndex + 1)}-${pad2(day)}`;
  }

  function origin() {
    return location.origin;
  }
  /** iframe: eingebettete Karte (Dach füllt den Rahmen — siehe index applyCrmMapDeepLink) */
  function mapEmbedUrl(lead) {
    const o = (lead && lead.osm_id) || '';
    if (!o) return origin() + '/';
    return origin() + '/?embed=1&osm=' + encodeURIComponent(String(o).trim());
  }
  /** Neuer Tab: eine gemeinsame Karten-App-URL (Sat, from_crm, Fokus auf Dach) */
  function mapAppNewTabUrl(lead) {
    const o = (lead && lead.osm_id) != null ? String(lead.osm_id).trim() : '';
    if (!o) return origin() + '/?sat=1';
    const d = (lead && lead.data) || {};
    let u = origin() + '/?from_crm=1&osm=' + encodeURIComponent(o) + '&sat=1';
    if (d.lat != null && d.lng != null) {
      u += '&lat=' + encodeURIComponent(String(d.lat)) + '&lng=' + encodeURIComponent(String(d.lng)) + '&zoom=19';
    }
    return u;
  }

  function getSortKey() {
    return localStorage.getItem(SORT_KEY) || 'prio';
  }
  function setSortKey(k) {
    if (k) localStorage.setItem(SORT_KEY, k);
  }

  function nameSortKey(L) {
    return String((L && L.name) || (L.data && L.data.address) || '').toLowerCase();
  }

  function getTableSort() {
    try {
      const o = JSON.parse(localStorage.getItem(TABLE_SORT_KEY) || 'null');
      if (o && o.col && (o.dir === 'asc' || o.dir === 'desc')) return o;
    } catch (e) { /* ignore */ }
    return { col: 'name', dir: 'asc' };
  }
  function setTableSortState(col, dir) {
    localStorage.setItem(TABLE_SORT_KEY, JSON.stringify({ col, dir }));
  }
  function getTableColWidths() {
    try {
      const d = JSON.parse(localStorage.getItem(TABLE_COLS_KEY) || '{}');
      if (d && typeof d === 'object') return d;
    } catch (e) { /* ignore */ }
    return {};
  }
  function setTableColWidth(id, px) {
    const o = getTableColWidths();
    o[id] = Math.min(520, Math.max(36, Math.round(px)));
    localStorage.setItem(TABLE_COLS_KEY, JSON.stringify(o));
  }
  function colWidthPx(id) {
    const w = getTableColWidths()[id];
    if (id === '__actions__') {
      if (w != null && w >= 32) return w;
      return 80;
    }
    const d = TABLE_COLUMNS.find(c => c.id === id);
    const defW = d ? d.defW : 80;
    if (w != null && w >= 32) return w;
    return defW;
  }
  function stageOrderIndex(st) {
    const i = STAGE_ORDER.indexOf(st);
    return i < 0 ? 999 : i;
  }
  function tableCellValue(L, col) {
    const c = L.contact || {};
    const d = L.data || {};
    switch (col) {
      case 'nr': return L.project_nr != null ? +L.project_nr : -1e12;
      case 'name': return nameSortKey(L);
      case 'stage': return stageOrderIndex(L.stage);
      case 'account': return (L.account_name || '').toLowerCase();
      case 'contact': return (c.name || '').toLowerCase();
      case 'phone': return (c.phone || '').toLowerCase();
      case 'email': return (c.email || '').toLowerCase();
      case 'address': return (d.address || '').toLowerCase();
      case 'dist': return +L.sort_distance_m || 0;
      case 'm2': return +L.sort_roof_m2 || 0;
      case 'kwp': return +L.sort_kwp || 0;
      case 'vm': return L.vollmacht_bestaetigt ? 1 : 0;
      case 'updated': return (L.updated_at || L.created_at || '');
      default: return '';
    }
  }
  function sortLeadsForTable(arr, col, dir) {
    const out = arr.slice();
    const mul = dir === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      const va = tableCellValue(a, col);
      const vb = tableCellValue(b, col);
      if (typeof va === 'number' && typeof vb === 'number') {
        if (va !== vb) return mul * (va - vb);
      } else {
        const s1 = String(va);
        const s2 = String(vb);
        if (s1 !== s2) return mul * s1.localeCompare(s2, 'de', { numeric: true, sensitivity: 'base' });
      }
      return String(a.id).localeCompare(String(b.id), 'de');
    });
    return out;
  }
  function formatDeShortDate(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    return isNaN(t.getTime()) ? String(iso).slice(0, 10) : t.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  function sortLeadsList(arr, key) {
    const out = arr.slice();
    const ts = (L) => String(L.updated_at || L.created_at || '');
    const cmpPrio = (a, b) => {
      const d1 = a.sort_distance_m || 0, d2 = b.sort_distance_m || 0;
      if (d1 !== d2) return d1 - d2;
      return (b.sort_roof_m2 || 0) - (a.sort_roof_m2 || 0);
    };
    switch (key) {
      case 'roof_desc': out.sort((a, b) => (b.sort_roof_m2 || 0) - (a.sort_roof_m2 || 0)); break;
      case 'kwp_desc': out.sort((a, b) => (b.sort_kwp || 0) - (a.sort_kwp || 0)); break;
      case 'name_asc': out.sort((a, b) => nameSortKey(a).localeCompare(nameSortKey(b), 'de')); break;
      case 'name_desc': out.sort((a, b) => nameSortKey(b).localeCompare(nameSortKey(a), 'de')); break;
      case 'updated_desc': out.sort((a, b) => ts(b).localeCompare(ts(a))); break;
      case 'updated_asc': out.sort((a, b) => ts(a).localeCompare(ts(b))); break;
      case 'dist_asc': out.sort((a, b) => (a.sort_distance_m || 0) - (b.sort_distance_m || 0)); break;
      case 'created_desc': out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))); break;
      default: out.sort(cmpPrio);
    }
    return out;
  }

  function reminderMeta(L) {
    const d = L.data || {};
    if (d.reminder_completed === true) return null;
    const raw = d.reminder_at || '';
    const ev = parseIsoDateLocal(raw);
    if (!ev) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ev0 = new Date(ev.getFullYear(), ev.getMonth(), ev.getDate());
    const days = Math.round((ev0 - today) / 864e5);
    return { days, ev: ev0 };
  }

  function reminderUrgencyClass(L) {
    const m = reminderMeta(L);
    if (!m) return '';
    if (m.days < 0) return 'crm-rem--missed';
    if (m.days <= 1) return 'crm-rem--soon';
    return '';
  }

  function isCrmPath() {
    return location.pathname === '/crm' || location.pathname.endsWith('/crm');
  }

  function showMapUi(show) {
    const hide = ['topbar', 'filterbar', 'statsbar', 'map-wrap'];
    for (const id of hide) {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? '' : 'none';
    }
    const v = document.getElementById('view-crm');
    if (v) v.style.display = show ? 'none' : 'flex';
  }

  function getTheme() {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  }
  function setThemeButtonIcons() {
    const sym = getTheme() === 'light' ? '☀' : '🌙';
    const bar = document.getElementById('crm-bar-theme');
    const tgl = document.getElementById('crm-theme-tgl');
    if (bar) bar.textContent = sym;
    if (tgl) tgl.textContent = sym;
  }
  function applyCrmTheme(t) {
    const v = t === 'light' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, v);
    const wrap = document.getElementById('view-crm');
    if (wrap) wrap.setAttribute('data-crm-theme', v);
    setThemeButtonIcons();
  }

  let _state = { leads: [], stageLabels: {}, me: null, accounts: [] };

  async function loadMe() {
    const r = await api('/api/me');
    if (!r.ok) return;
    _state.me = await r.json();
  }

  async function loadAccounts() {
    const r = await api('/api/crm/accounts');
    if (!r.ok) return;
    const d = await r.json();
    _state.accounts = d.accounts || [];
  }

  async function loadPipeline() {
    const r = await api('/api/crm/pipeline');
    if (r.status === 401) {
      document.getElementById('crm-root').innerHTML =
        '<p style="padding:24px;color:#f87171">Anmeldung erforderlich (HTTP Basic wie auf der Karte).</p>';
      return;
    }
    if (!r.ok) {
      document.getElementById('crm-root').innerHTML = '<p style="padding:24px;color:#f87171">Fehler beim Laden.</p>';
      return;
    }
    const d = await r.json();
    _state.leads = d.leads || [];
    _state.stageLabels = d.stageLabels || {};
    await renderAll();
  }

  function renderKanban() {
    const sk = getSortKey();
    const by = {};
    STAGE_ORDER.forEach(s => { by[s] = []; });
    for (const L of _state.leads) {
      if (!by[L.stage]) by[L.stage] = [];
      by[L.stage].push(L);
    }
    STAGE_ORDER.forEach(s => { by[s] = sortLeadsList(by[s] || [], sk); });
    const cols = STAGE_ORDER.map(st => {
      const label = _state.stageLabels[st] || st;
      const cards = (by[st] || []).map(L => cardHtml(L)).join('');
      return `<div class="crm-col" data-stage="${esc(st)}">
        <div class="crm-col-head">${esc(label)} <span class="crm-n">${(by[st] || []).length}</span></div>
        <div class="crm-col-body" data-drop="${esc(st)}">${cards}</div>
      </div>`;
    }).join('');
    return `<div class="crm-kanban">${cols}</div>`;
  }

  function cardHtml(L) {
    const d = L.data || {};
    const addr = d.address || `OSM ${L.osm_id}`;
    const sort = `${L.sort_distance_m} m · ${L.sort_roof_m2} m² · ${L.sort_kwp} kWp`;
    const pid = L.project_nr != null ? `P-${String(L.project_nr).padStart(3, '0')}` : '';
    const mTab = mapAppNewTabUrl(L);
    const rcls = reminderUrgencyClass(L);
    const rm = reminderMeta(L);
    const rline = rm ? (rm.days < 0 ? '⚠ überfällig' : rm.days <= 1 ? '⏱ bald' : '') : '';
    const discardCls = L.stage === 'verworfen' ? 'crm-card--discard' : '';
    const cardExtra = [rcls, discardCls].filter(Boolean).join(' ');
    return `<div class="crm-card${cardExtra ? ' ' + cardExtra : ''}" draggable="true" data-id="${esc(L.id)}" data-detail-open="${esc(L.id)}" title="Klick: Details · Ziehen: Stufe wechseln">
      <div class="crm-card-pid">${esc(pid)}</div>
      <div class="crm-card-title">${esc(L.name || addr)}</div>
      <div class="crm-card-meta">${esc(sort)}</div>
      ${rline ? `<div class="crm-card-remind">${rline}</div>` : ''}
      ${L.account_name ? `<div class="crm-card-acc">🏢 ${esc(L.account_name)}</div>` : ''}
      <div class="crm-card-actions">
        ${L.google_maps_url ? `<a class="crm-a" href="${esc(L.google_maps_url)}" target="_blank" rel="noopener">Maps</a>` : ''}
        <a class="crm-a" href="${esc(mTab)}" target="_blank" rel="noopener">Karte (neuer Tab)</a>
        <button type="button" class="crm-btn-mini" data-detail="${esc(L.id)}">Details</button>
      </div>
    </div>`;
  }

  function renderTable() {
    const ts = getTableSort();
    const leadsSorted = sortLeadsForTable(_state.leads, ts.col, ts.dir);
    const sortInd = (c) => (ts.col === c ? (ts.dir === 'asc' ? ' ▲' : ' ▼') : '');
    const thCell = (c) => {
      const T = TABLE_COLUMNS.find(x => x.id === c);
      if (!T) return '';
      return `<th class="crm-th-sort" data-crm-tcol="${esc(T.id)}" title="Klick: sortieren · Rand ziehen: Breite" scope="col">
        <span class="crm-th-txt">${esc(T.label)}${esc(sortInd(T.id))}</span>
        <span class="crm-col-res" data-crm-tcol="${esc(T.id)}" title="Spalte breiter/schmaler" aria-hidden="true"></span>
      </th>`;
    };
    const cols = TABLE_COLUMNS.map(c => `<col style="width:${colWidthPx(c.id)}px"/>`).join('');
    const rows = leadsSorted.map(L => {
      const d = L.data || {};
      const c = L.contact || {};
      const st = _state.stageLabels[L.stage] || L.stage;
      const rowCls = [reminderUrgencyClass(L), L.stage === 'verworfen' ? 'crm-row--discard' : ''].filter(Boolean).join(' ');
      return `<tr data-id="${esc(L.id)}" class="${esc(rowCls)}" data-row-open="${esc(L.id)}">
        <td class="td-nr">${esc(L.project_nr != null ? L.project_nr : '')}</td>
        <td class="td-name">${esc(L.name || '')}</td>
        <td class="td-stage">${esc(st)}</td>
        <td class="td-acc">${esc(L.account_name || '')}</td>
        <td class="td-ct">${esc(c.name || '')}</td>
        <td class="td-ph">${esc(c.phone || '')}</td>
        <td class="td-em">${esc(c.email || '')}</td>
        <td class="td-addr">${esc(d.address || '')}</td>
        <td class="td-num">${esc(L.sort_distance_m)}</td>
        <td class="td-num">${esc(L.sort_roof_m2)}</td>
        <td class="td-num">${esc(L.sort_kwp)}</td>
        <td class="td-n">${esc(L.vollmacht_bestaetigt ? 'ja' : 'nein')}</td>
        <td class="td-dt">${esc(formatDeShortDate(L.updated_at))}</td>
        <td class="td-act"><button type="button" class="crm-btn-mini" data-detail="${esc(L.id)}">Details</button></td>
      </tr>`;
    }).join('');
    return `<div class="crm-table-wrap" id="crm-table-wrap"><table class="crm-table crm-table-data">
      <colgroup>${cols}<col style="width:${colWidthPx('__actions__')}px"/></colgroup>
      <thead><tr>
        ${TABLE_COLUMNS.map(t => thCell(t.id)).join('')}
        <th class="crm-th-nosort" scope="col"><span class="crm-th-txt">Aktion</span>
          <span class="crm-col-res" data-crm-tcol="__actions__" title="Spalte breiter/schmaler"></span>
        </th>
      </tr></thead><tbody>${rows}</tbody>
    </table></div>`;
  }

  function renderTermine() {
    const items = _state.leads
      .filter(L => {
        const d = L.data || {};
        if (d.reminder_completed === true) return false;
        return !!parseIsoDateLocal(d.reminder_at);
      })
      .map(L => ({
        L,
        iso: String((L.data || {}).reminder_at || '').trim().slice(0, 10),
        meta: reminderMeta(L),
      }))
      .filter(x => x.meta)
      .sort((a, b) => a.iso.localeCompare(b.iso));

    if (!items.length) {
      return '<div class="crm-termine-empty">Keine offenen Erinnerungen / Termine.</div>';
    }

    const rows = items.map(({ L, iso, meta }) => {
      const d = L.data || {};
      const label = (d.reminder_label || '').trim();
      const name = L.name || d.address || `OSM ${L.osm_id}`;
      const st = _state.stageLabels[L.stage] || L.stage;
      const urg = reminderUrgencyClass(L);
      const rowCls = ['crm-term-row',
        urg === 'crm-rem--missed' ? 'crm-term-row--missed' : '',
        urg === 'crm-rem--soon' ? 'crm-term-row--soon' : '',
      ].filter(Boolean).join(' ');
      const dateDisp = parseIsoDateLocal(iso);
      const dateStr = dateDisp ? dateDisp.toLocaleDateString('de-AT') : iso;
      let badge = '';
      if (meta.days < 0) badge = '<span class="crm-term-badge crm-term-badge--miss">überfällig</span>';
      else if (meta.days <= 1) badge = '<span class="crm-term-badge crm-term-badge--soon">bald</span>';
      return `<tr class="${esc(rowCls)}" data-row-open="${esc(L.id)}">
        <td>${esc(dateStr)} ${badge}</td>
        <td>${esc(label || '—')}</td>
        <td>${esc(name)}</td>
        <td>${esc(st)}</td>
        <td class="crm-term-act">
          <button type="button" class="crm-btn-mini" data-detail="${esc(L.id)}">Details</button>
          <button type="button" class="crm-btn-mini crm-btn-termdone" data-reminder-done="${esc(L.id)}">Erledigt</button>
        </td>
      </tr>`;
    }).join('');

    return `<div class="crm-table-wrap crm-termine-wrap"><table class="crm-table crm-table-termine"><thead><tr>
      <th>Datum</th><th>Kurzbez.</th><th>Projekt</th><th>Stufe</th><th>Aktion</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function renderAudit() {
    const r = await api('/api/crm/audit?limit=120');
    if (!r.ok) {
      const msg = r.status === 403
        ? 'Audit ist nur für Administratoren.'
        : 'Audit nicht verfügbar.';
      return `<p style="color:#8892aa">${esc(msg)}</p>`;
    }
    const d = await r.json();
    const rows = (d.entries || []).map(e =>
      `<tr><td>${esc(e.ts)}</td><td>${esc(e.user)}</td><td>${esc(e.action)}</td><td>${esc(JSON.stringify(e.meta || {}))}</td></tr>`
    ).join('');
    return `<div class="crm-table-wrap"><table class="crm-table"><thead><tr><th>Zeit</th><th>User</th><th>Aktion</th><th>Meta</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  let _tab = 'kanban';

  async function renderAll() {
    const root = document.getElementById('crm-root');
    if (!root) return;
    const role = _state.me && _state.me.role;
    if (_tab === 'audit' && role !== 'admin') _tab = 'kanban';

    const auditTab = role === 'admin'
      ? `<button type="button" class="crm-tab ${_tab === 'audit' ? 'on' : ''}" data-t="audit">Audit</button>`
      : '';
    const terminTab = `<button type="button" class="crm-tab ${_tab === 'termin' ? 'on' : ''}" data-t="termin">Termine</button>`;

    let body;
    if (_tab === 'kanban') body = renderKanban();
    else if (_tab === 'table') body = renderTable();
    else if (_tab === 'termin') body = renderTermine();
    else body = await renderAudit();

    const th = getTheme() === 'light' ? '☀' : '🌙';
    const sk = getSortKey();
    const sortOpts = [
      ['prio', 'Prio (Trafo, Fläche)'],
      ['roof_desc', 'Dachfläche (größte zuerst)'],
      ['kwp_desc', 'kWp (höchste zuerst)'],
      ['dist_asc', 'Trafo-Abstand (niedrigste m)'],
      ['name_asc', 'Name A–Z'],
      ['name_desc', 'Name Z–A'],
      ['updated_desc', 'Zuletzt bearbeitet (neu)'],
      ['updated_asc', 'Zuletzt bearbeitet (alt)'],
      ['created_desc', 'Angelegt (neu zuerst)'],
    ].map(([v, lab]) => `<option value="${esc(v)}" ${sk === v ? 'selected' : ''}>${esc(lab)}</option>`).join('');
    const sortBlock = _tab === 'table'
      ? '<span class="crm-table-sort-hint">Tabelle: Spaltenkopf sortieren · Rand zwischen Spalten ziehen</span>'
      : _tab === 'termin'
        ? '<span class="crm-table-sort-hint">Offene Erinnerungen nach Datum · Zeile oder „Details“ öffnen</span>'
        : _tab === 'audit'
          ? '<span class="crm-table-sort-hint">Admin: Änderungsprotokoll</span>'
          : `<label class="crm-sort-lbl" title="Reihenfolge der Karten">Sortierung
        <select class="crm-sort" id="crm-sort-sel" aria-label="Sortierung Kanban">${sortOpts}</select>
      </label>`;
    root.innerHTML = `<div class="crm-toolbar">
      <button type="button" class="crm-tab ${_tab === 'kanban' ? 'on' : ''}" data-t="kanban">Kanban</button>
      <button type="button" class="crm-tab ${_tab === 'table' ? 'on' : ''}" data-t="table">Tabelle</button>
      ${terminTab}
      ${auditTab}
      <span class="crm-toolbar-sp"></span>
      ${sortBlock}
      <a class="crm-export" href="/api/crm/export.csv" target="_blank">CSV exportieren</a>
      <button type="button" class="crm-theme-btn" id="crm-theme-tgl" title="Hell- / Dunkelmodus">${th}</button>
      <span class="crm-user" id="crm-user-label"></span>
    </div>
    <div class="crm-body">${body}</div>
    <div id="crm-detail" class="crm-detail" style="display:none"></div>`;

    const ul = document.getElementById('crm-user-label');
    if (ul && _state.me) ul.textContent = (_state.me.username || '') + (role ? ' · ' + role : '');

    const tgl = document.getElementById('crm-theme-tgl');
    if (tgl) {
      tgl.addEventListener('click', () => {
        applyCrmTheme(getTheme() === 'light' ? 'dark' : 'light');
      });
    }

    const sortSel = document.getElementById('crm-sort-sel');
    if (sortSel) {
      sortSel.addEventListener('change', () => {
        setSortKey(sortSel.value);
        renderAll();
      });
    }

    root.querySelectorAll('.crm-tab').forEach(btn => {
      btn.addEventListener('click', async () => {
        _tab = btn.getAttribute('data-t');
        await renderAll();
      });
    });

    root.querySelectorAll('[data-detail]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); openDetail(btn.getAttribute('data-detail')); });
    });

    root.querySelectorAll('[data-reminder-done]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-reminder-done');
        if (!id) return;
        const r = await api('/api/leads/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { reminder_completed: true } }),
        });
        if (r.ok) await loadPipeline();
      });
    });

    setupCardOpen(root);
    setupDnD(root);
    if (_tab === 'table') setupCrmDataTable();
  }

  function setupCrmDataTable() {
    const wrap = document.getElementById('crm-table-wrap');
    if (!wrap) return;
    let resizeCol = null;
    let startX = 0;
    let startW = 0;
    const applyColWDom = (id, wPx) => {
      const cols = wrap.querySelectorAll('colgroup col');
      if (id === '__actions__' && cols.length) {
        cols[cols.length - 1].style.width = wPx + 'px';
        return;
      }
      const i = TABLE_COLUMNS.findIndex(c => c.id === id);
      if (i >= 0 && cols[i]) cols[i].style.width = wPx + 'px';
    };
    wrap.querySelectorAll('th.crm-th-sort').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('.crm-col-res')) return;
        const col = el.getAttribute('data-crm-tcol');
        if (!col) return;
        const cur = getTableSort();
        if (cur.col === col) setTableSortState(col, cur.dir === 'asc' ? 'desc' : 'asc');
        else setTableSortState(col, 'asc');
        renderAll();
      });
    });
    const onMove = (e) => {
      if (!resizeCol) return;
      const nw = Math.min(520, Math.max(36, startW + (e.clientX - startX)));
      applyColWDom(resizeCol, nw);
    };
    const onUp = (e) => {
      if (resizeCol && e) {
        const nw = Math.min(520, Math.max(36, startW + (e.clientX - startX)));
        setTableColWidth(resizeCol, nw);
      }
      resizeCol = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    wrap.querySelectorAll('.crm-col-res').forEach(h => {
      h.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        resizeCol = h.getAttribute('data-crm-tcol');
        if (!resizeCol) return;
        startX = e.clientX;
        startW = colWidthPx(resizeCol);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  function setupCardOpen(root) {
    root.querySelectorAll('.crm-card[data-detail-open]').forEach(card => {
      let blockClick = false;
      card.addEventListener('dragend', () => {
        blockClick = true;
        setTimeout(() => { blockClick = false; }, 80);
      });
      card.addEventListener('click', (e) => {
        if (blockClick) return;
        if (e.target.closest('a, button, .crm-a')) return;
        openDetail(card.getAttribute('data-detail-open'));
      });
    });
    root.querySelectorAll('tr[data-row-open]').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        openDetail(tr.getAttribute('data-row-open'));
      });
    });
  }

  function setupDnD(root) {
    let dragId = null;
    root.querySelectorAll('.crm-card').forEach(card => {
      card.addEventListener('dragstart', e => {
        dragId = card.getAttribute('data-id');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* ignore */ }
      });
    });
    root.querySelectorAll('.crm-col-body').forEach(col => {
      col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', async e => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const stage = col.getAttribute('data-drop');
        if (!dragId || !stage) return;
        const r = await api('/api/leads/' + encodeURIComponent(dragId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage }),
        });
        if (r.ok) await loadPipeline();
      });
    });
  }

  function defaultAddress(L) {
    const d = L.data || {};
    const a = d.address;
    if (a != null && String(a).trim() !== '') return String(a).trim();
    return '';
  }

  function normalizeSearchText(raw) {
    return String(raw || '')
      .toLocaleLowerCase('de-AT')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getLeadAccountIds(lead) {
    const ids = Array.isArray(lead && lead.account_ids) ? lead.account_ids : [];
    const out = ids.map((x) => String(x || '').trim()).filter(Boolean);
    if (!out.length && lead && lead.account_id) out.push(String(lead.account_id).trim());
    return Array.from(new Set(out));
  }

  function getAccountById(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return _state.accounts.find((a) => String(a.id) === key) || null;
  }

  function projectRefLabel(lead) {
    const nr = lead && lead.project_nr != null ? `P-${String(lead.project_nr).padStart(3, '0')}` : 'Projekt';
    const nm = String((lead && lead.name) || '').trim();
    return nm ? `${nr} · ${nm}` : nr;
  }

  function buildAccountPickerHtml(primaryId) {
    const selected = getAccountById(primaryId);
    return `<div class="crm-account-picker" id="d-account-picker" data-selected-id="${esc(primaryId || '')}">
      <div class="crm-account-input-row">
        <input type="text" id="d-account-search" class="crm-inp" value="${esc(selected ? selected.name : '')}" placeholder="Firma suchen oder neu anlegen" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="d-account-results"/>
        <button type="button" class="crm-btn-mini crm-account-clear" id="d-account-clear" title="Firma entfernen">×</button>
      </div>
      <input type="hidden" id="d-account" value="${esc(primaryId || '')}"/>
      <div class="crm-account-results" id="d-account-results" role="listbox" aria-label="Firmenvorschläge"></div>
      <div class="crm-account-meta" id="d-account-meta"></div>
    </div>`;
  }

  function setupAccountPicker(panel, lead) {
    const wrap = document.getElementById('d-account-picker');
    const inp = document.getElementById('d-account-search');
    const hid = document.getElementById('d-account');
    const results = document.getElementById('d-account-results');
    const meta = document.getElementById('d-account-meta');
    const clearBtn = document.getElementById('d-account-clear');
    if (!wrap || !inp || !hid || !results || !meta || !clearBtn) return;

    let visibleItems = [];
    let activeIndex = -1;

    function showResults() {
      results.classList.add('is-open');
      inp.setAttribute('aria-expanded', 'true');
    }

    function hideResults(opts) {
      const restoreSelection = !!(opts && opts.restoreSelection);
      results.classList.remove('is-open');
      inp.setAttribute('aria-expanded', 'false');
      activeIndex = -1;
      inp.removeAttribute('aria-activedescendant');
      results.querySelectorAll('.crm-account-opt.is-active').forEach((el) => el.classList.remove('is-active'));
      if (restoreSelection) {
        const acc = getAccountById(hid.value);
        inp.value = acc ? acc.name : '';
      }
    }

    function setSelectedAccount(acc, opts) {
      const keepText = !!(opts && opts.keepText);
      const keepOpen = !!(opts && opts.keepOpen);
      hid.value = acc ? String(acc.id) : '';
      wrap.dataset.selectedId = acc ? String(acc.id) : '';
      if (!keepText) inp.value = acc ? acc.name : '';
      renderMeta();
      renderResults(inp.value);
      if (!keepOpen) hideResults();
    }

    function renderMeta() {
      const acc = getAccountById(hid.value);
      if (!acc) {
        const typed = String(inp.value || '').trim();
        meta.innerHTML = typed
          ? `<span class="crm-account-hint">Neue Firma: <strong>${esc(typed)}</strong> mit Enter speichern.</span>`
          : '<span class="crm-account-hint">Eine Firma kann mehreren Projekten zugeordnet werden.</span>';
        return;
      }
      const linked = _state.leads
        .filter((x) => x.id !== lead.id && getLeadAccountIds(x).includes(acc.id))
        .slice()
        .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
      const linkedText = linked.length
        ? linked.slice(0, 6).map((x) => `<span class="crm-account-pill">${esc(projectRefLabel(x))}</span>`).join('')
        : '<span class="crm-account-hint">Noch kein weiteres Projekt dieser Firma zugeordnet.</span>';
      const previewCount = linked.length + (String(hid.value || '').trim() === String(acc.id) ? 1 : 0);
      const count = Math.max(acc.project_count != null ? acc.project_count : 0, previewCount);
      meta.innerHTML = `<div class="crm-account-summary">
        <strong>${esc(acc.name)}</strong>
        <span class="crm-account-summary-n">${esc(count)} Projekt${count === 1 ? '' : 'e'}</span>
      </div>
      <div class="crm-account-linked">${linkedText}</div>`;
    }

    function syncActiveOption() {
      results.querySelectorAll('.crm-account-opt').forEach((el, idx) => {
        const isActive = idx === activeIndex;
        el.classList.toggle('is-active', isActive);
        if (isActive && el.id) inp.setAttribute('aria-activedescendant', el.id);
      });
      if (activeIndex < 0) inp.removeAttribute('aria-activedescendant');
    }

    function moveActive(step) {
      if (!visibleItems.length) return;
      if (!results.classList.contains('is-open')) showResults();
      if (activeIndex < 0) activeIndex = step > 0 ? 0 : visibleItems.length - 1;
      else activeIndex = (activeIndex + step + visibleItems.length) % visibleItems.length;
      syncActiveOption();
      const item = visibleItems[activeIndex];
      const el = item && item.domId ? document.getElementById(item.domId) : null;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    function renderResults(query) {
      const q = normalizeSearchText(query);
      const selectedId = String(hid.value || '').trim();
      const filtered = _state.accounts
        .filter((acc) => {
          if (!q) return true;
          const hay = normalizeSearchText([acc.name, acc.note || '', ...(acc.project_labels || [])].join(' '));
          return hay.includes(q);
        })
        .sort((a, b) => {
          const aq = q && normalizeSearchText(a.name).startsWith(q) ? 0 : 1;
          const bq = q && normalizeSearchText(b.name).startsWith(q) ? 0 : 1;
          if (aq !== bq) return aq - bq;
          return String(a.name).localeCompare(String(b.name), 'de', { sensitivity: 'base' });
        })
        .slice(0, 10);

      const typed = String(query || '').trim();
      const exact = typed ? _state.accounts.find((acc) => normalizeSearchText(acc.name) === normalizeSearchText(typed)) : null;
      const items = [];
      visibleItems = [];
      if (typed && !exact) {
        const createId = 'd-account-opt-create';
        visibleItems.push({ kind: 'create', value: typed, domId: createId });
        items.push(`<button type="button" id="${createId}" class="crm-account-opt crm-account-opt-create" data-account-create="${esc(typed)}" role="option" aria-selected="false">
          Neue Firma anlegen: <strong>${esc(typed)}</strong>
        </button>`);
      }
      filtered.forEach((acc, idx) => {
        const current = String(acc.id) === selectedId;
        const count = acc.project_count || 0;
        const domId = `d-account-opt-${idx}`;
        visibleItems.push({ kind: 'account', value: String(acc.id), domId });
        items.push(`<button type="button" id="${domId}" class="crm-account-opt${current ? ' is-selected' : ''}" data-account-id="${esc(acc.id)}" role="option" aria-selected="${current ? 'true' : 'false'}">
          <span class="crm-account-opt-name">${esc(acc.name)}</span>
          <span class="crm-account-opt-meta">${esc(count)} Projekt${count === 1 ? '' : 'e'}</span>
        </button>`);
      });
      results.innerHTML = items.length ? items.join('') : '<div class="crm-account-empty">Keine passende Firma gefunden.</div>';
      if (activeIndex >= visibleItems.length) activeIndex = visibleItems.length ? 0 : -1;
      syncActiveOption();
      results.querySelectorAll('[data-account-id]').forEach((btn) => {
        btn.onclick = () => {
          const acc = getAccountById(btn.getAttribute('data-account-id'));
          setSelectedAccount(acc, { keepText: false });
        };
      });
      results.querySelectorAll('[data-account-create]').forEach((btn) => {
        btn.onclick = async () => {
          await createAccount(btn.getAttribute('data-account-create'));
        };
      });
    }

    async function createAccount(name) {
      const clean = String(name || '').trim();
      if (!clean) return null;
      const r = await api('/api/crm/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clean }),
      });
      if (!r.ok) {
        let msg = 'Firma konnte nicht angelegt werden.';
        try {
          const err = await r.json();
          if (err && err.error) msg = err.error;
        } catch (e) { /* ignore */ }
        alert(msg);
        return null;
      }
      const d = await r.json();
      await loadAccounts();
      const acc = d && d.account ? (getAccountById(d.account.id) || d.account) : _state.accounts.find((x) => normalizeSearchText(x.name) === normalizeSearchText(clean));
      setSelectedAccount(acc || null, { keepText: false });
      return acc || null;
    }

    async function commitInputSelection() {
      if (activeIndex >= 0 && visibleItems[activeIndex]) {
        const item = visibleItems[activeIndex];
        if (item.kind === 'account') {
          const acc = getAccountById(item.value);
          setSelectedAccount(acc, { keepText: false });
          return;
        }
        if (item.kind === 'create') {
          await createAccount(item.value);
          return;
        }
      }
      const typed = String(inp.value || '').trim();
      if (!typed) {
        setSelectedAccount(null, { keepText: false });
        return;
      }
      const exact = _state.accounts.find((acc) => normalizeSearchText(acc.name) === normalizeSearchText(typed));
      if (exact) setSelectedAccount(exact, { keepText: false });
      else await createAccount(typed);
    }

    clearBtn.onclick = () => {
      setSelectedAccount(null, { keepText: false, keepOpen: true });
      inp.focus();
      showResults();
    };
    inp.addEventListener('focus', () => {
      renderResults(inp.value);
      showResults();
    });
    inp.addEventListener('click', () => {
      renderResults(inp.value);
      showResults();
    });
    inp.addEventListener('input', () => {
      const typed = String(inp.value || '').trim();
      const selected = getAccountById(hid.value);
      if (selected && normalizeSearchText(selected.name) !== normalizeSearchText(typed)) {
        hid.value = '';
        wrap.dataset.selectedId = '';
      }
      activeIndex = -1;
      renderMeta();
      renderResults(typed);
      showResults();
    });
    inp.addEventListener('keydown', async (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        renderResults(inp.value);
        moveActive(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        renderResults(inp.value);
        moveActive(-1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideResults({ restoreSelection: true });
        renderMeta();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        await commitInputSelection();
      }
    });
    panel.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) hideResults({ restoreSelection: true });
    });
    results.addEventListener('mousedown', (e) => e.preventDefault());
    renderMeta();
    renderResults(inp.value);
  }

  function closeDetailPanel() {
    const panel = document.getElementById('crm-detail');
    if (!panel) return;
    if (panel._crmEsc) {
      document.removeEventListener('keydown', panel._crmEsc);
      panel._crmEsc = null;
    }
    if (panel._crmCalDocClose) {
      document.removeEventListener('click', panel._crmCalDocClose);
      panel._crmCalDocClose = null;
    }
    panel.onclick = null;
    panel.style.display = 'none';
  }

  /**
   * Monatskalender unter dem Erinnerungsdatum: Heute markiert, Klick setzt Datum (Popover).
   * Außenklick schließt; Escape schließt gesamtes Detail (bestehend).
   */
  function setupReminderCalendar(panel) {
    const inp = document.getElementById('d-reminder');
    const btn = document.getElementById('d-reminder-cal-btn');
    const pop = document.getElementById('d-reminder-cal-pop');
    if (!inp || !btn || !pop) return;

    if (panel._crmCalDocClose) {
      document.removeEventListener('click', panel._crmCalDocClose);
      panel._crmCalDocClose = null;
    }

    let viewMonth = new Date();
    viewMonth.setDate(1);
    viewMonth.setHours(12, 0, 0, 0);

    function syncViewFromInput() {
      const p = parseIsoDateLocal(inp.value);
      if (p) viewMonth = new Date(p.getFullYear(), p.getMonth(), 1, 12, 0, 0, 0);
    }

    function setOpen(wantOpen) {
      if (wantOpen) {
        syncViewFromInput();
        renderCal();
        pop.classList.add('crm-cal-popover--open');
      } else {
        pop.classList.remove('crm-cal-popover--open');
      }
    }

    function toggleCal() {
      setOpen(!pop.classList.contains('crm-cal-popover--open'));
    }

    function renderCal() {
      const y = viewMonth.getFullYear();
      const mo = viewMonth.getMonth();
      const firstDow = (new Date(y, mo, 1).getDay() + 6) % 7;
      const dim = new Date(y, mo + 1, 0).getDate();
      const todayIso = fmtIsoLocal(new Date());
      const selIso = (inp.value || '').trim().slice(0, 10);
      const doneCb = document.getElementById('d-reminder-done');
      const reminderDone = !!(doneCb && doneCb.checked);

      const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
      let html = `<div class="crm-cal-head">
        <button type="button" class="crm-cal-nav" data-cal="-1" aria-label="Vorheriger Monat">◀</button>
        <span class="crm-cal-title">${monthNames[mo]} ${y}</span>
        <button type="button" class="crm-cal-nav" data-cal="1" aria-label="Nächster Monat">▶</button>
      </div>`;
      html += `<div class="crm-cal-weekdays">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((w) => `<span>${w}</span>`).join('')}</div>`;
      html += '<div class="crm-cal-grid">';
      for (let i = 0; i < firstDow; i++) html += '<span class="crm-cal-pad"></span>';
      for (let d = 1; d <= dim; d++) {
        const iso = isoFromParts(y, mo, d);
        const cls = ['crm-cal-day'];
        if (iso === todayIso) cls.push('crm-cal-today');
        if (iso === selIso) cls.push('crm-cal-selected');
        if (selIso && iso === selIso && !reminderDone) cls.push('crm-cal-term');
        html += `<button type="button" class="${cls.join(' ')}" data-iso="${iso}">${d}</button>`;
      }
      html += '</div>';
      html += '<div class="crm-cal-foot"><button type="button" class="crm-cal-clear" id="d-reminder-cal-clear">Datum löschen</button></div>';
      pop.innerHTML = html;

      pop.querySelectorAll('[data-cal]').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          viewMonth.setMonth(viewMonth.getMonth() + +b.getAttribute('data-cal'));
          renderCal();
        };
      });
      pop.querySelectorAll('.crm-cal-day').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          inp.value = b.getAttribute('data-iso');
          pop.classList.remove('crm-cal-popover--open');
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        };
      });
      const clr = document.getElementById('d-reminder-cal-clear');
      if (clr) {
        clr.onclick = (e) => {
          e.stopPropagation();
          inp.value = '';
          pop.classList.remove('crm-cal-popover--open');
        };
      }
    }

    btn.onclick = (e) => {
      e.stopPropagation();
      toggleCal();
    };

    inp.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(true);
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    });

    const doneCb = document.getElementById('d-reminder-done');
    if (doneCb) {
      doneCb.addEventListener('change', () => {
        if (pop.classList.contains('crm-cal-popover--open')) renderCal();
      });
    }

    const docCloser = (e) => {
      const popEl = document.getElementById('d-reminder-cal-pop');
      const btnEl = document.getElementById('d-reminder-cal-btn');
      const inpEl = document.getElementById('d-reminder');
      if (!popEl || !popEl.classList.contains('crm-cal-popover--open')) return;
      if (btnEl && (e.target === btnEl || btnEl.contains(e.target))) return;
      if (inpEl && (e.target === inpEl || inpEl.contains(e.target))) return;
      if (popEl.contains(e.target)) return;
      popEl.classList.remove('crm-cal-popover--open');
    };
    panel._crmCalDocClose = docCloser;
    document.addEventListener('click', docCloser);
  }

  const CRM_MAP_H_STEP = 26;
  const CRM_MAP_W_STEP = 5;

  /** Entspricht dem früheren CSS clamp(260px, 42vh, 460px) — Bezug für Standard −25 % Höhe */
  function crmMapPreviewBaselineHeightPx() {
    return Math.min(Math.max(Math.round(window.innerHeight * 0.42), 260), 460);
  }

  function crmMapPreviewDefaultHeightPx() {
    return Math.round(crmMapPreviewBaselineHeightPx() * 0.75);
  }

  function loadCrmMapPreviewPrefs() {
    const fallbackH = crmMapPreviewDefaultHeightPx();
    try {
      const j = JSON.parse(localStorage.getItem(CRM_MAP_PREVIEW_LS) || '{}');
      const h = Number.isFinite(+j.h) ? Math.round(+j.h) : fallbackH;
      const wPct = Number.isFinite(+j.wPct) ? Math.round(+j.wPct) : 100;
      return { h, wPct };
    } catch {
      return { h: fallbackH, wPct: 100 };
    }
  }

  function saveCrmMapPreviewPrefs(h, wPct) {
    try {
      localStorage.setItem(CRM_MAP_PREVIEW_LS, JSON.stringify({ h, wPct }));
    } catch { /* ignore */ }
  }

  /** −/+ Höhe und Breite der eingebetteten Karte; Toolbar unten rechts auf der Karte */
  function setupCrmDetailMapResize() {
    const wrap = document.getElementById('crm-detail-map-wrap');
    if (!wrap) return;
    let prefs = loadCrmMapPreviewPrefs();

    function clampPrefs() {
      const maxH = Math.min(Math.round(window.innerHeight * 0.88), 540);
      prefs.h = Math.min(Math.max(prefs.h, 110), maxH);
      prefs.wPct = Math.min(Math.max(prefs.wPct, 52), 100);
    }

    function apply() {
      clampPrefs();
      wrap.style.setProperty('--crm-map-preview-h', prefs.h + 'px');
      wrap.style.setProperty('--crm-map-preview-w', prefs.wPct + '%');
      if (prefs.wPct >= 99) {
        wrap.style.marginLeft = '';
        wrap.style.marginRight = '';
      } else {
        wrap.style.marginLeft = 'auto';
        wrap.style.marginRight = 'auto';
      }
      saveCrmMapPreviewPrefs(prefs.h, prefs.wPct);
    }

    apply();

    function bind(btnId, handler) {
      const b = document.getElementById(btnId);
      if (!b) return;
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
      };
    }

    bind('crm-map-h-minus', () => { prefs.h -= CRM_MAP_H_STEP; apply(); });
    bind('crm-map-h-plus', () => { prefs.h += CRM_MAP_H_STEP; apply(); });
    bind('crm-map-w-minus', () => { prefs.wPct -= CRM_MAP_W_STEP; apply(); });
    bind('crm-map-w-plus', () => { prefs.wPct += CRM_MAP_W_STEP; apply(); });
  }

  async function openDetail(id) {
    const L = _state.leads.find(x => x.id === id);
    if (!L) return;
    const d = L.data || {};
    const c = L.contact || {};
    const panel = document.getElementById('crm-detail');
    if (panel._crmEsc) {
      document.removeEventListener('keydown', panel._crmEsc);
      panel._crmEsc = null;
    }
    if (panel._crmCalDocClose) {
      document.removeEventListener('click', panel._crmCalDocClose);
      panel._crmCalDocClose = null;
    }
    panel.style.display = 'flex';
    const stOpts = STAGE_ORDER.map(s =>
      `<option value="${esc(s)}" ${L.stage === s ? 'selected' : ''}>${esc(_state.stageLabels[s] || s)}</option>`
    ).join('');
    const accountIds = getLeadAccountIds(L);
    const primaryAccountId = accountIds[0] || '';
    const mEmbed = mapEmbedUrl(L);
    const mTab = mapAppNewTabUrl(L);
    const addr0 = defaultAddress(L);
    const projName = (L.name || '').trim();
    const notes0 = (d.crm_notes != null) ? String(d.crm_notes) : '';
    const projDesc0 = (d.project_description != null) ? String(d.project_description) : '';
    const remAt = (d.reminder_at || '').toString().slice(0, 10);
    const remLb = (d.reminder_label != null) ? String(d.reminder_label) : '';

    panel.innerHTML = `<div class="crm-detail-inner"
      ><button type="button" class="crm-detail-x" id="crm-detail-close">×</button>
      <h3 class="crm-detail-h">${esc(projName || d.address || 'Projekt')}</h3>
      <p class="crm-detail-sub">Osm-ID ${esc(L.osm_id)} · Prio: Trafo ${esc(L.sort_distance_m)} m · Dach ${esc(L.sort_roof_m2)} m² · ${esc(L.sort_kwp)} kWp</p>
      <div class="crm-detail-iframe-wrap" id="crm-detail-map-wrap">
        <div class="crm-map-iframe-slot">
          <iframe class="crm-map-iframe" title="Kartenvorschau" src="${esc(mEmbed)}" loading="eager" referrerpolicy="same-origin"></iframe>
          <div class="crm-map-resize-tools" role="toolbar" aria-label="Größe der Kartenvorschau">
            <button type="button" class="crm-map-rs-btn" id="crm-map-h-minus" title="Höhe verringern">−</button>
            <span class="crm-map-rs-lbl" title="Höhe">H</span>
            <button type="button" class="crm-map-rs-btn" id="crm-map-h-plus" title="Höhe erhöhen">+</button>
            <span class="crm-map-rs-gap" aria-hidden="true"></span>
            <button type="button" class="crm-map-rs-btn" id="crm-map-w-minus" title="Breite verringern">−</button>
            <span class="crm-map-rs-lbl" title="Breite (Anteil Dialogbreite)">B</span>
            <button type="button" class="crm-map-rs-btn" id="crm-map-w-plus" title="Breite erhöhen">+</button>
          </div>
        </div>
        <div class="crm-iframe-hint">Satellit + Dachumriss — Zoom so, dass das gesamte Dach sichtbar ist</div>
      </div>
      <div class="crm-detail-links">
        <a class="crm-a" href="${esc(L.google_maps_url)}" target="_blank" rel="noopener">Google Maps</a>
        <span class="crm-dot">·</span>
        <a class="crm-a" href="${esc(d.atlas_url || 'https://atlas.noe.gv.at/')}" target="_blank" rel="noopener">NÖ Atlas</a>
        <span class="crm-dot">·</span>
        <a class="crm-a" href="${esc(mTab)}" target="_blank" rel="noopener">Karte in neuem Tab</a>
      </div>
      <div class="crm-detail-form">
        <label class="crm-lbl">Projektname
          <input type="text" id="d-name" class="crm-inp" value="${esc(projName)}" placeholder="interner Name"/>
        </label>
        <label class="crm-lbl crm-span2">Grundstücksadresse / Lage
          <textarea id="d-addr" class="crm-ta" rows="2" placeholder="Straße, Postleitzahl, Ort (nicht: interner Projektname / Trafo)">${esc(addr0)}</textarea>
        </label>
        <label class="crm-lbl">Ansprechpartner
          <input type="text" id="d-cname" class="crm-inp" value="${esc(c.name)}" placeholder="Name"/>
        </label>
        <label class="crm-lbl">Telefon
          <input type="text" id="d-cphone" class="crm-inp" value="${esc(c.phone)}" />
        </label>
        <label class="crm-lbl">E-Mail
          <input type="email" id="d-email" class="crm-inp" value="${esc(c.email)}" />
        </label>
        <label class="crm-lbl">Stufe
          <select id="d-stage" class="crm-sel">${stOpts}</select>
        </label>
        <label class="crm-lbl">Firma
          ${buildAccountPickerHtml(primaryAccountId)}
        </label>
        <label class="crm-lbl crm-span2">Projektbeschreibung
          <textarea id="d-projdesc" class="crm-ta crm-ta-notes" rows="3" placeholder="Vorhaben, Eckdaten, nächste Schritte — ähnlich den Gesprächsnotizen, aber für die Gesamtbeschreibung">${esc(projDesc0)}</textarea>
        </label>
        <label class="crm-lbl crm-span2 crm-cbrow"><input type="checkbox" id="d-vb" ${L.vollmacht_bestaetigt ? 'checked' : ''}/> Vollmacht bestätigt (final)</label>
        <label class="crm-lbl crm-span2">Notizen (Anrufe, Infos)
          <textarea id="d-notes" class="crm-ta crm-ta-notes" rows="4" placeholder="Freitext — z. B. was im Telefonat besprochen wurde">${esc(notes0)}</textarea>
        </label>
        <label class="crm-lbl crm-span2">Erinnerung / Wiedervorlage (Datum)
          <span class="crm-reminder-hint">Auf Datum oder Kalender klicken — Popup öffnet nach oben (Ortsdatum, Mitternacht).</span>
          <div class="crm-reminder-anchor">
            <div class="crm-reminder-row">
              <input type="date" id="d-reminder" class="crm-inp crm-reminder-inp" readonly value="${esc(remAt)}" title="Klick öffnet Kalender"/>
              <button type="button" id="d-reminder-cal-btn" class="crm-cal-open-btn" title="Monatskalender">📅 Kalender</button>
            </div>
            <div id="d-reminder-cal-pop" class="crm-cal-popover" role="dialog" aria-label="Datum für Erinnerung wählen"></div>
          </div>
        </label>
        <label class="crm-lbl crm-span2">Kurzbezeichnung Termin
          <input type="text" id="d-remlabel" class="crm-inp" value="${esc(remLb)}" placeholder="z. B. Rückruf, Termin vor Ort"/>
        </label>
        <label class="crm-lbl crm-span2 crm-cbrow"><input type="checkbox" id="d-reminder-done" ${d.reminder_completed === true ? 'checked' : ''}/> Erinnerung / Termin als erledigt markieren</label>
        <div class="crm-lbl crm-span2" style="margin-top:4px">GIS</div>
        <button type="button" class="crm-sync-btn" id="d-sync">Aktuelle Gebäude-Daten synchronisieren</button>
      </div>
      <div class="crm-detail-actions">
        <button type="button" class="crm-save-btn" id="d-save">Speichern</button>
      </div>
    </div>`;

    document.getElementById('crm-detail-close').onclick = () => closeDetailPanel();
    panel._crmEsc = (e) => {
      if (e.key !== 'Escape') return;
      const pop = document.getElementById('d-reminder-cal-pop');
      if (pop && pop.classList.contains('crm-cal-popover--open')) {
        pop.classList.remove('crm-cal-popover--open');
        return;
      }
      closeDetailPanel();
    };
    document.addEventListener('keydown', panel._crmEsc);
    panel.onclick = (e) => { if (e.target === panel) closeDetailPanel(); };
    document.getElementById('d-sync').onclick = async () => {
      const r = await api('/api/leads/' + encodeURIComponent(id) + '/sync-gis', { method: 'POST' });
      if (r.ok) {
        await loadPipeline();
        openDetail(id);
      }
    };
    setupAccountPicker(panel, L);
    document.getElementById('d-save').onclick = async () => {
      const name = (document.getElementById('d-name').value || '').trim();
      const address = (document.getElementById('d-addr').value || '').trim();
      const notes = (document.getElementById('d-notes').value || '').trim();
      const projDesc = (document.getElementById('d-projdesc').value || '').trim();
      const remRaw = (document.getElementById('d-reminder').value || '').trim();
      const remLabel = (document.getElementById('d-remlabel').value || '').trim();
      const remDoneEl = document.getElementById('d-reminder-done');
      const data = {
        address,
        crm_notes: notes,
        reminder_label: remLabel,
        project_description: projDesc || null,
        reminder_completed: !!(remDoneEl && remDoneEl.checked),
      };
      if (remRaw) data.reminder_at = remRaw;
      else data.reminder_at = null;
      const body = {
        name: name || undefined,
        stage: document.getElementById('d-stage').value,
        account_id: document.getElementById('d-account').value || null,
        account_ids: (() => {
          const primary = String(document.getElementById('d-account').value || '').trim();
          return primary ? [primary] : [];
        })(),
        vollmacht_bestaetigt: document.getElementById('d-vb').checked,
        contact: {
          name:  (document.getElementById('d-cname').value || '').trim(),
          phone: (document.getElementById('d-cphone').value || '').trim(),
          email: (document.getElementById('d-email').value || '').trim(),
        },
        data,
      };
      if (!body.name) delete body.name;
      const r = await api('/api/leads/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        await loadPipeline();
        closeDetailPanel();
      }
    };

    setupReminderCalendar(panel);
    setupCrmDetailMapResize();
  }

  function injectStyles() {
    document.getElementById('crm-styles')?.remove();
    const s = document.createElement('style');
    s.id = 'crm-styles';
    s.textContent = `
#view-crm{position:fixed;inset:0;z-index:6000;flex-direction:column;--crm-link:#7ecfff;--crm-bg:#111520;--crm-panel:#1a1d26;--crm-brd:#2e3450;--crm-txt:#e0e4ef;--crm-muted:#8892aa;--crm-scroll-track:#0f1219;--crm-scroll-thumb:#3d4a6a}
#view-crm[data-crm-theme="light"]{--crm-link:#0ea5e9;--crm-bg:#f1f5f9;--crm-panel:#ffffff;--crm-brd:#cbd5e1;--crm-txt:#0f172a;--crm-muted:#64748b;--crm-scroll-track:#e2e8f0;--crm-scroll-thumb:#94a3b8}
#view-crm{flex-direction:column;background:var(--crm-bg);color:var(--crm-txt);font-family:'Segoe UI',system-ui,sans-serif}
.crm-a{color:var(--crm-link)!important;font-weight:600;text-decoration:underline;text-underline-offset:2px}
.crm-a:hover{filter:brightness(1.12)}
.crm-bar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:#0a0c12;border-bottom:1px solid var(--crm-brd)}
#view-crm[data-crm-theme="light"] .crm-bar{background:#e2e8f0}
.crm-bar a.crm-a{color:var(--crm-link)!important}
.crm-bar a[href="/"]:not(.crm-a){color:var(--crm-link)!important;font-weight:700}
.crm-bar strong{color:var(--crm-link)}
#crm-root{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.crm-toolbar{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--crm-brd);flex-wrap:wrap}
.crm-theme-btn{background:var(--crm-panel);border:1px solid var(--crm-brd);color:var(--crm-txt);border-radius:8px;padding:4px 10px;cursor:pointer;font-size:1rem;line-height:1}
.crm-tab{padding:5px 12px;border-radius:6px;border:1px solid var(--crm-brd);background:var(--crm-panel);color:var(--crm-muted);cursor:pointer;font-size:.78rem;font-weight:600}
.crm-tab.on{background:#2563eb;border-color:#2563eb;color:#fff}
.crm-toolbar-sp{flex:1}
.crm-sort-lbl{display:flex;align-items:center;gap:6px;font-size:.7rem;font-weight:700;color:var(--crm-muted);text-transform:uppercase;letter-spacing:.04em}
.crm-sort{background:var(--crm-panel);color:var(--crm-txt);border:1px solid var(--crm-brd);border-radius:6px;padding:4px 8px;font-size:.72rem;max-width:min(220px,46vw)}
.crm-card.crm-rem--missed{border-color:#ea580c;box-shadow:0 0 0 1px rgba(234,88,12,.48)}
.crm-card.crm-rem--soon{border-color:#facc15;box-shadow:0 0 0 1px rgba(250,204,21,.45)}
#view-crm[data-crm-theme="light"] .crm-card.crm-rem--missed,#view-crm[data-crm-theme="light"] .crm-card.crm-rem--soon{box-shadow:0 1px 2px rgba(0,0,0,.1)}
tr.crm-rem--missed td{background:rgba(234,88,12,.16)!important}
tr.crm-rem--soon td{background:rgba(161,98,7,.18)!important}
.crm-card-remind{font-size:.65rem;font-weight:700;color:#facc15}
.crm-card.crm-rem--missed .crm-card-remind{color:#fb923c}
.crm-termine-empty{padding:28px 16px;color:var(--crm-muted);font-size:.85rem;text-align:center}
.crm-table-termine{table-layout:auto;min-width:min(920px,100%)}
.crm-term-row--missed td{background:rgba(234,88,12,.12)!important}
.crm-term-row--soon td{background:rgba(161,98,7,.14)!important}
.crm-term-badge{display:inline-block;margin-left:6px;padding:2px 6px;border-radius:4px;font-size:.58rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
.crm-term-badge--miss{background:rgba(234,88,12,.35);color:#ffedd5}
.crm-term-badge--soon{background:rgba(250,204,21,.35);color:#422006}
.crm-term-act{white-space:nowrap}
.crm-btn-termdone{color:#16a34a!important;border-color:rgba(22,163,74,.45)}
.crm-ta-notes{min-height:88px}
.crm-export{font-size:.76rem;color:#16a34a!important;font-weight:700}
#view-crm[data-crm-theme="light"] .crm-export{color:#15803d!important}
.crm-user{font-size:.72rem;color:var(--crm-muted)}
.crm-body{flex:1;overflow:auto;padding:10px;scrollbar-color:var(--crm-scroll-thumb) var(--crm-scroll-track);scrollbar-width:thin}
.crm-body::-webkit-scrollbar,.crm-col-body::-webkit-scrollbar,.crm-table-wrap::-webkit-scrollbar,.crm-detail-inner::-webkit-scrollbar{width:9px;height:9px}
.crm-body::-webkit-scrollbar-track,.crm-col-body::-webkit-scrollbar-track,.crm-table-wrap::-webkit-scrollbar-track,.crm-detail-inner::-webkit-scrollbar-track{background:var(--crm-scroll-track);border-radius:5px}
.crm-body::-webkit-scrollbar-thumb,.crm-col-body::-webkit-scrollbar-thumb,.crm-table-wrap::-webkit-scrollbar-thumb,.crm-detail-inner::-webkit-scrollbar-thumb{background:var(--crm-scroll-thumb);border-radius:5px}
.crm-kanban{display:flex;gap:10px;align-items:flex-start;min-height:400px}
.crm-col{flex:1;min-width:160px;background:var(--crm-panel);border:1px solid var(--crm-brd);border-radius:8px;display:flex;flex-direction:column;max-height:calc(100vh - 140px)}
.crm-col-head{padding:8px;font-size:.72rem;font-weight:800;color:var(--crm-link);border-bottom:1px solid var(--crm-brd)}
.crm-n{opacity:.6}
.crm-col-body{padding:6px;overflow-y:auto;flex:1;scrollbar-color:var(--crm-scroll-thumb) var(--crm-scroll-track);scrollbar-width:thin}
.crm-col-body.drag-over{background:rgba(37,99,235,.12)}
.crm-card{background:var(--crm-panel);border:1px solid var(--crm-brd);border-radius:6px;padding:7px;margin-bottom:6px;cursor:grab;font-size:.74rem;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.crm-card.crm-card--discard{border-color:#b91c1c;background:rgba(127,29,29,.14)}
#view-crm[data-crm-theme="light"] .crm-card.crm-card--discard{background:#fef2f2;border-color:#dc2626}
#view-crm[data-crm-theme="light"] .crm-card{background:#fff}
.crm-card-pid{font-size:.65rem;color:var(--crm-muted);font-weight:800}
.crm-card-title{color:var(--crm-txt);font-weight:600}
.crm-card-meta{color:var(--crm-muted);font-size:.66rem;margin-top:2px}
.crm-card-actions{margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.crm-btn-mini{font-size:.65rem;padding:3px 8px;border-radius:4px;border:1px solid var(--crm-brd);background:var(--crm-bg);color:var(--crm-link);cursor:pointer;font-weight:600}
.crm-table-wrap{overflow:auto;scrollbar-color:var(--crm-scroll-thumb) var(--crm-scroll-track);scrollbar-width:thin}
.crm-table{width:100%;border-collapse:collapse;font-size:.74rem}
.crm-table th,.crm-table td{border-bottom:1px solid var(--crm-brd);padding:6px 8px;text-align:left;vertical-align:top}
.crm-table th{color:var(--crm-muted);font-weight:700}
.crm-table-data{table-layout:fixed;width:100%;min-width:max(1100px,100%)}
.crm-table-data .td-n,.crm-table-data .td-num,.crm-table-data .td-dt{white-space:nowrap}
.crm-table-data .td-n,.crm-table-data .td-num{text-align:right}
.crm-table-data .td-dt,.crm-table-data .td-act{text-align:left}
.crm-table-data .td-name,.crm-table-data .td-addr,.crm-table-data .td-em{word-break:break-word;overflow-wrap:anywhere;hyphens:auto}
.crm-table-data tr.crm-row--discard td{background:rgba(127,29,29,.12)!important}
#view-crm[data-crm-theme="light"] .crm-table-data tr.crm-row--discard td{background:#fef2f2!important}
.crm-th-sort,.crm-th-nosort{position:relative;cursor:pointer;padding:6px 10px 6px 6px;white-space:nowrap}
.crm-th-nosort{cursor:default}
.crm-th-sort:hover{background:rgba(37,99,235,.1)}
#view-crm[data-crm-theme="light"] .crm-th-sort:hover{background:rgba(37,99,235,.12)}
.crm-th-txt{pointer-events:none}
.crm-col-res{position:absolute;right:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:2;padding:0 2px;box-sizing:content-box}
.crm-col-res:hover{background:rgba(56,189,248,.2)}
.crm-table-sort-hint{font-size:.68rem;color:var(--crm-muted);line-height:1.3;max-width:min(320px,40vw)}
.crm-detail{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:7000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
#view-crm[data-crm-theme="light"] .crm-detail{background:rgba(15,23,42,.35)}
.crm-detail-inner{position:relative;background:var(--crm-panel);border:1px solid var(--crm-brd);border-radius:12px;padding:20px;max-width:min(920px,96vw);width:100%;max-height:90vh;overflow-y:auto;box-sizing:border-box}
.crm-detail-h{margin:0 0 4px 0;font-size:1.05rem;color:var(--crm-txt)}
.crm-detail-sub{margin:0 0 10px 0;font-size:.72rem;color:var(--crm-muted);line-height:1.4}
.crm-detail-iframe-wrap{
  margin:10px auto;
  border:1px solid var(--crm-brd);
  border-radius:10px;
  overflow:hidden;
  background:#000;
  width:var(--crm-map-preview-w,100%);
  height:var(--crm-map-preview-h,240px);
  min-height:140px;
  max-height:min(88vh,540px);
  flex-shrink:0;
  box-sizing:border-box;
  display:flex;
  flex-direction:column;
}
.crm-map-iframe-slot{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.crm-map-iframe{flex:1;width:100%;min-height:72px;border:0;display:block}
.crm-map-resize-tools{
  position:absolute;
  bottom:8px;
  right:8px;
  display:flex;
  align-items:center;
  gap:3px;
  background:rgba(17,21,32,.92);
  border:1px solid var(--crm-brd);
  border-radius:8px;
  padding:5px 7px;
  z-index:6;
  box-shadow:0 4px 14px rgba(0,0,0,.45);
}
#view-crm[data-crm-theme="light"] .crm-map-resize-tools{background:rgba(255,255,255,.94)}
.crm-map-rs-btn{
  width:26px;height:26px;padding:0;border-radius:6px;
  border:1px solid var(--crm-brd);
  background:var(--crm-panel);
  color:var(--crm-txt);
  cursor:pointer;font-size:.95rem;line-height:1;font-weight:700;
}
.crm-map-rs-btn:hover{border-color:#2563eb;color:var(--crm-link)}
.crm-map-rs-lbl{font-size:.62rem;font-weight:800;color:var(--crm-muted);width:14px;text-align:center;text-transform:none;letter-spacing:0}
.crm-map-rs-gap{width:8px;flex-shrink:0}
.crm-iframe-hint{font-size:.65rem;color:var(--crm-muted);padding:6px 8px 8px;background:rgba(0,0,0,.35);flex-shrink:0;line-height:1.35}
#view-crm[data-crm-theme="light"] .crm-iframe-hint{background:rgba(241,245,249,.88)}
.crm-reminder-hint{display:block;font-size:.62rem;font-weight:500;color:var(--crm-muted);text-transform:none;letter-spacing:0;line-height:1.35;margin-top:2px}
.crm-reminder-anchor{position:relative;width:100%;margin-top:6px}
.crm-reminder-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.crm-reminder-inp{flex:1;min-width:160px;cursor:pointer}
.crm-cal-open-btn{flex-shrink:0;padding:8px 14px;border-radius:8px;border:1px solid var(--crm-brd);background:var(--crm-bg);color:var(--crm-link);cursor:pointer;font-size:.78rem;font-weight:700}
.crm-cal-open-btn:hover{border-color:#2563eb}
.crm-cal-popover{display:none;position:absolute;left:0;bottom:100%;margin-bottom:8px;margin-top:0;width:min(280px,94vw);max-width:94vw;padding:8px;border:1px solid var(--crm-brd);border-radius:10px;background:var(--crm-panel);box-shadow:0 10px 28px rgba(0,0,0,.4);z-index:80}
.crm-cal-popover.crm-cal-popover--open{display:block}
.crm-cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:6px}
.crm-cal-nav{background:var(--crm-bg);border:1px solid var(--crm-brd);color:var(--crm-txt);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:.85rem;line-height:1}
.crm-cal-title{font-size:.82rem;font-weight:700;color:var(--crm-txt);flex:1;text-align:center}
.crm-cal-weekdays{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px;font-size:.62rem;color:var(--crm-muted);text-align:center}
.crm-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.crm-cal-pad{min-height:34px}
.crm-cal-day{min-height:34px;border-radius:6px;border:1px solid transparent;background:var(--crm-bg);color:var(--crm-txt);cursor:pointer;font-size:.76rem;font-weight:600;padding:0}
.crm-cal-day:hover{border-color:#2563eb;background:rgba(37,99,235,.14)}
.crm-cal-day.crm-cal-today{box-shadow:inset 0 0 0 2px #facc15}
.crm-cal-day.crm-cal-term:not(.crm-cal-selected){background:rgba(250,204,21,.38);border-color:#ca8a04}
.crm-cal-day.crm-cal-selected{background:#2563eb;color:#fff;border-color:#2563eb}
.crm-cal-day.crm-cal-selected.crm-cal-term{box-shadow:inset 0 0 0 2px #eab308}
.crm-cal-foot{margin-top:8px;display:flex;justify-content:flex-end}
.crm-cal-clear{font-size:.72rem;padding:5px 10px;border-radius:6px;border:1px solid var(--crm-brd);background:transparent;color:var(--crm-muted);cursor:pointer}
.crm-detail-links{margin-bottom:12px;font-size:.8rem;line-height:1.6}
.crm-dot{opacity:.45;padding:0 2px}
.crm-detail-form{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.crm-lbl{display:flex;flex-direction:column;gap:4px;font-size:.7rem;font-weight:700;color:var(--crm-muted);text-transform:uppercase;letter-spacing:.04em}
.crm-span2{grid-column:1/-1}
.crm-inp,.crm-sel,.crm-ta{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--crm-brd);background:var(--crm-bg);color:var(--crm-txt);font-size:.85rem;box-sizing:border-box}
.crm-account-picker{position:relative;display:flex;flex-direction:column;gap:8px}
.crm-account-input-row{display:flex;gap:8px;align-items:center}
.crm-account-clear{flex:0 0 auto;min-width:38px;height:38px;font-size:1rem;line-height:1}
.crm-account-results{display:none;max-height:220px;overflow:auto;border:1px solid var(--crm-brd);border-radius:8px;background:var(--crm-panel);box-shadow:0 8px 22px rgba(0,0,0,.18)}
.crm-account-results.is-open{display:block}
.crm-account-opt{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:0;border-bottom:1px solid var(--crm-brd);background:transparent;color:var(--crm-txt);cursor:pointer;text-align:left}
.crm-account-opt:last-child{border-bottom:0}
.crm-account-opt:hover,.crm-account-opt.is-active,.crm-account-opt.is-selected{background:rgba(37,99,235,.12)}
.crm-account-opt-create{color:var(--crm-link);font-weight:700}
.crm-account-opt-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crm-account-opt-meta{flex:0 0 auto;font-size:.72rem;color:var(--crm-muted)}
.crm-account-empty{padding:10px;color:var(--crm-muted);font-size:.8rem}
.crm-account-meta{display:flex;flex-direction:column;gap:6px}
.crm-account-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:.78rem;color:var(--crm-txt);text-transform:none;letter-spacing:0}
.crm-account-summary-n{font-size:.72rem;color:var(--crm-muted)}
.crm-account-linked{display:flex;gap:6px;flex-wrap:wrap}
.crm-account-pill{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:rgba(37,99,235,.14);color:var(--crm-link);font-size:.72rem;font-weight:600;text-transform:none;letter-spacing:0}
.crm-account-hint{font-size:.74rem;color:var(--crm-muted);text-transform:none;letter-spacing:0}
.crm-ta{resize:vertical;min-height:48px}
.crm-cbrow{flex-direction:row;align-items:center;gap:8px;text-transform:none;font-weight:600;cursor:pointer;color:var(--crm-txt)}
.crm-cbrow input{accent-color:#2563eb;width:auto}
.crm-sync-btn{grid-column:1/-1;padding:7px 12px;border-radius:8px;border:1px solid var(--crm-brd);background:var(--crm-bg);color:var(--crm-link);cursor:pointer;font-size:.8rem;font-weight:600;justify-self:start}
.crm-detail-x{position:absolute;top:6px;right:10px;border:none;background:none;color:var(--crm-muted);font-size:1.4rem;cursor:pointer;line-height:1}
.crm-detail-actions{margin-top:16px}
.crm-save-btn{padding:9px 20px;border-radius:8px;border:none;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;font-size:.88rem}
.crm-detail-actions .crm-save-btn:hover{background:#1d4ed8}
`;
    document.head.appendChild(s);
  }

  async function init() {
    if (!isCrmPath()) return;
    document.title = 'CRM Roof';
    injectStyles();
    const wrap = document.createElement('div');
    wrap.id = 'view-crm';
    wrap.innerHTML = `<div class="crm-bar">
      <a class="crm-a" href="/">← Karte</a>
      <strong>Vertrieb-CRM</strong>
      <span style="flex:1"></span>
      <button type="button" class="crm-theme-btn" id="crm-bar-theme" title="Hell / Dunkel">${getTheme() === 'light' ? '☀' : '🌙'}</button>
    </div><div id="crm-root" style="flex:1;min-height:0;display:flex;flex-direction:column"><p style="padding:20px">Lade…</p></div>`;
    document.body.appendChild(wrap);
    applyCrmTheme(getTheme());
    wrap.style.display = 'flex';
    showMapUi(false);
    document.getElementById('crm-bar-theme').addEventListener('click', () => {
      applyCrmTheme(getTheme() === 'light' ? 'dark' : 'light');
    });
    await loadMe();
    await loadAccounts();
    await loadPipeline();
    try {
      const sp = new URLSearchParams(location.search);
      const byId = sp.get('open') || sp.get('lead') || sp.get('id');
      const byOsm = sp.get('osm');
      let toOpen = byId;
      if (!toOpen && byOsm) {
        const m = _state.leads.find(
          (x) => x.osm_id != null && String(x.osm_id) === String(byOsm)
        );
        if (m) toOpen = m.id;
      }
      if (toOpen) {
        setTimeout(() => {
          void openDetail(toOpen);
          const u = new URL(location.href);
          ['open', 'lead', 'id', 'osm'].forEach((k) => u.searchParams.delete(k));
          const q = u.searchParams.toString();
          history.replaceState({}, '', u.pathname + (q ? '?' + q : ''));
        }, 100);
      }
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
