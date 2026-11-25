// Gera a vitrine de estilos da landing (/conheca): a MESMA cena em cada estilo de imagem do Cenaria.
// Usa o próprio site (/api/imagem) com o token do robô; salva em /tmp/estilos/<id>.jpg.
import { writeFileSync, mkdirSync } from 'node:fs';
const SITE = (process.env.SITE || 'https://cenaria.cenaria-z2.workers.dev').replace(/\/$/, '');
const TOKEN = process.env.ROBO_TOKEN;
if (!TOKEN) { console.error('Falta ROBO_TOKEN'); process.exit(1); }
const CENA = 'a lone astronaut standing on a rocky ridge at night, looking up at an enormous glowing spiral galaxy that fills the whole sky, vertical composition';
const ESTILOS = {
  dreamcore: 'dark dreamcore cinematic film still, liminal and eerie atmosphere, muted cold teal and deep blue palette with faint amber light, thin fog and volumetric haze, deep black shadows, soft focus, 35mm film grain look, photorealistic',
  cinematica: 'cinematic, photorealistic, dramatic lighting, shallow depth of field',
  animacao3d: '3d animated feature film style, soft lighting, vibrant colors, charming character design',
  anime: 'anime style illustration, detailed painterly background, vivid sky',
  aquarela: 'watercolor painting, soft textures, artistic, paper grain',
  neon: 'dark moody, neon lights, cyberpunk, high contrast',
  palito: 'minimalist stick figure drawing, simple hand drawn black ink lines on off-white paper, doodle style, tiny stick figure',
};
mkdirSync('/tmp/estilos', { recursive: true });
let ok = 0;
for (const [id, estilo] of Object.entries(ESTILOS)) {
  const q = new URLSearchParams({ fonte: 'ia', w: '720', h: '1280', seed: '2026', prompt: `${CENA}. Art style: ${estilo}.` });
  for (let t = 1; t <= 4; t++) {
    try {
      const r = await fetch(`${SITE}/api/imagem?${q}`, { headers: { 'x-robo': TOKEN } });
      if (!r.ok || !/image/.test(r.headers.get('content-type') || '')) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
      writeFileSync(`/tmp/estilos/${id}.jpg`, Buffer.from(await r.arrayBuffer()));
      console.log('ok', id); ok++; break;
    } catch (e) { console.log(`${id} tentativa ${t}: ${e.message}`); await new Promise((s) => setTimeout(s, 20000)); }
  }
}
console.log(`${ok}/${Object.keys(ESTILOS).length} estilos`);
process.exit(ok ? 0 : 1);
