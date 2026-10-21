"""Make a seamless loop: tail (last `xf` s, fading out) mixed over the faded-in head.
Usage: python loop.py in.wav out.wav [crossfade_seconds]"""
import sys
import numpy as np
import soundfile as sf

src, dst = sys.argv[1], sys.argv[2]
xf = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
x, sr = sf.read(src, always_2d=True)
n = int(xf * sr)
body = x[:-n].copy()
ramp = np.linspace(0.0, 1.0, n)[:, None]
# equal-power crossfade: loop point is where the tail started, so it wraps cleanly
body[:n] = body[:n] * np.sin(ramp * np.pi / 2) + x[-n:] * np.cos(ramp * np.pi / 2)
sf.write(dst, body, sr)
