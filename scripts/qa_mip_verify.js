// ============================================================
// QA 独立验证脚本（临时文件，验证后可删除）
//
// 从实际源码逐字复刻以下算法，独立验证修复正确性：
//  - src/pages/imageViewer/imageViewerCore.tsx :: selectMipLevel
//  - src-tauri/.../image_viewer_service.rs :: downscale_to_fit
//  - src-tauri/.../image_viewer_service.rs :: build_mip_chain (mip 链循环)
//
// 注意：本脚本不 import 任何源码，是「独立复刻 + 断言」，
//       目的是证明算法本身正确，而不是确认代码存在。
// ============================================================

// ---------- Rust 侧常量（逐字对应 image_viewer_service.rs） ----------
const MAX_CACHED_IMAGES = 4;
const MAX_MIP_LEVELS = 8;
const MIN_MIP_DIM = 256;
const MAX_MIP0_DIM = 8192;
const MAX_MIP0_PIXELS = 32_000_000;
const MAX_PIXELS = 400_000_000;

// ---------- 复刻 Rust::downscale_to_fit ----------
// fn downscale_to_fit(mut img, max_dim, max_pixels) -> DynamicImage
function downscaleToFit(w0, h0, maxDim, maxPixels) {
	let w = w0;
	let h = h0;
	const longest = Math.max(w, h);
	const pixels = w * h;

	const edgeScale = longest > maxDim ? maxDim / longest : 1.0;
	const pixelScale = pixels > maxPixels ? Math.sqrt(maxPixels / pixels) : 1.0;
	const scale = Math.min(edgeScale, pixelScale);
	if (scale >= 1.0) {
		return { w, h, halvings: 0, lanczos: false };
	}

	// Rust: ((w as f64 * scale).round() as u32).max(1)
	const targetW = Math.max(1, Math.round(w * scale));
	const targetH = Math.max(1, Math.round(h * scale));

	// 快速整数减半阶段: while w/2 >= target_w && h/2 >= target_h && w > 1 && h > 1
	let halvings = 0;
	while (
		Math.floor(w / 2) >= targetW &&
		Math.floor(h / 2) >= targetH &&
		w > 1 &&
		h > 1
	) {
		w = Math.max(1, Math.floor(w / 2));
		h = Math.max(1, Math.floor(h / 2));
		halvings++;
		if (halvings > 64) throw new Error("downscale_to_fit 整数减半疑似死循环");
	}

	if (w === targetW && h === targetH) {
		return { w, h, halvings, lanczos: false };
	}
	return { w: targetW, h: targetH, halvings, lanczos: true };
}

// ---------- 复刻 Rust::build_mip_chain 的 mip 链循环 ----------
function buildMipChain(origW, origH) {
	const pixels = origW * origH;
	if (pixels > MAX_PIXELS) {
		return {
			rejected: true,
			reason: `图片尺寸过大 (${origW}×${origH} = ${(pixels / 1e6).toFixed(1)} 百万像素)，超过当前支持上限 (${(MAX_PIXELS / 1e6).toFixed(0)} 百万像素)`,
		};
	}

	const base = downscaleToFit(origW, origH, MAX_MIP0_DIM, MAX_MIP0_PIXELS);
	let curW = base.w;
	let curH = base.h;

	const mips = [];
	let level = 0;
	let guard = 0;
	for (;;) {
		if (++guard > 1000) throw new Error("build_mip_chain loop 死循环");
		mips.push({ width: curW, height: curH, file_path: `mip_${level}.png` });

		level += 1;
		if (level >= MAX_MIP_LEVELS) break;
		if (curW <= MIN_MIP_DIM && curH <= MIN_MIP_DIM) break;

		const nextW = Math.max(1, Math.floor(curW / 2));
		const nextH = Math.max(1, Math.floor(curH / 2));
		if (nextW === curW && nextH === curH) break;
		curW = nextW;
		curH = nextH;
	}
	return { rejected: false, mips, base };
}

// ---------- 复刻 TS::selectMipLevel（反向遍历 + &&） ----------
function selectMipLevel(mips, renderW, renderH) {
	if (mips.length === 0) return { index: -1, width: 0, height: 0 };
	for (let i = mips.length - 1; i >= 0; i--) {
		const m = mips[i];
		if (m.width >= renderW && m.height >= renderH) {
			return { index: i, width: m.width, height: m.height };
		}
	}
	const largest = mips[0];
	return { index: 0, width: largest.width, height: largest.height };
}

// ---------- 复刻 TS::fitToWindow 的 fitScale ----------
function fitScale(imgW, imgH, viewW, viewH, rotation = 0) {
	const isSwapped = rotation % 180 !== 0;
	const ew = isSwapped ? imgH : imgW;
	const eh = isSwapped ? imgW : imgH;
	return Math.min(viewW / ew, viewH / eh) * 0.95;
}

// ============================================================
// 断言框架
// ============================================================
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
	if (cond) {
		pass++;
		console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ""}`);
	} else {
		fail++;
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function fmtMips(mips) {
	return mips.map((m, i) => `[${i}]${m.width}x${m.height}`).join(" ");
}

// ============================================================
// 场景 1：用户真实图 18334×14865，fit 到 1000×800 视口，dpr=1.5
// ============================================================
console.log("\n=== 场景 1: 真实故障图 18334×14865 → 视口 1000×800, dpr=1.5 ===");
{
	const W = 18334;
	const H = 14865;
	const chain = buildMipChain(W, H);
	check("未被 MAX_PIXELS 拒绝", !chain.rejected, `${(W * H / 1e6).toFixed(1)}MP < 400MP`);
	console.log(`  mip 链: ${fmtMips(chain.mips)}`);

	const m0 = chain.mips[0];
	check(
		"mip[0] 最长边 <= 8192",
		Math.max(m0.width, m0.height) <= MAX_MIP0_DIM,
		`最长边=${Math.max(m0.width, m0.height)}`,
	);
	check(
		"mip[0] 不再是全分辨率（修复前会是 18334×14865 → WebView2 全黑）",
		m0.width < W && m0.height < H,
		`${m0.width}×${m0.height} vs 原图 ${W}×${H}`,
	);

	const dpr = 1.5;
	const zoom = fitScale(W, H, 1000, 800);
	const dstW = W * zoom;
	const dstH = H * zoom;
	const sel = selectMipLevel(chain.mips, dstW * dpr, dstH * dpr);
	console.log(
		`  zoom=${zoom.toFixed(5)} 渲染需求=${Math.round(dstW * dpr)}×${Math.round(dstH * dpr)}`,
	);
	check(
		"选中的 mip index 不是 0",
		sel.index !== 0,
		`选中 mip[${sel.index}] ${sel.width}×${sel.height}`,
	);
	check(
		"选中的 mip 尺寸在 3000~6000 量级",
		sel.width >= 1000 && sel.width <= 6500,
		`宽=${sel.width}`,
	);
	check(
		"选中的 mip 能覆盖渲染需求（不会糊）",
		sel.width >= dstW * dpr && sel.height >= dstH * dpr,
		`${sel.width}×${sel.height} >= ${Math.round(dstW * dpr)}×${Math.round(dstH * dpr)}`,
	);
	// 证明它确实是「够用的最小」：下一级（更小）应该不够用
	if (sel.index + 1 < chain.mips.length) {
		const smaller = chain.mips[sel.index + 1];
		check(
			"再小一级就不够用（证明选的是最优 mip，非过大）",
			!(smaller.width >= dstW * dpr && smaller.height >= dstH * dpr),
			`mip[${sel.index + 1}] ${smaller.width}×${smaller.height} 不足`,
		);
	}
}

// ============================================================
// 场景 2：1920×1080 @ 100% zoom, dpr=1 → 应选 mip[0] 原生
// ============================================================
console.log("\n=== 场景 2: 1920×1080 @ 100% zoom, dpr=1 ===");
{
	const W = 1920;
	const H = 1080;
	const chain = buildMipChain(W, H);
	console.log(`  mip 链: ${fmtMips(chain.mips)}`);
	check(
		"mip[0] 未被缩放，保持 1:1 原生画质",
		chain.mips[0].width === W && chain.mips[0].height === H,
		`mip[0]=${chain.mips[0].width}×${chain.mips[0].height}`,
	);
	const sel = selectMipLevel(chain.mips, W * 1 * 1, H * 1 * 1);
	check("100% zoom 选中 mip[0]", sel.index === 0, `选中 mip[${sel.index}] ${sel.width}×${sel.height}`);
}

// ============================================================
// 场景 3：1920×1080 @ 25% zoom → 应选比 mip[0] 更小的级别
// ============================================================
console.log("\n=== 场景 3: 1920×1080 @ 25% zoom, dpr=1（修复前恒为 mip[0]）===");
{
	const W = 1920;
	const H = 1080;
	const chain = buildMipChain(W, H);
	const zoom = 0.25;
	const need = { w: W * zoom, h: H * zoom };
	const sel = selectMipLevel(chain.mips, need.w, need.h);
	console.log(`  mip 链: ${fmtMips(chain.mips)}  需求=${need.w}×${need.h}`);
	check(
		"选中比 mip[0] 更小的级别",
		sel.index > 0,
		`选中 mip[${sel.index}] ${sel.width}×${sel.height}`,
	);
	check(
		"选中的 mip 仍能覆盖需求",
		sel.width >= need.w && sel.height >= need.h,
		`${sel.width}×${sel.height} >= ${need.w}×${need.h}`,
	);
	// 对照：修复前的错误实现（正向遍历 + ||）
	function selectMipLevelBuggy(mips, renderW, renderH) {
		for (let i = 0; i < mips.length; i++) {
			if (mips[i].width >= renderW || mips[i].height >= renderH) {
				return { index: i, width: mips[i].width, height: mips[i].height };
			}
		}
		return { index: mips.length - 1 };
	}
	const buggy = selectMipLevelBuggy(chain.mips, need.w, need.h);
	check(
		"对照：旧实现确实恒返回 mip[0]（证明这是真实修复而非无意义改动）",
		buggy.index === 0 && sel.index !== buggy.index,
		`旧=mip[${buggy.index}] 新=mip[${sel.index}]`,
	);
}

// ============================================================
// 场景 4：8000×6000 (48MP) → mip[0] 最长边 <= 8192 且像素 <= 32MP
// ============================================================
console.log("\n=== 场景 4: 8000×6000 (48MP) ===");
{
	const W = 8000;
	const H = 6000;
	const chain = buildMipChain(W, H);
	const m0 = chain.mips[0];
	console.log(`  mip 链: ${fmtMips(chain.mips)}`);
	check(
		"mip[0] 最长边 <= 8192",
		Math.max(m0.width, m0.height) <= MAX_MIP0_DIM,
		`最长边=${Math.max(m0.width, m0.height)}（注意：本图最长边本就 8000<8192，触发限制的是像素预算）`,
	);
	check(
		"mip[0] 被像素预算压缩（48MP > 32MP）",
		m0.width * m0.height < W * H,
		`${m0.width}×${m0.height} = ${(m0.width * m0.height / 1e6).toFixed(1)}MP，原图 48.0MP`,
	);
	const overshoot = m0.width * m0.height - MAX_MIP0_PIXELS;
	check(
		"mip[0] 像素数约束在 32MP（允许 round() 带来的极小溢出）",
		overshoot <= 100_000,
		`实际 ${(m0.width * m0.height).toLocaleString()}，超出上限 ${overshoot} px`,
	);
	check(
		"宽高比保持（误差 < 0.5%）",
		Math.abs(m0.width / m0.height - W / H) / (W / H) < 0.005,
		`${(m0.width / m0.height).toFixed(4)} vs ${(W / H).toFixed(4)}`,
	);
}

// ============================================================
// 场景 5：25000×20000 (500MP) → Rust 端 MAX_PIXELS 拒绝
// ============================================================
console.log("\n=== 场景 5: 25000×20000 (500MP) → 应走 MAX_PIXELS 拒绝分支 ===");
{
	const chain = buildMipChain(25000, 20000);
	check("被 MAX_PIXELS 拒绝（返回 Err 字符串，前端显示错误而非黑屏）", chain.rejected === true);
	check(
		"错误信息包含可读的尺寸与上限说明",
		!!chain.reason && chain.reason.includes("500.0") && chain.reason.includes("400"),
		chain.reason,
	);
	// 边界：399MP 应通过
	const okChain = buildMipChain(20000, 19950); // 399.0MP
	check(
		"边界：399MP (20000×19950) 不被拒绝",
		okChain.rejected === false,
		`mip[0]=${okChain.mips[0].width}×${okChain.mips[0].height}`,
	);
}

// ============================================================
// 场景 6：全部 mip 都不够大（极端放大）→ 退化返回 index 0，不能是 -1
// ============================================================
console.log("\n=== 场景 6: 极端放大，所有 mip 都不够大 ===");
{
	const chain = buildMipChain(18334, 14865);
	const zoom = 20; // 前端 zoom 上限
	const dpr = 2;
	const need = { w: 18334 * zoom * dpr, h: 14865 * zoom * dpr };
	const sel = selectMipLevel(chain.mips, need.w, need.h);
	check(
		"退化返回 index 0，而不是 -1（-1 会让 renderToCanvas 直接 return → 黑屏）",
		sel.index === 0,
		`选中 mip[${sel.index}] ${sel.width}×${sel.height}`,
	);
	check("返回的宽高有效（>0），不会被 mipW<=0 提前 return", sel.width > 0 && sel.height > 0);

	// 空 mips 才允许 -1，且此时前端 scheduleRender 已提前 return
	const empty = selectMipLevel([], 100, 100);
	check("mips 为空时返回 -1（唯一允许的 -1 情形）", empty.index === -1);
}

// ============================================================
// 场景 7：mip 链循环健壮性 — 极端宽高比 / 奇数尺寸 / 1px 边
// ============================================================
console.log("\n=== 场景 7: mip 链循环健壮性（死循环 / 边界） ===");
{
	const cases = [
		[1, 1],
		[1, 20000],
		[20000, 1],
		[3, 7],
		[8193, 1],
		[19999, 14863], // 奇数宽高
		[65535, 6000],
		[257, 257],
		[256, 256],
	];
	let allOk = true;
	const notes = [];
	for (const [w, h] of cases) {
		let chain;
		try {
			chain = buildMipChain(w, h);
		} catch (e) {
			allOk = false;
			notes.push(`${w}x${h} 抛异常: ${e.message}`);
			continue;
		}
		if (chain.rejected) {
			notes.push(`${w}x${h} → 拒绝`);
			continue;
		}
		const mips = chain.mips;
		// 断言：级数 <= MAX_MIP_LEVELS
		if (mips.length > MAX_MIP_LEVELS) {
			allOk = false;
			notes.push(`${w}x${h} 级数 ${mips.length} 超过 ${MAX_MIP_LEVELS}`);
		}
		// 断言：严格递减（不能有两级尺寸完全相同 → 说明循环没进展）
		for (let i = 1; i < mips.length; i++) {
			if (mips[i].width === mips[i - 1].width && mips[i].height === mips[i - 1].height) {
				allOk = false;
				notes.push(`${w}x${h} mip[${i}] 与 mip[${i - 1}] 尺寸相同（循环无进展）`);
			}
			if (mips[i].width > mips[i - 1].width || mips[i].height > mips[i - 1].height) {
				allOk = false;
				notes.push(`${w}x${h} mip 链非单调递减`);
			}
		}
		// 断言：任何一级尺寸 >= 1
		for (const m of mips) {
			if (m.width < 1 || m.height < 1) {
				allOk = false;
				notes.push(`${w}x${h} 出现 0 尺寸 mip`);
			}
		}
		notes.push(`${w}x${h} → ${mips.length}级 ${fmtMips(mips)}`);
	}
	for (const n of notes) console.log(`    ${n}`);
	check("所有极端尺寸均无死循环 / 无 0 尺寸 / 单调递减 / 级数不超限", allOk);
}

// ============================================================
// 场景 8：selectMipLevel 的 && vs || —— 瘦长图不能选中过小 mip
// ============================================================
console.log("\n=== 场景 8: 瘦长图（&& 而非 || 的必要性）===");
{
	const chain = buildMipChain(16000, 1200);
	console.log(`  mip 链: ${fmtMips(chain.mips)}`);
	// 需求必须落在 mip[0] 能力范围内（8192×614），否则任何实现都只能退化，
	// 无法用于区分 && 与 ||。这里取 300×300：宽度很容易满足、高度是瓶颈。
	const need = { w: 300, h: 300 };
	const sel = selectMipLevel(chain.mips, need.w, need.h);
	check(
		"选中的 mip 两个维度都覆盖需求",
		sel.width >= need.w && sel.height >= need.h,
		`mip[${sel.index}] ${sel.width}×${sel.height} >= ${need.w}×${need.h}`,
	);
	function selectMipLevelOr(mips, rw, rh) {
		for (let i = mips.length - 1; i >= 0; i--) {
			if (mips[i].width >= rw || mips[i].height >= rh) {
				return { index: i, width: mips[i].width, height: mips[i].height };
			}
		}
		return { index: 0, width: mips[0].width, height: mips[0].height };
	}
	const orSel = selectMipLevelOr(chain.mips, need.w, need.h);
	check(
		"对照：用 || 会选到高度不足的过小 mip（证明 && 是必要修复）",
		!(orSel.width >= need.w && orSel.height >= need.h),
		`|| 版本选中 mip[${orSel.index}] ${orSel.width}×${orSel.height}（高度不足 ${need.h}）`,
	);

	// 补充：需求超出 mip[0] 能力时（瘦长图放大），必须退化到 index 0 而非 -1
	const over = selectMipLevel(chain.mips, 4000, 1100);
	check(
		"需求高度超出 mip[0] 上限时退化到 index 0（可接受的模糊，而非黑屏）",
		over.index === 0 && over.width > 0 && over.height > 0,
		`需求 4000×1100 > mip[0] 8192×614 → 选中 mip[${over.index}] ${over.width}×${over.height}`,
	);
}

// ============================================================
// 场景 9：dpr 一致性 —— renderToCanvas 坐标系
// ============================================================
console.log("\n=== 场景 9: dpr 坐标系一致性（ctx.scale(dpr,dpr) 后用 CSS 像素）===");
{
	// 复刻 renderToCanvas 的几何计算
	function geom(imgW, imgH, zoom, panX, panY, bw, bh, dpr) {
		const cw = bw / dpr;
		const ch = bh / dpr;
		const dstW = imgW * zoom;
		const dstH = imgH * zoom;
		const dstX0 = cw / 2 + panX - dstW / 2;
		const dstY0 = ch / 2 + panY - dstH / 2;
		return { cw, ch, dstW, dstH, dstX0, dstY0 };
	}
	// 容器 1000×800 CSS px, dpr=2 → backing store 2000×1600
	const g = geom(1920, 1080, 0.5, 0, 0, 2000, 1600, 2);
	check(
		"CSS 像素画布尺寸正确还原（backing/dpr）",
		g.cw === 1000 && g.ch === 800,
		`cw=${g.cw} ch=${g.ch}`,
	);
	check(
		"zoom=0.5 的 1920×1080 在 1000×800 CSS 视口内居中",
		Math.abs(g.dstX0 - (1000 - 960) / 2) < 1e-9 &&
			Math.abs(g.dstY0 - (800 - 540) / 2) < 1e-9,
		`dstX0=${g.dstX0} dstY0=${g.dstY0} (期望 20, 130)`,
	);
	// dpr 变化不应改变 CSS 像素下的几何（只影响 mip 选择精度）
	const g1 = geom(1920, 1080, 0.5, 0, 0, 1000, 800, 1);
	check(
		"同一 CSS 视口下 dpr=1 与 dpr=2 的几何完全一致（修复前 dpr 混用会错位/黑屏）",
		g1.dstX0 === g.dstX0 && g1.dstY0 === g.dstY0 && g1.cw === g.cw,
		`dpr1=(${g1.dstX0},${g1.dstY0}) dpr2=(${g.dstX0},${g.dstY0})`,
	);
	// HiDPI 下应选更大的 mip
	const chain = buildMipChain(4000, 3000);
	const zoom = 0.25;
	const selDpr1 = selectMipLevel(chain.mips, 4000 * zoom * 1, 3000 * zoom * 1);
	const selDpr2 = selectMipLevel(chain.mips, 4000 * zoom * 2, 3000 * zoom * 2);
	check(
		"HiDPI(dpr=2) 选中比 dpr=1 更大（index 更小）的 mip，保证不发虚",
		selDpr2.index < selDpr1.index,
		`dpr1→mip[${selDpr1.index}] ${selDpr1.width}×${selDpr1.height}, dpr2→mip[${selDpr2.index}] ${selDpr2.width}×${selDpr2.height}`,
	);
}

// ============================================================
// 场景 10：旋转路径 —— isTransformed 时画整张 mip 的源矩形正确性
// ============================================================
console.log("\n=== 场景 10: 旋转/翻转时的源矩形（整张 mip，不裁剪）===");
{
	function srcRect(imgW, imgH, mipW, mipH, isTransformed) {
		let imgLeft = 0, imgTop = 0, imgRight = imgW, imgBottom = imgH;
		if (isTransformed) {
			// 走整张 mip 分支
		}
		const mipScaleX = mipW / imgW;
		const mipScaleY = mipH / imgH;
		const csx = Math.max(0, Math.min(imgLeft * mipScaleX, mipW));
		const csy = Math.max(0, Math.min(imgTop * mipScaleY, mipH));
		const csw = Math.min(imgRight * mipScaleX, mipW) - csx;
		const csh = Math.min(imgBottom * mipScaleY, mipH) - csy;
		return { csx, csy, csw, csh };
	}
	const r = srcRect(18334, 14865, 6282, 5094, true);
	check(
		"旋转时源矩形 = 整张 mip（0,0,mipW,mipH），不会裁掉旋转后可见部分",
		r.csx === 0 && r.csy === 0 && Math.abs(r.csw - 6282) < 1e-6 && Math.abs(r.csh - 5094) < 1e-6,
		`csx=${r.csx} csy=${r.csy} csw=${r.csw} csh=${r.csh}`,
	);
	check("源矩形宽高 > 0，不会触发 csw<=0 的提前 return（黑屏）", r.csw > 0 && r.csh > 0);
}

// ============================================================
// 场景 11：LRU 缓存淘汰
// ============================================================
console.log("\n=== 场景 11: MAX_CACHED_IMAGES LRU 淘汰 ===");
{
	const images = new Set();
	const order = [];
	const evicted = [];
	function open(p) {
		if (images.has(p)) {
			const i = order.indexOf(p);
			if (i >= 0) order.push(order.splice(i, 1)[0]);
			return;
		}
		images.add(p);
		const i = order.indexOf(p);
		if (i >= 0) order.splice(i, 1);
		order.push(p);
		while (order.length > MAX_CACHED_IMAGES) {
			const oldest = order.shift();
			images.delete(oldest);
			evicted.push(oldest);
		}
	}
	["a", "b", "c", "d", "e"].forEach(open);
	check("打开 5 张后淘汰最旧的 a", evicted.length === 1 && evicted[0] === "a", `evicted=[${evicted}]`);
	check("缓存量稳定在 4", order.length === MAX_CACHED_IMAGES, `order=[${order}]`);
	open("b"); // touch
	open("f");
	check(
		"touch 过的 b 不被优先淘汰（LRU 语义正确）",
		!evicted.includes("b") && order.includes("b"),
		`evicted=[${evicted}] order=[${order}]`,
	);
}

// ============================================================
// 汇总
// ============================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`总计: ${pass + fail} 条断言 | 通过 ${pass} | 失败 ${fail}`);
if (fail > 0) {
	console.log("\n失败项:");
	failures.forEach((f) => console.log(`  - ${f}`));
	process.exitCode = 1;
} else {
	console.log("全部通过");
}
