from pathlib import Path
import json
import re

root = Path(__file__).resolve().parents[1]
migration = json.loads((root / 'packages/owner-services/migration.json').read_text())
names = {Path(old).stem: new for old, new in migration['imports'].items()}
for old in migration['remove']:
    target = root / 'packages/owner-services/src/maintained' / Path(old).name
    if not target.is_file():
        raise RuntimeError(f'Maintained controller missing: {target.relative_to(root)}')

changed = []
for folder in ('src', 'test', 'scripts'):
    for file in (root / 'apps/desktop' / folder).rglob('*'):
        if file.suffix not in ('.ts', '.cts', '.mjs') or 'renderer' in file.parts:
            continue
        if file.relative_to(root).as_posix() in migration['remove']:
            continue
        original = file.read_text()
        content = original
        for name, destination in names.items():
            for prefix in ('./', '../src/', '../dist/'):
                for quote in ('"', "'"):
                    content = content.replace(f'{quote}{prefix}{name}.js{quote}', f'{quote}{destination}{quote}')
            pattern = rf'await import\(\s*path\.join\(\s*(?:desktop|dist),\s*"(?:dist/)?{re.escape(name)}\.js"\s*\)\s*\)'
            content = re.sub(pattern, f'await import("{destination}")', content)
        if content != original:
            file.write_text(content)
            changed.append(file.relative_to(root).as_posix())

for old in migration['remove']:
    (root / old).unlink(missing_ok=True)

for relative in ('tsconfig.json', 'apps/desktop/tsconfig.json', 'apps/headless/tsconfig.json'):
    file = root / relative
    data = json.loads(file.read_text())
    reference = {'path': 'packages/owner-services' if relative == 'tsconfig.json' else '../../packages/owner-services'}
    if reference not in data['references']:
        data['references'].insert(-1, reference)
    file.write_text(json.dumps(data, indent=2) + '\n')

for application in ('desktop', 'headless'):
    file = root / f'apps/{application}/package.json'
    data = json.loads(file.read_text())
    data['dependencies']['@domo/owner-services'] = '*'
    file.write_text(json.dumps(data, indent=2) + '\n')

file = root / 'vitest.config.ts'
content = file.read_text()
aliases = ''.join(f'      "{destination}": p("packages/owner-services/src/maintained/{name}.ts"),\n' for name, destination in names.items())
aliases += '      "@domo/owner-services": p("packages/owner-services/src/index.ts"),\n'
if '"@domo/owner-services"' not in content:
    content = content.replace('    alias: {\n', '    alias: {\n' + aliases)
file.write_text(content)

file = root / 'apps/desktop/scripts/copy-renderer.mjs'
content = file.read_text()
copy = 'fs.copyFileSync(path.join(dir, "../../../packages/owner-services/dist/maintained/onboardingExampleCatalog.js"), path.join(dir, "../dist/onboardingExampleCatalog.js"));\n'
if copy not in content:
    content = content.replace('fs.cpSync(src, dest, { recursive: true });\n', 'fs.cpSync(src, dest, { recursive: true });\n' + copy)
file.write_text(content)

file = root / 'apps/desktop/test/copyRenderer.test.ts'
content = file.read_text()
fixture = '  fs.mkdirSync(path.join(root, "packages/owner-services/dist/maintained"), { recursive: true });\n  fs.writeFileSync(path.join(root, "packages/owner-services/dist/maintained/onboardingExampleCatalog.js"), "export const pluginExamples = () => [];\\n");\n'
if fixture not in content:
    content = content.replace('  // The script reads a renderer', fixture + '  // The script reads a renderer')
file.write_text(content)
print(json.dumps({'migratedControllers': len(names), 'updatedCallers': changed}))
