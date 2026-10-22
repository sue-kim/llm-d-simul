#!/usr/bin/env python3
"""Generate the supported deployment snapshot from the pinned BLIS catalog."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / '.runtime/blis-catalog'
lock = json.loads((ROOT / 'blis.lock.json').read_text())
commit = lock['repositories']['blis-catalog']['commit']
actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CATALOG, text=True).strip()
if actual != commit:
    raise RuntimeError('Catalog checkout does not match blis.lock.json')

# This is an intentionally bounded support list, not every entry in the catalog.
# Add a combination only after scripts/verify-deployments.mjs completes on both policies.
model_labels = [
    ('llama-3.1-8b-instruct', 'Llama 3.1 8B Instruct'),
    ('qwen2.5-7b-instruct', 'Qwen 2.5 7B Instruct'),
    ('qwen3-14b', 'Qwen3 14B'),
]
hardware_labels = [('a100-80', 'A100'), ('h100', 'H100'), ('h200', 'H200')]
context_limit = 32768
models = []
for model_id, label in model_labels:
    config = json.loads((CATALOG / 'models' / model_id / 'config.json').read_text())
    if config.get('torch_dtype', config.get('dtype')) != 'bfloat16':
        raise RuntimeError(f'{model_id}: this integration requires a BF16 checkpoint')
    if config['max_position_embeddings'] < context_limit:
        raise RuntimeError(f'{model_id}: native context is below the common engine limit')
    models.append(dict(id=model_id, label=label,
                       nativeContextTokens=config['max_position_embeddings'],
                       hardwareIds=[gpu_id for gpu_id, _ in hardware_labels]))
hardware = []
for gpu_id, label in hardware_labels:
    # Read this one top-level numeric scalar; refuse other YAML representations.
    source = (CATALOG / 'hardware' / f'{gpu_id}.yaml').read_text()
    values = re.findall(r'^MemoryGiB:\s*([0-9]+(?:\.[0-9]+)?)\s*$', source, flags=re.MULTILINE)
    if len(values) != 1:
        raise RuntimeError(f'{gpu_id}: expected one numeric MemoryGiB declaration')
    hardware.append(dict(id=gpu_id, label=f'NVIDIA {label}', shortLabel=label,
                         memoryGiB=float(values[0])))
networks = []
for network_id, label in [('ib-400g', 'InfiniBand 400 Gb/s'), ('roce-200g', 'RoCE 200 Gb/s'), ('ethernet-100gbe', 'Ethernet 100 Gb/s')]:
    source = (CATALOG / 'networks' / f'{network_id}.yaml').read_text()
    values = re.findall(r'^InterNodeBwGBps:\s*([0-9]+(?:\.[0-9]+)?)\s*$', source, flags=re.MULTILINE)
    if len(values) != 1:
        raise RuntimeError(f'{network_id}: expected one numeric bandwidth declaration')
    networks.append(dict(id=network_id, label=label, bandwidthGBps=float(values[0])))
snapshot = dict(catalogCommit=commit, precision='BF16', contextLimit=context_limit,
                gpusPerInstance=1, models=models, hardware=hardware, networks=networks)
(ROOT / 'cmd/server/deployments.json').write_text(json.dumps(snapshot, indent=2) + '\n')
print(f'Updated {len(models)} models and {len(hardware)} GPUs from catalog {commit[:12]}.')
