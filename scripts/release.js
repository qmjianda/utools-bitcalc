#!/usr/bin/env node
'use strict';

/**
 * bitcalc 发布打包脚本
 *
 * 只把运行必需的文件复制到 dist/bitcalc，并生成同名 zip。
 * 开发文件（tests/、.opencode/、.agents/、package.json、DESIGN.md 等）
 * 不会进入发行包；校验不通过时不会生成 zip。
 *
 * 用法：npm run release
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const APP_ID = 'bitcalc';
const PACKAGE_DIR = path.join(DIST_DIR, APP_ID);

/** 打包白名单：发行包 == 以下文件，新增文件必须显式加入。 */
const MANIFEST = [
  'plugin.json',
  'index.html',
  'logo.png',
  'preload.js',
  'styles.css',
  'src/core.js',
  'src/app.js',
  'src/theme-init.js',
];

/** 发行包中不允许出现的目录名。 */
const FORBIDDEN_DIR_NAMES = new Set([
  '.git',
  '.github',
  '.vscode',
  '.idea',
  '.opencode',
  '.agents',
  'node_modules',
  'tests',
  'test',
  '__tests__',
  '__pycache__',
]);

/** 发行包中不允许出现的文件类型。 */
const FORBIDDEN_EXT = new Set([
  '.pyc',
  '.map',
  '.md',
  '.csv',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.jsc',
  '.log',
  '.bak',
  '.zip',
  '.ts',
  '.py',
]);

/** preload 允许 require 的裸模块（其余必须随包提交或为 node: 内置）。 */
const ALLOWED_BARE_REQUIRES = new Set(['electron']);

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function formatSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function stageFiles() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(PACKAGE_DIR, { recursive: true });

  for (const relative of MANIFEST) {
    const source = path.join(ROOT, relative);
    if (!fs.existsSync(source)) {
      fail(`缺少源文件：${relative}`);
      continue;
    }
    const target = path.join(PACKAGE_DIR, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function validatePluginJson(packaged) {
  const file = path.join(PACKAGE_DIR, 'plugin.json');
  if (!fs.existsSync(file)) return;

  let plugin;
  try {
    plugin = JSON.parse(readText(file));
  } catch (error) {
    fail(`plugin.json 不是合法 JSON：${error.message}`);
    return;
  }

  if (typeof plugin.main !== 'string' || !plugin.main.toLowerCase().endsWith('.html')) {
    fail('plugin.json 的 main 必须是包内 .html 文件');
  } else if (!packaged.includes(plugin.main)) {
    fail(`plugin.json 的 main 指向不存在的文件：${plugin.main}`);
  }

  if (plugin.logo && !packaged.includes(plugin.logo)) {
    fail(`plugin.json 的 logo 指向不存在的文件：${plugin.logo}`);
  }

  if (plugin.preload && !packaged.includes(plugin.preload)) {
    fail(`plugin.json 的 preload 指向不存在的文件：${plugin.preload}`);
  }

  if (!Array.isArray(plugin.features) || plugin.features.length === 0) {
    fail('plugin.json 缺少 features');
    return;
  }

  for (const feature of plugin.features) {
    if (!feature || typeof feature.code !== 'string' || !feature.code) {
      fail('plugin.json 的 feature 缺少 code');
    }
    if (!feature || !Array.isArray(feature.cmds) || feature.cmds.length === 0) {
      fail(`plugin.json 的 feature（${(feature && feature.code) || '?'}）缺少 cmds`);
    }
  }
}

function validatePreload() {
  const file = path.join(PACKAGE_DIR, 'preload.js');
  if (!fs.existsSync(file)) return;

  const source = readText(file);
  const longest = source
    .split(/\r?\n/)
    .reduce((max, line) => Math.max(max, line.length), 0);
  if (longest > 500) {
    fail(`preload.js 单行 ${longest} 字符，疑似被压缩或打包`);
  }
  if (/\b_0x[0-9a-f]{4}\b/i.test(source)) {
    fail('preload.js 疑似被混淆（检测到 _0x 变量名）');
  }

  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => match[1]
  );
  for (const moduleName of requires) {
    if (moduleName.startsWith('.') || moduleName.startsWith('node:')) continue;
    if (ALLOWED_BARE_REQUIRES.has(moduleName)) continue;
    if (fs.existsSync(path.join(ROOT, 'node_modules', moduleName))) {
      fail(`preload.js 依赖的 npm 包 ${moduleName} 未随包提交`);
      continue;
    }
    fail(`preload.js 引用了未声明/未提交的模块：${moduleName}`);
  }
}

function validateTextFiles(files) {
  const textExt = new Set(['.js', '.html', '.css', '.json']);
  for (const file of files) {
    if (!textExt.has(path.extname(file).toLowerCase())) continue;
    const source = readText(file);
    if (/[A-Za-z]:[\\/](?:Users|Project|Projects|Desktop)[\\/]/.test(source)) {
      fail(`发行包文件包含开发机绝对路径：${toPosix(path.relative(PACKAGE_DIR, file))}`);
    }
  }
}

function validateHtmlRefs() {
  const file = path.join(PACKAGE_DIR, 'index.html');
  if (!fs.existsSync(file)) return;

  const html = readText(file);
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(
    (match) => match[1]
  );
  for (const ref of refs) {
    if (
      ref.startsWith('#') ||
      ref.startsWith('data:') ||
      ref.startsWith('mailto:') ||
      /^(?:https?:)?\/\//.test(ref)
    ) {
      continue;
    }
    const localPath = ref.split('?')[0].split('#')[0];
    if (localPath && !fs.existsSync(path.join(PACKAGE_DIR, localPath))) {
      fail(`index.html 引用的本地文件不在发行包中：${localPath}`);
    }
  }
}

function validatePackage() {
  const files = walk(PACKAGE_DIR);
  const packaged = files.map((file) => toPosix(path.relative(PACKAGE_DIR, file)));

  for (const relative of packaged) {
    if (!MANIFEST.includes(relative)) {
      fail(`发行包出现白名单外文件：${relative}`);
    }
    for (const segment of relative.split('/')) {
      if (FORBIDDEN_DIR_NAMES.has(segment)) {
        fail(`发行包出现禁用目录：${relative}`);
      }
    }
    if (FORBIDDEN_EXT.has(path.extname(relative).toLowerCase())) {
      fail(`发行包出现禁用类型文件：${relative}`);
    }
  }

  for (const relative of MANIFEST) {
    if (!packaged.includes(relative)) fail(`发行包缺少必需文件：${relative}`);
  }

  validatePluginJson(packaged);
  validatePreload();
  validateTextFiles(files);
  validateHtmlRefs();

  const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  return { count: files.length, bytes };
}

function hasZipCommand() {
  const result = spawnSync('zip', ['-v'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function createZip(version) {
  const zipName = `${APP_ID}-v${version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);

  if (hasZipCommand()) {
    const result = spawnSync('zip', ['-r', '-q', zipName, APP_ID], {
      cwd: DIST_DIR,
      stdio: 'inherit',
    });
    if (result.status === 0) return zipName;
    warn('zip 命令执行失败，改用 PowerShell 压缩');
  }

  if (process.platform === 'win32') {
    const script = [
      `Compress-Archive -LiteralPath '${PACKAGE_DIR.replace(/'/g, "''")}'`,
      `-DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ].join(' ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'inherit',
    });
    if (result.status === 0 && fs.existsSync(zipPath)) return zipName;
    warn('PowerShell Compress-Archive 执行失败');
  }

  warn('未找到可用的压缩工具，请手动压缩 dist/bitcalc');
  return null;
}

function main() {
  const pkgFile = path.join(ROOT, 'package.json');
  const version = fs.existsSync(pkgFile) ? JSON.parse(readText(pkgFile)).version || '0.0.0' : '0.0.0';

  console.log(`bitcalc 发布打包：v${version}`);
  stageFiles();

  const summary = validatePackage();

  if (errors.length > 0) {
    console.error('\n校验未通过，未生成 zip：');
    for (const message of errors) console.error(`  x ${message}`);
    process.exitCode = 1;
    return;
  }

  const zipName = createZip(version);

  console.log(`\nOK 发行目录：dist/${APP_ID}/（${summary.count} 个文件，${formatSize(summary.bytes)}）`);
  if (zipName) console.log(`OK 压缩包：dist/${zipName}`);
  for (const message of warnings) console.log(`  ! ${message}`);

  console.log('\n提交审核时上传 dist/' + APP_ID + ' 目录或对应 zip，不要上传仓库根目录。');
  console.log('已排除：tests/、.opencode/、.agents/、package.json、DESIGN.md、skills-lock.json 等开发文件。');
}

main();
