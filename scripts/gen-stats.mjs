#!/usr/bin/env node
/* =====================================================================
   构建期生成 GitHub 统计卡（静态 SVG）
   ---------------------------------------------------------------------
   为什么这么做：
   原本 <img> 直接指向 github-stats-extended.vercel.app。该域名在 *.vercel.app
   段内，中国大陆常遭 DNS 污染，直接解析失败 —— 境内用户必然看到 fallback。
   改为在构建时把 SVG 拉下来落盘，运行时只读本站静态资源：
     - 彻底消灭 *.vercel.app 运行时依赖（DNS 污染问题消失）
     - 零运行时密钥、零服务端函数、部署形态仍是纯静态
     - 产物吃 vercel.json 里现成的 immutable 长缓存

   失败策略（重要）：
   GitHub 统计服务抽风时**不能让构建失败**，否则整站发不上去。所以任一张卡
   拉取失败时沿用仓库里已提交的那份产物，并在日志里明确告警。

   用法：
     node scripts/gen-stats.mjs            # 生成/更新
     node scripts/gen-stats.mjs --check    # 只校验现有产物是否可用，不写文件
   ===================================================================== */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');
const TIMEOUT_MS = 20000;

/* 输出目录：默认 scripts/ 上一级的 assets/；用 --out=DIR 覆盖。
   AboutHali 站点用默认 assets/，profile README 仓库用 --out=assets/readme。 */
const outArg = process.argv.find(a => a.startsWith('--out='));
const OUT_DIR = outArg ? resolve(ROOT, outArg.slice(6)) : resolve(ROOT, 'assets');

/* 参数必须与线上历史完全一致，否则卡片样式/字段会对不上 */
const BASE = 'https://github-stats-extended.vercel.app';
const CARDS = [
    {
        file: 'gh-stats.svg',
        url: `${BASE}/api?username=haliChina&show_icons=true&theme=tokyonight&hide_border=true`,
        label: 'GitHub Stats',
    },
    {
        file: 'gh-langs.svg',
        url: `${BASE}/api/top-langs/?username=haliChina&layout=compact&theme=tokyonight&hide_border=true`,
        label: 'Top Languages',
    },
];

async function fetchSvg(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            redirect: 'follow',
            headers: {
                // 显式 UA：部分 CDN 对默认 UA 返回 403
                'User-Agent': 'Mozilla/5.0 (compatible; abouthali-build/1.0)',
                Accept: 'image/svg+xml,*/*',
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!isValidSvg(text)) throw new Error('响应不是有效 SVG（可能被拦截或返回了 HTML）');
        return text;
    } finally {
        clearTimeout(timer);
    }
}

function isValidSvg(text) {
    if (!text) return false;
    const t = text.trim();
    return t.startsWith('<svg') && /<\/svg>\s*$/i.test(t);
}

async function existing(file) {
    const p = resolve(OUT_DIR, file);
    if (!existsSync(p)) return null;
    return readFile(p, 'utf8');
}

async function main() {
    if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

    if (CHECK_ONLY) {
        let bad = 0;
        for (const c of CARDS) {
            const cur = await existing(c.file);
            const ok = isValidSvg(cur);
            console.log(`${ok ? 'OK  ' : 'BAD '} ${c.file}${cur ? ` (${cur.length}B)` : ' (missing)'}`);
            if (!ok) bad++;
        }
        process.exit(bad ? 1 : 0);
    }

    let failed = 0;
    for (const c of CARDS) {
        const outPath = resolve(OUT_DIR, c.file);
        try {
            const svg = await fetchSvg(c.url);
            await writeFile(outPath, svg, 'utf8');
            console.log(`✓ ${c.file}  ${svg.length}B  ${c.label}`);
        } catch (err) {
            failed++;
            const prev = await existing(c.file);
            if (isValidSvg(prev)) {
                console.warn(
                    `⚠ ${c.file} 拉取失败（${err.message}）——沿用仓库中已提交的版本（${prev.length}B），构建继续。`
                );
            } else {
                // 关键：回退也必须校验，否则会把一个损坏/被污染的产物当成"历史版本"
                // 继续用下去，掩盖问题。
                console.error(
                    `✗ ${c.file} 拉取失败（${err.message}）` +
                    (prev ? `，且仓库中的历史产物已损坏（${prev.length}B，非有效 SVG）` : '，且仓库中没有历史产物可回退')
                );
                console.error('  站内该图将走 onerror 兜底卡片，不影响构建；建议手动补一张再提交。');
            }
        }
    }

    if (failed) {
        console.warn(`\n共 ${failed} 张卡未更新（构建仍会成功）。`);
    } else {
        console.log('\n全部卡片已更新，记得 git add assets/gh-*.svg 一起提交。');
    }
}

main().catch((e) => {
    console.error('gen-stats 异常:', e && e.message);
    process.exit(0); // 绝不因统计卡失败而中断构建
});