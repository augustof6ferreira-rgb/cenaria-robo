// Robô do Cenaria (roda no GitHub Actions, sem tela): abre o site com ?robo=1, espera os vídeos ficarem prontos,
// padroniza o MP4 (H.264 + AAC, aceito por TikTok e YouTube) e envia ao cofre (R2) com os metadados.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const SITE = (process.env.SITE || 'https://cenaria.cenaria-z2.workers.dev').replace(/\/$/, '');
const TOKEN = process.env.ROBO_TOKEN;
const QTD = Math.max(1, Math.min(4, Number(process.env.QTD) || 2));
const LIMITE_MIN = 280; // 3 vídeos com folga (o job tem 300 min)
if (!TOKEN) { console.error('Falta o segredo ROBO_TOKEN no GitHub.'); process.exit(1); }

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((t) => {
  try { localStorage.setItem('cenaria.config', JSON.stringify({ ...JSON.parse(localStorage.getItem('cenaria.config') || '{}'), robo: t })); } catch {}
}, TOKEN);
const page = await ctx.newPage();
page.on('dialog', (d) => d.dismiss().catch(() => {}));      // nenhum "confirmar" passa sozinho (ex.: gasto pago)
page.on('console', (m) => { if (m.text().startsWith('[robo]')) console.log(m.text()); });
// erros de rede agrupados por serviço (ex.: 429 = limite por minuto): mostra QUEM está limitando, sem poluir o log
const falhas = new Map();
page.on('response', (r) => {
  if (r.status() < 400) return;
  const u = new URL(r.url());
  const k = `${r.status()} ${u.host}${u.pathname.replace(/\/[0-9a-f-]{20,}.*$/i, '/…').slice(0, 60)}`;
  falhas.set(k, (falhas.get(k) || 0) + 1);
});
const resumoFalhas = () => { if (falhas.size) console.log('[rede] ' + [...falhas].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}x ${k}`).join(' | ')); falhas.clear(); };
page.on('pageerror', (e) => console.log('ERRO NA PÁGINA:', e.message));
const arquivos = new Map();
page.on('download', async (d) => {
  const destino = `/tmp/${d.suggestedFilename()}`;
  await d.saveAs(destino);
  arquivos.set(d.suggestedFilename(), destino);
  console.log('baixado', d.suggestedFilename());
});

await page.goto(`${SITE}/?robo=1&qtd=${QTD}`, { waitUntil: 'domcontentloaded' });
const ini = Date.now();
let estado;
for (;;) {
  await page.waitForTimeout(15000);
  estado = await page.evaluate(() => window.__robo && { status: window.__robo.status, n: window.__robo.videos.length }).catch(() => null);
  if ((Date.now() - ini) % (10 * 60e3) < 15000) resumoFalhas(); // a cada ~10 min
  if (estado?.status === 'fim') break;
  if (Date.now() - ini > LIMITE_MIN * 60e3) { console.log('Tempo esgotado.'); break; }
}
resumoFalhas();
const r = await page.evaluate(() => window.__robo).catch(() => null);
await page.waitForTimeout(5000); // termina de salvar o último download
await browser.close();

let enviados = 0;
let descartados = 0;
for (const v of r?.videos || []) {
  // trava de qualidade: vídeo com cena sem imagem (ou sem voz) não vai para o cofre — evita "tela verde" na aprovação
  const falta = [].concat(v.itensFaltando || v.falta || []).join(' | ');
  if (/cenas com imagem/i.test(falta)) {
    descartados++;
    console.log(`[robo] vídeo ${v.ordem + 1} DESCARTADO: cena(s) sem imagem ou voz (${falta})`);
    continue;
  }
  const bruto = arquivos.get(v.arquivo);
  if (!bruto) { console.log(`vídeo ${v.ordem + 1}: download não chegou`); continue; }
  const final = bruto.replace(/\.mp4$/, '-final.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', bruto, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', final], { stdio: 'inherit' });
  const meta = Buffer.from(JSON.stringify({ ...v, arquivo: undefined })).toString('base64');
  const resp = await fetch(`${SITE}/api/robo/video`, {
    method: 'PUT', headers: { 'x-robo': TOKEN, 'x-meta': meta, 'content-type': 'video/mp4' }, body: readFileSync(final),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) { console.log(`vídeo ${v.ordem + 1}: envio falhou (${resp.status}) ${j.erro || ''}`); continue; }
  enviados++;
  console.log(`✔ vídeo ${v.ordem + 1} no cofre: ${j.titulo} · nota ${j.nota} · ${(statSync(final).size / 1048576).toFixed(1)} MB · posta ${j.quando}`);
}
for (const e of r?.erros || []) console.log('erro:', e);
console.log(`Resumo: ${enviados}/${QTD} vídeo(s) prontos para aprovação${descartados ? ` · ${descartados} descartado(s) por falta de imagem/voz` : ''}.`);
process.exit(enviados ? 0 : 1);
