"""Generate Aftershock SFX with Stable Audio Open; pick best of N by CLAP score."""
import json, os, sys, torch, soundfile as sf, numpy as np
from diffusers import StableAudioPipeline, CosineDPMSolverMultistepScheduler
from transformers import ClapModel, ClapProcessor

OUT = os.path.expanduser('~/temp/es-sfx/raw')
os.makedirs(OUT, exist_ok=True)
NEG = 'music, melody, singing, speech, voice, talking, low quality, distorted, noise hiss'
SFX = {
  'crack':      ('asphalt and concrete ground cracking and splitting apart, sharp creaking cracks, earthquake, close up foley', 2.5),
  'hole_open':  ('ground caving in to a sinkhole, crumbling rocks, dirt and gravel pouring down, heavy collapse rumble', 3.5),
  'rumble':     ('deep low earthquake rumble, continuous ground shaking, sub bass tremor, steady', 10.0),
  'whoosh':     ('heavy object falling fast through the air, short downward whoosh', 1.2),
  'impact_concrete': ('heavy concrete block slams onto asphalt street, loud thud with debris scattering', 1.8),
  'impact_metal':    ('metal air conditioner unit crashes onto pavement, loud metallic crunch and rattle', 1.8),
  'impact_tiles':    ('stack of ceramic roof tiles shatters on the street, crash and shards', 1.8),
  'impact_pot':      ('ceramic flower pot smashes on concrete, crack and soil scatter', 1.5),
  'collapse':   ('two storey building collapsing, crumbling concrete walls, wood snapping, rubble avalanche', 5.0),
  'creak':      ('old wooden house frame creaking and groaning under stress before collapse', 2.2),
  'hurt':       ('dull body impact thump, heavy punch hit, foley', 0.8),
  'fall':       ('rocks and gravel tumbling down a deep hole, echoing falling debris', 2.5),
  'horn':       ('car horn honking urgently, repeated loud honks, street', 1.4),
  'car_rush':   ('car engine accelerating hard, loud revving engine passing by fast', 2.2),
  'car_crash':  ('car crashing into a wall, metal crunch, glass shattering, debris', 2.0),
}
N = int(os.environ.get('N', 3))
only = sys.argv[1:]

dev = 'cuda'
pipe = StableAudioPipeline.from_pretrained(os.path.expanduser('~/LLMs/stable-audio-open-1.0'), torch_dtype=torch.float32).to(dev)
# torchsde BrownianTree recurses forever / yields NaN on this stack; plain seeded
# Gaussian noise per step is a fine stand-in for the SDE solver's increments.
import diffusers.schedulers.scheduling_cosine_dpmsolver_multistep as _cos
class _SimpleNoise:
    def __init__(self, x, sigma_min=None, sigma_max=None, seed=None, **_):
        self.shape, self.dtype, self.device = x.shape, x.dtype, x.device
        self.g = torch.Generator(x.device).manual_seed(seed if isinstance(seed, int) else 0)
    def __call__(self, s0, s1):
        return torch.randn(self.shape, generator=self.g, device=self.device, dtype=torch.float32).to(self.dtype)
_cos.BrownianTreeNoiseSampler = _SimpleNoise
clap = ClapModel.from_pretrained('laion/clap-htsat-unfused').to(dev).eval()
proc = ClapProcessor.from_pretrained('laion/clap-htsat-unfused')
sr = pipe.vae.sampling_rate

def clap_score(wav, text):
    import torchaudio.functional as AF
    mono = torch.tensor(wav.mean(axis=1) if wav.ndim == 2 else wav, dtype=torch.float32)
    mono = AF.resample(mono, sr, 48000).numpy()
    inp = proc(text=[text], audio=[mono], sampling_rate=48000, return_tensors='pt', padding=True).to(dev)
    with torch.no_grad():
        o = clap(**inp)
    return float(o.logits_per_audio[0, 0])

report = {}
for name, (prompt, dur) in SFX.items():
    if only and name not in only:
        continue
    best = None
    for i in range(N):
        g = torch.Generator(dev).manual_seed(1000 + i * 77 + len(name))
        audio = pipe(prompt, negative_prompt=NEG, num_inference_steps=100, audio_end_in_s=max(dur, 1.0),
                     num_waveforms_per_prompt=1, generator=g).audios[0]
        wav = audio.T.float().cpu().numpy()[: int(dur * sr)]
        s = clap_score(wav, prompt)
        peak = float(np.abs(wav).max())
        print(f'{name} cand{i} clap={s:.2f} peak={peak:.3f}', flush=True)
        sf.write(f'{OUT}/{name}_c{i}.wav', wav, sr)
        if peak > 0.02 and (best is None or s > best[0]):
            best = (s, i)
    report[name] = {'best': best[1] if best else 0, 'score': best[0] if best else None}
    sf.write(f'{OUT}/{name}.wav', sf.read(f'{OUT}/{name}_c{report[name]["best"]}.wav')[0], sr)
json.dump(report, open(f'{OUT}/report.json', 'w'), indent=1)
print('DONE', json.dumps(report))
