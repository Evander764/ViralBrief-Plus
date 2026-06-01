#!/usr/bin/env node
/**
 * Build a lightweight macOS .app bundle.
 *
 * The app is a small launcher around the existing local Node service. It keeps
 * user data outside the bundle under ~/Library/Application Support/Viral Brief,
 * so app upgrades do not overwrite the local database or encrypted API key.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const appName = 'Viral Brief Plus';
const productSlug = 'viral-brief-plus';
const versionTag = `${pkg.version}-${stamp}`;
const distDir = join(ROOT, 'dist');
const macDir = join(distDir, 'mac');
const releasesDir = join(distDir, 'releases');
const appBundle = join(macDir, `${appName}.app`);
const contentsDir = join(appBundle, 'Contents');
const macosDir = join(contentsDir, 'MacOS');
const resourcesDir = join(contentsDir, 'Resources');
const bundledAppDir = join(resourcesDir, 'app');

const signIdentity = (process.env.VBP_MAC_SIGN_IDENTITY || '').trim();
const shouldNotarize = parseEnvFlag(process.env.VBP_MAC_NOTARIZE);
const notaryKeyPath = (process.env.VBP_NOTARY_KEY_PATH || '').trim();
const notaryKeyId = (process.env.VBP_NOTARY_KEY_ID || '').trim();
const notaryIssuerId = (process.env.VBP_NOTARY_ISSUER_ID || '').trim();

const excludes = new Set([
  '.git',
  '.chrome-data',
  '.claude',
  '.DS_Store',
  'data',
  'dist',
  'node_modules',
]);

function shouldCopy(src) {
  const rel = relative(ROOT, src);
  const [top] = rel.split('/');
  return rel && !excludes.has(top) && !rel.endsWith('.log');
}

function parseEnvFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function requireReleaseInputs() {
  if (shouldNotarize && !signIdentity) {
    throw new Error('VBP_MAC_NOTARIZE=1 requires VBP_MAC_SIGN_IDENTITY with a Developer ID Application certificate name.');
  }
  if (shouldNotarize) {
    const missing = [
      ['VBP_NOTARY_KEY_PATH', notaryKeyPath],
      ['VBP_NOTARY_KEY_ID', notaryKeyId],
      ['VBP_NOTARY_ISSUER_ID', notaryIssuerId],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`VBP_MAC_NOTARIZE=1 is missing required notary input(s): ${missing.join(', ')}.`);
    }
  }
}

function copyProject() {
  mkdirSync(bundledAppDir, { recursive: true });
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'README.md', '.env.example', '.gitignore', 'package.json']) {
    const src = join(ROOT, name);
    if (existsSync(src)) cpSync(src, join(bundledAppDir, name), { recursive: true });
  }
  for (const name of ['extension', 'scripts', 'server', 'skills', 'test', 'web']) {
    const src = join(ROOT, name);
    if (existsSync(src) && shouldCopy(src)) cpSync(src, join(bundledAppDir, name), { recursive: true });
  }
}

function writeInfoPlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>ViralBrief</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>local.viralbrief.app.v3</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${pkg.version}</string>
  <key>CFBundleVersion</key>
  <string>${stamp}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
  writeFileSync(join(contentsDir, 'Info.plist'), plist);
}

function writeLauncher() {
  const launcher = `#!/bin/zsh
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
APP_SUPPORT_DIR="$HOME/Library/Application Support/Viral Brief Plus"
LOG_DIR="$HOME/Library/Logs/Viral Brief Plus"
PORT="\${VBP_PORT:-\${VB_PORT:-8787}}"
URL="http://127.0.0.1:\${PORT}"

mkdir -p "$APP_SUPPORT_DIR" "$LOG_DIR"
export VBP_DATA_DIR="\${VBP_DATA_DIR:-\${VB_DATA_DIR:-$APP_SUPPORT_DIR}}"
export VBP_OPEN_BROWSER="false" # 阻止 Node 端在默认浏览器中弹窗，完全使用原生 WebKit 窗口

# 如果服务已经在运行，直接启动原生窗口并退出
if command -v curl >/dev/null 2>&1 && curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  "$(dirname "$0")/ViralBriefWindow"
  exit 0
fi

export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [[ -x "${process.execPath}" ]]; then
  NODE_BIN="${process.execPath}"
fi

if [[ -z "$NODE_BIN" ]]; then
  osascript -e 'display alert "Viral Brief Plus 需要 Node.js" message "请先安装 Node.js 22.5 或更高版本，然后重新打开应用。" as critical'
  exit 1
fi

NODE_OK="$("$NODE_BIN" -e 'const [M,m]=process.versions.node.split(".").map(Number); process.stdout.write(M>22||M===22&&m>=5?"1":"0")')"
if [[ "$NODE_OK" != "1" ]]; then
  NODE_VER="$("$NODE_BIN" -v)"
  osascript -e "display alert \\"Node.js 版本过低\\" message \\"当前版本：$NODE_VER。Viral Brief Plus 需要 Node.js 22.5 或更高版本。\\" as critical"
  exit 1
fi

cd "$APP_ROOT"
LOG_FILE="$LOG_DIR/app-$(date +%Y%m%d).log"

# 后台启动 Node 服务器并记录 PID
"$NODE_BIN" --disable-warning=ExperimentalWarning server/index.js >> "$LOG_FILE" 2>&1 &
NODE_PID=$!

# 退出时清理后台进程
cleanup() {
  kill "$NODE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 启动 100% 原生 Cocoa/Swift UI 窗口并阻塞
"$(dirname "$0")/ViralBriefWindow"
`;
  const launcherPath = join(macosDir, 'ViralBrief');
  writeFileSync(launcherPath, launcher);
  chmodSync(launcherPath, 0o755);
}

function writeReadme() {
  const distributionNote = signIdentity
    ? `- 此包已使用证书签名：${signIdentity}。\n${shouldNotarize ? '- 此包会在打包流程中提交 Apple 公证，公证通过后适合发布给普通用户。' : '- 此包尚未启用 Apple 公证；公开发布前请设置 VBP_MAC_NOTARIZE=1 重新打包。'}`
    : '- 这是本地开发包，尚未签名或公证；从网络下载后 macOS 可能会拦截。公开发给普通用户前，请使用 Developer ID 签名并完成 Apple 公证。';
  const text = `Viral Brief Plus for macOS

版本：${pkg.version}
打包时间：${new Date().toISOString()}

打开方式：
1. 双击 Viral Brief Plus.app。
2. 应用会启动本地服务并打开 http://127.0.0.1:8787。
3. 本地数据保存在 ~/Library/Application Support/Viral Brief Plus。
4. 日志保存在 ~/Library/Logs/Viral Brief Plus。

运行要求：
- macOS 12 或更高版本。
- Node.js 22.5 或更高版本。

安全说明：
- API Key、数据库、截图和导出文件都不会写入应用包。
- 服务仍只监听 127.0.0.1。
${distributionNote}
`;
  writeFileSync(join(resourcesDir, 'README.txt'), text);
}

function signApp() {
  if (!signIdentity) {
    console.warn('WARNING: VBP_MAC_SIGN_IDENTITY is not set. Building an unsigned local development app.');
    return { signed: false, sign_identity: '' };
  }

  console.log(`Signing macOS app with identity: ${signIdentity}`);
  const timestampArgs = signIdentity === '-' ? [] : ['--timestamp'];
  run('codesign', [
    '--force',
    '--deep',
    '--options',
    'runtime',
    ...timestampArgs,
    '--sign',
    signIdentity,
    appBundle,
  ]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
  return { signed: true, sign_identity: signIdentity };
}

function notarizeApp() {
  if (!shouldNotarize) return { notarized: false };

  const notaryZip = join(releasesDir, `${appName}-${versionTag}-notary.zip`);
  rmSync(notaryZip, { force: true });
  console.log('Creating temporary notarization archive...');
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, notaryZip]);

  console.log('Submitting app to Apple notary service...');
  run('xcrun', [
    'notarytool',
    'submit',
    notaryZip,
    '--key',
    notaryKeyPath,
    '--key-id',
    notaryKeyId,
    '--issuer',
    notaryIssuerId,
    '--wait',
  ]);

  console.log('Stapling notarization ticket...');
  run('xcrun', ['stapler', 'staple', appBundle]);
  run('xcrun', ['stapler', 'validate', appBundle]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appBundle]);
  rmSync(notaryZip, { force: true });
  return { notarized: true };
}

function makeArchives(distribution) {
  const appZip = join(releasesDir, `${appName}-${versionTag}-mac.zip`);
  const sourceArchive = join(releasesDir, `${productSlug}-${versionTag}-source.tar.gz`);

  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, appZip]);
  run('tar', [
    '--exclude', './data',
    '--exclude', './dist',
    '--exclude', './node_modules',
    '--exclude', './.git',
    '--exclude', './.claude',
    '--exclude', './.chrome-data',
    '--exclude', './*.log',
    '-czf',
    sourceArchive,
    '.',
  ], { cwd: ROOT });

  const manifest = [
    `version=${pkg.version}`,
    `stamp=${stamp}`,
    `app_bundle=${appBundle}`,
    `app_zip=${appZip}`,
    `source_archive=${sourceArchive}`,
    `signed=${distribution.signed ? 'true' : 'false'}`,
    `sign_identity=${distribution.sign_identity || ''}`,
    `notarized=${distribution.notarized ? 'true' : 'false'}`,
    `notary_requested=${shouldNotarize ? 'true' : 'false'}`,
    'data_excluded=true',
    'node_modules_excluded=true',
  ].join('\n') + '\n';
  writeFileSync(join(releasesDir, `${productSlug}-${versionTag}-manifest.txt`), manifest);

  return { appBundle, appZip, sourceArchive };
}

function buildIcns(pngPath, outIcnsPath) {
  if (!existsSync(pngPath)) {
    console.log('No app_icon.png found in project root, skipping icon compilation.');
    return;
  }
  console.log('Compiling premium app icon with sips and iconutil...');
  const iconsetDir = join(ROOT, 'AppIcon.iconset');
  if (existsSync(iconsetDir)) rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });

  const sizes = [
    { size: 16, name: 'icon_16x16.png' },
    { size: 32, name: 'icon_16x16@2x.png' },
    { size: 32, name: 'icon_32x32.png' },
    { size: 64, name: 'icon_32x32@2x.png' },
    { size: 128, name: 'icon_128x128.png' },
    { size: 256, name: 'icon_128x128@2x.png' },
    { size: 256, name: 'icon_256x256.png' },
    { size: 512, name: 'icon_256x256@2x.png' },
    { size: 512, name: 'icon_512x512.png' },
    { size: 1024, name: 'icon_512x512@2x.png' }
  ];

  for (const item of sizes) {
    const dest = join(iconsetDir, item.name);
    execFileSync('sips', ['-s', 'format', 'png', '-z', item.size, item.size, pngPath, '--out', dest], { stdio: 'ignore' });
  }

  run('iconutil', ['-c', 'icns', iconsetDir, '-o', outIcnsPath]);
  rmSync(iconsetDir, { recursive: true, force: true });
}

requireReleaseInputs();
rmSync(appBundle, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
mkdirSync(releasesDir, { recursive: true });

// 编译原生的 Cocoa/Swift 桌面窗口程序
const swiftSrc = join(ROOT, 'scripts', 'LauncherWindow.swift');
const swiftOut = join(macosDir, 'ViralBriefWindow');
console.log('Compiling 100% native macOS Cocoa Window binary...');
run('swiftc', ['-O', swiftSrc, '-o', swiftOut]);

// 生成应用专属 AppIcon.icns
const pngIconPath = join(ROOT, 'app_icon.png');
const outIcnsPath = join(resourcesDir, 'AppIcon.icns');
buildIcns(pngIconPath, outIcnsPath);

copyProject();
writeInfoPlist();
writeLauncher();
writeReadme();
const signing = signApp();
const notarization = notarizeApp();
const outputs = makeArchives({ ...signing, ...notarization });

console.log(JSON.stringify(outputs, null, 2));
