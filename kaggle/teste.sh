#!/usr/bin/env bash
# Teste da Fase 2: 4 cenas dreamcore do Cenaria -> GPU grátis do Kaggle (LTX-Video) -> vídeo de amostra.
# Precisa dos segredos do GitHub: ROBO_TOKEN, KAGGLE_USERNAME, KAGGLE_KEY.
set -euo pipefail
SITE="${SITE:-https://cenariavideos.com}"
U="$KAGGLE_USERNAME"
TRAB=/tmp/kaggle; rm -rf "$TRAB"; mkdir -p "$TRAB/dados" "$TRAB/kernel" "$TRAB/saida" ~/.kaggle
printf '{"username":"%s","key":"%s"}' "$KAGGLE_USERNAME" "$KAGGLE_KEY" > ~/.kaggle/kaggle.json && chmod 600 ~/.kaggle/kaggle.json

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

echo "== 2) enviando as cenas ao Kaggle (dataset $U/cenaria-cenas)"
cat > "$TRAB/dados/dataset-metadata.json" <<EOF
{"title":"cenaria-cenas","id":"$U/cenaria-cenas","licenses":[{"name":"CC0-1.0"}]}
EOF
if kaggle datasets status "$U/cenaria-cenas" >/dev/null 2>&1; then
  kaggle datasets version -p "$TRAB/dados" -m "teste $(date -u +%FT%T)" -q
else
  kaggle datasets create -p "$TRAB/dados" -q
fi
for i in $(seq 1 30); do
  st=$(kaggle datasets status "$U/cenaria-cenas" 2>/dev/null || echo "?")
  echo "  dataset: $st"; [ "$st" = "ready" ] && break; sleep 10
done

echo "== 3) disparando a GPU do Kaggle"
cp "$(dirname "$0")/animar.py" "$TRAB/kernel/"
cat > "$TRAB/kernel/kernel-metadata.json" <<EOF
{"id":"$U/cenaria-animar","title":"cenaria-animar","code_file":"animar.py","language":"python","kernel_type":"script",
 "is_private":true,"enable_gpu":true,"enable_internet":true,"dataset_sources":["$U/cenaria-cenas"],
 "competition_sources":[],"kernel_sources":[],"model_sources":[]}
EOF
kaggle kernels push -p "$TRAB/kernel"
inicio=$(date +%s)
while true; do
  sleep 30
  st=$(kaggle kernels status "$U/cenaria-animar" 2>&1 | tail -1)
  echo "  $(( ($(date +%s)-inicio)/60 )) min: $st"
  case "$st" in *complete*|*COMPLETE*) break ;; *error*|*ERROR*|*cancel*|*CANCEL*) break ;; esac
  [ $(( $(date +%s)-inicio )) -gt 5400 ] && { echo "  passou de 90 min, parando de esperar"; break; }
done

echo "== 4) baixando os vídeos"
kaggle kernels output "$U/cenaria-animar" -p "$TRAB/saida" || true
ls -la "$TRAB/saida"
[ -f "$TRAB/saida/relatorio.json" ] && cat "$TRAB/saida/relatorio.json"
tail -60 "$TRAB"/saida/*.log 2>/dev/null || true

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
