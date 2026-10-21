/**
 * Aviso de aporte con comprobante.
 *
 * GET  /api/aviso  → { listo }  (la web solo manda al formulario cuando todo está configurado)
 * POST /api/aviso  → recibe el aviso en JSON (el comprobante va en base64), lo valida,
 *                    lo guarda en el repo PRIVADO de aportes y le avisa a la fundación por correo
 *                    con el comprobante adjunto. Si el donante dejó correo, le confirma que recibimos.
 *
 * Datos personales y bancarios: el comprobante nunca queda en una carpeta pública ni detrás de un
 * enlace. Se guarda en el repo privado (AVISOS_REPO) y viaja adjunto al correo de la fundación.
 * Esta función nunca devuelve una URL del comprobante.
 *
 * Variables de entorno (Vercel → renacecolombia → Settings → Environment Variables):
 *   AVISOS_GITHUB_TOKEN  token de GitHub con «Contents: read and write» SOLO sobre el repo privado
 *   AVISOS_REPO          repo privado (por defecto oceanagencycol-stack/renace-aportes)
 *   AVISOS_RAMA          rama (por defecto main)
 *   SMTP_HOST, SMTP_PORT (465 o 587), SMTP_USER, SMTP_PASS   cuenta que envía los correos
 *   AVISOS_PARA          correo(s) de la fundación que reciben los avisos, separados por coma
 *   AVISOS_DE            remitente visible (por defecto SMTP_USER)
 */
'use strict';
const crypto = require('crypto');

const MAX_ARCHIVO = 3 * 1024 * 1024;           // 3 MB ya comprimido (el navegador reduce las fotos)
const MIN_SEGUNDOS = 3;                         // menos que esto es un robot llenando el formulario
const LIMITE = { ventanaMs: 15 * 60 * 1000, max: 8 }; // por IP y por instancia
const MEDIOS = {
  davivienda: 'Cuenta de ahorros Davivienda (Colombia)',
  breb: 'Bre-B (llave NIT)',
  dolarapp: 'DolarApp',
  exterior: 'Transferencia desde EE. UU. (ACH o wire)',
  otro: 'Otro',
};
const ORIGENES = [
  /^https:\/\/(www\.)?renacecol\.org$/,
  /^https:\/\/renacecolombia\.vercel\.app$/,
  /^https:\/\/renacecolombia-[a-z0-9-]+-ocean-agency\.vercel\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

function config() {
  const e = process.env;
  const c = {
    token: e.AVISOS_GITHUB_TOKEN || '',
    repo: e.AVISOS_REPO || 'oceanagencycol-stack/renace-aportes',
    rama: e.AVISOS_RAMA || 'main',
    api: e.AVISOS_GITHUB_API || 'https://api.github.com',
    smtp: { host: e.SMTP_HOST || '', port: Number(e.SMTP_PORT || 465), user: e.SMTP_USER || '', pass: e.SMTP_PASS || '' },
    para: (e.AVISOS_PARA || '').split(',').map(s => s.trim()).filter(Boolean),
  };
  c.de = e.AVISOS_DE || c.smtp.user;
  c.guarda = Boolean(c.token && c.repo);
  c.correo = Boolean(c.smtp.host && c.smtp.user && c.smtp.pass && c.para.length);
  c.listo = c.guarda && c.correo;   // sin las dos cosas no se abre el formulario: un aviso no se puede perder
  return c;
}

/* ── límite de envíos (en memoria: frena ráfagas; no es una garantía global) ── */
const vistos = new Map();
function pasaLimite(ip) {
  const ahora = Date.now();
  const lista = (vistos.get(ip) || []).filter(t => ahora - t < LIMITE.ventanaMs);
  if (lista.length >= LIMITE.max) { vistos.set(ip, lista); return false; }
  lista.push(ahora); vistos.set(ip, lista);
  if (vistos.size > 5000) vistos.clear();
  return true;
}

/* ── el archivo es lo que dice ser: se mira el contenido, no la extensión ── */
function tipoReal(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { mime: 'image/png', ext: 'png' };
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (b.slice(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  const ftyp = b.slice(4, 12).toString('latin1');
  if (/^ftyp(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(ftyp)) return { mime: 'image/heic', ext: 'heic' };
  return null;
}

/* ── validación: todo se revisa aquí, aunque el formulario ya lo haya revisado ── */
const texto = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const CORREO_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

function validar(b) {
  const err = {};
  const d = {};
  d.nombre = texto(b.nombre, 120);
  if (d.nombre.length < 2 || !/\p{L}/u.test(d.nombre)) err.nombre = 'nombre';

  d.canal = b.canal === 'whatsapp' ? 'whatsapp' : 'correo';
  const contacto = texto(b.contacto, 160);
  if (d.canal === 'correo') {
    if (!CORREO_RE.test(contacto)) err.contacto = 'correo';
    d.correo = contacto.toLowerCase();
  } else {
    const digitos = contacto.replace(/[^\d+]/g, '');
    if (!/^\+?\d{7,15}$/.test(digitos)) err.contacto = 'whatsapp';
    d.whatsapp = digitos;
  }

  d.moneda = b.moneda === 'USD' ? 'USD' : 'COP';
  const monto = Number(String(b.monto || '').replace(/[^\d.,]/g, '').replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.'));
  if (/-/.test(String(b.monto || '')) || !isFinite(monto) || monto <= 0 || monto > (d.moneda === 'USD' ? 1e6 : 5e9)) err.monto = 'monto';
  d.monto = Math.round(monto * 100) / 100;

  const fecha = texto(b.fecha, 10);
  const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? new Date(fecha + 'T12:00:00Z') : null;
  const hoy = Date.now();
  if (!f || isNaN(f) || f.getTime() > hoy + 36e5 * 36 || f.getTime() < hoy - 400 * 864e5) err.fecha = 'fecha';
  d.fecha = fecha;

  d.medio = Object.prototype.hasOwnProperty.call(MEDIOS, b.medio) ? b.medio : '';
  if (!d.medio) err.medio = 'medio';

  d.publico = b.publico === 'nombre' ? 'nombre' : 'anonimo';
  const obra = texto(b.obra, 40);
  d.obra = /^RNC-[A-Z]-[0-9a-f]{8}$/.test(obra) ? obra : 'donde_mas_se_necesite';
  d.idioma = b.idioma === 'en' ? 'en' : 'es';

  if (b.autoriza !== true) err.autoriza = 'autoriza';

  const a = b.archivo || {};
  let buf = null, tipo = null;
  if (typeof a.datos !== 'string' || !a.datos) err.archivo = 'falta';
  else {
    if (a.datos.length > Math.ceil(MAX_ARCHIVO / 3) * 4 + 8) err.archivo = 'grande';
    else {
      buf = Buffer.from(a.datos, 'base64');
      if (buf.length > MAX_ARCHIVO) err.archivo = 'grande';
      else if (!(tipo = tipoReal(buf))) err.archivo = 'tipo';
    }
  }
  return { err, d, buf, tipo };
}

/* ── guardar en el repo privado ── */
async function gh(c, metodo, ruta, cuerpo) {
  // dos avisos al mismo tiempo pueden chocar en la rama (409): se reintenta con una pausa corta
  for (let intento = 1; ; intento++) {
    const r = await fetch(`${c.api}/repos/${c.repo}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'renace-avisos', 'Content-Type': 'application/json' },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return r.json();
    if ((r.status === 409 || r.status >= 500) && intento < 3) { await new Promise(ok => setTimeout(ok, 400 * intento + Math.random() * 400)); continue; }
    throw new Error(`GitHub ${metodo} ${ruta.split('?')[0]} → ${r.status}`);
  }
}
async function guardar(c, id, mes, registro, buf, tipo) {
  const base = `avisos/${mes}/${id}`;
  // los mensajes de commit no llevan datos personales: solo el número de aviso
  await gh(c, 'PUT', `/contents/${base}/comprobante.${tipo.ext}`, { message: `Aviso ${id}: comprobante`, content: buf.toString('base64'), branch: c.rama });
  await gh(c, 'PUT', `/contents/${base}/aviso.json`, { message: `Aviso ${id}`, content: Buffer.from(JSON.stringify(registro, null, 2) + '\n').toString('base64'), branch: c.rama });
  return base;
}

/* ── correos ── */
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmtMonto = (m, mon) => mon === 'USD'
  ? 'US$ ' + m.toLocaleString('en-US', { minimumFractionDigits: m % 1 ? 2 : 0 })
  : '$' + Math.round(m).toLocaleString('es-CO') + ' COP';
const fmtFecha = f => { const [a, m, d] = f.split('-'); return `${d}/${m}/${a}`; };

function transporte(c) {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: c.smtp.host, port: c.smtp.port, secure: c.smtp.port === 465,
    auth: { user: c.smtp.user, pass: c.smtp.pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
}

function correoFundacion(c, id, d, ruta, buf, tipo) {
  const contacto = d.canal === 'correo' ? `Correo: ${d.correo}` : `WhatsApp: ${d.whatsapp}`;
  const filas = [
    ['Aviso', id],
    ['Nombre', d.nombre],
    ['Devolver el folio por', contacto],
    ['Monto', fmtMonto(d.monto, d.moneda)],
    ['Fecha del aporte', fmtFecha(d.fecha)],
    ['Medio', MEDIOS[d.medio]],
    ['En el registro público', d.publico === 'nombre' ? 'Con su nombre' : 'Anónimo'],
    ['Obra', d.obra === 'donde_mas_se_necesite' ? 'Donde más se necesite' : d.obra],
    ['Autorizó el tratamiento de datos (Ley 1581)', 'Sí'],
    ['Guardado en', `${c.repo} (privado) → ${ruta}`],
  ];
  return {
    from: c.de, to: c.para.join(', '),
    replyTo: d.canal === 'correo' ? d.correo : undefined,
    subject: `Aviso de aporte ${id} · ${fmtMonto(d.monto, d.moneda)} · ${d.nombre}`,
    text: `Llegó un aviso de aporte desde renacecol.org. El comprobante va adjunto.\n\n${filas.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nPara cumplir la promesa de la web, el folio se devuelve hoy por ${d.canal === 'correo' ? 'correo' : 'WhatsApp'}.\nEl comprobante tiene datos personales y bancarios: no lo reenvíes fuera de la fundación.`,
    html: `<p>Llegó un aviso de aporte desde renacecol.org. <b>El comprobante va adjunto.</b></p><table cellpadding="6" style="border-collapse:collapse;font:14px/1.4 Arial,sans-serif">${filas.map(([k, v]) => `<tr><td style="color:#6E6558;border-bottom:1px solid #E0D7C4">${esc(k)}</td><td style="border-bottom:1px solid #E0D7C4"><b>${esc(v)}</b></td></tr>`).join('')}</table><p style="font:14px/1.5 Arial,sans-serif">Para cumplir la promesa de la web, el folio se devuelve <b>hoy</b> por ${d.canal === 'correo' ? 'correo' : 'WhatsApp'}.<br><span style="color:#6E6558">El comprobante tiene datos personales y bancarios: no lo reenvíes fuera de la fundación.</span></p>`,
    attachments: [{ filename: `comprobante-${id}.${tipo.ext}`, content: buf, contentType: tipo.mime }],
  };
}

function correoDonante(c, id, d) {
  const en = d.idioma === 'en';
  const m = fmtMonto(d.monto, d.moneda);
  const asunto = en ? `We received your RENACE contribution notice (${id})` : `Recibimos tu aviso de aporte a RENACE (${id})`;
  const cuerpo = en
    ? `Hi ${d.nombre},\n\nWe received your notice for ${m} made on ${fmtFecha(d.fecha)}, with its receipt. Your notice number is ${id}.\n\nThe foundation is verifying it and you will receive your tracking number (folio) at this email today. With that number you can look up your contribution at https://renacecol.org.\n\nThank you for rebuilding with us.\nRENACE · Fundación Un Hogar Sin Olvido`
    : `Hola, ${d.nombre}:\n\nRecibimos tu aviso por ${m} del ${fmtFecha(d.fecha)}, con su comprobante. Tu número de aviso es ${id}.\n\nLa fundación lo está verificando y hoy te llega tu folio a este correo. Con ese folio puedes consultar tu aporte en https://renacecol.org.\n\nGracias por reconstruir con nosotros.\nRENACE · Fundación Un Hogar Sin Olvido`;
  return { from: c.de, to: d.correo, replyTo: c.para[0], subject: asunto, text: cuerpo };
}

/* ── respaldo: si el correo a la fundación falla, queda un issue en el repo privado (sin datos personales) ── */
async function avisarFalla(c, id, ruta) {
  try {
    await gh(c, 'POST', '/issues', {
      title: `Aviso ${id} sin notificar a la fundación`,
      body: `El aviso ${id} quedó guardado en \`${ruta}\`, pero el correo a la fundación falló. Reenvíalo hoy para que el donante reciba su folio.`,
    });
  } catch (e) { console.error('aviso: tampoco se pudo abrir el issue de respaldo', e.message); }
}

function leerCuerpo(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((ok, mal) => {
    let n = 0; const partes = [];
    req.on('data', ch => { n += ch.length; if (n > 4.6e6) { mal(new Error('grande')); req.destroy(); } else partes.push(ch); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')); } catch (e) { mal(e); } });
    req.on('error', mal);
  });
}

function responder(res, estado, obj) {
  res.statusCode = estado;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = async function aviso(req, res) {
  const c = config();
  if (req.method === 'GET' || req.method === 'HEAD') return responder(res, 200, { listo: c.listo });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return responder(res, 405, { ok: false, error: 'metodo' }); }

  const origen = req.headers.origin || '';
  if (!ORIGENES.some(re => re.test(origen))) return responder(res, 403, { ok: false, error: 'origen' });
  if (!c.listo) return responder(res, 503, { ok: false, error: 'no_configurado' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (!pasaLimite(ip)) return responder(res, 429, { ok: false, error: 'limite' });

  let b;
  try { b = await leerCuerpo(req); } catch { return responder(res, 400, { ok: false, error: 'cuerpo' }); }

  // trampas para robots: campo oculto lleno o formulario enviado en un instante. Se responde como si
  // hubiera salido bien para no enseñarle al robot qué lo delató, y no se guarda ni se avisa nada.
  if (texto(b.sitio, 200) || !(Number(b.t) >= MIN_SEGUNDOS * 1000)) {
    return responder(res, 200, { ok: true, aviso: 'AV-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8) });
  }

  const { err, d, buf, tipo } = validar(b);
  if (Object.keys(err).length) return responder(res, 422, { ok: false, error: 'campos', campos: err });

  const ahora = new Date();
  const co = new Date(ahora.getTime() - 5 * 36e5);   // hora de Colombia
  const yymmdd = co.toISOString().slice(2, 10).replace(/-/g, '');
  const id = `AV-${yymmdd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const mes = co.toISOString().slice(0, 7);
  const registro = {
    aviso: id, recibido: ahora.toISOString(), ...d,
    comprobante: { archivo: `comprobante.${tipo.ext}`, tipo: tipo.mime, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') },
    autorizacion_datos: { ley: '1581 de 2012', aceptada: true, fecha: ahora.toISOString() },
    estado: 'pendiente_folio',
  };

  let ruta = null, guardado = false, notificado = false;
  try { ruta = await guardar(c, id, mes, registro, buf, tipo); guardado = true; }
  catch (e) { console.error('aviso: no se pudo guardar', id, e.message); }

  const t = transporte(c);
  try { await t.sendMail(correoFundacion(c, id, d, ruta || '(no se pudo guardar: el comprobante solo está en este correo)', buf, tipo)); notificado = true; }
  catch (e) { console.error('aviso: no se pudo avisar a la fundación', id, e.message); }

  if (!guardado && !notificado) return responder(res, 502, { ok: false, error: 'servicio' });
  if (guardado && !notificado) await avisarFalla(c, id, ruta);

  if (d.canal === 'correo') {
    try { await t.sendMail(correoDonante(c, id, d)); }
    catch (e) { console.error('aviso: no se pudo confirmar al donante', id, e.message); }
  }
  console.log('aviso recibido', id, { guardado, notificado });
  return responder(res, 200, { ok: true, aviso: id });
};

module.exports._interno = { validar, tipoReal, config };
