#!/usr/bin/env bash
# Teste da Fase 2: 4 cenas dreamcore do Cenaria -> GPU grátis do Kaggle (LTX-Video) -> vídeo de amostra.
# Só precisa do segredo ROBO_TOKEN: a chave do Kaggle fica no Cloudflare e o site faz a ponte (/api/robo/kaggle/...).
set -euo pipefail
SITE="${SITE:-https://cenariavideos.com}"
PONTE="$SITE/api/robo/kaggle/kernels"
SLUG=cenaria-animar
TRAB=/tmp/kaggle; rm -rf "$TRAB"; mkdir -p "$TRAB/dados" "$TRAB/saida"

ESTILO='dark dreamcore cinematic film still, liminal and eerie atmosphere, muted cold teal and deep blue palette with faint amber light, thin fog and volumetric haze, lonely tiny human silhouettes or astronauts against vast emptiness, deep black shadows, soft focus, 35mm film grain look, photorealistic'

# id | cena (imagem) | ação física | movimento de câmera
CENAS=(
"c1|a lone tiny astronaut standing on a dark rocky plain under a huge dying red star|the dying star pulses slowly and fog drifts across the ground|slow smooth camera push-in toward the main subject"
"c2|a giant radio telescope dish in a dark desert at night under a faint green sky glow|the radio telescope dish slowly turns toward the sky|slow steady horizontal camera pan across the scene"
"c3|a lonely gas giant planet with thin rings floating in deep black space|the planet slowly rotates, clouds drifting across its surface|gentle slow camera orbit around the main subject"
"c4|an endless empty corridor with a single amber light at the far end and a small astronaut silhouette||static camera, only subtle natural motion: blinking, breathing, soft light flicker, floating particles"
)

echo "== 1) gerando as imagens no Cenaria (mesmas IAs grátis do robô)"
json='{"modelo":"Lightricks/LTX-Video","largura":512,"altura":896,"quadros":97,"passos":30,"guia":3.0,"cenas":['
primeiro=1
for linha in "${CENAS[@]}"; do
  IFS='|' read -r id cena acao camera <<< "$linha"
  prompt_img="$cena, $ESTILO"
  curl -sS --fail -G "$SITE/api/imagem" -H "x-robo: $ROBO_TOKEN" \
    --data-urlencode "prompt=$prompt_img" --data-urlencode "w=1080" --data-urlencode "h=1920" --data-urlencode "seed=7" \
    -o "$TRAB/dados/$id.jpg"
  echo "  $id: $(stat -c%s "$TRAB/dados/$id.jpg") bytes"
  mov="$cena."
  [ -n "$acao" ] && mov="$mov Main motion: $acao. The motion is clearly visible from the first to the last frame. Camera: nearly still, only a $camera." || mov="$mov Camera: $camera."
  mov="$mov Keep exactly the same art style, colors, lighting and characters as the start frame (dark dreamcore, fog, film grain). Smooth, slow, stable, continuous single shot. No text, no morphing, no new characters appearing."
  [ $primeiro = 1 ] || json="$json,"; primeiro=0
  json="$json$(python3 -c 'import json,sys; print(json.dumps({"id":sys.argv[1],"arquivo":sys.argv[1]+".jpg","prompt":sys.argv[2],"seed":42}))' "$id" "$mov")"
done
echo "$json]}" > "$TRAB/dados/cenas.json"

echo "== 2) montando o código do Kaggle com as cenas embutidas (imagens reduzidas a 512x896)"
python3 - "$TRAB/dados" "$(dirname "$0")/animar.py" > "$TRAB/kernel.py" <<'PY'
import base64, json, subprocess, sys, os
dados, script = sys.argv[1], sys.argv[2]
cfg = json.load(open(os.path.join(dados, 'cenas.json')))
for c in cfg['cenas']:
    src = os.path.join(dados, c['arquivo']); peq = src + '.small.jpg'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-vf', 'scale=512:896', '-q:v', '3', peq], check=True)
    c['imagem_b64'] = base64.b64encode(open(peq, 'rb').read()).decode()
print('CENAS_EMBUTIDAS = ' + json.dumps(cfg))
print(open(script).read())
PY
echo "  código: $(stat -c%s "$TRAB/kernel.py") bytes"

echo "== 3) disparando a GPU do Kaggle (pela ponte do Cenaria)"
python3 -c 'import json,sys; print(json.dumps({"titulo":"cenaria-animar","codigo":open(sys.argv[1]).read()}))' "$TRAB/kernel.py" > "$TRAB/push.json"
resp=$(curl -sS -X POST "$PONTE/push?slug=$SLUG" -H "x-robo: $ROBO_TOKEN" -H 'content-type: application/json' --data-binary @"$TRAB/push.json")
echo "  resposta: $resp"
echo "$resp" | grep -qi '"error"\|"erro"' && { echo "PUSH FALHOU"; exit 1; }
inicio=$(date +%s)
while true; do
  sleep 30
  st=$(curl -sS "$PONTE/status?slug=$SLUG" -H "x-robo: $ROBO_TOKEN" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status") or d)' 2>&1 || echo "?")
  echo "  $(( ($(date +%s)-inicio)/60 )) min: $st"
  case "$st" in *omplete*|*OMPLETE*) break ;; *rror*|*RROR*|*ancel*|*ANCEL*) break ;; esac
  [ $(( $(date +%s)-inicio )) -gt 5400 ] && { echo "  passou de 90 min, parando de esperar"; break; }
done

echo "== 4) baixando os vídeos"
curl -sS "$PONTE/output?slug=$SLUG" -H "x-robo: $ROBO_TOKEN" > "$TRAB/output.json"
python3 - "$TRAB/output.json" "$TRAB/saida" <<'PY'
import json, sys, urllib.request, os
d = json.load(open(sys.argv[1])); dest = sys.argv[2]
for f in d.get('files', []):
    nome = os.path.basename(f.get('fileName') or f.get('name') or '')
    if not nome: continue
    urllib.request.urlretrieve(f['url'], os.path.join(dest, nome)); print('  baixado', nome)
log = d.get('log') or ''
open(os.path.join(dest, 'kaggle.log'), 'w').write(log if isinstance(log, str) else json.dumps(log))
PY
ls -la "$TRAB/saida"
[ -f "$TRAB/saida/relatorio.json" ] && cat "$TRAB/saida/relatorio.json"
tail -c 4000 "$TRAB/saida/kaggle.log" 2>/dev/null || true

echo "== 5) montando a amostra (cena original 1 s + animação de cada cena)"
mkdir -p /tmp/amostra; lista=/tmp/amostra/lista.txt; : > "$lista"
for linha in "${CENAS[@]}"; do
  id="${linha%%|*}"
  [ -f "$TRAB/saida/$id.mp4" ] || continue
  ffmpeg -y -loglevel error -i "$TRAB/saida/$id.mp4" \
    -vf "scale=1080:1920:flags=lanczos,eq=contrast=1.05:saturation=0.9,noise=alls=8:allf=t,vignette=PI/5" \
    -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -an "/tmp/amostra/$id.mp4"
  echo "file '/tmp/amostra/$id.mp4'" >> "$lista"
done
if [ -s "$lista" ]; then
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$lista" -c copy /tmp/amostra/kaggle-teste.mp4
  cp "$TRAB/saida/relatorio.json" /tmp/amostra/ 2>/dev/null || true
  cp "$TRAB"/dados/*.jpg /tmp/amostra/ 2>/dev/null || true
  echo "AMOSTRA PRONTA: $(stat -c%s /tmp/amostra/kaggle-teste.mp4) bytes"
else
  echo "NENHUM CLIPE GERADO"; exit 1
fi
