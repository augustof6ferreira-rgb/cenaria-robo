# Cenaria — animação grátis na GPU do Kaggle (Fase 2).
# Roda como "kernel" do Kaggle (script, GPU + internet). Lê as cenas do dataset <usuario>/cenaria-cenas
# (cenas.json + imagens), anima cada imagem com o LTX-Video (imagem -> vídeo) e salva os MP4 em /kaggle/working.
# Quem cria o dataset, dispara este script e baixa os vídeos é o GitHub Actions (.github/workflows/kaggle-teste.yml).
import glob
import json
import os
import subprocess
import sys
import time

INICIO = time.time()
SAIDA = '/kaggle/working'
relatorio = {'gpu': None, 'modelo': None, 'cenas': [], 'erros': []}


def salvar_relatorio():
    relatorio['tempo_total_s'] = round(time.time() - INICIO, 1)
    with open(os.path.join(SAIDA, 'relatorio.json'), 'w') as f:
        json.dump(relatorio, f, ensure_ascii=False, indent=2)


subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', '-U',
                'diffusers>=0.32', 'transformers>=4.46', 'accelerate', 'sentencepiece', 'imageio[ffmpeg]'], check=True)

import torch  # noqa: E402
from diffusers import LTXImageToVideoPipeline  # noqa: E402
from diffusers.utils import export_to_video, load_image  # noqa: E402

relatorio['gpu'] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'SEM GPU'
print('GPU:', relatorio['gpu'], flush=True)

if 'CENAS_EMBUTIDAS' in globals():
    # cenas vieram dentro do próprio código (enviado pela ponte do Cenaria): imagens em base64
    import base64
    base = '/tmp/entrada'
    os.makedirs(base, exist_ok=True)
    config = CENAS_EMBUTIDAS  # noqa: F821
    for c in config['cenas']:
        with open(os.path.join(base, c['arquivo']), 'wb') as f:
            f.write(base64.b64decode(c.pop('imagem_b64')))
else:
    entrada = glob.glob('/kaggle/input/**/cenas.json', recursive=True)
    if not entrada:
        relatorio['erros'].append('cenas.json não encontrado no dataset')
        salvar_relatorio()
        sys.exit(1)
    base = os.path.dirname(entrada[0])
    config = json.load(open(entrada[0]))
cenas = config['cenas']
W, H = int(config.get('largura', 512)), int(config.get('altura', 896))       # múltiplos de 32, vertical 9:16
QUADROS = int(config.get('quadros', 97))                                     # 8k+1 quadros; 97 = 4 s a 24 fps
PASSOS = int(config.get('passos', 30))
NEG = config.get('negativo', 'worst quality, inconsistent motion, blurry, jittery, distorted, text, subtitles, watermark, logo')

# T4/P100 não têm bfloat16: usa float16 com o VAE em float32 (evita quadros pretos por estouro numérico)
modelo = config.get('modelo', 'Lightricks/LTX-Video')
relatorio['modelo'] = modelo
t0 = time.time()
pipe = LTXImageToVideoPipeline.from_pretrained(modelo, torch_dtype=torch.float16)
pipe.vae.to(torch.float32)
pipe.vae.enable_tiling()
pipe.enable_model_cpu_offload()   # cabe nos 16 GB da T4
relatorio['carregar_modelo_s'] = round(time.time() - t0, 1)
print(f'modelo carregado em {relatorio["carregar_modelo_s"]}s', flush=True)

for c in cenas:
    t = time.time()
    info = {'id': c['id'], 'ok': False}
    try:
        img = load_image(os.path.join(base, c['arquivo'])).convert('RGB').resize((W, H))
        quadros = pipe(
            image=img, prompt=c['prompt'], negative_prompt=NEG, width=W, height=H,
            num_frames=QUADROS, num_inference_steps=PASSOS, guidance_scale=float(config.get('guia', 3.0)),
            generator=torch.Generator(device='cuda').manual_seed(int(c.get('seed', 42))),
        ).frames[0]
        destino = os.path.join(SAIDA, f"{c['id']}.mp4")
        export_to_video(quadros, destino, fps=24)
        # quadro todo preto = estouro numérico (NaN) no float16
        import numpy as np
        brilho = float(np.asarray(quadros[len(quadros) // 2]).mean())
        info.update(ok=brilho > 1.0, brilho_meio=round(brilho, 1), arquivo=os.path.basename(destino))
        if brilho <= 1.0:
            relatorio['erros'].append(f"{c['id']}: quadros pretos (float16)")
    except Exception as e:  # uma cena com erro não derruba as outras
        info['erro'] = str(e)[:400]
        relatorio['erros'].append(f"{c['id']}: {str(e)[:200]}")
    info['tempo_s'] = round(time.time() - t, 1)
    relatorio['cenas'].append(info)
    print(json.dumps(info, ensure_ascii=False), flush=True)
    torch.cuda.empty_cache()

salvar_relatorio()
print('FIM', json.dumps(relatorio, ensure_ascii=False), flush=True)
