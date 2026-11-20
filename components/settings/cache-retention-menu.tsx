"use client";

import type { CacheRetention } from "@earendil-works/pi-ai";

const OPTIONS = [
	{ value: undefined, compact: "默认", label: "Pi 默认", description: "不设置此项，采用 Pi 的常规行为和环境变量覆盖。" },
	{ value: "none", compact: "不请求", label: "不请求缓存", description: "传入 Pi 原生的 none 偏好。服务商仍可能自动缓存。" },
	{ value: "short", compact: "短", label: "短保留", description: "传入 Pi 原生的 short 偏好。保留时长取决于服务商和模型。" },
	{ value: "long", compact: "长", label: "长保留", description: "传入 Pi 原生的 long 偏好。缓存写入费用可能更高。" },
] as const;

export function cacheRetentionLabel(value: CacheRetention | undefined): string {
	return `缓存：${OPTIONS.find((option) => option.value === value)!.compact}`;
}

export function CacheRetentionMenu({ value, onPick }: {
	value: CacheRetention | undefined;
	onPick: (value: CacheRetention | undefined) => void;
}) {
	return <>
		<div className="border-b border-border px-2 pb-2">
			<p className="text-card-foreground">缓存保留</p>
			<p className="mt-1 text-muted-foreground">控制发送给 Pi 的缓存保留偏好。是否支持及保留时长取决于服务商和模型，不保证命中缓存。</p>
		</div>
		{OPTIONS.map((option) => <button
			key={option.value ?? "default"}
			type="button"
			data-testid={`cache-retention-option-${option.value ?? "default"}`}
			aria-pressed={value === option.value}
			onClick={() => onPick(option.value)}
			className={`rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted ${value === option.value ? "bg-muted/60" : ""}`}
		>
			<span className="flex justify-between gap-2 text-card-foreground"><span>{option.label}</span>{value === option.value && <span aria-hidden>✓</span>}</span>
			<span className="mt-1 block text-muted-foreground">{option.description}</span>
		</button>)}
	</>;
}
