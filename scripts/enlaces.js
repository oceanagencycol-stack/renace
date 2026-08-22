#!/usr/bin/env node
/**
 * Comprueba que los enlaces externos de la página sigan vivos.
 *
 * Importa sobre todo por los recursos de "Si necesitas ayuda ahora": mandar a
 * alguien en emergencia a una página caída es peor que no darle nada. Ese enlace
 * estuvo roto varios días sin que nadie lo notara.
 *
 * No corre en el despliegue —un servicio externo caído no debe impedir publicar—
 * sino a mano o desde una tarea programada:
 *     node scripts/enlaces.js
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function recolectar() {
  const urls = new Map();   // url -> [dónde aparece]
  const anota = (u, donde) => {
    if (!/^https?:\/\//.test(u)) return;
    if (u.includes('renacecol.org') || u.includes('wa.me')) return;
    if (!urls.has(u)) urls.set(u, []);
    urls.get(u).push(donde);
  };
  const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) anota(m[1], 'index.html');
  const rec = JSON.parse(fs.readFileSync(path.join(RAIZ, 'data/recursos.json'), 'utf8'));
  for (const r of rec.recursos) anota(r.url, `RECURSO DE EMERGENCIA · ${r.titulo}`);
  return urls;
}

async function probar(u) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    let r = await fetch(u, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } });
    // algunos servidores rechazan HEAD pero responden a GET
    if (r.status === 405 || r.status === 403) {
      r = await fetch(u, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } });
    }
    return r.status;
  } catch (e) {
    return e.name === 'AbortError' ? 'sin respuesta' : 'error';
  } finally { clearTimeout(t); }
}

(async () => {
  const urls = recolectar();
  console.log(`\n  Comprobando ${urls.size} enlaces externos…\n`);
  const rotos = [], criticos = [];
  for (const [u, donde] of urls) {
    const st = await probar(u);
    const ok = st >= 200 && st < 400;
    const critico = donde.some(d => d.startsWith('RECURSO DE EMERGENCIA'));
    const marca = ok ? '✓' : (critico ? '🔴' : '✗');
    console.log(`  ${marca} ${String(st).padEnd(12)} ${u.slice(0, 62)}`);
    if (!ok) {
      (critico ? criticos : rotos).push({ u, st, donde: donde[0] });
    }
  }
  if (criticos.length) {
    console.log('\n  🔴 RECURSOS DE EMERGENCIA CAÍDOS — arréglalo hoy:');
    criticos.forEach(x => console.log(`     ${x.donde}\n       ${x.u} → ${x.st}`));
    console.log('\n     Alguien en emergencia va a hacer clic ahí. Si el servicio no vuelve,');
    console.log('     cambia el enlace o deja el número de teléfono como camino principal.');
  }
  if (rotos.length) {
    console.log('\n  ✗ Otros enlaces con problema:');
    rotos.forEach(x => console.log(`     ${x.u} → ${x.st}`));
  }
  if (!criticos.length && !rotos.length) console.log('\n  Todos los enlaces responden.\n');
  else console.log('');
  process.exit(criticos.length ? 1 : 0);
})();
