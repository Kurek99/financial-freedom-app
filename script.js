// ═══════════════════════════════════════════════════════════
//  WealthPath  |  script.js
//  LocalStorage persistence + Math Engine + UI
// ═══════════════════════════════════════════════════════════

const STORAGE_KEY = 'wealthpath_v2';

// ── DEFAULT STATE ───────────────────────────────────────────
const DEFAULT_STATE = {
  incomeA: 2800, incomeB: 2200,
  nameA: 'Martin', nameB: 'Zuzana',
  inflation: 3.5, returnRate: 8.0, pensionRent: 2000,
  expenses: [
    { id:1, label:'Nájom / Hypotéka', amount:900 },
    { id:2, label:'Potraviny', amount:500 },
    { id:3, label:'Auto (splátka + PHM)', amount:350 },
    { id:4, label:'Netflix / Streaming', amount:30 },
    { id:5, label:'Donáška jedla', amount:80 },
    { id:6, label:'Oblečenie', amount:100 },
  ],
  goals: [
    { id:1, icon:'🚗', label:'Auto', target:30000, type:'car', currentSavings:0 },
    { id:2, icon:'🏠', label:'Byt / Dom', target:200000, type:'housing', currentSavings:0 },
    { id:3, icon:'👶', label:'Zabezpečenie detí', target:80000, type:'children', currentSavings:0 },
    { id:4, icon:'🏦', label:'Dôchodok', target:0, type:'pension', currentSavings:0, isPension:true },
  ],
  selectedChartGoal: 1,
  nextExpId: 7,
  nextGoalId: 5,
};

// ── STATE (loaded from localStorage or defaults) ────────────
let state = loadState();
let growthChart = null;
let saveTimer = null;

// ═══════════════════════════════════════════════════════════
//  LOCALSTORAGE — PERSISTENCE
// ═══════════════════════════════════════════════════════════

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return deepClone(DEFAULT_STATE);
    const saved = JSON.parse(raw);
    // Merge with defaults to handle new fields in future versions
    return { ...deepClone(DEFAULT_STATE), ...saved };
  } catch(e) {
    console.warn('WealthPath: Could not load saved state', e);
    return deepClone(DEFAULT_STATE);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setSaveDot('saved');
    updateStorageStatus();
  } catch(e) {
    console.warn('WealthPath: Could not save state', e);
    if (e.name === 'QuotaExceededError') {
      showToast('⚠️ Úložisko plné — dáta sa neuložili');
    }
  }
}

// Debounced auto-save — triggers 800ms after last change
function scheduleSave() {
  setSaveDot('unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveState();
    showToast('✓ Uložené');
  }, 800);
}

function setSaveDot(status) {
  const dot = document.getElementById('save-dot');
  if (!dot) return;
  dot.className = 'save-dot ' + status;
  dot.title = status === 'saved' ? 'Uložené ✓' : 'Neuložené zmeny…';
}

function updateStorageStatus() {
  const el = document.getElementById('storage-status');
  if (!el) return;
  const now = new Date().toLocaleTimeString('sk-SK', { hour:'2-digit', minute:'2-digit' });
  el.textContent = `💾 Uložené lokálne (${now}) — toto zariadenie`;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── EXPORT ──────────────────────────────────────────────────
function exportData() {
  const data = {
    _app: 'WealthPath',
    _version: 2,
    _exported: new Date().toISOString(),
    ...state
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wealthpath-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('⬇ Export stiahnutý');
}

// ── IMPORT ──────────────────────────────────────────────────
function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported._app !== 'WealthPath') {
        showToast('⚠️ Neplatný súbor'); return;
      }
      const { _app, _version, _exported, ...data } = imported;
      state = { ...deepClone(DEFAULT_STATE), ...data };
      saveState();
      initInputs();
      recalc();
      showToast('✓ Import úspešný');
    } catch(err) {
      showToast('⚠️ Chyba pri importe');
    }
  };
  reader.readAsText(file);
  event.target.value = ''; // reset so same file can be imported again
}

// ── RESET ───────────────────────────────────────────────────
function confirmReset() {
  if (confirm('Vymazať všetky dáta a začať od nuly? Táto akcia sa nedá vrátiť.')) {
    localStorage.removeItem(STORAGE_KEY);
    state = deepClone(DEFAULT_STATE);
    initInputs();
    recalc();
    showToast('🗑 Dáta vymazané');
  }
}

// ═══════════════════════════════════════════════════════════
//  MATH ENGINE
// ═══════════════════════════════════════════════════════════

function calcMonthsSaving(pmt, fvNominal, inflPct) {
  if (pmt <= 0) return Infinity;
  const i = inflPct / 100;
  for (let m = 1; m <= 1440; m++) {
    if (pmt * m >= fvNominal * Math.pow(1 + i, m / 12)) return m;
  }
  return Infinity;
}

function calcMonthsInvesting(pmt, fvNominal, annualRetPct, inflPct, pv = 0) {
  if (pmt <= 0) return Infinity;
  const r = annualRetPct / 100 / 12;
  const i = inflPct / 100;
  if (r <= 0) return calcMonthsSaving(pmt, fvNominal, inflPct);
  let portfolio = pv;
  for (let m = 1; m <= 1440; m++) {
    portfolio = portfolio * (1 + r) + pmt;
    if (portfolio >= fvNominal * Math.pow(1 + i, m / 12)) return m;
  }
  return Infinity;
}

function buildGrowthData(pmt, fvNominal, annualRetPct, inflPct, maxMonths) {
  const r = annualRetPct / 100 / 12;
  const i = inflPct / 100;
  const step = Math.max(1, Math.floor(maxMonths / 160));
  const points = []; let portfolio = 0;
  for (let m = 0; m <= maxMonths; m += step) {
    if (m > 0) portfolio = portfolio * Math.pow(1 + r, step) + pmt * (Math.pow(1 + r, step) - 1) / (r || 1e-9);
    points.push({
      x: parseFloat((m / 12).toFixed(2)),
      saving: Math.round(pmt * m),
      investing: Math.round(portfolio),
      targetReal: Math.round(fvNominal * Math.pow(1 + i, m / 12)),
      targetNominal: fvNominal,
    });
  }
  return points;
}

function pensionTarget(rent) { return (rent * 12) / 0.04; }

function effectiveTarget(g) {
  return g.isPension ? pensionTarget(state.pensionRent) : g.target;
}

function fmt(n) {
  if (!isFinite(n) || n > 1e9) return '∞';
  return new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 0 }).format(n) + ' €';
}

function fmtMonths(m) {
  if (!isFinite(m) || m > 1440) return 'nedosiahnuteľné';
  const y = Math.floor(m / 12), mo = m % 12;
  if (y === 0) return `${mo} mes.`;
  if (mo === 0) return `${y} r.`;
  return `${y} r. ${mo} m.`;
}

function totalIncome() { return (state.incomeA || 0) + (state.incomeB || 0); }
function totalExpenses() { return state.expenses.reduce((s, e) => s + (e.amount || 0), 0); }
function investable() { return totalIncome() - totalExpenses(); }

function prioritizeGoals() {
  const pmt = Math.max(0, investable());
  const per = pmt / Math.max(state.goals.length, 1);
  const typeScore = { housing:5, car:4, pension:3, children:2 };
  return state.goals.map(g => {
    const tgt = effectiveTarget(g);
    const mI = calcMonthsInvesting(per, tgt, state.returnRate, state.inflation, g.currentSavings || 0);
    const score = (typeScore[g.type] || 1) * (isFinite(mI) ? 1440 / mI : 0);
    return { ...g, mI, score };
  }).sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════════

function renderExpenses() {
  const el = document.getElementById('expense-list');
  el.innerHTML = '';
  state.expenses.forEach(exp => {
    const row = document.createElement('div');
    row.className = 'expense-row';
    row.innerHTML = `
      <input type="text" value="${escHtml(exp.label)}" placeholder="Kategória…"
        oninput="updateExpense(${exp.id},'label',this.value)" />
      <input type="number" value="${exp.amount}" min="0" inputmode="numeric"
        oninput="updateExpense(${exp.id},'amount',+this.value)" style="text-align:right" />
      <button class="btn btn-ghost btn-sm" onclick="removeExpense(${exp.id})"
        style="padding:8px;font-size:15px;color:var(--red)">✕</button>
    `;
    el.appendChild(row);
  });
}

function renderSummary() {
  const inc = totalIncome(), exp = totalExpenses(), inv = investable();
  setText('sum-income', fmt(inc));
  setText('sum-expenses', fmt(exp));
  setText('sum-investable', fmt(inv));
  setText('hdr-investable', fmt(inv));
  setText('hdr-total-income', fmt(inc));
  setText('pensionTarget', fmt(pensionTarget(state.pensionRent)));
  const el = document.getElementById('sum-investable');
  if (el) el.style.color = inv >= 0 ? 'var(--gold-light)' : 'var(--red)';
}

function renderGoals() {
  const grid = document.getElementById('goal-grid');
  const per = Math.max(0, investable()) / Math.max(state.goals.length, 1);
  grid.innerHTML = '';
  state.goals.forEach(g => {
    const tgt = effectiveTarget(g);
    const mS = calcMonthsSaving(per, tgt, state.inflation);
    const mI = calcMonthsInvesting(per, tgt, state.returnRate, state.inflation, g.currentSavings || 0);
    const saved = isFinite(mS) && isFinite(mI) ? mS - mI : null;
    const sel = g.id === state.selectedChartGoal;
    const d = document.createElement('div');
    d.className = 'goal-card' + (sel ? ' selected' : '');
    d.onclick = () => { state.selectedChartGoal = g.id; renderGoals(); renderChartGoalButtons(); if(document.getElementById('panel-charts').classList.contains('active')) renderGrowthChart(); };
    d.innerHTML = `
      ${saved && saved > 12 ? `<div class="goal-badge">Úspora ${fmtMonths(saved)}</div>` : ''}
      <div class="goal-icon">${g.icon}</div>
      <div class="goal-name">${escHtml(g.label)}</div>
      <div class="goal-target">${fmt(tgt)}</div>
      <div class="goal-metrics">
        <div class="goal-metric">
          <span class="goal-metric-label">💤 Sporenie</span>
          <span class="goal-metric-val val-saving">${fmtMonths(mS)}</span>
        </div>
        <div class="goal-metric">
          <span class="goal-metric-label">📈 Investovanie</span>
          <span class="goal-metric-val val-investing">${fmtMonths(mI)}</span>
        </div>
        <div class="goal-metric">
          <span class="goal-metric-label">Príspevok/mes</span>
          <span class="goal-metric-val" style="color:var(--blue)">${fmt(per)}</span>
        </div>
      </div>
      <div class="goal-actions">
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();editGoal(${g.id})">✏️</button>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();removeGoal(${g.id})" style="color:var(--red)">✕</button>
      </div>
    `;
    grid.appendChild(d);
  });
  renderPriorityList();
}

function renderPriorityList() {
  const list = document.getElementById('priority-list');
  const per = Math.max(0, investable()) / Math.max(state.goals.length, 1);
  list.innerHTML = '';
  prioritizeGoals().forEach((g, idx) => {
    const tgt = effectiveTarget(g);
    const mS = calcMonthsSaving(per, tgt, state.inflation);
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="pnum">${idx + 1}</div>
      <span style="font-size:17px">${g.icon}</span>
      <span class="pgoal-name">${escHtml(g.label)} <span style="color:var(--text-dim);font-weight:400">${fmt(tgt)}</span></span>
      <span class="pgoal-saving">💤 ${fmtMonths(mS)}</span>
      <span class="pgoal-investing">📈 ${fmtMonths(g.mI)}</span>
    `;
    list.appendChild(li);
  });
}

function renderChartGoalButtons() {
  const c = document.getElementById('chart-goal-btns');
  c.innerHTML = '';
  state.goals.forEach(g => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm ' + (g.id === state.selectedChartGoal ? 'btn-gold' : 'btn-ghost');
    b.textContent = g.icon + ' ' + g.label;
    b.onclick = () => { state.selectedChartGoal = g.id; renderChartGoalButtons(); renderGrowthChart(); };
    c.appendChild(b);
  });
}

function renderGrowthChart() {
  const goal = state.goals.find(g => g.id === state.selectedChartGoal) || state.goals[0];
  if (!goal) return;
  const tgt = effectiveTarget(goal);
  const per = Math.max(0, investable()) / Math.max(state.goals.length, 1);
  const mS = calcMonthsSaving(per, tgt, state.inflation);
  const mI = calcMonthsInvesting(per, tgt, state.returnRate, state.inflation, goal.currentSavings || 0);
  const maxM = Math.min(isFinite(mS) ? mS + 24 : 480, 480);
  const data = buildGrowthData(per, tgt, state.returnRate, state.inflation, maxM);

  const ctx = document.getElementById('growthChart').getContext('2d');
  if (growthChart) growthChart.destroy();
  growthChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => d.x + 'r'),
      datasets: [
        { label:'💤 Sporenie', data: data.map(d=>d.saving), borderColor:'#f97316',
          backgroundColor:'rgba(249,115,22,.07)', borderWidth:2.5, pointRadius:0, tension:.3, fill:true },
        { label:'📈 Investovanie', data: data.map(d=>d.investing), borderColor:'#2adf8a',
          backgroundColor:'rgba(42,223,138,.07)', borderWidth:2.5, pointRadius:0, tension:.3, fill:true },
        { label:'🎯 Cieľ (inflačný)', data: data.map(d=>d.targetReal), borderColor:'rgba(201,168,76,.55)',
          borderWidth:1.5, borderDash:[6,4], pointRadius:0, fill:false },
        { label:'— Nominál', data: data.map(d=>d.targetNominal), borderColor:'rgba(201,168,76,.2)',
          borderWidth:1, borderDash:[2,6], pointRadius:0, fill:false },
      ],
    },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{duration:500},
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{ labels:{ color:'#7a95a8', font:{family:'JetBrains Mono',size:10}, boxWidth:10 } },
        tooltip:{
          backgroundColor:'#0d1117', borderColor:'#1e2d3d', borderWidth:1,
          titleColor:'#c9a84c', bodyColor:'#d4dde8',
          titleFont:{family:'Playfair Display',size:12}, bodyFont:{family:'JetBrains Mono',size:11},
          callbacks:{ label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` },
        },
      },
      scales:{
        x:{ ticks:{color:'#4a6070',font:{family:'JetBrains Mono',size:9},maxTicksLimit:10},
            grid:{color:'rgba(255,255,255,.03)'}, border:{color:'#1e2d3d'} },
        y:{ ticks:{color:'#4a6070',font:{family:'JetBrains Mono',size:9},
              callback: v => v>=1000 ? Math.round(v/1000)+'k€' : v+'€'},
            grid:{color:'rgba(255,255,255,.03)'}, border:{color:'#1e2d3d'} },
      },
    },
  });
}

function renderInflationTable() {
  const per = Math.max(0, investable()) / Math.max(state.goals.length, 1);
  const i = state.inflation / 100;
  let html = '';
  state.goals.forEach(g => {
    const tgt = effectiveTarget(g);
    const mS = calcMonthsSaving(per, tgt, state.inflation);
    const years = isFinite(mS) ? mS / 12 : 20;
    const realNeeded = tgt * Math.pow(1 + i, years);
    const loss = realNeeded - tgt;
    html += `<div class="inflation-row">
      <span>${g.icon} <strong>${escHtml(g.label)}</strong></span>
      <div class="inflation-vals">
        <span>Nominál: <strong style="color:var(--gold-light)">${fmt(tgt)}</strong></span>
        <span>Reálna potreba: <strong class="loss-red">${fmt(realNeeded)}</strong></span>
        <span>Strata: <strong class="loss-red">+${fmt(loss)}</strong></span>
      </div>
    </div>`;
  });
  document.getElementById('inflation-table').innerHTML = html || '<p style="color:var(--text-dim)">Pridajte ciele.</p>';
}

function renderSankey() {
  const W = 700, H = 340;
  const svg = document.getElementById('sankey-svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.width = '100%';
  const inc = totalIncome();
  if (inc <= 0) {
    svg.innerHTML = `<text x="350" y="170" text-anchor="middle" fill="#4a6070" font-family="JetBrains Mono" font-size="13">Zadajte príjem</text>`;
    return;
  }
  const exp = totalExpenses(), inv = Math.max(0, investable());
  const totalH = H * 0.78;
  const expH = inc > 0 ? (exp / inc) * totalH : 0;
  const invH = inc > 0 ? (inv / inc) * totalH : 0;
  const nW = 26, sx = 38, mx = W / 2, ex = W - 58;
  const yOff = (H - expH - invH - 4) / 2;

  let s = `<defs>
    <linearGradient id="gI" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#38a8e8"/><stop offset="100%" stop-color="#1a5a80"/></linearGradient>
    <linearGradient id="gE" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f97316"/><stop offset="100%" stop-color="#7a2e00"/></linearGradient>
    <linearGradient id="gN" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2adf8a"/><stop offset="100%" stop-color="#0a4a28"/></linearGradient>
  </defs>`;

  const incY = (H - expH - invH) / 2;
  s += `<rect x="${sx}" y="${incY}" width="${nW}" height="${expH + invH}" rx="4" fill="url(#gI)" opacity=".9"/>`;
  s += `<text x="${sx+nW/2}" y="${incY-8}" text-anchor="middle" fill="#38a8e8" font-family="JetBrains Mono" font-size="9" font-weight="600">PRÍJEM</text>`;
  s += `<text x="${sx+nW/2}" y="${incY+expH+invH+16}" text-anchor="middle" fill="#38a8e8" font-family="JetBrains Mono" font-size="10" font-weight="700">${fmt(inc)}</text>`;

  const expColors = ['#f97316','#fb923c','#fdba74','#fcd34d','#fde68a','#fed7aa','#fef3c7'];
  let midExpY = yOff, srcExpY = incY;
  s += `<rect x="${mx-nW/2}" y="${yOff}" width="${nW}" height="${Math.max(2,expH)}" rx="4" fill="url(#gE)" opacity=".85"/>`;
  s += `<text x="${mx}" y="${yOff-7}" text-anchor="middle" fill="#f97316" font-family="JetBrains Mono" font-size="9" font-weight="600">VÝDAVKY</text>`;
  s += `<text x="${mx}" y="${yOff+expH+15}" text-anchor="middle" fill="#f97316" font-family="JetBrains Mono" font-size="9">${fmt(exp)}</text>`;

  state.expenses.forEach((e, i) => {
    const h = exp > 0 ? Math.max(2, (e.amount / exp) * expH) : 2;
    const col = expColors[i % expColors.length];
    const sY = srcExpY, dY = midExpY;
    s += `<path d="M ${sx+nW} ${sY} C ${mx-80} ${sY}, ${mx-80} ${dY}, ${mx-nW/2} ${dY} L ${mx-nW/2} ${dY+h} C ${mx-80} ${dY+h}, ${mx-80} ${sY+h}, ${sx+nW} ${sY+h} Z" fill="${col}" opacity=".2"/>`;
    s += `<text x="${mx-nW/2-5}" y="${dY+h/2+4}" text-anchor="end" fill="${col}" font-family="JetBrains Mono" font-size="8">${escHtml(e.label)}</text>`;
    srcExpY += h; midExpY += h;
  });

  const invBarY = yOff + expH + 4;
  s += `<rect x="${mx-nW/2}" y="${invBarY}" width="${nW}" height="${Math.max(4,invH)}" rx="4" fill="url(#gN)" opacity=".9"/>`;
  s += `<text x="${mx}" y="${invBarY-7}" text-anchor="middle" fill="#2adf8a" font-family="JetBrains Mono" font-size="9" font-weight="600">INVESTÍCIE</text>`;
  s += `<text x="${mx}" y="${invBarY+invH+15}" text-anchor="middle" fill="#2adf8a" font-family="JetBrains Mono" font-size="9">${fmt(inv)}</text>`;
  const invSrcY = incY + expH;
  s += `<path d="M ${sx+nW} ${invSrcY} C ${mx-70} ${invSrcY}, ${mx-70} ${invBarY}, ${mx-nW/2} ${invBarY} L ${mx-nW/2} ${invBarY+invH} C ${mx-70} ${invBarY+invH}, ${mx-70} ${invSrcY+invH}, ${sx+nW} ${invSrcY+invH} Z" fill="#2adf8a" opacity=".13"/>`;

  const gCols = ['#2adf8a','#38a8e8','#c9a84c','#a78bfa','#f472b6'];
  let gY = invBarY;
  state.goals.forEach((g, i) => {
    const h = Math.max(6, invH / Math.max(state.goals.length, 1));
    const col = gCols[i % gCols.length];
    s += `<rect x="${ex}" y="${gY}" width="${nW}" height="${h}" rx="3" fill="${col}" opacity=".85"/>`;
    s += `<text x="${ex+nW+5}" y="${gY+h/2+4}" fill="${col}" font-family="JetBrains Mono" font-size="9">${g.icon} ${escHtml(g.label)}</text>`;
    const srcY2 = invBarY + (i / state.goals.length) * invH;
    s += `<path d="M ${mx+nW/2} ${srcY2} C ${ex-50} ${srcY2}, ${ex-50} ${gY}, ${ex} ${gY} L ${ex} ${gY+h} C ${ex-50} ${gY+h}, ${ex-50} ${srcY2+h}, ${mx+nW/2} ${srcY2+h} Z" fill="${col}" opacity=".14"/>`;
    gY += h + 2;
  });
  svg.innerHTML = s;
}

function renderVerdict() {
  const pmt = Math.max(0, investable());
  const per = pmt / Math.max(state.goals.length, 1);
  const nameA = state.nameA || 'Partner A';
  const nameB = state.incomeB > 0 ? ` a ${state.nameB || 'Partner B'}` : '';
  let html = `<div class="verdict"><div class="verdict-title">📊 Analýza pre ${escHtml(nameA)}${escHtml(nameB)}</div>`;

  if (pmt <= 0) {
    html += `<p style="color:var(--red)">⚠️ Výdavky presahujú príjem o <em style="color:var(--red)">${fmt(Math.abs(pmt))}</em>. Nemáte investovateľný zostatok.</p>`;
  } else {
    html += `<p>Investovateľný CF: <em style="color:var(--gold-light)">${fmt(pmt)}/mes.</em> — rozdelený na <em style="color:var(--gold-light)">${state.goals.length}</em> cieľov (${fmt(per)}/mes. na každý).</p><br/>`;
    state.goals.forEach(g => {
      const tgt = effectiveTarget(g);
      const mS = calcMonthsSaving(per, tgt, state.inflation);
      const mI = calcMonthsInvesting(per, tgt, state.returnRate, state.inflation, g.currentSavings || 0);
      const diff = isFinite(mS) && isFinite(mI) ? mS - mI : null;
      if (diff !== null && diff > 0) {
        html += `<p>${g.icon} <strong>${escHtml(g.label)}</strong> (${fmt(tgt)}): Ak budeš len sporiť, cieľ dosiahneš za <span style="color:#f97316">${fmtMonths(mS)}</span>. Pri investovaní (${state.returnRate}% p.a.) za <strong style="color:var(--green)">${fmtMonths(mI)}</strong>. <em style="color:var(--gold-light)">Ušetríš ${fmtMonths(diff)} svojho života.</em></p><br/>`;
      } else if (isFinite(mI)) {
        html += `<p>${g.icon} <strong>${escHtml(g.label)}</strong>: Cieľ investovaním za <strong style="color:var(--green)">${fmtMonths(mI)}</strong>.</p><br/>`;
      } else {
        html += `<p>${g.icon} <strong>${escHtml(g.label)}</strong>: S príspevkom ${fmt(per)}/mes. nedosiahnuteľné. Zvýšte príspevok alebo znížte cieľ.</p><br/>`;
      }
    });
    const largest = [...state.goals].sort((a,b) => effectiveTarget(b)-effectiveTarget(a))[0];
    if (largest) {
      const nomTgt = effectiveTarget(largest);
      const real30 = nomTgt * Math.pow(1 + state.inflation/100, 30);
      html += `<p style="border-top:1px solid rgba(255,255,255,.06);padding-top:12px;margin-top:4px">⚠️ <strong style="color:var(--gold-light)">Inflačné varovanie:</strong> Cieľ <em>${escHtml(largest.label)}</em> (${fmt(nomTgt)}) — bez investovania by ste za 30 rokov potrebovali <span style="color:var(--red)">${fmt(real30)}</span> (o <span style="color:var(--red)">${fmt(real30-nomTgt)}</span> viac kvôli inflácii ${state.inflation}%).</p>`;
    }
  }
  html += '</div>';
  document.getElementById('verdict-content').innerHTML = html;
}

// ═══════════════════════════════════════════════════════════
//  ACTIONS
// ═══════════════════════════════════════════════════════════

function addExpense(label = 'Nová kategória', amount = 0) {
  state.expenses.push({ id: state.nextExpId++, label, amount });
  recalc();
}
function removeExpense(id) {
  state.expenses = state.expenses.filter(e => e.id !== id);
  recalc();
}
function updateExpense(id, field, value) {
  const e = state.expenses.find(e => e.id === id);
  if (e) { e[field] = value; scheduleSave(); renderSummary(); }
}

// Goal modal
function openGoalModal() {
  document.getElementById('modal-label').value = '';
  document.getElementById('modal-target').value = '';
  document.getElementById('modal-savings').value = '0';
  document.getElementById('goal-modal').classList.add('open');
  setTimeout(() => document.getElementById('modal-label').focus(), 100);
}
function closeGoalModal() { document.getElementById('goal-modal').classList.remove('open'); }
function closeModalOutside(e) { if (e.target === document.getElementById('goal-modal')) closeGoalModal(); }

function confirmAddGoal() {
  const label = document.getElementById('modal-label').value.trim() || 'Nový cieľ';
  const target = parseFloat(document.getElementById('modal-target').value) || 10000;
  const savings = parseFloat(document.getElementById('modal-savings').value) || 0;
  state.goals.push({ id: state.nextGoalId++, icon:'⭐', label, target, type:'custom', currentSavings: savings });
  closeGoalModal();
  recalc();
  showToast('✓ Cieľ pridaný');
}

function removeGoal(id) {
  if (!confirm('Vymazať tento cieľ?')) return;
  state.goals = state.goals.filter(g => g.id !== id);
  if (state.selectedChartGoal === id && state.goals.length > 0) state.selectedChartGoal = state.goals[0].id;
  recalc();
}

function editGoal(id) {
  const g = state.goals.find(x => x.id === id);
  if (!g) return;
  if (!g.isPension) {
    const t = parseFloat(prompt(`Cieľová suma pre "${g.label}" (€):`, g.target));
    if (!isNaN(t) && t > 0) g.target = t;
  }
  const cs = parseFloat(prompt(`Aktuálne úspory / portfólio pre "${g.label}" (€):`, g.currentSavings || 0));
  if (!isNaN(cs)) g.currentSavings = cs;
  recalc();
  showToast('✓ Cieľ aktualizovaný');
}

function updateRange(id, valId, suffix) {
  const v = parseFloat(document.getElementById(id).value);
  document.getElementById(valId).textContent = v.toFixed(1) + suffix;
  state[id] = v;
}

// ═══════════════════════════════════════════════════════════
//  TAB ROUTING
// ═══════════════════════════════════════════════════════════

function switchTab(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));

  document.getElementById('panel-' + name).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.getAttribute('onclick') && b.getAttribute('onclick').includes("'" + name + "'")) b.classList.add('active');
  });
  const bnav = document.getElementById('bnav-' + name);
  if (bnav) bnav.classList.add('active');

  // Scroll to top on tab change (mobile)
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (name === 'charts') { renderGrowthChart(); renderInflationTable(); }
  if (name === 'sankey') renderSankey();
  if (name === 'verdict') renderVerdict();
}

// ═══════════════════════════════════════════════════════════
//  MAIN RECALC
// ═══════════════════════════════════════════════════════════

function recalc() {
  // Read all inputs into state
  state.incomeA = parseFloat(document.getElementById('incomeA').value) || 0;
  state.incomeB = parseFloat(document.getElementById('incomeB').value) || 0;
  state.nameA = document.getElementById('nameA').value;
  state.nameB = document.getElementById('nameB').value;
  state.inflation = parseFloat(document.getElementById('inflation').value) || 3.5;
  state.returnRate = parseFloat(document.getElementById('returnRate').value) || 8;
  state.pensionRent = parseFloat(document.getElementById('pensionRent').value) || 2000;

  // Keep pension goal target in sync
  const pg = state.goals.find(g => g.isPension);
  if (pg) pg.target = pensionTarget(state.pensionRent);

  renderExpenses();
  renderSummary();
  renderGoals();
  renderChartGoalButtons();

  // Re-render active lazy panels
  const active = document.querySelector('.panel.active');
  if (active) {
    if (active.id === 'panel-charts') { renderGrowthChart(); renderInflationTable(); }
    if (active.id === 'panel-sankey') renderSankey();
    if (active.id === 'panel-verdict') renderVerdict();
  }

  scheduleSave();
}

// ═══════════════════════════════════════════════════════════
//  INIT — restore inputs from state
// ═══════════════════════════════════════════════════════════

function initInputs() {
  setVal('incomeA', state.incomeA);
  setVal('incomeB', state.incomeB);
  setVal('nameA', state.nameA);
  setVal('nameB', state.nameB);
  setVal('inflation', state.inflation);
  setVal('returnRate', state.returnRate);
  setVal('pensionRent', state.pensionRent);
  document.getElementById('inflationVal').textContent = state.inflation.toFixed(1) + '%';
  document.getElementById('returnRateVal').textContent = state.returnRate.toFixed(1) + '%';
}

// ═══════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ═══════════════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════════════
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  initInputs();
  recalc();
  // Mark as saved if we loaded from localStorage
  if (localStorage.getItem(STORAGE_KEY)) {
    setSaveDot('saved');
    updateStorageStatus();
  }
  // Handle keyboard Enter in modal
  document.getElementById('modal-target').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmAddGoal();
  });
});
