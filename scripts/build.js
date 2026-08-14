#!/usr/bin/env node
/**
 * Se ejecuta en cada despliegue de Vercel.
 * 1) Valida los archivos de data/. Si alguno está roto, el despliegue FALLA
 *    y la versión anterior sigue en línea.
 * 2) Sincroniza las cifras que van escritas en index.html (las que ve quien
 *    tiene JavaScript desactivado) con lo que dice data/aportes.json.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const errores = [];
const avisos = [];

function leerJSON(rel) {
  const p = path.join(RAIZ, rel);
  if (!fs.existsSync(p)) { errores.push(`${rel} no existe`); return null; }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    errores.push(`${rel} no es JSON válido — ${e.message}`);
    return null;
  }
}

const esFecha = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// ── aportes ──────────────────────────────────────────────
const ESTADOS = ['recibido','en_asignacion','comprado','entregado','no_ejecutado','costo_operacion'];
const ap = leerJSON('data/aportes.json');
let n = 0, obras = '0 / 100', pct = '0,00 %';

if (ap) {
  if (!Array.isArray(ap.aportes)) errores.push('aportes.json — "aportes" debe ser una lista');
  else {
    const folios = new Set();
    ap.aportes.forEach((a, i) => {
      const d = `aportes.json — entrada ${i + 1}`;
      if (!a.folio) errores.push(`${d} sin folio`);
      else if (folios.has(a.folio)) errores.push(`${d} folio repetido: ${a.folio}`);
      else folios.add(a.folio);
      if (!esFecha(a.fecha)) errores.push(`${d} (${a.folio}) fecha inválida, se espera AAAA-MM-DD`);
      if ('monto' in a || 'monto_orig' in a)
        errores.push(`${d} (${a.folio}) trae un MONTO. Por seguridad no se publican montos: quítalo de este archivo.`);
      if (!a.origen) errores.push(`${d} (${a.folio}) sin origen`);
      if (a.estado && !ESTADOS.includes(a.estado))
        errores.push(`${d} (${a.folio}) estado "${a.estado}" no existe. Válidos: ${ESTADOS.join(', ')}`);

    });
    if (typeof ap.avance_pct !== 'number' || ap.avance_pct < 0 || ap.avance_pct > 100)
      errores.push('aportes.json — "avance_pct" debe ser un número entre 0 y 100');
    if (!esFecha(ap.actualizado)) errores.push('aportes.json — "actualizado" con fecha inválida');

    if (!errores.length) {
      n = ap.aportes.length;
      obras = `${ap.obras_entregadas || 0} / ${ap.meta_obras || 100}`;
      pct = ap.avance_pct.toFixed(2).replace('.', ',') + ' %';
    }
  }
}


// ── nada sensible puede quedar publicado en una nota ──────
const PROHIBIDO = [
  [/\bTR[A-Za-z0-9]{6,}\b/, 'una referencia de transacción'],
  [/\b\d{9,}\b/, 'un número largo (cuenta o documento)'],
  [/\btitular\b/i, 'la palabra "titular" seguida de un nombre'],
  [/\b\d{1,2}:\d{2}\b/, 'una hora exacta'],
  [/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/, 'una fecha escrita con barras'],
];
if (ap && Array.isArray(ap.aportes)) {
  ap.aportes.forEach(a => {
    ['nota', 'nota_en'].forEach(campo => {
      const v = a[campo];
      if (!v) return;
      PROHIBIDO.forEach(([re_, que]) => {
        if (re_.test(v))
          errores.push(`aportes.json — la nota de ${a.folio} contiene ${que}. ` +
            `Las notas son públicas: deja solo una descripción neutra del aporte.`);
      });
    });
    if (typeof a.origen === 'string' && /\d{7,}/.test(a.origen))
      errores.push(`aportes.json — el origen de ${a.folio} trae un número largo. Usa solo el nombre.`);
  });
}

// ── el resto de archivos ─────────────────────────────────
const otros = {
  'data/novedades.json': d => Array.isArray(d.novedades) || 'falta la lista "novedades"',
  'data/entregas.json':  d => Array.isArray(d.entregas)  || 'falta la lista "entregas"',
  'data/zonas.json':     d => Array.isArray(d.zonas)     || 'falta la lista "zonas"',
  'data/aliados.json':   d => Array.isArray(d.aliados)   || 'falta la lista "aliados"',
  'data/recursos.json':  d => Array.isArray(d.recursos)  || 'falta la lista "recursos"',
  'assets/col.json':     d => Array.isArray(d.deps) && d.deps.length > 20 || 'el mapa no trae los departamentos',
};
for (const [rel, comprueba] of Object.entries(otros)) {
  const d = leerJSON(rel);
  if (d) { const r = comprueba(d); if (r !== true) errores.push(`${rel} — ${r}`); }
}

// todo recurso externo debe llevar enlace y quién lo opera
const rec = leerJSON('data/recursos.json');
if (rec && Array.isArray(rec.recursos)) {
  rec.recursos.forEach(r => {
    if (!/^https:\/\//.test(r.url || '')) errores.push(`recursos.json — "${r.titulo}" necesita una URL https`);
    if (!r.quien) errores.push(`recursos.json — "${r.titulo}" debe decir quién lo opera`);
  });
}

// las zonas del mapa deben caer dentro del lienzo
const z = leerJSON('data/zonas.json');
if (z && Array.isArray(z.zonas)) {
  z.zonas.concat(z.epicentro ? [z.epicentro] : []).forEach(p => {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || p.x < 0 || p.x > 1000 || p.y < 0 || p.y > 1400)
      errores.push(`zonas.json — "${p.n || p.nombre}" tiene coordenadas fuera del mapa`);
  });
}

// los logos de los aliados deben existir
const al = leerJSON('data/aliados.json');
if (al && Array.isArray(al.aliados)) {
  al.aliados.forEach(a => {
    if (a.logo && !fs.existsSync(path.join(RAIZ, 'assets', a.logo)))
      errores.push(`aliados.json — falta el archivo assets/${a.logo} (${a.nombre})`);
  });
}

// ── informe ──────────────────────────────────────────────
if (avisos.length) {
  console.log('\nAvisos:');
  avisos.forEach(a => console.log('  · ' + a));
}
if (errores.length) {
  console.error('\n❌ Los datos tienen errores. NO se publica y la versión anterior sigue en línea.\n');
  errores.forEach(e => console.error('  · ' + e));
  console.error('\nCorrige el archivo y vuelve a empujar.\n');
  process.exit(1);
}

// ── sincronizar las cifras escritas en el HTML ───────────
const idx = path.join(RAIZ, 'index.html');
let html = fs.readFileSync(idx, 'utf8');
const reemplazos = [
  ['tPct', pct], ['tAp', String(n)], ['tOb', obras],
  ['lvPct', pct], ['lvAportes', String(n)], ['lvObras', obras], ['mPct', pct],
];
let cambios = 0;
for (const [id, valor] of reemplazos) {
  const re = new RegExp(`(id="${id}"[^>]*>)([^<]*)(<)`);
  const m = html.match(re);
  // ojo: el valor lleva "$" y en replace() eso es una retrorreferencia.
  // Por eso se usa una función, que no interpreta $ ni nada.
  if (m && m[2] !== valor) { html = html.replace(re, (_, a, __, c) => a + valor + c); cambios++; }
}
if (cambios) fs.writeFileSync(idx, html);

console.log(`\n✅ Datos correctos · ${n} aportes · ${pct} de la meta · sin montos publicados`);
console.log(`   Cifras del HTML sincronizadas (${cambios} ${cambios === 1 ? 'cambio' : 'cambios'}).\n`);
