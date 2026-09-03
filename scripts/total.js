#!/usr/bin/env node
/**
 * Reconstruye el total recaudado leyendo los mensajes de commit del agente.
 *
 * El agente de WhatsApp escribe cada aporte con un mensaje del tipo
 *   "Aporte RNC-2608-000048 — Tiru Tadesse — 550000 COP"
 * Ese mensaje queda en el historial de git aunque el monto se borre del
 * archivo publicado. Es la única fuente de los montos que no está en
 * ningún otro lado, y sirve para no depender de que alguien recuerde la cifra.
 *
 * Uso:  node scripts/total.js          → muestra el total y qué falta
 *       node scripts/total.js --aplicar → además lo escribe en aportes.json
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const P = path.join(RAIZ, 'data/aportes.json');
const ap = JSON.parse(fs.readFileSync(P, 'utf8'));
const publicados = new Set(ap.aportes.map(a => a.folio));

// ── montos según los mensajes de commit ──
const log = execSync('git log --format=%s --all', { cwd: RAIZ, maxBuffer: 20 * 1024 * 1024 }).toString();
const porMensaje = new Map();
for (const ln of log.split('\n')) {
  const m = ln.match(/(RNC-\d{4}-\d{6}).*?(\d[\d.]*)\s*COP/i);
  if (m) {
    const folio = m[1], monto = parseInt(m[2].replace(/\./g, ''), 10);
    if (!porMensaje.has(folio) && isFinite(monto)) porMensaje.set(folio, monto);
  }
}

// ── montos que quedaron en versiones antiguas del archivo ──
const porArchivo = new Map();
try {
  const hs = execSync('git log --format=%H --all -- data/aportes.json', { cwd: RAIZ }).toString().trim().split('\n');
  for (const h of hs) {
    if (!h) continue;
    let d;
    try { d = JSON.parse(execSync(`git show ${h}:data/aportes.json`, { cwd: RAIZ, maxBuffer: 10 * 1024 * 1024 }).toString()); }
    catch { continue; }
    for (const a of d.aportes || []) {
      if (typeof a.monto === 'number' && !porArchivo.has(a.folio)) porArchivo.set(a.folio, a.monto);
    }
  }
} catch { /* repositorio sin historial */ }

// ── cruce ──
let total = 0;
const sinMonto = [];
const detalle = [];
const CUENTAN = new Set(['recibido', 'en_asignacion', 'comprado', 'entregado']);  // 'pendiente' no: aún no llegó
// 'pendiente' queda fuera hasta que el banco confirme
const excluidos = [];
for (const a of ap.aportes) {
  // un duplicado o un costo de operación no es plata que entró
  if (a.estado && !CUENTAN.has(a.estado)) { excluidos.push(`${a.folio} · ${a.estado}`); continue; }
  const m = porMensaje.get(a.folio) ?? porArchivo.get(a.folio);
  if (m == null) { sinMonto.push(a.folio + ' · ' + a.origen); continue; }
  total += m;
  detalle.push({ folio: a.folio, origen: a.origen, monto: m,
                 fuente: porMensaje.has(a.folio) ? 'commit' : 'archivo' });
}

const cop = v => '$' + v.toLocaleString('es-CO');
console.log(`\n  ${ap.aportes.length} entradas en el registro · ${detalle.length + sinMonto.length} cuentan como ingreso`);
if (excluidos.length) {
  console.log(`  ${excluidos.length} excluidas del total:`);
  excluidos.forEach(x => console.log('   · ' + x));
}
console.log(`  ${detalle.length} con monto recuperado · ${sinMonto.length} sin monto\n`);
for (const d of detalle) {
  console.log(`   ${d.folio}  ${cop(d.monto).padStart(12)}  ${d.origen.slice(0, 30).padEnd(32)} (${d.fuente})`);
}
if (sinMonto.length) {
  console.log('\n  ⚠ SIN MONTO — no se pueden sumar, hay que buscarlos a mano:');
  sinMonto.forEach(x => console.log('   · ' + x));
}
console.log(`\n  Total reconstruido:  ${cop(total)}`);
console.log(`  Total publicado:     ${cop(ap.total_cop)}  (suma ${ap.aportes_en_total} aportes)`);

if (total !== ap.total_cop && !sinMonto.length) {
  console.log(`  ⚠ DIFERENCIA de ${cop(Math.abs(total - ap.total_cop))}`);
}

if (process.argv.includes('--aplicar')) {
  if (sinMonto.length) {
    console.error('\n  No se aplica: hay aportes sin monto. Complétalos primero.\n');
    process.exit(1);
  }
  ap.total_cop = total;
  ap.aportes_en_total = detalle.length;
  ap.actualizado = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(P, JSON.stringify(ap, null, 1));
  console.log(`\n  ✅ aportes.json actualizado a ${cop(total)} con ${ap.aportes.length} aportes.\n`);
} else {
  console.log('\n  Para escribirlo:  node scripts/total.js --aplicar\n');
}
