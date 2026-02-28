<script lang="ts">
	import type { UiBlock } from '$lib/ui/model';
	import ToggleSwitch from '../ToggleSwitch.svelte';

	let {
		block,
		pageId = ''
	} = $props<{
		block: Extract<UiBlock, { type: 'form' }>;
		pageId?: string;
	}>();

	const fieldValue = (value: string | number | boolean | undefined): string =>
		value === undefined ? '' : String(value);

	const fieldChecked = (value: string | number | boolean | undefined): boolean =>
		value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
</script>

<div class="surface-subtle rounded-xl border border-[var(--line)] p-4">
	{#if block.title}
		<h3 class="text-base font-semibold">{block.title}</h3>
	{/if}
	{#if block.description}
		<p class="subtle mt-1 text-sm">{block.description}</p>
	{/if}
	<form class="mt-3 space-y-4" method={block.submit.method} action={block.submit.href}>
		<input type="hidden" name="__pinokio_page_id" value={pageId} />
		<input type="hidden" name="__pinokio_form_id" value={block.id} />
		{#each block.fields as field}
			<label class="block space-y-1.5">
				<span class="flex items-center gap-1.5">
					<span class="text-sm font-medium">{field.label}</span>
					{#if field.required}
						<span class="text-xs text-[var(--danger)]">*</span>
					{/if}
				</span>
				{#if field.kind === 'textarea'}
					<textarea
						class="field"
						name={field.name}
						placeholder={field.placeholder}
						required={field.required}
						disabled={field.disabled}
					>{fieldValue(field.defaultValue)}</textarea>
				{:else if field.kind === 'select'}
					<select
						class="field"
						name={field.name}
						required={field.required}
						disabled={field.disabled}
					>
						{#if !field.required}<option value="">Select...</option>{/if}
						{#each field.options as option}
							<option
								value={option.value}
								selected={fieldValue(field.defaultValue) === option.value}
							>
								{option.label}
							</option>
						{/each}
					</select>
				{:else if field.kind === 'checkbox'}
					<label
						class="surface-subtle flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
					>
						<input
							type="checkbox"
							name={field.name}
							value="true"
							checked={fieldChecked(field.defaultValue)}
							disabled={field.disabled}
						/>
						<span>{field.placeholder ?? 'Enabled'}</span>
					</label>
				{:else if field.kind === 'toggle'}
					<ToggleSwitch
						name={field.name}
						checked={fieldChecked(field.defaultValue)}
						label={field.placeholder ?? ''}
					/>
				{:else if field.kind === 'range'}
					<div class="flex items-center gap-3">
						<input
							type="range"
							class="w-full accent-[var(--accent)]"
							name={field.name}
							min={field.min ?? 0}
							max={field.max ?? 100}
							step={field.step ?? 1}
							value={fieldValue(field.defaultValue)}
							disabled={field.disabled}
						/>
						<span class="mono min-w-[3ch] text-right text-sm"
							>{fieldValue(field.defaultValue)}</span
						>
					</div>
				{:else if field.kind === 'date'}
					<input
						class="field"
						type="date"
						name={field.name}
						required={field.required}
						value={fieldValue(field.defaultValue)}
						disabled={field.disabled}
					/>
				{:else if field.kind === 'radio'}
					<div class="space-y-1.5">
						{#each field.options as option}
							<label
								class="surface-subtle flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-sm hover:border-[var(--line-strong)]"
							>
								<input
									type="radio"
									name={field.name}
									value={option.value}
									checked={fieldValue(field.defaultValue) === option.value}
									disabled={field.disabled}
								/>
								<span>{option.label}</span>
							</label>
						{/each}
					</div>
				{:else if field.kind === 'tags'}
					<input
						class="field"
						type="text"
						name={field.name}
						placeholder={field.placeholder ?? 'Comma-separated values'}
						value={fieldValue(field.defaultValue)}
						disabled={field.disabled}
					/>
				{:else if field.kind === 'file'}
					<input
						class="field"
						type="file"
						name={field.name}
						accept={field.accept}
						required={field.required}
						disabled={field.disabled}
					/>
				{:else if field.kind === 'color'}
					<div class="flex items-center gap-2">
						<input
							type="color"
							name={field.name}
							value={fieldValue(field.defaultValue) || '#087f5b'}
							class="h-9 w-9 cursor-pointer rounded border border-[var(--line)]"
							disabled={field.disabled}
						/>
						<span class="mono text-sm">{fieldValue(field.defaultValue) || '#087f5b'}</span>
					</div>
				{:else}
					<input
						class="field"
						type={field.kind}
						name={field.name}
						placeholder={field.placeholder}
						required={field.required}
						value={fieldValue(field.defaultValue)}
						disabled={field.disabled}
					/>
				{/if}
				{#if field.help}
					<p class="text-xs text-[var(--text-soft)]">{field.help}</p>
				{/if}
			</label>
		{/each}
		<button class="btn btn-primary">{block.submitLabel}</button>
	</form>
</div>
