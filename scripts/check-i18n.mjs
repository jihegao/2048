import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const zh = JSON.parse(await readFile(path.join(root, 'src/i18n/zh-CN.json'), 'utf8'));
const en = JSON.parse(await readFile(path.join(root, 'src/i18n/en.json'), 'utf8'));

function flatten(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child)
      ? flatten(child, next)
      : [next];
  });
}

const zhKeys = flatten(zh).sort();
const enKeys = flatten(en).sort();
const errors = [];
const getValue = (source, key) => key.split('.').reduce((value, part) => value?.[part], source);
for (const key of zhKeys) if (!enKeys.includes(key)) errors.push(`英文缺少翻译键: ${key}`);
for (const key of enKeys) if (!zhKeys.includes(key)) errors.push(`中文缺少翻译键: ${key}`);
for (const key of zhKeys) {
  if (typeof getValue(zh, key) !== 'string' || getValue(zh, key).trim() === '') {
    errors.push(`中文翻译为空或不是文本: ${key}`);
  }
  if (typeof getValue(en, key) !== 'string' || getValue(en, key).trim() === '') {
    errors.push(`英文翻译为空或不是文本: ${key}`);
  }
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(target)));
    else if (/\.(ts|tsx)$/u.test(entry.name)) files.push(target);
  }
  return files;
}

for (const file of await sourceFiles(path.join(root, 'src'))) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/\bt\(\s*['"]([^'"`]+)['"]/gu)) {
    if (!match[1].includes('${') && !zhKeys.includes(match[1])) {
      errors.push(`${path.relative(root, file)} 使用不存在的翻译键: ${match[1]}`);
    }
  }
  if (file.endsWith('.tsx')) {
    let jsxOnly = source;
    for (let pass = 0; pass < 12; pass += 1) jsxOnly = jsxOnly.replace(/\{[^{}]*\}/gsu, '');
    for (const match of jsxOnly.matchAll(/>\s*([A-Za-z\u4e00-\u9fff][^<{]*)\s*</gu)) {
      if (!/^\s*(VS)?\s*$/u.test(match[1])) {
        const line = jsxOnly.slice(0, match.index).split(/\r?\n/u).length;
        errors.push(
          `${path.relative(root, file)}:${line} 存在未国际化的界面文本: ${match[1].trim()}`,
        );
      }
    }
    for (const match of source.matchAll(
      /\b(?:aria-label|alt|placeholder|title)\s*=\s*["']([A-Za-z\u4e00-\u9fff][^"']*)["']/gu,
    )) {
      const line = source.slice(0, match.index).split(/\r?\n/u).length;
      errors.push(
        `${path.relative(root, file)}:${line} 存在未国际化的界面属性: ${match[1].trim()}`,
      );
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`i18n check passed: ${zhKeys.length} keys in each locale\n`);
