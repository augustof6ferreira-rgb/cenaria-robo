// Robô do Cenaria (roda no GitHub Actions, sem tela): abre o site com ?robo=1, espera os vídeos ficarem prontos,
// padroniza o MP4 (H.264 + AAC, aceito por TikTok e YouTube) e envia ao cofre (R2) com os metadados.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';

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

const VITRINE = process.env.MODO === 'vitrine'; // vídeo de apresentação da landing (não vai para a fila de posts)
await page.goto(`${SITE}/?robo=1&${VITRINE ? 'modo=vitrine' : `qtd=${QTD}`}`, { waitUntil: 'domcontentloaded' });
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

if (VITRINE) {
  const bruto = arquivos.get('vitrine.mp4');
  for (const e of r?.erros || []) console.log('erro:', e);
  if (!bruto) { console.log('vitrine: download não chegou'); process.exit(1); }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', bruto, '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '/tmp/vitrine-final.mp4'], { stdio: 'inherit' });
  console.log(`vitrine pronta: ${(statSync('/tmp/vitrine-final.mp4').size / 1048576).toFixed(1)} MB · ${r?.videos?.[0]?.duracao || '?'} s`);
  process.exit(0);
}
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
  // textos exatos do post para a tarefa que agenda no Metricool (ela lê este log com `gh api` e decodifica com base64 -d;
  // a leitura pelo site resumia a legenda em vez de copiar)
  // capa dreamcore: quadro da abertura + título curto (Instagram usa; YouTube/TikTok só em contas verificadas/empresa)
  let capa = '';
  try {
    const curto = String(j.titulo || '').split(/[:–—|]/)[0].trim().toUpperCase().slice(0, 48);
    const linhas = []; let atual = '';
    for (const w of curto.split(/\s+/)) { if ((atual + ' ' + w).trim().length > 16 && atual) { linhas.push(atual); atual = w; } else atual = (atual + ' ' + w).trim(); }
    if (atual) linhas.push(atual);
    const txt = bruto.replace(/\.mp4$/, '-capa.txt'), jpg = bruto.replace(/\.mp4$/, '-capa.jpg');
    writeFileSync(txt, linhas.slice(0, 3).join('\n'));
    const fonte = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'].find(existsSync);
    const vf = ['scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920', 'eq=contrast=1.06:saturation=0.85', 'vignette=PI/4.5',
      'drawbox=x=0:y=ih*0.48:w=iw:h=ih*0.52:color=black@0.18:t=fill', 'drawbox=x=0:y=ih*0.56:w=iw:h=ih*0.44:color=black@0.2:t=fill', 'drawbox=x=0:y=ih*0.62:w=iw:h=ih*0.38:color=black@0.22:t=fill',
      ...(fonte ? [`drawtext=fontfile=${fonte}:textfile=${txt}:fontsize=96:line_spacing=14:fontcolor=white:borderw=6:bordercolor=black@0.85:x=(w-text_w)/2:y=h*0.64`] : [])].join(',');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.2', '-i', final, '-frames:v', '1', '-vf', vf, '-q:v', '3', jpg]);
    const rc = await fetch(`${SITE}/api/robo/capa?id=${j.id}`, { method: 'PUT', headers: { 'x-robo': TOKEN, 'content-type': 'image/jpeg' }, body: readFileSync(jpg) });
    const jc = await rc.json().catch(() => ({}));
    if (rc.ok) capa = jc.capa || ''; else console.log(`capa ${v.ordem + 1}: envio falhou (${rc.status}) ${jc.erro || ''}`);
  } catch (e) { console.log(`capa ${v.ordem + 1}: ${e.message}`); }
  const tags = (j.hashtags || []).map((h) => `#${String(h).replace(/^#/, '')}`).join(' ');
  const post = { id: j.id, titulo: j.titulo || '', texto: [String(j.descricao || '').trim(), tags].filter(Boolean).join('\n\n'), comentario: j.comentario || '', capa };
  console.log(`[post] ${j.id} ${Buffer.from(JSON.stringify(post)).toString('base64')}`);
}
for (const e of r?.erros || []) console.log('erro:', e);
console.log(`Resumo: ${enviados}/${QTD} vídeo(s) prontos para aprovação${descartados ? ` · ${descartados} descartado(s) por falta de imagem/voz` : ''}.`);
process.exit(enviados ? 0 : 1);
