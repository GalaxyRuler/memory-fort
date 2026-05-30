import re

data = open('/tmp/p.txt', encoding='utf-8', errors='replace').read()
total = len(data.encode('utf-8'))
fence = chr(96) * 3
blocks = re.findall(fence + r'markdown\n(.*?)\n' + fence, data, re.DOTALL)
raw_bytes = sum(len(b.encode('utf-8')) for b in blocks)
print(f'total prompt: {total:,} bytes')
print(f'raw content blocks: {len(blocks)} blocks, {raw_bytes:,} bytes')
print(f'cap (totalMaxBytes): 200,000')
if raw_bytes > 220000:
    print(f'>>> VIOLATION: raw is {raw_bytes/200000:.1f}x the cap')
else:
    print('cap respected for raw; bloat is elsewhere')
if blocks:
    sizes = sorted((len(b.encode('utf-8')) for b in blocks), reverse=True)
    print(f'biggest 3 blocks (bytes): {sizes[:3]}')
    print(f'block count > 10KB: {sum(1 for s in sizes if s > 10000)}')
