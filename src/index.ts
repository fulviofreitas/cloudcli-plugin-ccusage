import type { PluginAPI, PluginContext, ViewMode, DailyEntry, MonthlyEntry, SessionEntry, BlockEntry } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";
const MAX_ROWS = 200;
const VIEWS: { key: ViewMode; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'session', label: 'Session' },
  { key: 'blocks', label: '5-Hour Blocks' },
];

// ── Theme ──────────────────────────────────────────────────────────────

interface Theme {
  bg: string; surface: string; border: string; text: string;
  muted: string; accent: string; accentDim: string; green: string;
  red: string; yellow: string;
}

function getTheme(dark: boolean): Theme {
  return dark
    ? { bg: '#08080f', surface: '#0e0e1a', border: '#1a1a2c', text: '#e2e0f0',
        muted: '#52507a', accent: '#fbbf24', accentDim: 'rgba(251,191,36,0.1)',
        green: '#22c55e', red: '#ef4444', yellow: '#eab308' }
    : { bg: '#fafaf9', surface: '#ffffff', border: '#e8e6f0', text: '#0f0e1a',
        muted: '#9490b0', accent: '#d97706', accentDim: 'rgba(217,119,6,0.08)',
        green: '#16a34a', red: '#dc2626', yellow: '#ca8a04' };
}

// ── Helpers ────────────────────────────────────────────────────────────

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function shortModel(name: string): string {
  return name
    .replace('claude-', '')
    .replace(/-\d{8}$/, '');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Ensure CSS ────────────────────────────────────────────────────────

function ensureStyles(): void {
  if (document.getElementById('cc-cost-styles')) return;
  const style = document.createElement('style');
  style.id = 'cc-cost-styles';
  style.textContent = `
    @keyframes cc-pulse { 0%,100%{opacity:.3} 50%{opacity:.6} }
    @keyframes cc-fadeup { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
    .cc-skel { animation: cc-pulse 1.6s ease infinite; }
    .cc-up { animation: cc-fadeup 0.35s ease both; }
    .cc-seg-btn { border:none; padding:6px 14px; font-size:0.7rem; cursor:pointer;
      font-family:${MONO}; letter-spacing:0.04em; transition:all 0.15s; border-radius:3px; }
    .cc-seg-btn:hover { opacity:0.9; }
    .cc-table { width:100%; border-collapse:collapse; font-size:0.7rem; }
    .cc-table th { text-align:left; text-transform:uppercase; letter-spacing:0.1em;
      font-size:0.6rem; padding:8px 10px; font-weight:500; }
    .cc-table td { padding:7px 10px; }
    .cc-table tr:hover td { opacity:0.85; }
    .cc-refresh { border:none; padding:5px 12px; font-size:0.7rem; cursor:pointer;
      font-family:${MONO}; letter-spacing:0.05em; border-radius:3px; transition:all 0.15s; background:transparent; }
    .cc-refresh:hover { opacity:0.8; }
    .cc-check { cursor:pointer; margin-right:6px; }
    .cc-date-input { border:none; padding:4px 8px; font-size:0.7rem; font-family:${MONO};
      border-radius:3px; width:100px; }
  `;
  document.head.appendChild(style);

  if (!document.getElementById('cc-font')) {
    const link = document.createElement('link');
    link.id = 'cc-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap';
    document.head.appendChild(link);
  }
}

// ── State ──────────────────────────────────────────────────────────────

interface State {
  view: ViewMode;
  data: unknown | null;
  loading: boolean;
  error: string | null;
  showBreakdown: boolean;
  since: string;
  until: string;
  offline: boolean;
}

// ── Mount / Unmount ────────────────────────────────────────────────────

export function mount(container: HTMLElement, api: PluginAPI): void {
  ensureStyles();

  const state: State = {
    view: 'daily',
    data: null,
    loading: false,
    error: null,
    showBreakdown: false,
    since: '',
    until: '',
    offline: false,
  };

  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    padding: '24px', fontFamily: MONO,
  });
  container.appendChild(root);

  // ── Data fetching ──────────────────────────────────────────────

  async function fetchData(noCache = false): Promise<void> {
    state.loading = true;
    state.error = null;
    state.offline = false;
    render(api.context);

    try {
      let path: string;
      if (state.view === 'daily' && (state.since || state.until)) {
        const params = new URLSearchParams({ range: state.view });
        if (state.since) params.set('since', state.since.replace(/-/g, ''));
        if (state.until) params.set('until', state.until.replace(/-/g, ''));
        if (noCache) params.set('nocache', '1');
        path = `range?${params}`;
      } else {
        const params = new URLSearchParams({ range: state.view });
        if (noCache) params.set('nocache', '1');
        path = `summary?${params}`;
      }

      const result = await api.rpc('GET', path) as Record<string, unknown>;

      if (result && typeof result === 'object' && 'error' in result) {
        state.error = String(result.error);
        state.data = null;
      } else {
        state.data = result;
        if (result && '_offline' in result) state.offline = true;
      }
    } catch (err) {
      state.error = (err as Error).message;
      state.data = null;
    }

    state.loading = false;
    render(api.context);
  }

  // ── Rendering ──────────────────────────────────────────────────

  function render(ctx: PluginContext): void {
    const t = getTheme(ctx.theme === 'dark');
    root.style.background = t.bg;
    root.style.color = t.text;

    root.innerHTML = `
      ${renderHeader(t)}
      ${renderControls(t)}
      ${state.offline ? `<div style="font-size:0.65rem;color:${t.yellow};margin-bottom:12px;padding:6px 10px;background:${t.accentDim};border-radius:3px;">Pricing data served from offline cache. Network may be unavailable.</div>` : ''}
      ${state.loading ? renderSkeleton(t) : ''}
      ${state.error ? renderError(t) : ''}
      ${!state.loading && !state.error && state.data ? renderData(t) : ''}
    `;

    bindEvents();
  }

  function renderHeader(t: Theme): string {
    const totalCost = computeTotalCost();
    return `
      <div class="cc-up" style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px">
        <div>
          <div style="font-size:0.65rem;color:${t.muted};letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px">Claude Code Usage</div>
          <div style="font-size:2rem;font-weight:700;letter-spacing:-0.04em;line-height:1">
            ${totalCost !== null ? fmtCost(totalCost) : '--'}
          </div>
          <div style="font-size:0.62rem;color:${t.muted};margin-top:4px">${totalCostLabel()}</div>
        </div>
        <button class="cc-refresh" id="cc-refresh" style="color:${t.muted};border:1px solid ${t.border}">
          &#x21bb; refresh
        </button>
      </div>`;
  }

  function renderControls(t: Theme): string {
    const segmented = VIEWS.map(v => {
      const active = v.key === state.view;
      return `<button class="cc-seg-btn" data-view="${v.key}" style="
        background:${active ? t.accent : t.surface};
        color:${active ? t.bg : t.muted};
        border:1px solid ${active ? t.accent : t.border};
        font-weight:${active ? '700' : '400'};
      ">${v.label}</button>`;
    }).join('');

    let extras = '';

    // Date range for daily view
    if (state.view === 'daily') {
      extras += `
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <label style="font-size:0.62rem;color:${t.muted};text-transform:uppercase;letter-spacing:0.08em">Since</label>
          <input type="date" class="cc-date-input" id="cc-since" value="${state.since}"
            style="background:${t.surface};color:${t.text};border:1px solid ${t.border};" />
          <label style="font-size:0.62rem;color:${t.muted};text-transform:uppercase;letter-spacing:0.08em">Until</label>
          <input type="date" class="cc-date-input" id="cc-until" value="${state.until}"
            style="background:${t.surface};color:${t.text};border:1px solid ${t.border};" />
          <button class="cc-seg-btn" id="cc-apply-range" style="background:${t.surface};color:${t.accent};border:1px solid ${t.border};font-size:0.62rem;padding:4px 10px;">Apply</button>
          ${state.since || state.until ? `<button class="cc-seg-btn" id="cc-clear-range" style="background:transparent;color:${t.muted};border:1px solid ${t.border};font-size:0.62rem;padding:4px 10px;">Clear</button>` : ''}
        </div>`;
    }

    // Breakdown toggle
    extras += `
      <div style="margin-top:10px;display:flex;align-items:center">
        <input type="checkbox" id="cc-breakdown" class="cc-check" ${state.showBreakdown ? 'checked' : ''} />
        <label for="cc-breakdown" style="font-size:0.65rem;color:${t.muted};cursor:pointer">Per-model breakdown</label>
      </div>`;

    return `
      <div style="margin-bottom:16px">
        <div style="display:flex;gap:4px;flex-wrap:wrap">${segmented}</div>
        ${extras}
      </div>`;
  }

  function renderSkeleton(t: Theme): string {
    const bars = [75, 60, 45, 30, 55].map((w, i) =>
      `<div class="cc-skel" style="height:10px;width:${w}%;background:${t.muted};border-radius:2px;margin-bottom:8px;animation-delay:${i * 0.1}s"></div>`
    ).join('');
    return `<div style="background:${t.surface};border:1px solid ${t.border};border-radius:3px;padding:18px;margin-bottom:12px">${bars}</div>`;
  }

  function renderError(t: Theme): string {
    let msg = state.error ?? 'Unknown error';
    if (msg.includes('No such file') || msg.includes('ENOENT') || msg.includes('no JSONL')) {
      msg = 'No Claude Code usage data found at ~/.claude/projects/. Use Claude Code first to generate usage data.';
    }
    return `<div style="padding:16px;font-size:0.75rem;color:${t.red};background:${t.surface};border:1px solid ${t.border};border-radius:3px">${escHtml(msg)}</div>`;
  }

  function renderData(t: Theme): string {
    const d = state.data as Record<string, unknown>;
    switch (state.view) {
      case 'daily': return renderDailyTable(t, (d.daily ?? []) as DailyEntry[]);
      case 'monthly': return renderMonthlyTable(t, (d.monthly ?? []) as MonthlyEntry[]);
      case 'session': return renderSessionTable(t, (d.sessions ?? []) as SessionEntry[]);
      case 'blocks': return renderBlocksTable(t, (d.blocks ?? []) as BlockEntry[]);
      default: return '';
    }
  }

  function renderDailyTable(t: Theme, rows: DailyEntry[]): string {
    if (!rows.length) return emptyState(t);
    const capped = rows.slice(0, MAX_ROWS);
    const showBd = state.showBreakdown;

    let html = `<div class="cc-up" style="background:${t.surface};border:1px solid ${t.border};border-radius:3px;overflow-x:auto">
      <table class="cc-table">
        <thead><tr style="border-bottom:1px solid ${t.border}">
          <th style="color:${t.muted}">Date</th>
          ${showBd ? `<th style="color:${t.muted}">Model</th>` : ''}
          <th style="color:${t.muted}">Input</th>
          <th style="color:${t.muted}">Output</th>
          <th style="color:${t.muted}">Cache Write</th>
          <th style="color:${t.muted}">Cache Read</th>
          <th style="color:${t.muted};text-align:right">Cost</th>
        </tr></thead><tbody>`;

    for (const row of capped) {
      if (showBd && row.modelBreakdowns?.length) {
        for (let mi = 0; mi < row.modelBreakdowns.length; mi++) {
          const m = row.modelBreakdowns[mi];
          html += `<tr style="border-bottom:1px solid ${t.border}">
            ${mi === 0 ? `<td rowspan="${row.modelBreakdowns.length}" style="font-weight:600">${row.date}</td>` : ''}
            <td style="color:${t.muted}">${escHtml(shortModel(m.modelName))}</td>
            <td>${fmtTokens(m.inputTokens)}</td>
            <td>${fmtTokens(m.outputTokens)}</td>
            <td>${fmtTokens(m.cacheCreationTokens)}</td>
            <td>${fmtTokens(m.cacheReadTokens)}</td>
            <td style="text-align:right;color:${t.accent};font-weight:600">${fmtCost(m.cost)}</td>
          </tr>`;
        }
      } else {
        html += `<tr style="border-bottom:1px solid ${t.border}">
          <td style="font-weight:600">${row.date}</td>
          ${showBd ? `<td style="color:${t.muted}">${row.modelsUsed.map(shortModel).join(', ')}</td>` : ''}
          <td>${fmtTokens(row.inputTokens)}</td>
          <td>${fmtTokens(row.outputTokens)}</td>
          <td>${fmtTokens(row.cacheCreationTokens)}</td>
          <td>${fmtTokens(row.cacheReadTokens)}</td>
          <td style="text-align:right;color:${t.accent};font-weight:600">${fmtCost(row.totalCost)}</td>
        </tr>`;
      }
    }

    html += '</tbody></table></div>';
    if (rows.length > MAX_ROWS) html += cappedNote(t, rows.length);
    return html;
  }

  function renderMonthlyTable(t: Theme, rows: MonthlyEntry[]): string {
    if (!rows.length) return emptyState(t);
    const capped = rows.slice(0, MAX_ROWS);
    const showBd = state.showBreakdown;

    let html = `<div class="cc-up" style="background:${t.surface};border:1px solid ${t.border};border-radius:3px;overflow-x:auto">
      <table class="cc-table">
        <thead><tr style="border-bottom:1px solid ${t.border}">
          <th style="color:${t.muted}">Month</th>
          ${showBd ? `<th style="color:${t.muted}">Model</th>` : ''}
          <th style="color:${t.muted}">Input</th>
          <th style="color:${t.muted}">Output</th>
          <th style="color:${t.muted}">Cache Write</th>
          <th style="color:${t.muted}">Cache Read</th>
          <th style="color:${t.muted};text-align:right">Cost</th>
        </tr></thead><tbody>`;

    for (const row of capped) {
      if (showBd && row.modelBreakdowns?.length) {
        for (let mi = 0; mi < row.modelBreakdowns.length; mi++) {
          const m = row.modelBreakdowns[mi];
          html += `<tr style="border-bottom:1px solid ${t.border}">
            ${mi === 0 ? `<td rowspan="${row.modelBreakdowns.length}" style="font-weight:600">${row.month}</td>` : ''}
            <td style="color:${t.muted}">${escHtml(shortModel(m.modelName))}</td>
            <td>${fmtTokens(m.inputTokens)}</td>
            <td>${fmtTokens(m.outputTokens)}</td>
            <td>${fmtTokens(m.cacheCreationTokens)}</td>
            <td>${fmtTokens(m.cacheReadTokens)}</td>
            <td style="text-align:right;color:${t.accent};font-weight:600">${fmtCost(m.cost)}</td>
          </tr>`;
        }
      } else {
        html += `<tr style="border-bottom:1px solid ${t.border}">
          <td style="font-weight:600">${row.month}</td>
          ${showBd ? `<td style="color:${t.muted}">${row.modelsUsed.map(shortModel).join(', ')}</td>` : ''}
          <td>${fmtTokens(row.inputTokens)}</td>
          <td>${fmtTokens(row.outputTokens)}</td>
          <td>${fmtTokens(row.cacheCreationTokens)}</td>
          <td>${fmtTokens(row.cacheReadTokens)}</td>
          <td style="text-align:right;color:${t.accent};font-weight:600">${fmtCost(row.totalCost)}</td>
        </tr>`;
      }
    }

    html += '</tbody></table></div>';
    if (rows.length > MAX_ROWS) html += cappedNote(t, rows.length);
    return html;
  }

  function renderSessionTable(t: Theme, rows: SessionEntry[]): string {
    if (!rows.length) return emptyState(t);
    const capped = rows.slice(0, MAX_ROWS);
    const showBd = state.showBreakdown;

    let html = `<div class="cc-up" style="background:${t.surface};border:1px solid ${t.border};border-radius:3px;overflow-x:auto">
      <table class="cc-table">
        <thead><tr style="border-bottom:1px solid ${t.border}">
          <th style="color:${t.muted}">Session</th>
          ${showBd ? `<th style="color:${t.muted}">Model</th>` : ''}
          <th style="color:${t.muted}">Last Active</th>
          <th style="color:${t.muted}">Input</th>
          <th style="color:${t.muted}">Output</th>
          <th style="color:${t.muted}">Cache</th>
          <th style="color:${t.muted};text-align:right">Cost</th>
        </tr></thead><tbody>`;

    for (const row of capped) {
      const sessionLabel = escHtml(row.sessionId.length > 40 ? '...' + row.sessionId.slice(-37) : row.sessionId);
      const cacheTotal = row.cacheCreationTokens + row.cacheReadTokens;

      if (showBd && row.modelBreakdowns?.length) {
        for (let mi = 0; mi < row.modelBreakdowns.length; mi++) {
          const m = row.modelBreakdowns[mi];
          const mCache = m.cacheCreationTokens + m.cacheReadTokens;
          html += `<tr style="border-bottom:1px solid ${t.border}">
            ${mi === 0 ? `<td rowspan="${row.modelBreakdowns.length}" title="${escHtml(row.sessionId)}" style="font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sessionLabel}</td>` : ''}
            <td style="color:${t.muted}">${escHtml(shortModel(m.modelName))}</td>
            ${mi === 0 ? `<td rowspan="${row.modelBreakdowns.length}" style="color:${t.muted}">${row.lastActivity}</td>` : ''}
            <td>${fmtTokens(m.inputTokens)}</td>
            <td>${fmtTokens(m.outputTokens)}</td>
            <td>${fmtTokens(mCache)}</td>
            <td style="text-align:right;color:${t.accent};font-weight:600">${fmtCost(m.cost)}</td>
          </tr>`;
        }
      } else {
        html += `<tr style="border-bottom:1px solid ${t.border}">
          <td title="${escHtml(row.sessionId)}" style="font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sessionLabel}</td>
          ${showBd ? `<td style="color:${t.muted}">${row.modelsUsed.map(shortModel).join(', ')}</td>` : ''}
          <td style="color:${t.muted}">${row.lastActivity}</td>
          <td>${fmtTokens(row.inputTokens)}</td>
          <td>${fmtTokens(row.outputTokens)}</td>
          <td>${fmtTokens(cacheTotal)}</td>
          <td style="text-align:right;color:${t.accent};font-weight:600">${fmtCost(row.totalCost)}</td>
        </tr>`;
      }
    }

    html += '</tbody></table></div>';
    if (rows.length > MAX_ROWS) html += cappedNote(t, rows.length);
    return html;
  }

  function renderBlocksTable(t: Theme, rows: BlockEntry[]): string {
    const nonGap = rows.filter(b => !b.isGap);
    if (!nonGap.length) return emptyState(t);
    const capped = nonGap.slice(0, MAX_ROWS);

    let html = `<div class="cc-up" style="background:${t.surface};border:1px solid ${t.border};border-radius:3px;overflow-x:auto">
      <table class="cc-table">
        <thead><tr style="border-bottom:1px solid ${t.border}">
          <th style="color:${t.muted}">Block Start</th>
          <th style="color:${t.muted}">Input</th>
          <th style="color:${t.muted}">Output</th>
          <th style="color:${t.muted}">Cache</th>
          <th style="color:${t.muted}">Entries</th>
          <th style="color:${t.muted}">Models</th>
          <th style="color:${t.muted};text-align:right">Cost</th>
        </tr></thead><tbody>`;

    for (const row of capped) {
      const start = new Date(row.startTime);
      const label = `${start.toLocaleDateString()} ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      const tc = row.tokenCounts;
      const cacheTotal = (tc.cacheCreationInputTokens ?? 0) + (tc.cacheReadInputTokens ?? 0);

      html += `<tr style="border-bottom:1px solid ${t.border}">
        <td style="font-weight:600;white-space:nowrap">${label}${row.isActive ? ` <span style="color:${t.green};font-size:0.6rem">ACTIVE</span>` : ''}</td>
        <td>${fmtTokens(tc.inputTokens)}</td>
        <td>${fmtTokens(tc.outputTokens)}</td>
        <td>${fmtTokens(cacheTotal)}</td>
        <td>${row.entries}</td>
        <td style="color:${t.muted};max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${row.models.map(shortModel).join(', ')}</td>
        <td style="text-align:right;color:${t.accent};font-weight:600">${fmtCost(row.costUSD)}</td>
      </tr>`;
    }

    html += '</tbody></table></div>';
    if (nonGap.length > MAX_ROWS) html += cappedNote(t, nonGap.length);
    return html;
  }

  function emptyState(t: Theme): string {
    return `<div style="padding:24px;text-align:center;color:${t.muted};font-size:0.75rem;background:${t.surface};border:1px solid ${t.border};border-radius:3px">
      No Claude Code usage data found at <code>~/.claude/projects/</code>.<br/>Use Claude Code first to generate usage data.
    </div>`;
  }

  function cappedNote(t: Theme, total: number): string {
    return `<div style="font-size:0.62rem;color:${t.muted};margin-top:8px;text-align:right">Showing ${MAX_ROWS} of ${total} rows</div>`;
  }

  // ── Cost summary computation ────────────────────────────────────

  function computeTotalCost(): number | null {
    if (!state.data || typeof state.data !== 'object') return null;
    const d = state.data as Record<string, unknown>;

    if (state.view === 'daily') {
      const rows = (d.daily ?? []) as DailyEntry[];
      return rows.reduce((sum, r) => sum + r.totalCost, 0);
    }
    if (state.view === 'monthly') {
      const rows = (d.monthly ?? []) as MonthlyEntry[];
      return rows.reduce((sum, r) => sum + r.totalCost, 0);
    }
    if (state.view === 'session') {
      const rows = (d.sessions ?? []) as SessionEntry[];
      return rows.reduce((sum, r) => sum + r.totalCost, 0);
    }
    if (state.view === 'blocks') {
      const rows = (d.blocks ?? []) as BlockEntry[];
      return rows.filter(b => !b.isGap).reduce((sum, r) => sum + r.costUSD, 0);
    }
    return null;
  }

  function totalCostLabel(): string {
    switch (state.view) {
      case 'daily': return state.since || state.until ? 'filtered range total' : 'all-time daily total';
      case 'monthly': return 'all-time monthly total';
      case 'session': return 'all sessions total';
      case 'blocks': return 'all blocks total';
      default: return '';
    }
  }

  // ── Event binding ───────────────────────────────────────────────

  function bindEvents(): void {
    root.querySelector('#cc-refresh')?.addEventListener('click', () => fetchData(true));

    root.querySelectorAll<HTMLButtonElement>('.cc-seg-btn[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.view as ViewMode;
        if (v !== state.view) {
          state.view = v;
          state.data = null;
          fetchData();
        }
      });
    });

    root.querySelector('#cc-breakdown')?.addEventListener('change', (e) => {
      state.showBreakdown = (e.target as HTMLInputElement).checked;
      render(api.context);
    });

    root.querySelector('#cc-apply-range')?.addEventListener('click', () => {
      const sinceEl = root.querySelector('#cc-since') as HTMLInputElement | null;
      const untilEl = root.querySelector('#cc-until') as HTMLInputElement | null;
      state.since = sinceEl?.value ?? '';
      state.until = untilEl?.value ?? '';
      fetchData();
    });

    root.querySelector('#cc-clear-range')?.addEventListener('click', () => {
      state.since = '';
      state.until = '';
      fetchData();
    });
  }

  // ── Context change ──────────────────────────────────────────────

  const unsubscribe = api.onContextChange((ctx) => {
    render(ctx);
  });

  (container as any)._ccCleanup = unsubscribe;

  // ── Initial load ────────────────────────────────────────────────

  fetchData();
}

export function unmount(container: HTMLElement): void {
  if (typeof (container as any)._ccCleanup === 'function') {
    (container as any)._ccCleanup();
    delete (container as any)._ccCleanup;
  }
  container.innerHTML = '';
}
