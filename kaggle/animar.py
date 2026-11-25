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


# versões travadas: uma atualização das bibliotecas não quebra o robô de um dia para o outro
# (se a versão travada não instalar, cai para a mais nova e registra qual veio no relatorio.json)
VERSOES = {'diffusers': '0.35.2', 'transformers': '4.57.1', 'accelerate': '1.11.0'}
EXTRAS = ['sentencepiece', 'imageio[ffmpeg]']
r = subprocess.run([sys.executable, '-m', 'pip', 'install', '-q'] + [f'{k}=={v}' for k, v in VERSOES.items()] + EXTRAS)
if r.returncode:
    relatorio['erros'].append('versões travadas não instalaram: usando as mais novas')
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', '-U'] + list(VERSOES) + EXTRAS, check=True)

import torch  # noqa: E402
from diffusers import LTXImageToVideoPipeline  # noqa: E402

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
            f.write(base64.b64decode(c['imagem_b64']))
else:
    entrada = glob.glob('/kaggle/input/**/cenas.json', recursive=True)
    if not entrada:
        relatorio['erros'].append('cenas.json não encontrado no dataset')
        salvar_relatorio()
        sys.exit(1)
    base = os.path.dirname(entrada[0])
    config = json.load(open(entrada[0]))
cenas = config['cenas']
relatorio['id_lote'] = config.get('id_lote')  # o site confere que o relatório é do lote que ele enviou
W, H = int(config.get('largura', 512)), int(config.get('altura', 896))       # múltiplos de 32, vertical 9:16
QUADROS = int(config.get('quadros', 97))                                     # 8k+1 quadros; 97 = 4 s a 24 fps
PASSOS = int(config.get('passos', 40))
NEG = config.get('negativo', 'worst quality, inconsistent motion, blurry, jittery, distorted, deformed limbs, morphing, text, subtitles, watermark, logo')

# ---- 2 GPUs (T4 x2): o texto (T5, ~9,5 GB) é codificado uma vez só; depois cada GPU anima metade das cenas
modelo = config.get('modelo', 'Lightricks/LTX-Video')
relatorio['modelo'] = modelo
relatorio['versoes'] = {k: __import__(k).__version__ for k in ('diffusers', 'transformers', 'accelerate', 'torch')}
TRAB = '/tmp/cenaria'
os.makedirs(TRAB, exist_ok=True)
t0 = time.time()
pipe_txt = LTXImageToVideoPipeline.from_pretrained(modelo, transformer=None, vae=None, torch_dtype=torch.float16).to('cuda:0')
for c in cenas:
    neg = ', '.join(x for x in (NEG, c.get('negativo_extra', '')) if x)
    with torch.no_grad():
        pe, pm, ne, nm = pipe_txt.encode_prompt(prompt=c['prompt'], negative_prompt=neg, do_classifier_free_guidance=True,
                                                device='cuda:0', dtype=torch.float16)
    torch.save({'pe': pe.cpu(), 'pm': pm.cpu(), 'ne': ne.cpu(), 'nm': nm.cpu()}, os.path.join(TRAB, f"{c['id']}.pt"))
del pipe_txt
torch.cuda.empty_cache()
relatorio['codificar_texto_s'] = round(time.time() - t0, 1)

trabalho = {'modelo': modelo, 'base': base, 'saida': SAIDA, 'trab': TRAB, 'W': W, 'H': H, 'quadros': QUADROS,
            'passos': PASSOS, 'guia': float(config.get('guia', 3.0)),
            'cenas': [{k: v for k, v in c.items() if k != 'imagem_b64'} for c in cenas]}
json.dump(trabalho, open(os.path.join(TRAB, 'trabalho.json'), 'w'))

TRABALHADOR = r"""
import json, os, sys, time
import numpy as np, torch
from PIL import Image, ImageOps
from diffusers import LTXImageToVideoPipeline
from diffusers.utils import export_to_video
cfg = json.load(open(sys.argv[1])); ids = sys.argv[2].split(',')
t0 = time.time()
# T4 não tem bfloat16: float16 com o VAE em float32 (evita quadros pretos por estouro numérico)
pipe = LTXImageToVideoPipeline.from_pretrained(cfg['modelo'], text_encoder=None, tokenizer=None, torch_dtype=torch.float16)
pipe.vae.to(torch.float32)
def _f32(f):  # o pipeline manda imagem/latentes em float16 para o VAE
    def g(*a, **k):
        a = [x.float() if torch.is_tensor(x) and x.is_floating_point() else x for x in a]
        k = {n: (v.float() if torch.is_tensor(v) and v.is_floating_point() else v) for n, v in k.items()}
        return f(*a, **k)
    return g
pipe.vae.encode = _f32(pipe.vae.encode); pipe.vae.decode = _f32(pipe.vae.decode)
pipe.vae.enable_tiling()
pipe.to('cuda')   # sem o T5, transformer + VAE cabem inteiros nos 16 GB (mais rápido que cpu offload)
print(json.dumps({'gpu_pronta': os.environ.get('CUDA_VISIBLE_DEVICES'), 'carregar_s': round(time.time() - t0, 1)}), flush=True)
for c in [x for x in cfg['cenas'] if x['id'] in ids]:
    t = time.time(); info = {'id': c['id'], 'ok': False, 'gpu': os.environ.get('CUDA_VISIBLE_DEVICES')}
    try:
        # encaixa sem esticar (corta bordas se a proporção for diferente)
        img = ImageOps.fit(Image.open(os.path.join(cfg['base'], c['arquivo'])).convert('RGB'), (cfg['W'], cfg['H']), Image.LANCZOS)
        e = torch.load(os.path.join(cfg['trab'], c['id'] + '.pt'))
        args = dict(image=img, prompt_embeds=e['pe'].to('cuda'), prompt_attention_mask=e['pm'].to('cuda'),
                    negative_prompt_embeds=e['ne'].to('cuda'), negative_prompt_attention_mask=e['nm'].to('cuda'),
                    width=cfg['W'], height=cfg['H'], num_frames=int(c.get('quadros', cfg['quadros'])),
                    num_inference_steps=cfg['passos'], guidance_scale=float(c.get('guia', cfg['guia'])),
                    generator=torch.Generator(device='cuda').manual_seed(int(c.get('seed', 42))))
        try:  # ruído na decodificação do VAE (textura/nitidez do 0.9.1+), não gera movimento
            quadros = pipe(**args, decode_timestep=0.05, decode_noise_scale=0.025).frames[0]
        except TypeError:
            quadros = pipe(**args).frames[0]
        destino = os.path.join(cfg['saida'], c['id'] + '.mp4')
        export_to_video(quadros, destino, fps=24)
        q = [np.asarray(quadros[i]).astype(np.float32) for i in (0, len(quadros) // 2, len(quadros) - 1)]
        brilho = float(q[1].mean())
        movimento = float((np.abs(q[1] - q[0]).mean() + np.abs(q[2] - q[1]).mean()) / 2)  # 0-255
        info.update(ok=brilho > 1.0, brilho_meio=round(brilho, 1), movimento=round(movimento, 2),
                    congelado=movimento < 2.0, arquivo=os.path.basename(destino))
        if brilho <= 1.0: info['erro'] = 'quadros pretos (float16)'
    except Exception as ex:  # uma cena com erro não derruba as outras
        info['erro'] = str(ex)[:400]
    info['tempo_s'] = round(time.time() - t, 1)
    print('CENA ' + json.dumps(info, ensure_ascii=False), flush=True)
    torch.cuda.empty_cache()
"""
open(os.path.join(TRAB, 'trabalhador.py'), 'w').write(TRABALHADOR)
n_gpu = max(1, torch.cuda.device_count())
relatorio['gpus'] = n_gpu
grupos = [[c['id'] for c in cenas[i::n_gpu]] for i in range(n_gpu)]
procs = []
for i, ids in enumerate(grupos):
    if not ids: continue
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(i))
    procs.append(subprocess.Popen([sys.executable, os.path.join(TRAB, 'trabalhador.py'), os.path.join(TRAB, 'trabalho.json'), ','.join(ids)],
                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
for p in procs:
    for linha in p.stdout:
        print(linha.rstrip(), flush=True)
        if linha.startswith('CENA '):
            info = json.loads(linha[5:])
            relatorio['cenas'].append(info)
            if info.get('erro'): relatorio['erros'].append(f"{info['id']}: {info['erro'][:200]}")
            if info.get('congelado'): relatorio['erros'].append(f"{info['id']}: saiu quase sem movimento")
    p.wait()
    if p.returncode: relatorio['erros'].append(f'processo de GPU terminou com código {p.returncode}')
feitas = {c['id'] for c in relatorio['cenas']}
for c in cenas:
    if c['id'] not in feitas:
        relatorio['cenas'].append({'id': c['id'], 'ok': False, 'erro': 'não processada'})
relatorio['cenas'].sort(key=lambda x: x['id'])
salvar_relatorio()
print('FIM', json.dumps(relatorio, ensure_ascii=False), flush=True)
