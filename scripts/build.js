#!/usr/bin/env node
/**
 * Se ejecuta en cada despliegue de Vercel. Dos niveles, a propósito:
 *   SANEA   → lo arreglable solo (notas con datos sensibles, montos que no deberían
 *             estar). El despliegue continúa, nada sensible llega a producción, y
 *             queda el aviso en el registro de compilación.
 *   BLOQUEA → solo lo que rompería la página o publicaría algo incoherente.
 * Criterio: un aporte real nunca debe quedar sin publicar porque el agente escribió
 * mal una nota. Bloquear por eso deja fuera del registro a alguien que sí donó.
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const errores = [], saneados = [], avisos = [];

function leerJSON(rel) {
  const p = path.join(RAIZ, rel);
  if (!fs.existsSync(p)) { errores.push(`${rel} no existe`); return null; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { errores.push(`${rel} no es JSON válido — ${e.message}`); return null; }
}
const esFecha = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

const ESTADOS = ['recibido','en_asignacion','comprado','entregado','no_ejecutado','costo_operacion'];
const SENSIBLE = [
  [/\bTR[A-Za-z0-9]{6,}\b/i, 'referencia de transacción'],
  [/\b\d{9,}\b/, 'número largo (cuenta o documento)'],
  [/\btitular\b/i, 'nombre de titular'],
  [/\b\d{1,2}:\d{2}/, 'hora exacta'],
  [/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/, 'fecha con barras'],
];
const NEUTRA = { es: 'Aporte verificado con comprobante', en: 'Contribution verified with receipt' };
const ANON = { es: 'Aporte anónimo por decisión de quien donó', en: 'Anonymous contribution by the donor choice' };

const ap = leerJSON('data/aportes.json');
let n = 0, obras = '0 / 100', pct = '0,00 %', cambio = false;

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
      if (!a.origen) errores.push(`${d} (${a.folio}) sin origen`);
      if (a.estado && !ESTADOS.includes(a.estado))
        errores.push(`${d} (${a.folio}) estado "${a.estado}" no existe. Válidos: ${ESTADOS.join(', ')}`);

      ['monto','monto_orig','moneda','moneda_orig','trm_aplicada'].forEach(k => {
        if (k in a) { delete a[k]; cambio = true;
          saneados.push(`${a.folio}: se quitó el campo "${k}" (los montos no se publican)`); }
      });
      const anon = /an[oó]nim/i.test(String(a.origen || ''));
      ['nota','nota_en'].forEach(campo => {
        const v = a[campo];
        if (typeof v !== 'string' || !v) return;
        const motivos = SENSIBLE.filter(([re]) => re.test(v)).map(([, q]) => q);
        if (motivos.length) {
          const lg = campo === 'nota_en' ? 'en' : 'es';
          a[campo] = anon ? ANON[lg] : NEUTRA[lg];
          cambio = true;
          saneados.push(`${a.folio} [${campo}]: contenía ${[...new Set(motivos)].join(', ')} — se reemplazó por una nota neutra`);
        }
      });
      if (typeof a.origen === 'string' && /\d{7,}/.test(a.origen)) {
        a.origen = a.origen.replace(/\s*\d{7,}\s*/g, ' ').trim(); cambio = true;
        saneados.push(`${a.folio}: se quitó un número largo del campo "origen"`);
      }
    });
    if (typeof ap.avance_pct !== 'number' || ap.avance_pct < 0 || ap.avance_pct > 100)
      errores.push('aportes.json — "avance_pct" debe ser un número entre 0 y 100');
    if (!esFecha(ap.actualizado)) avisos.push('aportes.json — "actualizado" con fecha inválida');
    if (!errores.length) {
      n = ap.aportes.length;
      obras = `${ap.obras_entregadas || 0} / ${ap.meta_obras || 100}`;
      pct = ap.avance_pct.toFixed(2).replace('.', ',') + ' %';
    }
  }
}

const otros = {
  'data/novedades.json': d => Array.isArray(d.novedades) || 'falta la lista "novedades"',
  'data/entregas.json':  d => Array.isArray(d.entregas)  || 'falta la lista "entregas"',
  'data/zonas.json':     d => Array.isArray(d.zonas)     || 'falta la lista "zonas"',
  'data/aliados.json':   d => Array.isArray(d.aliados)   || 'falta la lista "aliados"',
  'data/recursos.json':  d => Array.isArray(d.recursos)  || 'falta la lista "recursos"',
  'assets/col.json':     d => (Array.isArray(d.deps) && d.deps.length > 20) || 'el mapa no trae los departamentos',
};
for (const [rel, ok] of Object.entries(otros)) {
  const d = leerJSON(rel);
  if (d) { const r = ok(d); if (r !== true) errores.push(`${rel} — ${r}`); }
}
const rec = leerJSON('data/recursos.json');
if (rec && Array.isArray(rec.recursos)) rec.recursos.forEach(r => {
  if (!/^https:\/\//.test(r.url || '')) errores.push(`recursos.json — "${r.titulo}" necesita una URL https`);
  if (!r.quien) errores.push(`recursos.json — "${r.titulo}" debe decir quién lo opera`);
});
const z = leerJSON('data/zonas.json');
if (z && Array.isArray(z.zonas)) z.zonas.concat(z.epicentro ? [z.epicentro] : []).forEach(p => {
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || p.x < 0 || p.x > 1000 || p.y < 0 || p.y > 1400)
    errores.push(`zonas.json — "${p.n || p.nombre}" tiene coordenadas fuera del mapa`);
});
const al = leerJSON('data/aliados.json');
if (al && Array.isArray(al.aliados)) al.aliados.forEach(a => {
  if (a.logo && !fs.existsSync(path.join(RAIZ, 'assets', a.logo)))
    errores.push(`aliados.json — falta el archivo assets/${a.logo} (${a.nombre})`);
});

if (saneados.length) {
  console.log('\n⚠  SE SANEARON DATOS ANTES DE PUBLICAR');
  console.log('   El despliegue continúa y nada de esto llega a producción,');
  console.log('   pero hay que corregir el origen (probablemente el agente de WhatsApp):\n');
  saneados.forEach(x => console.log('   · ' + x));
  console.log('');
}
if (avisos.length) { console.log('Avisos:'); avisos.forEach(a => console.log('  · ' + a)); }
if (errores.length) {
  console.error('\n❌ Errores que no se pueden corregir solos. NO se publica y la versión anterior sigue en línea.\n');
  errores.forEach(e => console.error('  · ' + e));
  console.error('\nCorrige el archivo y vuelve a empujar.\n');
  process.exit(1);
}
if (cambio) {
  fs.writeFileSync(path.join(RAIZ, 'data/aportes.json'), JSON.stringify(ap, null, 1));
  console.log('   → data/aportes.json saneado para esta publicación.\n');
}
const idx = path.join(RAIZ, 'index.html');
let html = fs.readFileSync(idx, 'utf8');
let cambios = 0;
for (const [id, valor] of [['tPct',pct],['tAp',String(n)],['tOb',obras],
                           ['lvPct',pct],['lvAportes',String(n)],['lvObras',obras],['mPct',pct]]) {
  const re = new RegExp(`(id="${id}"[^>]*>)([^<]*)(<)`);
  const m = html.match(re);
  if (m && m[2] !== valor) { html = html.replace(re, (_, a, __, c) => a + valor + c); cambios++; }
}
if (cambios) fs.writeFileSync(idx, html);
console.log(`✅ Publicando · ${n} aportes · ${pct} de la meta · sin montos`);
console.log(`   Cifras del HTML sincronizadas (${cambios} ${cambios === 1 ? 'cambio' : 'cambios'}).\n`);
