from pathlib import Path
import sqlite3

root = Path(r'C:\MCP\ArtForge-AI-Cloud')
backup = (root / 'evidence/gateway-before-stats.sql').read_text(encoding='utf8')
migrations = sorted((root / 'worker/migrations').glob('*.sql'))
source = sqlite3.connect(':memory:')
source.executescript(backup)
tables = ['access_codes', 'ownership', 'code_exchanges']
before = {t: source.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in tables}
source.executescript(migrations[-1].read_text(encoding='utf8'))
assert before == {t: source.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in tables}
assert source.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
restored = sqlite3.connect(':memory:')
restored.executescript(backup)
assert before == {t: restored.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in tables}
assert 'is_test' not in [r[1] for r in restored.execute('PRAGMA table_info(access_codes)')]
clean = sqlite3.connect(':memory:')
for file in migrations:
    clean.executescript(file.read_text(encoding='utf8'))
assert clean.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
print('Clean migration, representative upgrade, original row counts, integrity and backup restore PASS')
